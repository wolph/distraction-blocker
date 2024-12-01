import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncEchoes, SyncWriter } from '../../../src/background/sync-writer';

describe('SyncWriter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces rapid writes to the same key into one flush', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const w = new SyncWriter(10_000, write);
    w.queue('bank', { balanceMs: 1 });
    w.queue('bank', { balanceMs: 2 });
    w.queue('streak', { current: 3 });
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({ bank: { balanceMs: 2 }, streak: { current: 3 } });
  });

  it('flushNow writes immediately and cancels the timer', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const w = new SyncWriter(10_000, write);
    w.queue('bank', { balanceMs: 5 });
    await w.flushNow();
    expect(write).toHaveBeenCalledWith({ bank: { balanceMs: 5 } });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('preserves a failed batch and retries it with later writes', async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error('sync unavailable'))
      .mockResolvedValueOnce(undefined);
    const writer = new SyncWriter(10_000, write);
    writer.queue('bank', 5);

    await expect(writer.flushNow()).rejects.toThrow('sync unavailable');
    writer.queue('streak', 3);
    await writer.flushNow();

    expect(write).toHaveBeenNthCalledWith(2, { bank: 5, streak: 3 });
  });

  it('cancels a pending set and retries removal of its stored key', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const remove = vi
      .fn()
      .mockRejectedValueOnce(new Error('sync unavailable'))
      .mockResolvedValueOnce(undefined);
    const writer = new SyncWriter(10_000, write, remove);
    writer.queue('agg:dev:2026-10-02', { date: '2026-10-02', focusMs: 60_000 });
    writer.remove('agg:dev:2026-10-02');

    await expect(writer.flushNow()).rejects.toThrow('sync unavailable');
    await writer.flushNow();

    expect(write).not.toHaveBeenCalled();
    expect(remove).toHaveBeenNthCalledWith(1, ['agg:dev:2026-10-02']);
    expect(remove).toHaveBeenNthCalledWith(2, ['agg:dev:2026-10-02']);
  });

  it('serializes overlapping flushes so an older write cannot finish last', async () => {
    let releaseFirst: () => void = (): void => {};
    const firstBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseFirst = resolve;
    });
    const write = vi.fn(async (): Promise<void> => {
      if (write.mock.calls.length === 1) await firstBlocked;
    });
    const writer = new SyncWriter(10_000, write);
    writer.queue('streak', 'older');

    const firstFlush: Promise<void> = writer.flushNow();
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1);
    writer.queue('streak', 'newer');
    const secondFlush: Promise<void> = writer.flushNow();

    expect(write).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([firstFlush, secondFlush]);
    expect(write).toHaveBeenNthCalledWith(1, { streak: 'older' });
    expect(write).toHaveBeenNthCalledWith(2, { streak: 'newer' });
  });

  it('replays a durable pending journal after writer recreation', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    let durableJournal: { sets: Record<string, unknown>; removes: string[] } = {
      sets: {},
      removes: [],
    };
    const persistJournal = vi.fn(
      async (journal: { sets: Record<string, unknown>; removes: string[] }): Promise<void> => {
        durableJournal = structuredClone(journal);
      },
    );
    const writer = new SyncWriter(10_000, write, undefined, {
      initial: durableJournal,
      persist: persistJournal,
    });

    writer.queue('settings', { retentionDays: 30 });
    writer.queue('lists', { custom: [{ kind: 'host', pattern: 'example.com' }] });
    writer.queue('bank', { balanceMs: 42_000 });
    writer.queue('streak', { current: 4 });
    writer.queue('agg:dev:2026-08-29', { date: '2026-08-29', focusMs: 60_000 });
    await writer.whenJournalDurable();

    expect(write).not.toHaveBeenCalled();
    expect(durableJournal.sets).toMatchObject({
      settings: { retentionDays: 30 },
      lists: { custom: [{ kind: 'host', pattern: 'example.com' }] },
      bank: { balanceMs: 42_000 },
      streak: { current: 4 },
      'agg:dev:2026-08-29': { date: '2026-08-29', focusMs: 60_000 },
    });
    const queuedSets: Record<string, unknown> = structuredClone(durableJournal.sets);

    const recreated = new SyncWriter(10_000, write, undefined, {
      initial: durableJournal,
      persist: persistJournal,
    });
    await recreated.flushNow();

    expect(write).toHaveBeenCalledWith(queuedSets);
  });

  it('persists a move replacement before removing its source', async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error('sync unavailable'))
      .mockResolvedValueOnce(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    let durableJournal: { sets: Record<string, unknown>; removes: string[] } = {
      sets: {},
      removes: [],
    };
    const writer = new SyncWriter(10_000, write, remove, {
      initial: durableJournal,
      persist: async (journal): Promise<void> => {
        durableJournal = structuredClone(journal);
      },
    });
    writer.queue('archive:clock-rebase:dev:2026-08-30:1', { focusMs: 60_000 });
    writer.remove('agg:dev:2026-08-30');
    await writer.whenJournalDurable();

    await expect(writer.flushNow()).rejects.toThrow('sync unavailable');

    expect(remove).not.toHaveBeenCalled();
    expect(durableJournal).toEqual({
      sets: { 'archive:clock-rebase:dev:2026-08-30:1': { focusMs: 60_000 } },
      removes: ['agg:dev:2026-08-30'],
    });

    await writer.flushNow();

    expect(write.mock.invocationCallOrder[1]).toBeLessThan(remove.mock.invocationCallOrder[0] ?? 0);
    expect(durableJournal).toEqual({ sets: {}, removes: [] });
  });

  it('retries a failed cleanup checkpoint through the debounce scheduler', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    let failedCleanups: number = 0;
    let durableJournal: { sets: Record<string, unknown>; removes: string[] } = {
      sets: {},
      removes: [],
    };
    const writer = new SyncWriter(10_000, write, undefined, {
      initial: durableJournal,
      persist: async (journal): Promise<void> => {
        if (Object.keys(journal.sets).length === 0 && failedCleanups < 2) {
          failedCleanups += 1;
          throw new Error('journal unavailable');
        }
        durableJournal = structuredClone(journal);
      },
    });
    writer.queue('lists', { custom: [{ kind: 'host', pattern: 'example.org' }] });
    await writer.whenJournalDurable();

    await expect(writer.flushNow()).rejects.toThrow('journal unavailable');

    expect(write).toHaveBeenCalledTimes(1);
    expect(durableJournal.sets).toHaveProperty('lists');

    await vi.advanceTimersByTimeAsync(10_000);

    expect(write).toHaveBeenCalledTimes(1);
    expect(durableJournal.sets).toHaveProperty('lists');

    await vi.advanceTimersByTimeAsync(10_000);

    expect(write).toHaveBeenCalledTimes(1);
    expect(durableJournal).toEqual({ sets: {}, removes: [] });
  });
});

describe('SyncEchoes', () => {
  it('consumes only the matching local storage echo', () => {
    const echoes = new SyncEchoes();
    echoes.remember('bank', { balanceMs: 10 });

    expect(echoes.consume('bank', { balanceMs: 20 })).toBe(false);
    expect(echoes.consume('bank', { balanceMs: 10 })).toBe(true);
    expect(echoes.consume('bank', { balanceMs: 10 })).toBe(false);
  });
});

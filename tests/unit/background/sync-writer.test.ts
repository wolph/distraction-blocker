import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncEchoes, type SyncJournal, SyncWriter } from '../../../src/background/sync-writer';

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

  it('reports a key pending until its in-flight flush completes', async () => {
    let releaseWrite: () => void = (): void => {};
    let signalWriteStarted: () => void = (): void => {};
    const writeBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseWrite = resolve;
    });
    const writeStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalWriteStarted = resolve;
    });
    const writer: SyncWriter = new SyncWriter(10_000, async (): Promise<void> => {
      signalWriteStarted();
      await writeBlocked;
    });

    expect(writer.hasPending('lists')).toBe(false);
    writer.queue('lists', { custom: [] });
    expect(writer.hasPending('lists')).toBe(true);

    const flushing: Promise<void> = writer.flushNow();
    await writeStarted;
    expect(writer.hasPending('lists')).toBe(true);

    releaseWrite();
    await flushing;
    expect(writer.hasPending('lists')).toBe(false);
  });

  it('reports a flushed key pending until cleanup journal persistence completes', async () => {
    let releaseCleanup: () => void = (): void => {};
    let signalCleanupStarted: () => void = (): void => {};
    const cleanupBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseCleanup = resolve;
    });
    const cleanupStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalCleanupStarted = resolve;
    });
    const writer: SyncWriter = new SyncWriter(
      10_000,
      vi.fn().mockResolvedValue(undefined),
      undefined,
      {
        initial: { sets: {}, removes: [] },
        persist: async (journal): Promise<void> => {
          if (Object.keys(journal.sets).length === 0) {
            signalCleanupStarted();
            await cleanupBlocked;
          }
        },
      },
    );
    writer.queue('lists', { custom: [] });
    await writer.whenJournalDurable();

    const flushing: Promise<void> = writer.flushNow();
    await cleanupStarted;

    expect(writer.hasPending('lists')).toBe(true);
    releaseCleanup();
    await flushing;
    expect(writer.hasPending('lists')).toBe(false);
  });

  it('keeps a flushed key pending when cleanup journal persistence fails', async () => {
    let durableJournal: SyncJournal = { sets: {}, removes: [] };
    let rejectCleanup: boolean = true;
    const writer: SyncWriter = new SyncWriter(
      10_000,
      vi.fn().mockResolvedValue(undefined),
      undefined,
      {
        initial: durableJournal,
        persist: async (journal: SyncJournal): Promise<void> => {
          if (Object.keys(journal.sets).length === 0 && rejectCleanup) {
            rejectCleanup = false;
            throw new Error('cleanup unavailable');
          }
          durableJournal = structuredClone(journal);
        },
      },
    );
    writer.queue('lists', { custom: [{ kind: 'host', pattern: 'local.example' }] });
    await writer.whenJournalDurable();

    await expect(writer.flushNow()).rejects.toThrow('cleanup unavailable');

    expect(writer.hasPending('lists')).toBe(true);
    expect(durableJournal.sets).toHaveProperty('lists');
    const restarted: SyncWriter = new SyncWriter(10_000, vi.fn(), undefined, {
      initial: durableJournal,
      persist: vi.fn().mockResolvedValue(undefined),
    });
    expect(restarted.hasPending('lists')).toBe(true);
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

describe('SyncWriter quota defense', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('rejects an oversized queue replacement before changing pending state', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const persist = vi.fn().mockResolvedValue(undefined);
    const writer = new SyncWriter(10_000, write, undefined, {
      initial: { sets: {}, removes: [] },
      persist,
    });
    writer.queue('k', 'valid');
    await writer.whenJournalDurable();
    persist.mockClear();

    expect((): void => writer.queue('k', 'a'.repeat(8_190))).toThrow(
      'Cannot sync item "k": 8193 bytes exceeds the 8192-byte limit.',
    );
    expect(persist).not.toHaveBeenCalled();

    await writer.flushNow();
    expect(write).toHaveBeenCalledWith({ k: 'valid' });
  });

  it('rejects an oversized supersede while preserving its valid pending value', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const writer = new SyncWriter(10_000, write);
    writer.queue('k', 'valid');

    expect((): void => writer.supersede('k', 'a'.repeat(8_190))).toThrow(
      'Cannot sync item "k": 8193 bytes exceeds the 8192-byte limit.',
    );

    await writer.flushNow();
    expect(write).toHaveBeenCalledWith({ k: 'valid' });
  });

  it('rejects an unserializable queued value before journaling', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const persist = vi.fn().mockResolvedValue(undefined);
    const writer = new SyncWriter(10_000, write, undefined, {
      initial: { sets: {}, removes: [] },
      persist,
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect((): void => writer.queue('settings', circular)).toThrow(
      'Cannot sync item "settings": value cannot be serialized as JSON.',
    );
    expect(persist).not.toHaveBeenCalled();
    await writer.flushNow();
    expect(write).not.toHaveBeenCalled();
  });

  it('revalidates copied flush batches after a queued value mutates', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const writer = new SyncWriter(10_000, write);
    const value: { text: string } = { text: 'valid' };
    writer.queue('settings', value);
    value.text = 'a'.repeat(8_192);

    await expect(writer.flushNow()).rejects.toThrow(
      'Cannot sync item "settings": 8211 bytes exceeds the 8192-byte limit.',
    );
    expect(write).not.toHaveBeenCalled();
  });

  it('revalidates pending values before persisting another journal snapshot', async () => {
    const persisted: Array<{ sets: Record<string, unknown>; removes: string[] }> = [];
    const write = vi.fn().mockResolvedValue(undefined);
    const writer = new SyncWriter(10_000, write, undefined, {
      initial: { sets: {}, removes: [] },
      persist: async (journal): Promise<void> => {
        persisted.push(structuredClone(journal));
      },
    });
    const value: { text: string } = { text: 'valid' };
    writer.queue('settings', value);
    await writer.whenJournalDurable();
    const persistedBeforeMutation: number = persisted.length;
    value.text = 'a'.repeat(8_192);

    await expect(writer.whenJournalDurable()).rejects.toThrow(
      'Cannot sync item "settings": 8211 bytes exceeds the 8192-byte limit.',
    );
    expect(persisted).toHaveLength(persistedBeforeMutation);
  });

  it('sanitizes an initial pending journal before scheduling its flush', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    const persist = vi.fn().mockResolvedValue(undefined);
    const writer = new SyncWriter(10_000, write, remove, {
      initial: {
        sets: {
          valid: { enabled: true },
          huge: 'a'.repeat(8_192),
        },
        removes: ['obsolete'],
      },
      persist,
    });

    await writer.flushNow();

    expect(write).toHaveBeenCalledWith({ valid: { enabled: true } });
    expect(write).not.toHaveBeenCalledWith(expect.objectContaining({ huge: expect.anything() }));
  });

  it('checkpoints an initial journal containing only rejected sets', async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    new SyncWriter(10_000, vi.fn().mockResolvedValue(undefined), undefined, {
      initial: {
        sets: { huge: 'a'.repeat(8_192) },
        removes: [],
      },
      persist,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(persist).toHaveBeenCalledWith({ sets: {}, removes: [] });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('retries a failed rejected-only journal checkpoint through the scheduler', async () => {
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error('journal unavailable'))
      .mockResolvedValue(undefined);
    new SyncWriter(10_000, vi.fn().mockResolvedValue(undefined), undefined, {
      initial: {
        sets: { huge: 'a'.repeat(8_192) },
        removes: [],
      },
      persist,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(persist).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith({ sets: {}, removes: [] });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(persist).toHaveBeenCalledTimes(2);
  });
});

describe('SyncWriter concurrency ordering', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('excludes writes queued after a flush starts awaiting its journal generation', async (): Promise<void> => {
    let releaseFirstPersist: () => void = (): void => {};
    const firstPersistBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseFirstPersist = resolve;
    });
    let releaseSecondPersist: () => void = (): void => {};
    const secondPersistBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseSecondPersist = resolve;
    });
    let markFirstPersistStarted: () => void = (): void => {};
    const firstPersistStarted: Promise<void> = new Promise((resolve: () => void): void => {
      markFirstPersistStarted = resolve;
    });
    let persistCalls: number = 0;
    const persist = vi.fn(async (journal): Promise<void> => {
      persistCalls += 1;
      if (persistCalls === 1) {
        markFirstPersistStarted();
        await firstPersistBlocked;
      }
      if (Object.hasOwn(journal.sets, 'second')) await secondPersistBlocked;
    });
    let observeWrite: (items: Record<string, unknown>) => void = (): void => {};
    const written: Promise<Record<string, unknown>> = new Promise(
      (resolve: (items: Record<string, unknown>) => void): void => {
        observeWrite = resolve;
      },
    );
    const write = vi.fn((items: Record<string, unknown>): Promise<void> => {
      observeWrite(structuredClone(items));
      return Promise.resolve();
    });
    const writer = new SyncWriter(10_000, write, undefined, {
      initial: { sets: {}, removes: [] },
      persist,
    });
    writer.queue('first', 1);
    const flush: Promise<void> = writer.flushNow();
    await firstPersistStarted;

    writer.queue('second', 2);
    releaseFirstPersist();

    expect(await written).toEqual({ first: 1 });
    releaseSecondPersist();
    await flush;
  });

  it('preserves a newer requeue of the same mutable object while a write is pending', async (): Promise<void> => {
    let releaseFirstWrite: () => void = (): void => {};
    const firstWriteBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseFirstWrite = resolve;
    });
    let markFirstWriteStarted: () => void = (): void => {};
    const firstWriteStarted: Promise<void> = new Promise((resolve: () => void): void => {
      markFirstWriteStarted = resolve;
    });
    const writes: Array<Record<string, unknown>> = [];
    const write = vi.fn(async (items: Record<string, unknown>): Promise<void> => {
      writes.push(structuredClone(items));
      if (writes.length === 1) {
        markFirstWriteStarted();
        await firstWriteBlocked;
      }
    });
    const writer = new SyncWriter(10_000, write);
    const value: { text: string } = { text: 'first' };
    writer.queue('settings', value);
    const firstFlush: Promise<void> = writer.flushNow();
    await firstWriteStarted;

    value.text = 'second';
    writer.queue('settings', value);
    releaseFirstWrite();
    await firstFlush;
    await writer.flushNow();

    expect(writes).toEqual([{ settings: { text: 'first' } }, { settings: { text: 'second' } }]);
  });
});

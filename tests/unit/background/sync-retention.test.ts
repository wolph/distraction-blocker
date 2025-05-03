import { describe, expect, it, vi } from 'vitest';
import { Engine, type EnginePorts } from '../../../src/background/engine';
import { emptyRuntime } from '../../../src/background/stores';
import {
  SYNC_QUOTA_BYTES_TOTAL,
  setSyncItemsWithinQuota,
  syncItemBytes,
} from '../../../src/background/sync-quota';
import { compactPendingSyncRetention } from '../../../src/background/sync-retention';
import { SyncWriter } from '../../../src/background/sync-writer';
import { rollupMonth } from '../../../src/core/stats';
import { DEFAULT_LISTS, DEFAULT_SETTINGS, rulesFromLists } from '../../../src/shared/constants';
import { localDateStr } from '../../../src/shared/time';
import type { DailyAgg, MonthlyAgg, SessionConfig } from '../../../src/shared/types';

const DAY_MS: number = 86_400_000;
const T0: number = new Date(2026, 0, 15, 8, 0).getTime();

interface FakeSync {
  area: chrome.storage.SyncStorageArea;
  state: Record<string, unknown>;
}

function fakeSync(initial: Record<string, unknown>): FakeSync {
  const state: Record<string, unknown> = structuredClone(initial);
  const area: chrome.storage.SyncStorageArea = {
    get: vi.fn(async (): Promise<Record<string, unknown>> => structuredClone(state)),
    getBytesInUse: vi.fn(
      async (): Promise<number> =>
        Object.entries(state).reduce(
          (total: number, [key, value]: [string, unknown]): number =>
            total + syncItemBytes(key, value),
          0,
        ),
    ),
    set: vi.fn(async (items: Record<string, unknown>): Promise<void> => {
      Object.assign(state, structuredClone(items));
    }),
    remove: vi.fn(async (keys: string | string[]): Promise<void> => {
      const listed: string[] = typeof keys === 'string' ? [keys] : keys;
      for (const key of listed) delete state[key];
    }),
  } as unknown as chrome.storage.SyncStorageArea;
  return { area, state };
}

function daily(date: string, over: Partial<DailyAgg> = {}): DailyAgg {
  return {
    date,
    focusMs: 0,
    sessionsStarted: 0,
    sessionsCompleted: 0,
    attempts: {},
    attemptsOther: 0,
    pausesTaken: 0,
    pauseMsSpent: 0,
    pauseMsEarned: 0,
    unlocksTaken: 0,
    unlockMsSpent: 0,
    resisted: 0,
    ...over,
  };
}

function dateBefore(now: number, daysBefore: number): string {
  const date: Date = new Date(now);
  date.setDate(date.getDate() - daysBefore);
  return localDateStr(date.getTime());
}

function totalBytes(items: Record<string, unknown>): number {
  return Object.entries(items).reduce(
    (total: number, [key, value]: [string, unknown]): number => total + syncItemBytes(key, value),
    0,
  );
}

function aggregateTotals(
  items: Record<string, unknown>,
  deviceId: string,
): {
  focusMs: number;
  pauseMsEarned: number;
  unlockMsSpent: number;
} {
  return Object.entries(items)
    .filter(
      ([key]: [string, unknown]): boolean =>
        key.startsWith(`agg:${deviceId}:`) || key.startsWith(`aggm:${deviceId}:`),
    )
    .reduce(
      (
        totals: { focusMs: number; pauseMsEarned: number; unlockMsSpent: number },
        [, value]: [string, unknown],
      ): { focusMs: number; pauseMsEarned: number; unlockMsSpent: number } => {
        const aggregate = value as DailyAgg | MonthlyAgg;
        return {
          focusMs: totals.focusMs + aggregate.focusMs,
          pauseMsEarned: totals.pauseMsEarned + (aggregate.pauseMsEarned ?? 0),
          unlockMsSpent: totals.unlockMsSpent + (aggregate.unlockMsSpent ?? 0),
        };
      },
      { focusMs: 0, pauseMsEarned: 0, unlockMsSpent: 0 },
    );
}

describe('pending Sync retention', () => {
  it('removes near-quota expired dailies before retaining every monthly aggregate', async () => {
    const deviceId: string = 'dev-quota';
    const now: number = new Date(2026, 7, 30, 12, 0).getTime();
    const historyKey: string = `aggm:${deviceId}:2020-01`;
    const history: MonthlyAgg = rollupMonth('2020-01', [
      daily('2020-01-15', { focusMs: 7_000, pauseMsEarned: 700, unlockMsSpent: 70 }),
    ]);
    const initial: Record<string, unknown> = { [historyKey]: history };
    let expectedFocusMs: number = history.focusMs;
    let expectedPauseMsEarned: number = history.pauseMsEarned ?? 0;
    let expectedUnlockMsSpent: number = history.unlockMsSpent ?? 0;
    for (let index: number = 0; index < 14; index++) {
      const date: string = dateBefore(now, 120 + index * 35);
      const aggregate: DailyAgg = daily(date, {
        focusMs: (index + 1) * 1_000,
        pauseMsEarned: (index + 1) * 100,
        unlockMsSpent: (index + 1) * 10,
      });
      initial[`agg:${deviceId}:${date}`] = { ...aggregate, padding: 'x'.repeat(7_000) };
      expectedFocusMs += aggregate.focusMs;
      expectedPauseMsEarned += aggregate.pauseMsEarned ?? 0;
      expectedUnlockMsSpent += aggregate.unlockMsSpent ?? 0;
    }
    const initialBytes: number = totalBytes(initial);
    const sync: FakeSync = fakeSync(initial);
    let durableJournal = { sets: {} as Record<string, unknown>, removes: [] as string[] };
    const writer: SyncWriter = new SyncWriter(
      60_000,
      (items: Record<string, unknown>): Promise<void> => setSyncItemsWithinQuota(items, sync.area),
      async (keys: string[]): Promise<void> => sync.area.remove(keys),
      {
        initial: durableJournal,
        persist: async (journal): Promise<void> => {
          durableJournal = structuredClone(journal);
        },
      },
    );

    await compactPendingSyncRetention(
      writer,
      deviceId,
      90,
      now,
      async (): Promise<Record<string, unknown>> => structuredClone(sync.state),
    );
    await writer.flushNow();

    expect(initialBytes).toBeGreaterThan(100_000);
    expect(initialBytes).toBeLessThanOrEqual(SYNC_QUOTA_BYTES_TOTAL);
    expect(totalBytes(sync.state)).toBeLessThanOrEqual(SYNC_QUOTA_BYTES_TOTAL);
    expect(sync.state[historyKey]).toEqual(history);
    expect(aggregateTotals(sync.state, deviceId)).toEqual({
      focusMs: expectedFocusMs,
      pauseMsEarned: expectedPauseMsEarned,
      unlockMsSpent: expectedUnlockMsSpent,
    });
    expect(durableJournal).toEqual({ sets: {}, removes: [] });
  });

  it('replays a durable rollup after removal succeeds and its first write fails', async () => {
    const deviceId: string = 'dev-restart';
    const now: number = new Date(2026, 7, 30, 12, 0).getTime();
    const expiredDate: string = dateBefore(now, 2);
    const expiredKey: string = `agg:${deviceId}:${expiredDate}`;
    const monthKey: string = `aggm:${deviceId}:${expiredDate.slice(0, 7)}`;
    const existing: MonthlyAgg = rollupMonth(expiredDate.slice(0, 7), [
      daily(`${expiredDate.slice(0, 7)}-01`, {
        focusMs: 1_000,
        pauseMsEarned: 100,
        unlockMsSpent: 10,
      }),
    ]);
    const expired: DailyAgg = daily(expiredDate, {
      focusMs: 2_000,
      pauseMsEarned: 200,
      unlockMsSpent: 20,
    });
    const sync: FakeSync = fakeSync({ [expiredKey]: expired, [monthKey]: existing });
    let durableJournal = { sets: {} as Record<string, unknown>, removes: [] as string[] };
    let failWrite: boolean = true;
    const write = async (items: Record<string, unknown>): Promise<void> => {
      if (failWrite) {
        failWrite = false;
        throw new Error('sync unavailable');
      }
      await sync.area.set(items);
    };
    const journal = {
      initial: durableJournal,
      persist: async (pending: {
        sets: Record<string, unknown>;
        removes: string[];
      }): Promise<void> => {
        durableJournal = structuredClone(pending);
      },
    };
    const writer: SyncWriter = new SyncWriter(
      60_000,
      write,
      async (keys: string[]): Promise<void> => sync.area.remove(keys),
      journal,
    );

    await compactPendingSyncRetention(
      writer,
      deviceId,
      1,
      now,
      async (): Promise<Record<string, unknown>> => structuredClone(sync.state),
    );
    await expect(writer.flushNow()).rejects.toThrow('sync unavailable');

    expect(sync.state[expiredKey]).toBeUndefined();
    expect(sync.state[monthKey]).toEqual(existing);
    expect(durableJournal).toEqual({
      sets: {
        [monthKey]: expect.objectContaining({
          focusMs: 3_000,
          pauseMsEarned: 300,
          unlockMsSpent: 30,
        }),
      },
      removes: [expiredKey],
    });

    const recreated: SyncWriter = new SyncWriter(
      60_000,
      write,
      async (keys: string[]): Promise<void> => sync.area.remove(keys),
      {
        ...journal,
        initial: structuredClone(durableJournal),
      },
    );
    await recreated.flushNow();

    expect(sync.state[expiredKey]).toBeUndefined();
    expect(sync.state[monthKey]).toMatchObject({
      focusMs: 3_000,
      pauseMsEarned: 300,
      unlockMsSpent: 30,
    });
    expect(aggregateTotals(sync.state, deviceId)).toEqual({
      focusMs: 3_000,
      pauseMsEarned: 300,
      unlockMsSpent: 30,
    });
    expect(durableJournal).toEqual({ sets: {}, removes: [] });
  });

  it('compacts a 399-day nonempty session before the pending batch reaches Sync', async () => {
    const deviceId: string = 'dev-test';
    const existingMonthKey: string = `aggm:${deviceId}:2026-01`;
    const existingFocusMs: number = 42_000;
    const existingPauseMsEarned: number = 4_200;
    const existingUnlockMsSpent: number = 420;
    const initialBankMs: number = DEFAULT_SETTINGS.pause.unlockMs;
    const sync: FakeSync = fakeSync({
      [existingMonthKey]: rollupMonth('2026-01', [
        {
          date: '2026-01-01',
          focusMs: existingFocusMs,
          sessionsStarted: 1,
          sessionsCompleted: 1,
          attempts: {},
          attemptsOther: 0,
          pausesTaken: 0,
          pauseMsSpent: 0,
          pauseMsEarned: existingPauseMsEarned,
          unlocksTaken: 0,
          unlockMsSpent: existingUnlockMsSpent,
          resisted: 0,
        },
      ]),
    });
    const writer: SyncWriter = new SyncWriter(
      60_000,
      (items: Record<string, unknown>): Promise<void> => setSyncItemsWithinQuota(items, sync.area),
      async (keys: string[]): Promise<void> => {
        await sync.area.remove(keys);
      },
      {
        initial: { sets: {}, removes: [] },
        persist: async (): Promise<void> => {},
      },
    );
    let now: number = T0;
    const ports: EnginePorts = {
      now: (): number => now,
      newId: (): string => 'id',
      rehydrateAfterDataClear: async (): Promise<string> => 'rehydrated-id',
      saveRuntime: async (): Promise<void> => {},
      saveMatcherCache: async (): Promise<void> => {},
      hasPendingSync: (key: string): boolean => writer.hasPending(key),
      queueSync: (key: string, value: unknown): void => writer.queue(key, value),
      supersedeSync: (key: string, value: unknown): void => writer.supersede(key, value),
      removeSync: (key: string): void => writer.remove(key),
      persistSyncJournal: (): Promise<void> => writer.whenJournalDurable(),
      appendEvents: async (): Promise<void> => {},
      broadcast: (): void => {},
      applyBlocking: async (): Promise<void> => {},
      playSound: (): void => {},
      notify: (): void => {},
      updateIcon: (): void => {},
      scheduleWake: (): void => {},
      prune: (retentionDays: number, pruneNow: number): Promise<void> =>
        compactPendingSyncRetention(
          writer,
          deviceId,
          retentionDays,
          pruneNow,
          async (): Promise<Record<string, unknown>> => structuredClone(sync.state),
        ),
      reportError: (error: unknown): never => {
        throw error;
      },
      websiteBlockingReady: (): boolean => true,
    };
    const engine: Engine = new Engine(
      ports,
      DEFAULT_SETTINGS,
      DEFAULT_LISTS,
      { balanceMs: initialBankMs },
      null,
      emptyRuntime(T0),
      deviceId,
    );
    const session: SessionConfig = {
      mode: 'blacklist',
      strictness: 'friction',
      durationMin: 399 * 24 * 60,
      cycling: null,
      intention: 'long offline session',
      source: 'manual',
      scheduleEntryId: null,
      rules: rulesFromLists(DEFAULT_LISTS),
    };
    await engine.startSession(session);
    await engine.openGate('unlockSite', 'example.com');
    now = T0 + DEFAULT_SETTINGS.gate.delayMs;
    expect(await engine.confirmGate(null)).toEqual({ ok: true });
    now = T0 + 399 * DAY_MS;

    await engine.tick();
    await writer.flushNow();

    const aggregateEntries: Array<[string, unknown]> = Object.entries(sync.state).filter(
      ([key]: [string, unknown]): boolean =>
        key.startsWith(`agg:${deviceId}:`) || key.startsWith(`aggm:${deviceId}:`),
    );
    const totalBytes: number = Object.entries(sync.state).reduce(
      (total: number, [key, value]: [string, unknown]): number => total + syncItemBytes(key, value),
      0,
    );
    const totals: ReturnType<typeof aggregateTotals> = aggregateTotals(sync.state, deviceId);
    const dailyCount: number = aggregateEntries.filter(([key]: [string, unknown]): boolean =>
      key.startsWith(`agg:${deviceId}:`),
    ).length;

    expect(totalBytes).toBeLessThanOrEqual(SYNC_QUOTA_BYTES_TOTAL);
    expect(dailyCount).toBe(DEFAULT_SETTINGS.retentionDays);
    expect(sync.state[existingMonthKey]).toMatchObject({
      focusMs: expect.any(Number),
      sessionsStarted: 2,
    });
    expect(totals).toEqual({
      focusMs: 399 * DAY_MS + existingFocusMs,
      pauseMsEarned: DEFAULT_SETTINGS.pause.capMs + existingPauseMsEarned,
      unlockMsSpent: DEFAULT_SETTINGS.pause.unlockMs + existingUnlockMsSpent,
    });
  });
});

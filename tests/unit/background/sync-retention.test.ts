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
import { DEFAULT_LISTS, DEFAULT_SETTINGS } from '../../../src/shared/constants';
import type { SessionConfig } from '../../../src/shared/types';

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

describe('pending Sync retention', () => {
  it('compacts a 399-day nonempty session before the pending batch reaches Sync', async () => {
    const deviceId: string = 'dev-test';
    const existingMonthKey: string = `aggm:${deviceId}:2026-01`;
    const existingFocusMs: number = 42_000;
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
          pauseMsEarned: 0,
          unlocksTaken: 0,
          unlockMsSpent: 0,
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
    };
    const engine: Engine = new Engine(
      ports,
      DEFAULT_SETTINGS,
      DEFAULT_LISTS,
      { balanceMs: 0 },
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
    };
    await engine.startSession(session);
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
    const totalFocusMs: number = aggregateEntries.reduce(
      (total: number, [, value]: [string, unknown]): number =>
        total + (value as { focusMs: number }).focusMs,
      0,
    );
    const dailyCount: number = aggregateEntries.filter(([key]: [string, unknown]): boolean =>
      key.startsWith(`agg:${deviceId}:`),
    ).length;

    expect(totalBytes).toBeLessThanOrEqual(SYNC_QUOTA_BYTES_TOTAL);
    expect(dailyCount).toBeLessThanOrEqual(DEFAULT_SETTINGS.retentionDays + 1);
    expect(sync.state[existingMonthKey]).toMatchObject({
      focusMs: expect.any(Number),
      sessionsStarted: 2,
    });
    expect(totalFocusMs).toBe(399 * DAY_MS + existingFocusMs);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeListsSyncSnapshot } from '../../../src/background/list-sync-codec';
import {
  type AllDataClearBarrier,
  createPolicyStorage,
  type FirstSyncCheckpointSource,
  type PolicySnapshot,
  type PolicyStorage,
} from '../../../src/background/policy-storage';
import { emptyRuntime, type RuntimeState } from '../../../src/background/stores';
import type { SyncJournal } from '../../../src/background/sync-writer';
import { capAttempts, emptyDaily, rollupMonth } from '../../../src/core/stats';
import {
  CATEGORY_IDS,
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  DEFAULT_SETUP,
  rulesFromLists,
  TOP_SITES_DAILY,
} from '../../../src/shared/constants';
import {
  LOCAL_AGGREGATE_PRUNE,
  LOCAL_AGGREGATE_TOMBSTONES,
  LOCAL_BANK,
  LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS,
  LOCAL_CACHES,
  LOCAL_DATA_CLEAR_JOURNAL,
  LOCAL_DEVICE_ID,
  LOCAL_EVENTS,
  LOCAL_FIRST_SYNC_PUBLICATION,
  LOCAL_LISTS,
  LOCAL_POLICY_COMMIT,
  LOCAL_POLICY_GENERATION_PREFIX,
  LOCAL_RUNTIME,
  LOCAL_SETTINGS,
  LOCAL_SETUP,
  LOCAL_STREAK,
  LOCAL_SYNC_JOURNAL,
  LOCAL_SYNC_QUOTA_EVICTION,
  SYNC_BANK,
  SYNC_LISTS,
  SYNC_SETTINGS,
  SYNC_STREAK,
  syncAggKey,
} from '../../../src/shared/storage-keys';
import type {
  BankState,
  DailyAgg,
  EventRecord,
  ListsConfig,
  MonthlyAgg,
  SessionState,
  Settings,
  SetupState,
  StreakState,
} from '../../../src/shared/types';

interface FakeAreaState {
  values: Record<string, unknown>;
  failGet: Error | null;
  failSet: Error | null;
  failRemove: Error | null;
  suppressNextSet: boolean;
  alphabetizeValuesOnGet: boolean;
}

interface FakeStorage {
  area: chrome.storage.SyncStorageArea;
  state: FakeAreaState;
}

const STREAK: StreakState = {
  current: 2,
  freezeTokens: 1,
  lastCountedDate: '2026-08-30',
  lastFreezeGrantDate: '2026-08-24',
  activeDays: [29, 30],
  activeMonth: '2026-08',
};

const SNAPSHOT: PolicySnapshot = {
  settings: DEFAULT_SETTINGS,
  lists: DEFAULT_LISTS,
  bank: { balanceMs: 42_000 },
  streak: STREAK,
};

const BLOCKED_AGGREGATE_PUBLICATIONS_KEY: string = LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS;
const FIRST_SYNC_PUBLICATION_KEY: string = LOCAL_FIRST_SYNC_PUBLICATION;

function selectedValues(
  values: Record<string, unknown>,
  keys: string | string[] | Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (keys === null || keys === undefined) return structuredClone(values);
  const requested: string[] =
    typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
  return Object.fromEntries(
    requested
      .filter((key: string): boolean => Object.hasOwn(values, key))
      .map((key: string): [string, unknown] => [key, structuredClone(values[key])]),
  );
}

function alphabetizedStorageValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(alphabetizedStorageValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left]: [string, unknown], [right]: [string, unknown]): number =>
        left.localeCompare(right),
      )
      .map(([key, nested]: [string, unknown]): [string, unknown] => [
        key,
        alphabetizedStorageValue(nested),
      ]),
  );
}

function fakeStorage(initial: Record<string, unknown> = {}): FakeStorage {
  const state: FakeAreaState = {
    values: structuredClone(initial),
    failGet: null,
    failSet: null,
    failRemove: null,
    suppressNextSet: false,
    alphabetizeValuesOnGet: false,
  };
  const area = {
    clear: vi.fn(async (): Promise<void> => {
      state.values = {};
    }),
    get: vi.fn(
      async (
        keys?: string | string[] | Record<string, unknown> | null,
      ): Promise<Record<string, unknown>> => {
        if (state.failGet !== null) throw state.failGet;
        const selected: Record<string, unknown> = selectedValues(state.values, keys);
        return state.alphabetizeValuesOnGet
          ? (alphabetizedStorageValue(selected) as Record<string, unknown>)
          : selected;
      },
    ),
    getBytesInUse: vi.fn(async (): Promise<number> => JSON.stringify(state.values).length),
    remove: vi.fn(async (keys: string | string[]): Promise<void> => {
      if (state.failRemove !== null) throw state.failRemove;
      for (const key of typeof keys === 'string' ? [keys] : keys) delete state.values[key];
    }),
    set: vi.fn(async (items: Record<string, unknown>): Promise<void> => {
      if (state.failSet !== null) throw state.failSet;
      if (state.suppressNextSet) {
        state.suppressNextSet = false;
        return;
      }
      Object.assign(state.values, structuredClone(items));
    }),
    setAccessLevel: vi.fn(async (): Promise<void> => undefined),
    onChanged: { addListener: vi.fn(), hasListener: vi.fn(), removeListener: vi.fn() },
  } as unknown as chrome.storage.SyncStorageArea;
  return { area, state };
}

function localPolicy(setup: SetupState): Record<string, unknown> {
  return {
    [LOCAL_SETUP]: setup,
    [LOCAL_SETTINGS]: SNAPSHOT.settings,
    [LOCAL_LISTS]: SNAPSHOT.lists,
    [LOCAL_BANK]: SNAPSHOT.bank,
    [LOCAL_STREAK]: SNAPSHOT.streak,
  };
}

function runtimeWithActiveSession(now: number): RuntimeState {
  const activeSession: SessionState = {
    sessionId: 'active-session',
    config: {
      mode: 'blacklist',
      strictness: 'friction',
      durationMin: 25,
      cycling: null,
      intention: 'finish the launch',
      source: 'manual',
      scheduleEntryId: null,
      rules: rulesFromLists(DEFAULT_LISTS),
    },
    startedAt: now,
    sessionEndsAt: now + 25 * 60_000,
    phase: 'focus',
    phaseStartedAt: now,
    phaseEndsAt: now + 25 * 60_000,
    cycleIndex: 0,
    pausedFrom: null,
    focusedMs: 0,
  };
  return { ...emptyRuntime(now), session: activeSession };
}

const EMPTY_CHECKPOINT = {
  loadAggregateItems: async (): Promise<Record<string, unknown>> => ({}),
};

const DIRECT_ALL_DATA_CLEAR_BARRIER: AllDataClearBarrier = {
  runExclusive: <T>(operation: () => Promise<T>): Promise<T> => operation(),
};

function policyStorage(local: FakeStorage, sync: FakeStorage): PolicyStorage {
  return createPolicyStorage(
    local.area,
    sync.area,
    EMPTY_CHECKPOINT,
    DIRECT_ALL_DATA_CLEAR_BARRIER,
  );
}

async function setupState(local: FakeStorage): Promise<SetupState> {
  const value: unknown = (await local.area.get(LOCAL_SETUP))[LOCAL_SETUP];
  if (typeof value !== 'object' || value === null) throw new Error('setup missing');
  return value as SetupState;
}

function highCardinalityDaily(date: string, count: number): ReturnType<typeof emptyDaily> {
  return {
    ...emptyDaily(date),
    attempts: Object.fromEntries(
      Array.from({ length: count }, (_value: unknown, index: number): [string, number] => [
        `site-${String(index).padStart(4, '0')}.example`,
        count - index,
      ]),
    ),
  };
}

describe('PolicyStorage', (): void => {
  beforeEach((): void => {
    vi.useFakeTimers();
  });

  afterEach((): void => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('initializes an unconfirmed clean profile without any Sync API call', async (): Promise<void> => {
    const local: FakeStorage = fakeStorage();
    const sync: FakeStorage = fakeStorage({ [SYNC_SETTINGS]: DEFAULT_SETTINGS });
    const storage: PolicyStorage = policyStorage(local, sync);

    await storage.initialize();
    expect(await storage.loadSetup()).toEqual(DEFAULT_SETUP);
    expect(await storage.loadSnapshot()).toEqual({
      settings: DEFAULT_SETTINGS,
      lists: DEFAULT_LISTS,
      bank: { balanceMs: 0 },
      streak: null,
    });
    expect(sync.area.get).not.toHaveBeenCalled();
    expect(sync.area.getBytesInUse).not.toHaveBeenCalled();
    expect(sync.area.set).not.toHaveBeenCalled();
    expect(sync.area.remove).not.toHaveBeenCalled();
  });

  it('keeps imported legacy Sync intent paused until explicit consent', async (): Promise<void> => {
    const local: FakeStorage = fakeStorage();
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);
    const journal: SyncJournal = {
      sets: { [SYNC_SETTINGS]: SNAPSHOT.settings, [SYNC_BANK]: SNAPSHOT.bank },
      removes: [],
    };

    await storage.importLegacy(SNAPSHOT, emptyRuntime(Date.now()), journal);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(await storage.storageMode()).toBeNull();
    expect(await storage.loadSetup()).toMatchObject({
      storageMode: null,
      syncWriteStatus: 'pending',
      legacyImported: true,
    });
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toEqual(journal);
    expect(sync.area.set).not.toHaveBeenCalled();
    expect(sync.area.remove).not.toHaveBeenCalled();
  });

  it('materializes effective legacy aggregate sets and removals across local selection and restart', async (): Promise<void> => {
    const setKey: string = syncAggKey('legacy-device', '2026-08-30');
    const removeKey: string = syncAggKey('legacy-device', '2026-08-29');
    const storedSet: DailyAgg = { ...emptyDaily('2026-08-30'), focusMs: 1_000 };
    const pendingSet: DailyAgg = highCardinalityDaily('2026-08-30', 30);
    const removed: DailyAgg = { ...emptyDaily('2026-08-29'), focusMs: 5_000 };
    const storedSync: Record<string, unknown> = {
      [setKey]: storedSet,
      [removeKey]: removed,
    };
    const journal: SyncJournal = {
      sets: { [setKey]: pendingSet },
      removes: [removeKey],
    };
    const local: FakeStorage = fakeStorage();
    const sync: FakeStorage = fakeStorage(storedSync);
    const first: PolicyStorage = policyStorage(local, sync);

    await first.importLegacy(SNAPSHOT, emptyRuntime(Date.now()), journal, storedSync);

    const recoveredSet = local.state.values[setKey] as ReturnType<typeof emptyDaily>;
    expect(Object.keys(recoveredSet.attempts)).toHaveLength(TOP_SITES_DAILY);
    expect(recoveredSet.attemptsOther).toBe(55);
    expect(local.state.values[removeKey]).toBeUndefined();
    expect(local.state.values[LOCAL_AGGREGATE_TOMBSTONES]).toEqual([removeKey]);

    const restarted: PolicyStorage = createPolicyStorage(
      local.area,
      sync.area,
      {
        loadAggregateItems: async (): Promise<Record<string, unknown>> => ({
          [setKey]: structuredClone(local.state.values[setKey]),
        }),
      },
      DIRECT_ALL_DATA_CLEAR_BARRIER,
    );
    await restarted.initialize();
    await restarted.selectLocalMode();

    expect(local.state.values[setKey]).toEqual(recoveredSet);
    expect(local.state.values[removeKey]).toBeUndefined();
    expect(local.state.values[LOCAL_AGGREGATE_TOMBSTONES]).toEqual([removeKey]);

    await restarted.enableSync();

    expect(sync.state.values[setKey]).toEqual(recoveredSet);
    expect(sync.state.values[removeKey]).toBeUndefined();
  });

  it('limits setup updates to onboarding-owned fields', async (): Promise<void> => {
    const local: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, fakeStorage());
    await storage.initialize();

    await storage.updateSetup({
      websiteAccess: 'granted',
      blockingRegistration: 'ready',
      websiteAccessNotice: 'revoked-during-session',
    });
    await expect(
      Reflect.apply(storage.updateSetup, storage, [{ storageMode: 'sync' }]),
    ).rejects.toThrow('invalid setup update');
    await expect(
      Reflect.apply(storage.updateSetup, storage, [{ websiteAccess: 'invalid' }]),
    ).rejects.toThrow('invalid setup update');

    expect(await storage.loadSetup()).toEqual({
      ...DEFAULT_SETUP,
      websiteAccess: 'granted',
      blockingRegistration: 'ready',
      websiteAccessNotice: 'revoked-during-session',
    });

    local.state.suppressNextSet = true;
    await expect(storage.updateSetup({ websiteAccess: 'denied' })).rejects.toThrow(
      'could not verify local setup state',
    );
    expect((await storage.loadSetup()).websiteAccess).toBe('granted');
  });

  it('verifies storage writes when Chrome reorders nested object keys', async (): Promise<void> => {
    const local: FakeStorage = fakeStorage();
    local.state.alphabetizeValuesOnGet = true;
    const storage: PolicyStorage = policyStorage(local, fakeStorage());
    await storage.initialize();

    await storage.updateSetup({
      websiteAccess: 'granted',
      blockingRegistration: 'ready',
      websiteAccessNotice: null,
    });

    expect(await storage.loadSetup()).toEqual({
      ...DEFAULT_SETUP,
      websiteAccess: 'granted',
      blockingRegistration: 'ready',
    });
  });

  it('marks setup complete only after a storage mode is durable', async (): Promise<void> => {
    const local: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, fakeStorage());
    await storage.initialize();

    await expect(storage.markSetupCompleted()).rejects.toThrow(
      'cannot complete setup before storage is ready',
    );
    await storage.selectLocalMode();
    await storage.markSetupCompleted();

    expect(await storage.loadSetup()).toMatchObject({ storageMode: 'local', completed: true });
  });

  it('does not complete setup while data clearing is pending', async (): Promise<void> => {
    const setup: SetupState = {
      ...DEFAULT_SETUP,
      storageMode: 'local',
      dataClear: { status: 'pending', scope: 'all', phase: 'remote' },
    };
    const storage: PolicyStorage = policyStorage(
      fakeStorage({ [LOCAL_SETUP]: setup }),
      fakeStorage(),
    );

    await expect(storage.markSetupCompleted()).rejects.toThrow(
      'cannot complete setup before storage is ready',
    );
  });

  it('abandons a failed first-publish outbox when local mode is selected again', async (): Promise<void> => {
    const setup: SetupState = {
      ...DEFAULT_SETUP,
      storageMode: 'local',
      syncWriteStatus: 'error',
      storageError: 'sync-publish-failed',
    };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_SYNC_JOURNAL]: {
        sets: { [SYNC_SETTINGS]: SNAPSHOT.settings },
        removes: [SYNC_BANK],
      },
    });
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();

    await storage.selectLocalMode();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(await storage.loadSetup()).toMatchObject({
      storageMode: 'local',
      syncWriteStatus: 'idle',
      storageError: null,
    });
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toEqual({ sets: {}, removes: [] });
    expect(sync.area.set).not.toHaveBeenCalled();
    expect(sync.area.remove).not.toHaveBeenCalled();
  });

  it('does not treat local mode as selected while a publication journal remains', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, storageMode: 'local' };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_SYNC_JOURNAL]: {
        sets: { [SYNC_BANK]: SNAPSHOT.bank },
        removes: [],
      },
    });
    const storage: PolicyStorage = policyStorage(local, fakeStorage());
    await storage.initialize();

    await storage.selectLocalMode();

    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toEqual({ sets: {}, removes: [] });
  });

  it('clears a failed first-publish status before a publisher exists', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, storageMode: 'local' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = createPolicyStorage(
      local.area,
      sync.area,
      {
        loadAggregateItems: (): Promise<Record<string, unknown>> =>
          Promise.reject(new Error('local aggregate checkpoint is unavailable')),
      },
      DIRECT_ALL_DATA_CLEAR_BARRIER,
    );
    await storage.initialize();

    await expect(storage.enableSync()).rejects.toThrow('local aggregate checkpoint is unavailable');
    await storage.selectLocalMode();

    expect(await storage.loadSetup()).toMatchObject({
      storageMode: 'local',
      syncWriteStatus: 'idle',
      storageError: null,
    });
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toEqual({
      sets: {},
      removes: [],
    });
    expect(sync.area.set).not.toHaveBeenCalled();
  });

  it('writes explicit local keys without applying Sync quotas in local mode', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const local: FakeStorage = fakeStorage({ [LOCAL_SETUP]: setup });
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);
    const largeSettings = {
      ...DEFAULT_SETTINGS,
      schedule: [
        {
          id: 'large',
          days: [1],
          start: '09:00',
          end: '10:00',
          mode: 'blacklist' as const,
          strictness: 'friction' as const,
          cycling: null,
          intention: 'x'.repeat(10_000),
          enabled: true,
        },
      ],
    };

    await storage.initialize();
    await storage.setPolicy('settings', largeSettings);
    await storage.setPolicy('lists', DEFAULT_LISTS);

    expect(local.state.values[LOCAL_SETTINGS]).toEqual(largeSettings);
    expect(local.state.values[LOCAL_LISTS]).toEqual(DEFAULT_LISTS);
    expect(sync.area.getBytesInUse).not.toHaveBeenCalled();
    expect(sync.area.set).not.toHaveBeenCalled();
  });

  it('runtime-validates correlated keys and values', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const local: FakeStorage = fakeStorage({ [LOCAL_SETUP]: setup });
    const storage: PolicyStorage = policyStorage(local, fakeStorage());
    await storage.initialize();
    const unsafeSetPolicy = storage.setPolicy as (key: unknown, value: unknown) => Promise<void>;

    await expect(unsafeSetPolicy('bank', DEFAULT_SETTINGS)).rejects.toThrow('invalid bank policy');
    await expect(unsafeSetPolicy('unknown', DEFAULT_SETTINGS)).rejects.toThrow(
      'invalid policy key',
    );
    expect(local.state.values[LOCAL_BANK]).toBeUndefined();
  });

  it('rolls back a local value when write verification fails', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const prior = { ...DEFAULT_SETTINGS, retentionDays: 30 };
    const local: FakeStorage = fakeStorage({ [LOCAL_SETUP]: setup, [LOCAL_SETTINGS]: prior });
    const storage: PolicyStorage = policyStorage(local, fakeStorage());
    await storage.initialize();
    local.state.suppressNextSet = true;

    await expect(storage.setPolicy('settings', DEFAULT_SETTINGS)).rejects.toThrow(
      'could not verify local settings policy',
    );
    expect(local.state.values[LOCAL_SETTINGS]).toEqual(prior);
  });

  it('does not treat reordered storage arrays as an equivalent write', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const prior: Settings = { ...DEFAULT_SETTINGS, retentionDays: 30 };
    const local: FakeStorage = fakeStorage({ [LOCAL_SETUP]: setup, [LOCAL_SETTINGS]: prior });
    const storage: PolicyStorage = policyStorage(local, fakeStorage());
    await storage.initialize();
    const get = vi.mocked(local.area.get);
    get.mockImplementationOnce(
      async (
        keys?: string | string[] | Record<string, unknown> | null,
      ): Promise<Record<string, unknown>> => selectedValues(local.state.values, keys),
    );
    get.mockImplementationOnce(
      async (
        keys?: string | string[] | Record<string, unknown> | null,
      ): Promise<Record<string, unknown>> => {
        const selected: Record<string, unknown> = selectedValues(local.state.values, keys);
        const settings: Settings = selected[LOCAL_SETTINGS] as Settings;
        return {
          ...selected,
          [LOCAL_SETTINGS]: {
            ...settings,
            presetsMin: [settings.presetsMin[2], settings.presetsMin[1], settings.presetsMin[0]],
          },
        };
      },
    );

    await expect(storage.setPolicy('settings', DEFAULT_SETTINGS)).rejects.toThrow(
      'could not verify local settings policy',
    );
    expect(local.state.values[LOCAL_SETTINGS]).toEqual(prior);
  });

  it('serializes reverse-completion policy writes in invocation order', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const local: FakeStorage = fakeStorage({ [LOCAL_SETUP]: setup });
    const storage: PolicyStorage = policyStorage(local, fakeStorage());
    await storage.initialize();
    const first = { ...DEFAULT_SETTINGS, retentionDays: 30 };
    const second = { ...DEFAULT_SETTINGS, retentionDays: 14 };
    let releaseFirst: () => void = (): void => undefined;
    const blocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseFirst = resolve;
    });
    const set = vi.mocked(local.area.set);
    set.mockImplementationOnce(async (items: Record<string, unknown>): Promise<void> => {
      await blocked;
      Object.assign(local.state.values, structuredClone(items));
    });

    const firstSave: Promise<void> = storage.setPolicy('settings', first);
    const secondSave: Promise<void> = storage.setPolicy('settings', second);
    await Promise.resolve();
    expect(local.state.values[LOCAL_SETTINGS]).toBeUndefined();
    releaseFirst();
    await Promise.all([firstSave, secondSave]);

    expect(local.state.values[LOCAL_SETTINGS]).toEqual(second);
  });

  it('serializes a policy write before a concurrent local-mode transition', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'sync' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();
    const next: BankState = { balanceMs: 84_000 };

    const saved: Promise<void> = storage.setPolicy('bank', next);
    const selected: Promise<void> = storage.selectLocalMode();
    await Promise.all([saved, selected]);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(local.state.values[LOCAL_BANK]).toEqual(next);
    expect(await storage.storageMode()).toBe('local');
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toEqual({ sets: {}, removes: [] });
    expect(sync.area.set).not.toHaveBeenCalled();
  });

  it('queues a correction from current authority after a concurrent policy save', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'sync' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();
    const next: BankState = { balanceMs: 96_000 };

    const saved: Promise<void> = storage.setPolicy('bank', next);
    const corrected: Promise<void> = storage.queueVerifiedRemoteCorrections(['bank']);
    await Promise.all([saved, corrected]);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(local.state.values[LOCAL_BANK]).toEqual(next);
    expect(sync.state.values[SYNC_BANK]).toEqual(next);
  });

  it('reconstructs a failed corrective journal checkpoint on restart', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'sync' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();
    let failCorrectionJournal: boolean = true;
    vi.mocked(local.area.set).mockImplementation(
      async (items: Record<string, unknown>): Promise<void> => {
        if (failCorrectionJournal && Object.hasOwn(items, LOCAL_SYNC_JOURNAL)) {
          throw new Error('correction journal unavailable');
        }
        Object.assign(local.state.values, structuredClone(items));
      },
    );

    await expect(storage.queueVerifiedRemoteCorrections(['bank'])).rejects.toThrow(
      'correction journal unavailable',
    );
    expect(await storage.loadSetup()).toMatchObject({
      storageMode: 'sync',
      syncWriteStatus: 'error',
      storageError: 'sync-publish-failed',
    });

    failCorrectionJournal = false;
    const restarted: PolicyStorage = policyStorage(local, sync);
    await restarted.initialize();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sync.state.values[SYNC_BANK]).toEqual(SNAPSHOT.bank);
    expect((await restarted.loadSetup()).syncWriteStatus).toBe('idle');
  });

  it('applies a policy write after a concurrent local-mode transition', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'sync' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();
    const next: BankState = { balanceMs: 97_000 };

    const selected: Promise<void> = storage.selectLocalMode();
    const saved: Promise<void> = storage.setPolicy('bank', next);
    await Promise.all([selected, saved]);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await storage.storageMode()).toBe('local');
    expect(local.state.values[LOCAL_BANK]).toEqual(next);
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toEqual({ sets: {}, removes: [] });
    expect(sync.area.set).not.toHaveBeenCalled();
  });

  it('preserves direct authority when the generation pointer write fails', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, storageMode: 'local' };
    const prior: Settings = { ...DEFAULT_SETTINGS, retentionDays: 30 };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_SETTINGS]: prior,
    });
    const storage: PolicyStorage = policyStorage(local, fakeStorage());
    vi.mocked(local.area.set).mockImplementation(
      async (items: Record<string, unknown>): Promise<void> => {
        if (Object.hasOwn(items, LOCAL_POLICY_COMMIT)) throw new Error('pointer unavailable');
        Object.assign(local.state.values, structuredClone(items));
      },
    );

    await expect(
      storage.importLegacy(SNAPSHOT, emptyRuntime(Date.now()), { sets: {}, removes: [] }),
    ).rejects.toThrow('pointer unavailable');

    expect(local.state.values[LOCAL_SETTINGS]).toEqual(prior);
    expect(local.state.values[LOCAL_POLICY_COMMIT]).toBeUndefined();
    expect((await setupState(local)).legacyImported).toBe(false);
    expect((await setupState(local)).storageError).toBe('legacy-migration-failed');
  });

  it('preserves direct authority when generation staging cannot be verified', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, storageMode: 'local' };
    const prior: Settings = { ...DEFAULT_SETTINGS, retentionDays: 30 };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_SETTINGS]: prior,
    });
    const storage: PolicyStorage = policyStorage(local, fakeStorage());
    await storage.initialize();
    local.state.suppressNextSet = true;

    await expect(
      storage.importLegacy(SNAPSHOT, emptyRuntime(Date.now()), { sets: {}, removes: [] }),
    ).rejects.toThrow('could not verify local legacy policy generation');

    expect(local.state.values[LOCAL_SETTINGS]).toEqual(prior);
    expect(local.state.values[LOCAL_POLICY_COMMIT]).toBeUndefined();
    expect((await setupState(local)).legacyImported).toBe(false);
    expect((await setupState(local)).storageError).toBe('legacy-migration-failed');
  });

  it('retries named-generation cleanup after a migration crash', async (): Promise<void> => {
    const local: FakeStorage = fakeStorage();
    const sync: FakeStorage = fakeStorage();
    const first: PolicyStorage = policyStorage(local, sync);
    let failMaterialization: boolean = true;
    vi.mocked(local.area.set).mockImplementation(
      async (items: Record<string, unknown>): Promise<void> => {
        if (failMaterialization && Object.hasOwn(items, LOCAL_SETTINGS)) {
          throw new Error('materialization interrupted');
        }
        Object.assign(local.state.values, structuredClone(items));
      },
    );

    await expect(
      first.importLegacy(SNAPSHOT, emptyRuntime(Date.now()), { sets: {}, removes: [] }),
    ).rejects.toThrow('materialization interrupted');
    expect(local.state.values[LOCAL_POLICY_COMMIT]).toMatchObject({ source: 'generation' });

    failMaterialization = false;
    const restarted: PolicyStorage = policyStorage(local, sync);
    await restarted.initialize();

    expect(local.state.values[LOCAL_POLICY_COMMIT]).toMatchObject({ source: 'direct' });
    expect(
      Object.keys(local.state.values).some((key: string): boolean =>
        key.startsWith(LOCAL_POLICY_GENERATION_PREFIX),
      ),
    ).toBe(false);
    expect(await restarted.loadSnapshot()).toEqual(SNAPSHOT);
  });

  it('recovers effective legacy aggregate authority from a committed migration generation', async (): Promise<void> => {
    const setKey: string = syncAggKey('legacy-device', '2026-08-30');
    const removeKey: string = syncAggKey('legacy-device', '2026-08-29');
    const pendingSet: DailyAgg = { ...emptyDaily('2026-08-30'), focusMs: 9_000 };
    const removed: DailyAgg = { ...emptyDaily('2026-08-29'), focusMs: 5_000 };
    const local: FakeStorage = fakeStorage({ [removeKey]: removed });
    const first: PolicyStorage = policyStorage(local, fakeStorage());
    let interruptMaterialization: boolean = true;
    vi.mocked(local.area.set).mockImplementation(
      async (items: Record<string, unknown>): Promise<void> => {
        if (interruptMaterialization && Object.hasOwn(items, LOCAL_SETTINGS)) {
          interruptMaterialization = false;
          throw new Error('aggregate materialization interrupted');
        }
        Object.assign(local.state.values, structuredClone(items));
      },
    );

    await expect(
      first.importLegacy(
        SNAPSHOT,
        emptyRuntime(Date.now()),
        { sets: { [setKey]: pendingSet }, removes: [removeKey] },
        { [removeKey]: removed },
      ),
    ).rejects.toThrow('aggregate materialization interrupted');

    expect(local.state.values[LOCAL_POLICY_COMMIT]).toMatchObject({ source: 'generation' });
    expect(local.state.values[setKey]).toBeUndefined();

    const restarted: PolicyStorage = policyStorage(local, fakeStorage());
    await restarted.initialize();

    expect(local.state.values[setKey]).toEqual(pendingSet);
    expect(local.state.values[removeKey]).toBeUndefined();
    expect(local.state.values[LOCAL_AGGREGATE_TOMBSTONES]).toEqual([removeKey]);
    expect(local.state.values[LOCAL_POLICY_COMMIT]).toMatchObject({ source: 'direct' });
  });

  it('rejects an invalid authoritative legacy snapshot without changing either authority', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, storageMode: 'local' };
    const prior: Settings = { ...DEFAULT_SETTINGS, retentionDays: 30 };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_SETTINGS]: prior,
    });
    const remoteSettings: Settings = { ...DEFAULT_SETTINGS, retentionDays: 14 };
    const sync: FakeStorage = fakeStorage({ [SYNC_SETTINGS]: remoteSettings });
    const storage: PolicyStorage = policyStorage(local, sync);
    const invalidSnapshot: Record<string, unknown> = { ...SNAPSHOT, settings: null };

    await expect(
      Reflect.apply(storage.importLegacy, storage, [
        invalidSnapshot,
        emptyRuntime(Date.now()),
        { sets: {}, removes: [] },
      ]),
    ).rejects.toThrow('invalid settings policy');

    expect(local.state.values[LOCAL_SETTINGS]).toEqual(prior);
    expect(sync.state.values[SYNC_SETTINGS]).toEqual(remoteSettings);
    expect((await setupState(local)).legacyImported).toBe(false);
    expect((await setupState(local)).storageError).toBe('legacy-migration-failed');
    expect(local.state.values[LOCAL_POLICY_COMMIT]).toBeUndefined();
  });

  it('repairs setup from the committed generation without rereading remote data', async (): Promise<void> => {
    const local: FakeStorage = fakeStorage();
    const sync: FakeStorage = fakeStorage();
    const first: PolicyStorage = policyStorage(local, sync);
    let interruptSetupRepair: boolean = true;
    vi.mocked(local.area.set).mockImplementation(
      async (items: Record<string, unknown>): Promise<void> => {
        if (
          interruptSetupRepair &&
          Object.hasOwn(items, LOCAL_SETUP) &&
          Object.hasOwn(items, LOCAL_SYNC_JOURNAL)
        ) {
          interruptSetupRepair = false;
          throw new Error('setup repair interrupted');
        }
        Object.assign(local.state.values, structuredClone(items));
      },
    );

    await expect(
      first.importLegacy(SNAPSHOT, emptyRuntime(Date.now()), {
        sets: { [SYNC_BANK]: SNAPSHOT.bank },
        removes: [],
      }),
    ).rejects.toThrow('setup repair interrupted');
    expect(local.state.values[LOCAL_POLICY_COMMIT]).toMatchObject({ source: 'generation' });

    sync.state.failGet = new Error('remote storage is offline');
    const restarted: PolicyStorage = policyStorage(local, sync);
    await restarted.initialize();

    expect((await setupState(local)).legacyImported).toBe(true);
    expect((await setupState(local)).storageMode).toBeNull();
    expect(await restarted.loadSnapshot()).toEqual(SNAPSHOT);
    expect(sync.area.get).not.toHaveBeenCalled();
  });

  it('retries stale generation removal after the direct pointer switch', async (): Promise<void> => {
    const local: FakeStorage = fakeStorage();
    const first: PolicyStorage = policyStorage(local, fakeStorage());
    let failGenerationRemoval: boolean = true;
    vi.mocked(local.area.remove).mockImplementation(
      async (keys: string | string[]): Promise<void> => {
        const requested: string[] = typeof keys === 'string' ? [keys] : keys;
        if (
          failGenerationRemoval &&
          requested.some((key: string): boolean => key.startsWith(LOCAL_POLICY_GENERATION_PREFIX))
        ) {
          throw new Error('generation cleanup interrupted');
        }
        for (const key of requested) delete local.state.values[key];
      },
    );

    await expect(
      first.importLegacy(SNAPSHOT, emptyRuntime(Date.now()), { sets: {}, removes: [] }),
    ).rejects.toThrow('generation cleanup interrupted');
    expect(local.state.values[LOCAL_POLICY_COMMIT]).toMatchObject({ source: 'direct' });
    expect(
      Object.keys(local.state.values).some((key: string): boolean =>
        key.startsWith(LOCAL_POLICY_GENERATION_PREFIX),
      ),
    ).toBe(true);

    failGenerationRemoval = false;
    const restarted: PolicyStorage = policyStorage(local, fakeStorage());
    await restarted.initialize();

    expect(
      Object.keys(local.state.values).some((key: string): boolean =>
        key.startsWith(LOCAL_POLICY_GENERATION_PREFIX),
      ),
    ).toBe(false);
  });

  it('publishes verified local authority before switching to sync mode', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();

    await storage.enableSync();

    expect(sync.state.values).toMatchObject({
      [SYNC_SETTINGS]: SNAPSHOT.settings,
      [SYNC_LISTS]: SNAPSHOT.lists,
      [SYNC_BANK]: SNAPSHOT.bank,
      [SYNC_STREAK]: SNAPSHOT.streak,
    });
    expect((await setupState(local)).storageMode).toBe('sync');
    expect((await setupState(local)).syncWriteStatus).toBe('idle');
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toEqual({ sets: {}, removes: [] });
  });

  it('persists an aggregate locally without touching Sync in local mode', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);
    const key: string = syncAggKey('device-a', '2026-08-31');
    const aggregate = { ...emptyDaily('2026-08-31'), focusMs: 42_000 };

    await storage.saveAggregate(key, aggregate);

    expect(local.state.values[key]).toEqual(aggregate);
    expect(sync.area.get).not.toHaveBeenCalled();
    expect(sync.area.set).not.toHaveBeenCalled();
    expect((await setupState(local)).syncWriteStatus).toBe('idle');
  });

  it('caps daily aggregates before local persistence', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const date: string = '2026-08-31';
    const key: string = syncAggKey('device-a', date);
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const storage: PolicyStorage = policyStorage(local, fakeStorage());

    await storage.saveAggregate(key, highCardinalityDaily(date, 30));

    const stored = local.state.values[key] as ReturnType<typeof emptyDaily>;
    expect(Object.keys(stored.attempts)).toHaveLength(TOP_SITES_DAILY);
    expect(stored.attemptsOther).toBe(55);
  });

  it('normalizes oversized daily authority before first Sync checkpoint persistence', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const date: string = '2026-08-31';
    const key: string = syncAggKey('device-a', date);
    const oversized: DailyAgg = highCardinalityDaily(date, 600);
    const local: FakeStorage = fakeStorage({ ...localPolicy(setup), [key]: oversized });
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = createPolicyStorage(
      local.area,
      sync.area,
      { loadAggregateItems: async (): Promise<Record<string, unknown>> => ({ [key]: oversized }) },
      DIRECT_ALL_DATA_CLEAR_BARRIER,
    );

    await storage.enableSync();

    const localAggregate = local.state.values[key] as ReturnType<typeof emptyDaily>;
    const remoteAggregate = sync.state.values[key] as ReturnType<typeof emptyDaily>;
    expect(Object.keys(localAggregate.attempts)).toHaveLength(TOP_SITES_DAILY);
    expect(Object.keys(remoteAggregate.attempts)).toHaveLength(TOP_SITES_DAILY);
    expect(remoteAggregate.attemptsOther).toBe(168_490);
  });

  it('keeps an unsyncable aggregate locally with explicit retry state across restart', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'sync' };
    const date: string = '2026-08-31';
    const key: string = syncAggKey('device-a', date);
    const unsyncableDaily: DailyAgg = highCardinalityDaily(date, 30);
    delete unsyncableDaily.attempts['site-0000.example'];
    unsyncableDaily.attempts[`${'x'.repeat(20_000)}.example`] = 30;
    const normalized: DailyAgg = capAttempts(unsyncableDaily, TOP_SITES_DAILY);
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    const checkpoint: FirstSyncCheckpointSource = {
      loadAggregateItems: async (): Promise<Record<string, unknown>> =>
        Object.hasOwn(local.state.values, key) ? { [key]: local.state.values[key] } : {},
    };
    const storage: PolicyStorage = createPolicyStorage(
      local.area,
      sync.area,
      checkpoint,
      DIRECT_ALL_DATA_CLEAR_BARRIER,
    );
    await storage.initialize();

    await expect(storage.saveAggregate(key, unsyncableDaily)).resolves.toBeUndefined();

    expect(local.state.values[key]).toEqual(normalized);
    expect(await storage.loadSetup()).toMatchObject({
      storageMode: 'sync',
      syncWriteStatus: 'error',
      storageError: 'sync-publish-failed',
    });
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toEqual({ sets: {}, removes: [] });
    expect(local.state.values[BLOCKED_AGGREGATE_PUBLICATIONS_KEY]).toEqual({
      version: 1,
      items: { [key]: normalized },
    });

    const restarted: PolicyStorage = createPolicyStorage(
      local.area,
      sync.area,
      checkpoint,
      DIRECT_ALL_DATA_CLEAR_BARRIER,
    );
    await expect(restarted.initialize()).resolves.toBeUndefined();

    expect(local.state.values[key]).toEqual(normalized);
    expect(await restarted.loadSetup()).toMatchObject({
      storageMode: 'sync',
      syncWriteStatus: 'error',
      storageError: 'sync-publish-failed',
    });
    expect(local.state.values[BLOCKED_AGGREGATE_PUBLICATIONS_KEY]).toEqual({
      version: 1,
      items: { [key]: normalized },
    });
    expect(sync.area.set).not.toHaveBeenCalled();
  });

  it('keeps Sync error after an ordinary journal flush while a blocked aggregate remains', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'sync' };
    const normalKey: string = syncAggKey('device-a', '2026-08-30');
    const blockedKey: string = syncAggKey('device-a', '2026-08-31');
    const normal: DailyAgg = { ...emptyDaily('2026-08-30'), focusMs: 1_000 };
    const blocked: DailyAgg = {
      ...emptyDaily('2026-08-31'),
      attempts: { [`${'x'.repeat(20_000)}.example`]: 1 },
    };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();

    await storage.saveAggregate(normalKey, normal);
    await storage.saveAggregate(blockedKey, blocked);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sync.state.values[normalKey]).toEqual(normal);
    expect(sync.state.values[blockedKey]).toBeUndefined();
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toEqual({ sets: {}, removes: [] });
    expect(await storage.loadSetup()).toMatchObject({
      syncWriteStatus: 'error',
      storageError: 'sync-publish-failed',
    });
    expect(local.state.values[BLOCKED_AGGREGATE_PUBLICATIONS_KEY]).toEqual({
      version: 1,
      items: { [blockedKey]: blocked },
    });
  });

  it('cancels a pending aggregate set superseded by an unsyncable local value', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'sync' };
    const key: string = syncAggKey('device-a', '2026-08-31');
    const pending: DailyAgg = { ...emptyDaily('2026-08-31'), focusMs: 42_000 };
    const blocked: DailyAgg = {
      ...emptyDaily('2026-08-31'),
      attempts: { [`${'x'.repeat(20_000)}.example`]: 1 },
    };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);

    await storage.saveAggregate(key, pending);
    await storage.saveAggregate(key, blocked);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(local.state.values[key]).toEqual(blocked);
    expect(sync.state.values[key]).toBeUndefined();
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toEqual({ sets: {}, removes: [] });
    expect(local.state.values[LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]).toEqual({
      version: 1,
      items: { [key]: blocked },
    });
  });

  it('cancels a pending aggregate removal superseded by an unsyncable local value', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'sync' };
    const key: string = syncAggKey('device-a', '2026-08-31');
    const remote: DailyAgg = { ...emptyDaily('2026-08-31'), focusMs: 42_000 };
    const blocked: DailyAgg = {
      ...emptyDaily('2026-08-31'),
      attempts: { [`${'x'.repeat(20_000)}.example`]: 1 },
    };
    const local: FakeStorage = fakeStorage({ ...localPolicy(setup), [key]: remote });
    const sync: FakeStorage = fakeStorage({ [key]: remote });
    const storage: PolicyStorage = policyStorage(local, sync);

    await storage.removeAggregate(key);
    await storage.saveAggregate(key, blocked);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(local.state.values[key]).toEqual(blocked);
    expect(sync.state.values[key]).toEqual(remote);
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toEqual({ sets: {}, removes: [] });
    expect(local.state.values[LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]).toEqual({
      version: 1,
      items: { [key]: blocked },
    });
  });

  it('clears a blocked aggregate after a syncable superseding save', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'sync' };
    const key: string = syncAggKey('device-a', '2026-08-31');
    const blocked: DailyAgg = {
      ...emptyDaily('2026-08-31'),
      attempts: { [`${'x'.repeat(20_000)}.example`]: 1 },
    };
    const replacement: DailyAgg = { ...emptyDaily('2026-08-31'), focusMs: 42_000 };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);

    await storage.saveAggregate(key, blocked);
    await storage.saveAggregate(key, replacement);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(local.state.values[key]).toEqual(replacement);
    expect(sync.state.values[key]).toEqual(replacement);
    expect(local.state.values[BLOCKED_AGGREGATE_PUBLICATIONS_KEY]).toEqual({
      version: 1,
      items: {},
    });
    expect(await storage.loadSetup()).toMatchObject({
      syncWriteStatus: 'idle',
      storageError: null,
    });
  });

  it('retries a blocked aggregate that now fits Sync quota after restart', async (): Promise<void> => {
    const setup: SetupState = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'sync',
      syncWriteStatus: 'error',
      storageError: 'sync-publish-failed',
    };
    const key: string = syncAggKey('device-a', '2026-08-31');
    const aggregate: DailyAgg = { ...emptyDaily('2026-08-31'), focusMs: 42_000 };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [key]: aggregate,
      [LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]: {
        version: 1,
        items: { [key]: aggregate },
      },
    });
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = createPolicyStorage(
      local.area,
      sync.area,
      { loadAggregateItems: async (): Promise<Record<string, unknown>> => ({ [key]: aggregate }) },
      DIRECT_ALL_DATA_CLEAR_BARRIER,
    );

    await storage.initialize();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sync.state.values[key]).toEqual(aggregate);
    expect(local.state.values[LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]).toEqual({
      version: 1,
      items: {},
    });
    expect(await storage.loadSetup()).toMatchObject({
      syncWriteStatus: 'idle',
      storageError: null,
    });
  });

  it('does not replay a stale pending removal for a blocked aggregate after restart', async (): Promise<void> => {
    const setup: SetupState = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'sync',
      syncWriteStatus: 'error',
      storageError: 'sync-publish-failed',
    };
    const key: string = syncAggKey('device-a', '2026-08-31');
    const remote: DailyAgg = { ...emptyDaily('2026-08-31'), focusMs: 42_000 };
    const blocked: DailyAgg = {
      ...emptyDaily('2026-08-31'),
      attempts: { [`${'x'.repeat(20_000)}.example`]: 1 },
    };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [key]: blocked,
      [LOCAL_SYNC_JOURNAL]: { sets: {}, removes: [key] },
      [LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]: {
        version: 1,
        items: { [key]: blocked },
      },
    });
    const sync: FakeStorage = fakeStorage({ [key]: remote });
    const storage: PolicyStorage = createPolicyStorage(
      local.area,
      sync.area,
      { loadAggregateItems: async (): Promise<Record<string, unknown>> => ({ [key]: blocked }) },
      DIRECT_ALL_DATA_CLEAR_BARRIER,
    );

    await storage.initialize();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sync.state.values[key]).toEqual(remote);
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toEqual({ sets: {}, removes: [] });
    expect(local.state.values[LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]).toEqual({
      version: 1,
      items: { [key]: blocked },
    });
    expect(await storage.loadSetup()).toMatchObject({
      syncWriteStatus: 'error',
      storageError: 'sync-publish-failed',
    });
  });

  it('clears a blocked aggregate after a superseding removal', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'sync' };
    const key: string = syncAggKey('device-a', '2026-08-31');
    const blocked: DailyAgg = {
      ...emptyDaily('2026-08-31'),
      attempts: { [`${'x'.repeat(20_000)}.example`]: 1 },
    };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage({ [key]: emptyDaily('2026-08-31') });
    const storage: PolicyStorage = policyStorage(local, sync);

    await storage.saveAggregate(key, blocked);
    await storage.removeAggregate(key);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(local.state.values[key]).toBeUndefined();
    expect(sync.state.values[key]).toBeUndefined();
    expect(local.state.values[BLOCKED_AGGREGATE_PUBLICATIONS_KEY]).toEqual({
      version: 1,
      items: {},
    });
    expect(await storage.loadSetup()).toMatchObject({
      syncWriteStatus: 'idle',
      storageError: null,
    });
  });

  it.each(['disableSync', 'selectLocalMode'] as const)(
    'abandons blocked aggregate publications through %s',
    async (action: 'disableSync' | 'selectLocalMode'): Promise<void> => {
      const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'sync' };
      const key: string = syncAggKey('device-a', '2026-08-31');
      const blocked: DailyAgg = {
        ...emptyDaily('2026-08-31'),
        attempts: { [`${'x'.repeat(20_000)}.example`]: 1 },
      };
      const local: FakeStorage = fakeStorage(localPolicy(setup));
      const sync: FakeStorage = fakeStorage();
      const storage: PolicyStorage = policyStorage(local, sync);

      await storage.saveAggregate(key, blocked);
      await storage[action]();

      expect(local.state.values[key]).toEqual(blocked);
      expect(local.state.values[BLOCKED_AGGREGATE_PUBLICATIONS_KEY]).toEqual({
        version: 1,
        items: {},
      });
      expect(await storage.loadSetup()).toMatchObject({
        storageMode: 'local',
        syncWriteStatus: 'idle',
        storageError: null,
      });
    },
  );

  it('abandons a blocked aggregate registry when local mode is selected again', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const key: string = syncAggKey('device-a', '2026-08-31');
    const blocked: DailyAgg = {
      ...emptyDaily('2026-08-31'),
      attempts: { [`${'x'.repeat(20_000)}.example`]: 1 },
    };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [key]: blocked,
      [LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]: {
        version: 1,
        items: { [key]: blocked },
      },
    });
    const storage: PolicyStorage = policyStorage(local, fakeStorage());

    await storage.selectLocalMode();

    expect(local.state.values[key]).toEqual(blocked);
    expect(local.state.values[LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]).toEqual({
      version: 1,
      items: {},
    });
    expect(await storage.loadSetup()).toMatchObject({
      storageMode: 'local',
      syncWriteStatus: 'idle',
      storageError: null,
    });
  });

  it('rejects a malformed blocked aggregate publication registry', async (): Promise<void> => {
    const setup: SetupState = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'sync',
      syncWriteStatus: 'error',
      storageError: 'sync-publish-failed',
    };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [BLOCKED_AGGREGATE_PUBLICATIONS_KEY]: {
        version: 1,
        items: { invalid: emptyDaily('2026-08-31') },
      },
    });
    const storage: PolicyStorage = policyStorage(local, fakeStorage());

    await expect(storage.initialize()).rejects.toThrow(
      'invalid blocked aggregate publication registry',
    );
  });

  it('does not apply Sync item quota to local aggregate storage', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const key: string = 'aggm:device-a:2026-08';
    const oversizedMonthly: MonthlyAgg = {
      ...rollupMonth('2026-08', []),
      attempts: { ['x'.repeat(20_000)]: 1 },
    };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);

    await storage.saveAggregate(key, oversizedMonthly);

    expect(local.state.values[key]).toEqual(oversizedMonthly);
    expect(sync.area.set).not.toHaveBeenCalled();
  });

  it('includes local aggregate history in the first complete Sync checkpoint', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const key: string = syncAggKey('device-a', '2026-08-31');
    const aggregate = { ...emptyDaily('2026-08-31'), focusMs: 42_000 };
    const monthKey: string = 'aggm:device-a:2026-07';
    const monthly = rollupMonth('2026-07', [{ ...emptyDaily('2026-07-31'), focusMs: 21_000 }]);
    const archiveKey: string = 'archive:clock-rebase:device-a:2026-09-01:1:nonce';
    const archive = { ...emptyDaily('2026-09-01'), focusMs: 7_000 };
    const aggregates: Record<string, unknown> = {
      [key]: aggregate,
      [monthKey]: monthly,
      [archiveKey]: archive,
    };
    const local: FakeStorage = fakeStorage({ ...localPolicy(setup), ...aggregates });
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = createPolicyStorage(
      local.area,
      sync.area,
      { loadAggregateItems: async (): Promise<Record<string, unknown>> => aggregates },
      DIRECT_ALL_DATA_CLEAR_BARRIER,
    );

    await storage.enableSync();

    expect(sync.state.values[key]).toEqual(aggregate);
    expect(sync.state.values[monthKey]).toEqual(monthly);
    expect(sync.state.values[archiveKey]).toEqual(archive);
    expect(local.state.values[key]).toEqual(aggregate);
    expect(local.state.values[monthKey]).toEqual(monthly);
    expect(local.state.values[archiveKey]).toEqual(archive);
    expect((await setupState(local)).storageMode).toBe('sync');
  });

  it('reconstructs a missing aggregate journal entry from local authority after restart', async (): Promise<void> => {
    const setup: SetupState = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'sync',
      syncWriteStatus: 'pending',
    };
    const key: string = syncAggKey('device-a', '2026-08-31');
    const aggregate = { ...emptyDaily('2026-08-31'), focusMs: 42_000 };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [key]: aggregate,
      [LOCAL_SYNC_JOURNAL]: { sets: {}, removes: [] },
    });
    const sync: FakeStorage = fakeStorage();
    const restarted: PolicyStorage = createPolicyStorage(
      local.area,
      sync.area,
      { loadAggregateItems: async (): Promise<Record<string, unknown>> => ({ [key]: aggregate }) },
      DIRECT_ALL_DATA_CLEAR_BARRIER,
    );

    await restarted.initialize();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sync.state.values[key]).toEqual(aggregate);
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toEqual({ sets: {}, removes: [] });
    expect((await setupState(local)).syncWriteStatus).toBe('idle');
  });

  it('keeps a failed Sync aggregate publish durable in local storage and the journal', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'sync' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);
    const key: string = syncAggKey('device-a', '2026-08-31');
    const aggregate = { ...emptyDaily('2026-08-31'), focusMs: 42_000 };
    await storage.initialize();
    sync.state.failSet = new Error('sync unavailable');

    await storage.saveAggregate(key, aggregate);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(local.state.values[key]).toEqual(aggregate);
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toMatchObject({
      sets: { [key]: aggregate },
    });
    expect((await setupState(local)).syncWriteStatus).toBe('error');
  });

  it('removes stale aggregates from this device on first Sync without touching another device', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const currentKey: string = syncAggKey('device-a', '2026-08-31');
    const staleKey: string = syncAggKey('device-a', '2026-08-30');
    const otherKey: string = syncAggKey('device-b', '2026-08-30');
    const current = { ...emptyDaily('2026-08-31'), focusMs: 42_000 };
    const stale = { ...emptyDaily('2026-08-30'), focusMs: 21_000 };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_DEVICE_ID]: 'device-a',
      [currentKey]: current,
    });
    const sync: FakeStorage = fakeStorage({ [staleKey]: stale, [otherKey]: stale });
    const storage: PolicyStorage = createPolicyStorage(
      local.area,
      sync.area,
      {
        loadAggregateItems: async (): Promise<Record<string, unknown>> => ({
          [currentKey]: current,
        }),
      },
      DIRECT_ALL_DATA_CLEAR_BARRIER,
    );

    await storage.enableSync();

    expect(sync.state.values[currentKey]).toEqual(current);
    expect(sync.state.values[staleKey]).toBeUndefined();
    expect(sync.state.values[otherKey]).toEqual(stale);
  });

  it('serializes an aggregate save before a concurrently requested Sync enable', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const key: string = syncAggKey('device-a', '2026-08-31');
    const aggregate = { ...emptyDaily('2026-08-31'), focusMs: 42_000 };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_DEVICE_ID]: 'device-a',
    });
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = createPolicyStorage(
      local.area,
      sync.area,
      {
        loadAggregateItems: async (): Promise<Record<string, unknown>> => {
          const stored: Record<string, unknown> = await local.area.get(null);
          return Object.hasOwn(stored, key) ? { [key]: stored[key] } : {};
        },
      },
      DIRECT_ALL_DATA_CLEAR_BARRIER,
    );

    const saving: Promise<void> = storage.saveAggregate(key, aggregate);
    const enabling: Promise<void> = storage.enableSync();
    await Promise.all([saving, enabling]);

    expect(sync.state.values[key]).toEqual(aggregate);
    expect((await setupState(local)).storageMode).toBe('sync');
  });

  it('drains rollover and clock-rebase aggregate intents before the first Sync checkpoint', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const finishedKey: string = syncAggKey('device-a', '2026-08-30');
    const futureKey: string = syncAggKey('device-a', '2026-09-02');
    const archiveKey: string = 'archive:clock-rebase:device-a:2026-09-02:1:nonce';
    const finished = { ...emptyDaily('2026-08-30'), focusMs: 2_000 };
    const future = { ...emptyDaily('2026-09-02'), focusMs: 3_000 };
    const archive = { ...future };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_DEVICE_ID]: 'device-a',
      [futureKey]: future,
    });
    const sync: FakeStorage = fakeStorage({ [futureKey]: future });
    let storage: PolicyStorage;
    storage = createPolicyStorage(
      local.area,
      sync.area,
      {
        runExclusive: async <T>(operation: () => Promise<T>): Promise<T> => {
          await storage.saveAggregate(finishedKey, finished);
          await storage.saveAggregate(archiveKey, archive);
          await storage.removeAggregate(futureKey);
          return operation();
        },
        loadAggregateItems: async (): Promise<Record<string, unknown>> =>
          Object.fromEntries(
            Object.entries(local.state.values).filter(
              ([key]: [string, unknown]): boolean =>
                key.startsWith('agg:device-a:') ||
                key.startsWith('aggm:device-a:') ||
                key.startsWith('archive:clock-rebase:device-a:'),
            ),
          ),
      },
      DIRECT_ALL_DATA_CLEAR_BARRIER,
    );

    await storage.enableSync();

    expect(sync.state.values[finishedKey]).toEqual(finished);
    expect(sync.state.values[archiveKey]).toEqual(archive);
    expect(sync.state.values[futureKey]).toBeUndefined();
    expect((await setupState(local)).storageMode).toBe('sync');
  });

  it('keeps an aggregate save requested after disable local-only', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'sync' };
    const key: string = syncAggKey('device-a', '2026-08-31');
    const aggregate = { ...emptyDaily('2026-08-31'), focusMs: 42_000 };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();

    const disabling: Promise<void> = storage.disableSync();
    const saving: Promise<void> = storage.saveAggregate(key, aggregate);
    await Promise.all([disabling, saving]);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(local.state.values[key]).toEqual(aggregate);
    expect(sync.state.values[key]).toBeUndefined();
    expect((await setupState(local)).storageMode).toBe('local');
  });

  it('does not let an old flush cleanup erase newer save, remove, and prune intents', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'sync' };
    const oldKey: string = syncAggKey('device-a', '2026-08-30');
    const saveKey: string = syncAggKey('device-a', '2026-08-31');
    const removeKey: string = syncAggKey('device-a', '2026-09-01');
    const pruneDate: string = '2026-05-01';
    const pruneKey: string = syncAggKey('device-a', pruneDate);
    const monthKey: string = 'aggm:device-a:2026-05';
    const oldAggregate = { ...emptyDaily('2026-08-30'), focusMs: 1_000 };
    const savedAggregate = { ...emptyDaily('2026-08-31'), focusMs: 2_000 };
    const removedAggregate = { ...emptyDaily('2026-09-01'), focusMs: 3_000 };
    const prunedAggregate = { ...emptyDaily(pruneDate), focusMs: 4_000 };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_DEVICE_ID]: 'device-a',
      [removeKey]: removedAggregate,
      [pruneKey]: prunedAggregate,
    });
    const sync: FakeStorage = fakeStorage({
      [removeKey]: removedAggregate,
      [pruneKey]: prunedAggregate,
    });
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();
    await storage.saveAggregate(oldKey, oldAggregate);

    let signalCleanup: () => void = (): void => {
      throw new Error('cleanup signal was not initialized');
    };
    const cleanupStarted: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalCleanup = resolve;
    });
    let releaseCleanup: () => void = (): void => {
      throw new Error('cleanup release was not initialized');
    };
    let holdCleanup: boolean = true;
    vi.mocked(local.area.set).mockImplementation(
      async (items: Record<string, unknown>): Promise<void> => {
        const journal: unknown = items[LOCAL_SYNC_JOURNAL];
        if (
          holdCleanup &&
          typeof journal === 'object' &&
          journal !== null &&
          'sets' in journal &&
          'removes' in journal &&
          Object.keys((journal as SyncJournal).sets).length === 0 &&
          (journal as SyncJournal).removes.length === 0
        ) {
          holdCleanup = false;
          signalCleanup();
          await new Promise<void>((resolve: () => void): void => {
            releaseCleanup = resolve;
          });
        }
        Object.assign(local.state.values, structuredClone(items));
      },
    );
    const oldFlush: Promise<unknown> = vi.advanceTimersByTimeAsync(10_000);
    await cleanupStarted;

    let newerCompleted: boolean = false;
    const newer: Promise<void> = Promise.all([
      storage.saveAggregate(saveKey, savedAggregate),
      storage.removeAggregate(removeKey),
      storage.pruneRemoteHistory('device-a', 90, new Date(2026, 7, 31, 12, 0).getTime()),
    ]).then((): void => {
      newerCompleted = true;
    });
    await Promise.resolve();
    expect(newerCompleted).toBe(false);

    releaseCleanup();
    await Promise.all([oldFlush, newer]);

    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toMatchObject({
      sets: {
        [saveKey]: savedAggregate,
        [monthKey]: expect.objectContaining({ focusMs: 4_000 }),
      },
      removes: expect.arrayContaining([removeKey, pruneKey]),
    });
    expect(local.state.values[LOCAL_AGGREGATE_TOMBSTONES]).toEqual(
      expect.arrayContaining([removeKey, pruneKey]),
    );

    vi.clearAllTimers();
    const restarted: PolicyStorage = createPolicyStorage(
      local.area,
      sync.area,
      {
        loadAggregateItems: async (): Promise<Record<string, unknown>> =>
          Object.fromEntries(
            Object.entries(local.state.values).filter(
              ([key]: [string, unknown]): boolean =>
                key.startsWith('agg:device-a:') ||
                key.startsWith('aggm:device-a:') ||
                key.startsWith('archive:clock-rebase:device-a:'),
            ),
          ),
      },
      DIRECT_ALL_DATA_CLEAR_BARRIER,
    );
    await restarted.initialize();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sync.state.values[oldKey]).toEqual(oldAggregate);
    expect(sync.state.values[saveKey]).toEqual(savedAggregate);
    expect(sync.state.values[removeKey]).toBeUndefined();
    expect(sync.state.values[pruneKey]).toBeUndefined();
    expect(sync.state.values[monthKey]).toMatchObject({ focusMs: 4_000 });
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toEqual({ sets: {}, removes: [] });
    expect(local.state.values[LOCAL_AGGREGATE_TOMBSTONES]).toEqual([]);
  });

  it('prunes local aggregate authority without making a Sync call in local mode', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const oldDate: string = '2026-05-01';
    const oldKey: string = syncAggKey('device-a', oldDate);
    const monthKey: string = 'aggm:device-a:2026-05';
    const aggregate = { ...emptyDaily(oldDate), focusMs: 42_000 };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_DEVICE_ID]: 'device-a',
      [oldKey]: aggregate,
    });
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);

    await storage.pruneRemoteHistory('device-a', 90, new Date(2026, 7, 31, 12, 0).getTime());

    expect(local.state.values[oldKey]).toBeUndefined();
    expect(local.state.values[monthKey]).toMatchObject({ focusMs: 42_000 });
    expect(local.state.values[LOCAL_AGGREGATE_PRUNE]).toBeUndefined();
    expect(sync.area.get).not.toHaveBeenCalled();
    expect(sync.area.set).not.toHaveBeenCalled();
  });

  it('recovers an interrupted local prune from its exact desired checkpoint', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const oldDate: string = '2026-05-01';
    const oldKey: string = syncAggKey('device-a', oldDate);
    const monthKey: string = 'aggm:device-a:2026-05';
    const aggregate = { ...emptyDaily(oldDate), focusMs: 42_000 };
    const monthly = rollupMonth('2026-05', [aggregate]);
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [oldKey]: aggregate,
      [monthKey]: monthly,
      [LOCAL_AGGREGATE_PRUNE]: { set: { [monthKey]: monthly }, remove: [oldKey] },
    });
    const restarted: PolicyStorage = policyStorage(local, fakeStorage());

    await restarted.initialize();

    expect(local.state.values[oldKey]).toBeUndefined();
    expect(local.state.values[monthKey]).toEqual(monthly);
    expect(local.state.values[LOCAL_AGGREGATE_PRUNE]).toBeUndefined();
  });

  it('marks a failed aggregate prune journal durable error and recovers it after restart', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'sync' };
    const oldDate: string = '2026-05-01';
    const oldKey: string = syncAggKey('device-a', oldDate);
    const monthKey: string = 'aggm:device-a:2026-05';
    const aggregate = { ...emptyDaily(oldDate), focusMs: 42_000 };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_DEVICE_ID]: 'device-a',
      [oldKey]: aggregate,
    });
    const sync: FakeStorage = fakeStorage({ [oldKey]: aggregate });
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();
    let rejectJournal: boolean = true;
    vi.mocked(local.area.set).mockImplementation(
      async (items: Record<string, unknown>): Promise<void> => {
        const journal: unknown = items[LOCAL_SYNC_JOURNAL];
        if (
          rejectJournal &&
          typeof journal === 'object' &&
          journal !== null &&
          'sets' in journal &&
          Object.hasOwn((journal as SyncJournal).sets, monthKey)
        ) {
          throw new Error('aggregate prune journal unavailable');
        }
        Object.assign(local.state.values, structuredClone(items));
      },
    );

    await expect(
      storage.pruneRemoteHistory('device-a', 90, new Date(2026, 7, 31, 12, 0).getTime()),
    ).rejects.toThrow('aggregate prune journal unavailable');

    expect((await setupState(local)).syncWriteStatus).toBe('error');
    expect((await setupState(local)).storageError).toBe('sync-publish-failed');
    expect(local.state.values[monthKey]).toMatchObject({ focusMs: 42_000 });
    expect(local.state.values[LOCAL_AGGREGATE_TOMBSTONES]).toContain(oldKey);

    rejectJournal = false;
    const restarted: PolicyStorage = createPolicyStorage(
      local.area,
      sync.area,
      {
        loadAggregateItems: async (): Promise<Record<string, unknown>> => ({
          [monthKey]: local.state.values[monthKey],
        }),
      },
      DIRECT_ALL_DATA_CLEAR_BARRIER,
    );
    await restarted.initialize();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sync.state.values[oldKey]).toBeUndefined();
    expect(sync.state.values[monthKey]).toMatchObject({ focusMs: 42_000 });
    expect((await setupState(local)).syncWriteStatus).toBe('idle');
  });

  it('keeps an unsyncable monthly prune rollup locally and publishes its removals', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'sync' };
    const oldDate: string = '2026-05-01';
    const oldKey: string = syncAggKey('device-a', oldDate);
    const monthKey: string = 'aggm:device-a:2026-05';
    const aggregate: DailyAgg = {
      ...emptyDaily(oldDate),
      attempts: { [`${'x'.repeat(20_000)}.example`]: 1 },
    };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_DEVICE_ID]: 'device-a',
      [oldKey]: aggregate,
    });
    const sync: FakeStorage = fakeStorage({ [oldKey]: aggregate });
    const storage: PolicyStorage = policyStorage(local, sync);

    await storage.pruneRemoteHistory('device-a', 90, new Date(2026, 7, 31, 12, 0).getTime());
    await vi.advanceTimersByTimeAsync(10_000);

    expect(local.state.values[oldKey]).toBeUndefined();
    expect(local.state.values[monthKey]).toMatchObject({ attempts: aggregate.attempts });
    expect(sync.state.values[oldKey]).toBeUndefined();
    expect(sync.state.values[monthKey]).toBeUndefined();
    expect(local.state.values[BLOCKED_AGGREGATE_PUBLICATIONS_KEY]).toMatchObject({
      version: 1,
      items: { [monthKey]: expect.objectContaining({ attempts: aggregate.attempts }) },
    });
    expect(await storage.loadSetup()).toMatchObject({
      syncWriteStatus: 'error',
      storageError: 'sync-publish-failed',
    });
  });

  it('cancels a pending monthly set superseded by an unsyncable prune rollup', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'sync' };
    const oldDate: string = '2026-05-01';
    const oldKey: string = syncAggKey('device-a', oldDate);
    const monthKey: string = 'aggm:device-a:2026-05';
    const daily: DailyAgg = {
      ...emptyDaily(oldDate),
      attempts: { [`${'x'.repeat(20_000)}.example`]: 1 },
    };
    const pendingMonth = rollupMonth('2026-05', [{ ...emptyDaily('2026-05-02'), focusMs: 42_000 }]);
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_DEVICE_ID]: 'device-a',
      [oldKey]: daily,
    });
    const sync: FakeStorage = fakeStorage({ [oldKey]: daily });
    const storage: PolicyStorage = policyStorage(local, sync);

    await storage.saveAggregate(monthKey, pendingMonth);
    await storage.pruneRemoteHistory('device-a', 90, new Date(2026, 7, 31, 12, 0).getTime());
    await vi.advanceTimersByTimeAsync(10_000);

    expect(local.state.values[oldKey]).toBeUndefined();
    expect(local.state.values[monthKey]).toMatchObject({
      focusMs: 42_000,
      attempts: daily.attempts,
    });
    expect(sync.state.values[oldKey]).toBeUndefined();
    expect(sync.state.values[monthKey]).toBeUndefined();
    expect(local.state.values[LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]).toMatchObject({
      version: 1,
      items: { [monthKey]: expect.objectContaining({ attempts: daily.attempts }) },
    });
  });

  it('reconstructs a blocked prune rollup after interruption before registry persistence', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'sync' };
    const oldDate: string = '2026-05-01';
    const oldKey: string = syncAggKey('device-a', oldDate);
    const monthKey: string = 'aggm:device-a:2026-05';
    const aggregate: DailyAgg = {
      ...emptyDaily(oldDate),
      attempts: { [`${'x'.repeat(20_000)}.example`]: 1 },
    };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_DEVICE_ID]: 'device-a',
      [oldKey]: aggregate,
    });
    const sync: FakeStorage = fakeStorage({ [oldKey]: aggregate });
    const first: PolicyStorage = policyStorage(local, sync);
    let interruptRemoval: boolean = true;
    vi.mocked(local.area.remove).mockImplementation(
      async (keys: string | string[]): Promise<void> => {
        const requested: string[] = typeof keys === 'string' ? [keys] : keys;
        if (interruptRemoval && requested.includes(oldKey)) {
          interruptRemoval = false;
          throw new Error('prune removal interrupted');
        }
        for (const key of requested) delete local.state.values[key];
      },
    );

    await expect(
      first.pruneRemoteHistory('device-a', 90, new Date(2026, 7, 31, 12, 0).getTime()),
    ).rejects.toThrow('prune removal interrupted');

    expect(local.state.values[monthKey]).toBeDefined();
    expect(local.state.values[BLOCKED_AGGREGATE_PUBLICATIONS_KEY]).toBeUndefined();

    const restarted: PolicyStorage = createPolicyStorage(
      local.area,
      sync.area,
      {
        loadAggregateItems: async (): Promise<Record<string, unknown>> => ({
          [monthKey]: local.state.values[monthKey],
        }),
      },
      DIRECT_ALL_DATA_CLEAR_BARRIER,
    );
    await restarted.initialize();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(local.state.values[oldKey]).toBeUndefined();
    expect(sync.state.values[oldKey]).toBeUndefined();
    expect(local.state.values[BLOCKED_AGGREGATE_PUBLICATIONS_KEY]).toMatchObject({
      version: 1,
      items: { [monthKey]: expect.objectContaining({ attempts: aggregate.attempts }) },
    });
    expect(await restarted.loadSetup()).toMatchObject({
      syncWriteStatus: 'error',
      storageError: 'sync-publish-failed',
    });
  });

  it('leaves local mode and a retryable outbox when initial publish fails', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    sync.state.failSet = new Error('sync unavailable');
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();

    await expect(storage.enableSync()).rejects.toThrow('sync unavailable');

    expect((await setupState(local)).storageMode).toBe('local');
    expect((await setupState(local)).syncWriteStatus).toBe('error');
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toMatchObject({
      sets: {
        [SYNC_SETTINGS]: SNAPSHOT.settings,
        [SYNC_BANK]: SNAPSHOT.bank,
      },
    });
  });

  it('fails closed when the first aggregate checkpoint cannot be loaded', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = createPolicyStorage(
      local.area,
      sync.area,
      {
        loadAggregateItems: (): Promise<Record<string, unknown>> =>
          Promise.reject(new Error('aggregate checkpoint unavailable')),
      },
      DIRECT_ALL_DATA_CLEAR_BARRIER,
    );
    await storage.initialize();

    await expect(storage.enableSync()).rejects.toThrow('aggregate checkpoint unavailable');

    expect((await setupState(local)).storageMode).toBe('local');
    expect((await setupState(local)).storageError).toBe('sync-publish-failed');
    expect(sync.area.set).not.toHaveBeenCalled();
  });

  it('rejects a malformed aggregate before the first Sync mode flip', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    const key: string = syncAggKey('device-a', '2026-08-31');
    const storage: PolicyStorage = createPolicyStorage(
      local.area,
      sync.area,
      {
        loadAggregateItems: async (): Promise<Record<string, unknown>> => ({
          [key]: { ...emptyDaily('2026-08-31'), sessionsStarted: 0.5 },
        }),
      },
      DIRECT_ALL_DATA_CLEAR_BARRIER,
    );

    await expect(storage.enableSync()).rejects.toThrow('invalid first sync checkpoint item');

    expect((await setupState(local)).storageMode).toBe('local');
    expect(sync.area.set).not.toHaveBeenCalled();
  });

  it.each([SYNC_SETTINGS, SYNC_LISTS, SYNC_BANK, SYNC_STREAK])(
    'rejects a first-checkpoint contributor collision with %s',
    async (key: string): Promise<void> => {
      const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
      const local: FakeStorage = fakeStorage(localPolicy(setup));
      const sync: FakeStorage = fakeStorage();
      const storage: PolicyStorage = createPolicyStorage(
        local.area,
        sync.area,
        {
          loadAggregateItems: async (): Promise<Record<string, unknown>> => ({
            [key]: key === SYNC_BANK ? { balanceMs: 7 } : SNAPSHOT.settings,
          }),
        },
        DIRECT_ALL_DATA_CLEAR_BARRIER,
      );

      await expect(storage.enableSync()).rejects.toThrow('collides with policy');

      expect((await setupState(local)).storageMode).toBe('local');
      expect(local.state.values[LOCAL_SYNC_JOURNAL]).toBeUndefined();
      expect(sync.area.set).not.toHaveBeenCalled();
    },
  );

  it('records a retryable error when the initial complete outbox cannot persist', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();
    vi.mocked(local.area.set).mockImplementation(
      async (items: Record<string, unknown>): Promise<void> => {
        if (Object.hasOwn(items, LOCAL_SYNC_JOURNAL)) {
          throw new Error('initial outbox unavailable');
        }
        Object.assign(local.state.values, structuredClone(items));
      },
    );

    await expect(storage.enableSync()).rejects.toThrow('initial outbox unavailable');

    expect((await setupState(local)).storageMode).toBe('local');
    expect((await setupState(local)).syncWriteStatus).toBe('error');
    expect((await setupState(local)).storageError).toBe('sync-publish-failed');
    expect(sync.area.set).not.toHaveBeenCalled();
  });

  it('does not change mode when complete publication exceeds Sync quota', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const impossibleSettings = {
      ...DEFAULT_SETTINGS,
      schedule: [
        {
          id: 'too-large',
          days: [1],
          start: '09:00',
          end: '10:00',
          mode: 'blacklist' as const,
          strictness: 'friction' as const,
          cycling: null,
          intention: 'x'.repeat(20_000),
          enabled: true,
        },
      ],
    };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_SETTINGS]: impossibleSettings,
    });
    const storage: PolicyStorage = policyStorage(local, fakeStorage());
    await storage.initialize();

    await expect(storage.enableSync()).rejects.toThrow('8192-byte limit');
    expect((await setupState(local)).storageMode).toBe('local');
    expect((await setupState(local)).syncWriteStatus).toBe('error');
  });

  it('reconstructs a full outbox after a crash gap and recovers on retry', async (): Promise<void> => {
    const setup: SetupState = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'sync',
      syncWriteStatus: 'pending',
    };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_SYNC_JOURNAL]: { sets: {}, removes: [] },
    });
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);

    await storage.initialize();
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toMatchObject({
      sets: {
        [SYNC_SETTINGS]: SNAPSHOT.settings,
        [SYNC_BANK]: SNAPSHOT.bank,
      },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sync.state.values[SYNC_SETTINGS]).toEqual(SNAPSHOT.settings);
    expect((await setupState(local)).syncWriteStatus).toBe('idle');
    expect((await setupState(local)).storageError).toBeNull();
  });

  it('clears a prior publish error only after the empty journal is durable', async (): Promise<void> => {
    const setup: SetupState = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'sync',
      syncWriteStatus: 'error',
      storageError: 'sync-publish-failed',
    };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_SYNC_JOURNAL]: { sets: { [SYNC_BANK]: SNAPSHOT.bank }, removes: [] },
    });
    const storage: PolicyStorage = policyStorage(local, fakeStorage());

    await storage.initialize();
    expect((await setupState(local)).storageError).toBe('sync-publish-failed');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toEqual({ sets: {}, removes: [] });
    expect((await setupState(local)).syncWriteStatus).toBe('idle');
    expect((await setupState(local)).storageError).toBeNull();
  });

  it('marks a pre-flush journal verification failure as retryable', async (): Promise<void> => {
    const setup: SetupState = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'sync',
      syncWriteStatus: 'pending',
    };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_SYNC_JOURNAL]: { sets: { [SYNC_BANK]: SNAPSHOT.bank }, removes: [] },
    });
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();
    let failPreflight: boolean = true;
    vi.mocked(local.area.set).mockImplementation(
      async (items: Record<string, unknown>): Promise<void> => {
        if (
          failPreflight &&
          Object.hasOwn(items, LOCAL_SYNC_JOURNAL) &&
          Object.keys((items[LOCAL_SYNC_JOURNAL] as SyncJournal).sets).length > 0
        ) {
          failPreflight = false;
          throw new Error('pre-flush journal unavailable');
        }
        Object.assign(local.state.values, structuredClone(items));
      },
    );

    await vi.advanceTimersByTimeAsync(10_000);

    expect(sync.state.values[SYNC_BANK]).toBeUndefined();
    expect((await setupState(local)).syncWriteStatus).toBe('error');
    expect((await setupState(local)).storageError).toBe('sync-publish-failed');
  });

  it('recovers when remote success is followed by cleanup-journal failure', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'sync' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();
    const nextBank = { balanceMs: 84_000 };
    await storage.setPolicy('bank', nextBank);
    let failCleanup: boolean = true;
    vi.mocked(local.area.set).mockImplementation(
      async (items: Record<string, unknown>): Promise<void> => {
        const journal: unknown = items[LOCAL_SYNC_JOURNAL];
        if (
          failCleanup &&
          typeof journal === 'object' &&
          journal !== null &&
          Object.keys((journal as SyncJournal).sets).length === 0
        ) {
          failCleanup = false;
          throw new Error('cleanup journal unavailable');
        }
        Object.assign(local.state.values, structuredClone(items));
      },
    );

    await vi.advanceTimersByTimeAsync(10_000);

    expect(sync.state.values[SYNC_BANK]).toEqual(nextBank);
    expect((await setupState(local)).syncWriteStatus).toBe('error');
    expect((await setupState(local)).storageError).toBe('sync-publish-failed');

    await vi.advanceTimersByTimeAsync(10_000);

    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toEqual({ sets: {}, removes: [] });
    expect((await setupState(local)).syncWriteStatus).toBe('idle');
    expect((await setupState(local)).storageError).toBeNull();
  });

  it('immediately checkpoints a successful first Sync publication when cleanup fails', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();
    let failCleanup: boolean = true;
    vi.mocked(local.area.set).mockImplementation(
      async (items: Record<string, unknown>): Promise<void> => {
        const journal: unknown = items[LOCAL_SYNC_JOURNAL];
        if (
          failCleanup &&
          typeof journal === 'object' &&
          journal !== null &&
          Object.keys((journal as SyncJournal).sets).length === 0
        ) {
          failCleanup = false;
          throw new Error('cleanup journal unavailable');
        }
        Object.assign(local.state.values, structuredClone(items));
      },
    );

    await expect(storage.enableSync()).rejects.toThrow('cleanup journal unavailable');

    expect(sync.area.set).toHaveBeenCalledOnce();
    expect(sync.area.remove).toHaveBeenCalledOnce();
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toEqual({ sets: {}, removes: [] });
    expect(storage.hasPendingRemote(SYNC_SETTINGS)).toBe(false);
    expect(storage.hasPendingRemote(SYNC_BANK)).toBe(false);
    expect(await storage.loadSetup()).toMatchObject({
      storageMode: 'local',
      syncWriteStatus: 'error',
      storageError: 'sync-publish-failed',
    });

    const remoteGetCount: number = vi.mocked(sync.area.get).mock.calls.length;
    await storage.enableSync();

    expect(await storage.storageMode()).toBe('sync');
    expect(sync.area.get).toHaveBeenCalledTimes(remoteGetCount);
    expect(sync.area.set).toHaveBeenCalledOnce();
    expect(sync.area.remove).toHaveBeenCalledOnce();
    expect(local.state.values[FIRST_SYNC_PUBLICATION_KEY]).toBeUndefined();
  });

  it('publishes only local policy changes made after first Sync completed remotely', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();
    let failCleanup: boolean = true;
    vi.mocked(local.area.set).mockImplementation(
      async (items: Record<string, unknown>): Promise<void> => {
        const journal: unknown = items[LOCAL_SYNC_JOURNAL];
        if (
          failCleanup &&
          typeof journal === 'object' &&
          journal !== null &&
          Object.keys((journal as SyncJournal).sets).length === 0
        ) {
          failCleanup = false;
          throw new Error('cleanup journal unavailable');
        }
        Object.assign(local.state.values, structuredClone(items));
      },
    );
    await expect(storage.enableSync()).rejects.toThrow('cleanup journal unavailable');
    const nextBank: BankState = { balanceMs: 84_000 };
    await storage.setPolicy('bank', nextBank);
    const remoteGetCount: number = vi.mocked(sync.area.get).mock.calls.length;

    await storage.enableSync();

    expect(sync.area.get).toHaveBeenCalledTimes(remoteGetCount + 1);
    expect(sync.area.remove).toHaveBeenCalledOnce();
    expect(sync.area.set).toHaveBeenCalledTimes(2);
    expect(sync.area.set).toHaveBeenLastCalledWith({ [SYNC_BANK]: nextBank });
    expect(sync.state.values[SYNC_BANK]).toEqual(nextBank);
    expect(await storage.storageMode()).toBe('sync');
  });

  it('publishes only a local policy removal made after first Sync completed remotely', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();
    let failCleanup: boolean = true;
    vi.mocked(local.area.set).mockImplementation(
      async (items: Record<string, unknown>): Promise<void> => {
        const journal: unknown = items[LOCAL_SYNC_JOURNAL];
        if (
          failCleanup &&
          typeof journal === 'object' &&
          journal !== null &&
          Object.keys((journal as SyncJournal).sets).length === 0
        ) {
          failCleanup = false;
          throw new Error('cleanup journal unavailable');
        }
        Object.assign(local.state.values, structuredClone(items));
      },
    );
    await expect(storage.enableSync()).rejects.toThrow('cleanup journal unavailable');
    await storage.setPolicy('streak', null);
    const remoteGetCount: number = vi.mocked(sync.area.get).mock.calls.length;

    await storage.enableSync();

    expect(sync.area.get).toHaveBeenCalledTimes(remoteGetCount);
    expect(sync.area.set).toHaveBeenCalledOnce();
    expect(sync.area.remove).toHaveBeenCalledTimes(2);
    expect(sync.area.remove).toHaveBeenLastCalledWith([SYNC_STREAK]);
    expect(sync.state.values[SYNC_STREAK]).toBeUndefined();
    expect(await storage.storageMode()).toBe('sync');
  });

  it('validates a publishing marker after its remote-complete checkpoint fails', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();
    let failRemoteCompleteMarker: boolean = true;
    vi.mocked(local.area.set).mockImplementation(
      async (items: Record<string, unknown>): Promise<void> => {
        const marker: unknown = items[FIRST_SYNC_PUBLICATION_KEY];
        if (
          failRemoteCompleteMarker &&
          typeof marker === 'object' &&
          marker !== null &&
          (marker as { phase?: unknown }).phase === 'remote-complete'
        ) {
          failRemoteCompleteMarker = false;
          throw new Error('remote-complete marker unavailable');
        }
        Object.assign(local.state.values, structuredClone(items));
      },
    );

    await expect(storage.enableSync()).rejects.toThrow('remote-complete marker unavailable');

    expect(local.state.values[FIRST_SYNC_PUBLICATION_KEY]).toMatchObject({
      version: 1,
      phase: 'publishing',
    });
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toMatchObject({
      sets: { [SYNC_SETTINGS]: SNAPSHOT.settings, [SYNC_BANK]: SNAPSHOT.bank },
    });
    expect(sync.area.set).toHaveBeenCalledOnce();
    expect(sync.area.remove).toHaveBeenCalledOnce();
    const remoteGetCount: number = vi.mocked(sync.area.get).mock.calls.length;

    await storage.enableSync();

    expect(sync.area.get).toHaveBeenCalledTimes(remoteGetCount + 1);
    expect(sync.area.set).toHaveBeenCalledOnce();
    expect(sync.area.remove).toHaveBeenCalledOnce();
    expect(await storage.storageMode()).toBe('sync');
    expect(local.state.values[FIRST_SYNC_PUBLICATION_KEY]).toBeUndefined();
  });

  it('does not publish remotely before the publishing marker is durable', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();
    let failPublishingMarker: boolean = true;
    vi.mocked(local.area.set).mockImplementation(
      async (items: Record<string, unknown>): Promise<void> => {
        const marker: unknown = items[FIRST_SYNC_PUBLICATION_KEY];
        if (
          failPublishingMarker &&
          typeof marker === 'object' &&
          marker !== null &&
          (marker as { phase?: unknown }).phase === 'publishing'
        ) {
          failPublishingMarker = false;
          throw new Error('publishing marker unavailable');
        }
        Object.assign(local.state.values, structuredClone(items));
      },
    );

    await expect(storage.enableSync()).rejects.toThrow('publishing marker unavailable');

    expect(sync.area.set).not.toHaveBeenCalled();
    expect(sync.area.remove).not.toHaveBeenCalled();
    expect(local.state.values[FIRST_SYNC_PUBLICATION_KEY]).toBeUndefined();
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toMatchObject({
      sets: { [SYNC_SETTINGS]: SNAPSHOT.settings, [SYNC_BANK]: SNAPSHOT.bank },
    });

    await storage.enableSync();

    expect(sync.area.set).toHaveBeenCalledOnce();
    expect(sync.area.remove).toHaveBeenCalledOnce();
    expect(await storage.storageMode()).toBe('sync');
    expect(local.state.values[FIRST_SYNC_PUBLICATION_KEY]).toBeUndefined();
  });

  it('retains remote-complete authority across final mode persistence failure and restart', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    const first: PolicyStorage = policyStorage(local, sync);
    await first.initialize();
    let failModeWrite: boolean = true;
    vi.mocked(local.area.set).mockImplementation(
      async (items: Record<string, unknown>): Promise<void> => {
        const nextSetup: unknown = items[LOCAL_SETUP];
        if (
          failModeWrite &&
          typeof nextSetup === 'object' &&
          nextSetup !== null &&
          (nextSetup as SetupState).storageMode === 'sync'
        ) {
          failModeWrite = false;
          throw new Error('final mode unavailable');
        }
        Object.assign(local.state.values, structuredClone(items));
      },
    );

    await expect(first.enableSync()).rejects.toThrow('final mode unavailable');

    expect(local.state.values[FIRST_SYNC_PUBLICATION_KEY]).toMatchObject({
      version: 1,
      phase: 'remote-complete',
    });
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toEqual({ sets: {}, removes: [] });
    expect(await first.storageMode()).toBe('local');
    expect(sync.area.set).toHaveBeenCalledOnce();
    expect(sync.area.remove).toHaveBeenCalledOnce();
    const remoteGetCount: number = vi.mocked(sync.area.get).mock.calls.length;

    const restarted: PolicyStorage = policyStorage(local, sync);
    await restarted.initialize();
    await restarted.enableSync();

    expect(sync.area.get).toHaveBeenCalledTimes(remoteGetCount);
    expect(sync.area.set).toHaveBeenCalledOnce();
    expect(sync.area.remove).toHaveBeenCalledOnce();
    expect(await restarted.storageMode()).toBe('sync');
    expect(local.state.values[FIRST_SYNC_PUBLICATION_KEY]).toBeUndefined();
  });

  it('does not replay a durable outbox left behind after the remote-complete checkpoint', async (): Promise<void> => {
    const setup: SetupState = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'local',
      syncWriteStatus: 'error',
      storageError: 'sync-publish-failed',
    };
    const publication: SyncJournal = {
      sets: {
        [SYNC_SETTINGS]: SNAPSHOT.settings,
        [SYNC_LISTS]: SNAPSHOT.lists,
        [SYNC_BANK]: SNAPSHOT.bank,
        [SYNC_STREAK]: SNAPSHOT.streak,
      },
      removes: CATEGORY_IDS.map((categoryId: string): string => `lists:category:${categoryId}`),
    };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_SYNC_JOURNAL]: publication,
      [FIRST_SYNC_PUBLICATION_KEY]: {
        version: 1,
        phase: 'remote-complete',
        publication,
      },
    });
    const sync: FakeStorage = fakeStorage(publication.sets);
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();

    await storage.enableSync();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(sync.area.get).not.toHaveBeenCalled();
    expect(sync.area.set).not.toHaveBeenCalled();
    expect(sync.area.remove).not.toHaveBeenCalled();
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toEqual({ sets: {}, removes: [] });
    expect(await storage.storageMode()).toBe('sync');
  });

  it('lets local-history clearing retry a twice-failed first Sync cleanup immediately', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_EVENTS]: [{ t: 'sessionCompleted', at: 1, focusedMs: 1 }],
    });
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();
    let remainingCleanupFailures: number = 2;
    vi.mocked(local.area.set).mockImplementation(
      async (items: Record<string, unknown>): Promise<void> => {
        const journal: unknown = items[LOCAL_SYNC_JOURNAL];
        if (
          remainingCleanupFailures > 0 &&
          typeof journal === 'object' &&
          journal !== null &&
          Object.keys((journal as SyncJournal).sets).length === 0
        ) {
          remainingCleanupFailures -= 1;
          throw new Error('cleanup journal unavailable');
        }
        Object.assign(local.state.values, structuredClone(items));
      },
    );
    await expect(storage.enableSync()).rejects.toThrow('cleanup journal unavailable');

    await expect(storage.clearLocalHistory()).resolves.toBe(true);

    expect(sync.area.set).toHaveBeenCalledOnce();
    expect(sync.area.remove).toHaveBeenCalledOnce();
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toEqual({ sets: {}, removes: [] });
    expect(storage.hasPendingRemote(SYNC_SETTINGS)).toBe(false);
    expect(storage.hasPendingRemote(SYNC_BANK)).toBe(false);
    expect(local.state.values[LOCAL_EVENTS]).toBeUndefined();
    expect(await storage.loadSetup()).toMatchObject({
      storageMode: 'local',
      dataClear: { status: 'pending', scope: 'local-history', phase: 'runtime' },
      storageError: 'sync-publish-failed',
    });
  });

  it('preserves valid history sets and removals while reconstructing policy intent', async (): Promise<void> => {
    const setup: SetupState = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'sync',
      syncWriteStatus: 'pending',
    };
    const aggregateKey: string = 'agg:device:2026-08-30';
    const removedAggregateKey: string = 'agg:device:2026-08-29';
    const aggregate = emptyDaily('2026-08-30');
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_SYNC_JOURNAL]: {
        sets: { [aggregateKey]: aggregate },
        removes: [removedAggregateKey],
      },
    });
    const storage: PolicyStorage = policyStorage(local, fakeStorage());

    await storage.initialize();

    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toMatchObject({
      sets: {
        [SYNC_SETTINGS]: SNAPSHOT.settings,
        [aggregateKey]: aggregate,
      },
      removes: expect.arrayContaining([removedAggregateKey]),
    });
  });

  it('keeps local success and recoverable intent when journal persistence fails', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'sync' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const storage: PolicyStorage = policyStorage(local, fakeStorage());
    await storage.initialize();
    const nextBank = { balanceMs: 84_000 };
    const set = vi.mocked(local.area.set);
    set.mockImplementation(async (items: Record<string, unknown>): Promise<void> => {
      if (Object.hasOwn(items, LOCAL_SYNC_JOURNAL)) {
        throw new Error('journal unavailable');
      }
      Object.assign(local.state.values, structuredClone(items));
    });

    await expect(storage.setPolicy('bank', nextBank)).rejects.toThrow('journal unavailable');

    expect(local.state.values[LOCAL_BANK]).toEqual(nextBank);
    expect((await setupState(local)).syncWriteStatus).toBe('error');
  });

  it('supersedes an older pending setting with the accepted remote authority', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'sync' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);
    const pending: Settings = { ...DEFAULT_SETTINGS, retentionDays: 30 };
    const accepted: Settings = { ...DEFAULT_SETTINGS, retentionDays: 14 };

    await storage.initialize();
    await storage.setPolicy('settings', pending);
    await storage.mirrorAcceptedRemotePolicy({ settings: accepted }, [SYNC_SETTINGS]);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(local.state.values[LOCAL_SETTINGS]).toEqual(accepted);
    expect(sync.state.values[SYNC_SETTINGS]).toEqual(accepted);
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toEqual({ sets: {}, removes: [] });
  });

  it('supersedes every older pending list shard with one accepted remote revision', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'sync' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);
    const exclusions: ListsConfig['exclusions'] = {};
    for (const categoryId of CATEGORY_IDS) {
      exclusions[categoryId] = Array.from(
        { length: 60 },
        (_value: unknown, index: number): string => `${categoryId}-${index}.example`,
      );
    }
    const pending: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'pending.example' }],
      exclusions,
    };
    const accepted: ListsConfig = {
      ...pending,
      custom: [{ kind: 'host', pattern: 'accepted.example' }],
    };

    await storage.initialize();
    await storage.setPolicy('lists', pending);
    const pendingJournal: SyncJournal = local.state.values[LOCAL_SYNC_JOURNAL] as SyncJournal;
    const pendingListKeys: string[] = Object.keys(pendingJournal.sets).filter(
      (key: string): boolean => key === SYNC_LISTS || key.startsWith('lists:category:'),
    );
    expect(pendingListKeys.length).toBeGreaterThan(1);
    await storage.mirrorAcceptedRemotePolicy({ lists: accepted }, pendingListKeys);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(local.state.values[LOCAL_LISTS]).toEqual(accepted);
    expect(decodeListsSyncSnapshot(sync.state.values)).toEqual({
      kind: 'complete',
      lists: accepted,
    });
  });

  it('disables sync before quiescing and preserves remote values', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'sync' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage({ [SYNC_SETTINGS]: SNAPSHOT.settings });
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();

    await storage.disableSync();
    await storage.setPolicy('bank', { balanceMs: 90_000 });
    await vi.advanceTimersByTimeAsync(20_000);

    expect((await setupState(local)).storageMode).toBe('local');
    expect(await storage.storageMode()).toBe('local');
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toEqual({ sets: {}, removes: [] });
    expect(sync.state.values[SYNC_SETTINGS]).toEqual(SNAPSHOT.settings);
    expect(sync.state.values[SYNC_BANK]).toBeUndefined();
  });

  it('resumes sync publication when durable disable preparation fails', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'sync' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();
    const pendingBank = { balanceMs: 91_000 };
    await storage.setPolicy('bank', pendingBank);
    let failEmptyJournal: boolean = true;
    vi.mocked(local.area.set).mockImplementation(
      async (items: Record<string, unknown>): Promise<void> => {
        const journal: unknown = items[LOCAL_SYNC_JOURNAL];
        if (
          failEmptyJournal &&
          typeof journal === 'object' &&
          journal !== null &&
          Object.keys((journal as SyncJournal).sets).length === 0
        ) {
          failEmptyJournal = false;
          throw new Error('disable journal unavailable');
        }
        Object.assign(local.state.values, structuredClone(items));
      },
    );

    await expect(storage.disableSync()).rejects.toThrow('disable journal unavailable');

    expect((await setupState(local)).storageMode).toBe('sync');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sync.state.values[SYNC_BANK]).toEqual(pendingBank);
  });

  it('restores pending sync sets and removals when the final local-mode switch fails', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'sync' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const removeKey: string = syncAggKey('pending-device', '2026-08-29');
    const sync: FakeStorage = fakeStorage({ [removeKey]: emptyDaily('2026-08-29') });
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();
    const pendingBank = { balanceMs: 92_000 };
    await storage.setPolicy('bank', pendingBank);
    await storage.removeAggregate(removeKey);
    const pendingJournal: SyncJournal = structuredClone(
      local.state.values[LOCAL_SYNC_JOURNAL] as SyncJournal,
    );
    let failModeSwitch: boolean = true;
    vi.mocked(local.area.set).mockImplementation(
      async (items: Record<string, unknown>): Promise<void> => {
        const nextSetup: unknown = items[LOCAL_SETUP];
        if (
          failModeSwitch &&
          typeof nextSetup === 'object' &&
          nextSetup !== null &&
          (nextSetup as SetupState).storageMode === 'local'
        ) {
          failModeSwitch = false;
          throw new Error('mode switch unavailable');
        }
        Object.assign(local.state.values, structuredClone(items));
      },
    );

    await expect(storage.disableSync()).rejects.toThrow('mode switch unavailable');

    expect((await setupState(local)).storageMode).toBe('sync');
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toEqual(pendingJournal);

    vi.clearAllTimers();
    const restarted: PolicyStorage = policyStorage(local, sync);
    await restarted.initialize();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sync.state.values[SYNC_BANK]).toEqual(pendingBank);
    expect(sync.state.values[removeKey]).toBeUndefined();
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toEqual({ sets: {}, removes: [] });
  });

  it('uses a removal-only journal after sync is disabled and preserves unrelated keys', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage({
      [SYNC_SETTINGS]: SNAPSHOT.settings,
      [SYNC_LISTS]: SNAPSHOT.lists,
      [SYNC_BANK]: SNAPSHOT.bank,
      [SYNC_STREAK]: SNAPSHOT.streak,
      'agg:device:2026-08-30': { date: '2026-08-30' },
      'agg:stale-malformed': null,
      'aggm:stale-malformed': null,
      'prune:device': { remove: [] },
      'lists:category:retired': { stale: true },
      'archive:clock-rebase:device:2026-08-30:1:id': { date: '2026-08-30' },
      'unrelated:key': 'keep',
    });
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();

    await storage.deleteRemoteData('synced-policy');

    expect(sync.state.values).toEqual({ 'unrelated:key': 'keep' });
    expect(local.state.values[LOCAL_DATA_CLEAR_JOURNAL]).toBeUndefined();
    expect((await setupState(local)).syncWriteStatus).toBe('idle');
  });

  it('deletes remotely completed first-Sync authority even after its outbox was cleaned', async (): Promise<void> => {
    const setup: SetupState = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'local',
      syncWriteStatus: 'error',
      storageError: 'sync-publish-failed',
    };
    const publication: SyncJournal = {
      sets: { [SYNC_SETTINGS]: SNAPSHOT.settings, [SYNC_BANK]: SNAPSHOT.bank },
      removes: [],
    };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_SYNC_JOURNAL]: { sets: {}, removes: [] },
      [FIRST_SYNC_PUBLICATION_KEY]: {
        version: 1,
        phase: 'remote-complete',
        publication,
      },
    });
    const sync: FakeStorage = fakeStorage({ ...publication.sets, unrelated: 'keep' });
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();

    await storage.deleteRemoteData('synced-policy');

    expect(sync.state.values).toEqual({ unrelated: 'keep' });
    expect(local.state.values[FIRST_SYNC_PUBLICATION_KEY]).toBeUndefined();
    expect(await storage.loadSetup()).toMatchObject({
      storageMode: 'local',
      syncWriteStatus: 'idle',
      storageError: null,
    });
  });

  it('clears every Focus Lock local key only after remote all-data deletion succeeds', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const now: number = Date.now();
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_RUNTIME]: emptyRuntime(now),
      [LOCAL_CACHES]: { matcher: true },
      [LOCAL_DEVICE_ID]: 'device-id',
      'agg:device-id:2026-08-31': emptyDaily('2026-08-31'),
      'agg:malformed': { stale: true },
      'aggm:malformed': { stale: true },
      [LOCAL_AGGREGATE_TOMBSTONES]: ['agg:device-id:2026-08-30'],
      [LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]: {
        version: 1,
        items: {},
      },
      unrelated: 'keep',
    });
    const sync: FakeStorage = fakeStorage({
      [SYNC_SETTINGS]: SNAPSHOT.settings,
      'agg:malformed': { stale: true },
      'aggm:malformed': { stale: true },
      unrelated: 'keep',
    });
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();

    await storage.deleteRemoteData('all');

    expect(sync.state.values).toEqual({ unrelated: 'keep' });
    expect(local.state.values.unrelated).toBe('keep');
    expect(local.state.values[LOCAL_SETTINGS]).toBeUndefined();
    expect(local.state.values[LOCAL_RUNTIME]).toBeUndefined();
    expect(local.state.values[LOCAL_CACHES]).toBeUndefined();
    expect(local.state.values[LOCAL_DEVICE_ID]).toBeUndefined();
    expect(local.state.values['agg:device-id:2026-08-31']).toBeUndefined();
    expect(local.state.values['agg:malformed']).toBeUndefined();
    expect(local.state.values['aggm:malformed']).toBeUndefined();
    expect(local.state.values[LOCAL_AGGREGATE_TOMBSTONES]).toBeUndefined();
    expect(local.state.values[LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]).toBeUndefined();
    expect(await storage.loadSetup()).toEqual(DEFAULT_SETUP);
  });

  it('does not retain stale quiescence when a later all-data journal write fails early', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_RUNTIME]: emptyRuntime(Date.now()),
    });
    const sync: FakeStorage = fakeStorage({ [SYNC_SETTINGS]: SNAPSHOT.settings });
    const retainedAfterFailure: boolean[] = [];
    const storage: PolicyStorage = createPolicyStorage(local.area, sync.area, EMPTY_CHECKPOINT, {
      runExclusive: async <T>(
        operation: () => Promise<T>,
        retainQuiescence: () => boolean,
      ): Promise<T> => {
        try {
          return await operation();
        } catch (error: unknown) {
          retainedAfterFailure.push(retainQuiescence());
          throw error;
        }
      },
    });

    await storage.deleteRemoteData('all');
    vi.mocked(local.area.set).mockRejectedValueOnce(new Error('journal write unavailable'));

    await expect(storage.deleteRemoteData('all')).rejects.toThrow('journal write unavailable');

    expect(retainedAfterFailure).toEqual([false]);
    expect(await storage.loadSetup()).toEqual(DEFAULT_SETUP);
    expect(local.state.values[LOCAL_DATA_CLEAR_JOURNAL]).toBeUndefined();
  });

  it('re-scans local authority when a writer recreates Focus Lock data after removal', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_RUNTIME]: emptyRuntime(Date.now()),
    });
    const sync: FakeStorage = fakeStorage({ [SYNC_SETTINGS]: SNAPSHOT.settings });
    let recreated: boolean = false;
    vi.mocked(local.area.remove).mockImplementation(
      async (keys: string | string[]): Promise<void> => {
        const requested: string[] = typeof keys === 'string' ? [keys] : keys;
        for (const key of requested) delete local.state.values[key];
        if (!recreated && requested.includes(LOCAL_SETTINGS)) {
          recreated = true;
          local.state.values[LOCAL_EVENTS] = [
            { id: 'late-event', type: 'attempt', at: Date.now() },
          ];
        }
      },
    );
    const storage: PolicyStorage = policyStorage(local, sync);

    await storage.deleteRemoteData('all');

    expect(recreated).toBe(true);
    expect(local.state.values[LOCAL_EVENTS]).toBeUndefined();
    expect(await storage.loadSetup()).toEqual(DEFAULT_SETUP);
  });

  it('acquires the runtime barrier before entering the adapter mutation queue', async (): Promise<void> => {
    let releaseBarrier: () => void = (): void => undefined;
    let signalBarrierEntered: () => void = (): void => undefined;
    const barrierBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseBarrier = resolve;
    });
    const barrierEntered: Promise<void> = new Promise((resolve: () => void): void => {
      signalBarrierEntered = resolve;
    });
    const barrier: AllDataClearBarrier = {
      runExclusive: async <T>(operation: () => Promise<T>): Promise<T> => {
        signalBarrierEntered();
        await barrierBlocked;
        return operation();
      },
    };
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_RUNTIME]: emptyRuntime(Date.now()),
    });
    const storage: PolicyStorage = createPolicyStorage(
      local.area,
      fakeStorage({ [SYNC_SETTINGS]: SNAPSHOT.settings }).area,
      EMPTY_CHECKPOINT,
      barrier,
    );

    const clearing: Promise<void> = storage.deleteRemoteData('all');
    await barrierEntered;
    await expect(storage.setPolicy('bank', { balanceMs: 77_000 })).resolves.toBeUndefined();

    releaseBarrier();
    await clearing;
    expect(local.state.values[LOCAL_BANK]).toBeUndefined();
  });

  it('rejects all-data deletion without mutating storage while durable runtime is active', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const now: number = Date.now();
    const activeRuntime: RuntimeState = runtimeWithActiveSession(now);
    activeRuntime.commitCheckpoint = {
      bank: SNAPSHOT.bank,
      events: [],
      syncBank: true,
    };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_RUNTIME]: activeRuntime,
      [LOCAL_CACHES]: { matcher: true },
    });
    const sync: FakeStorage = fakeStorage({ [SYNC_SETTINGS]: SNAPSHOT.settings });
    const storage: PolicyStorage = policyStorage(local, sync);
    const priorLocal: Record<string, unknown> = structuredClone(local.state.values);
    const priorSync: Record<string, unknown> = structuredClone(sync.state.values);

    await expect(storage.deleteRemoteData('all')).rejects.toThrow(
      'stop the active session and blocking state before deleting all data',
    );

    expect(local.state.values).toEqual(priorLocal);
    expect(sync.state.values).toEqual(priorSync);
    expect(local.area.set).not.toHaveBeenCalled();
    expect(local.area.remove).not.toHaveBeenCalled();
    expect(sync.area.set).not.toHaveBeenCalled();
    expect(sync.area.remove).not.toHaveBeenCalled();
    expect(await storage.inboundSyncAllowed()).toBe(false);
  });

  it.each(['gate', 'unlocks', 'tabStates'] as const)(
    'rejects all-data deletion while durable runtime retains %s blocking state',
    async (field: 'gate' | 'unlocks' | 'tabStates'): Promise<void> => {
      const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
      const now: number = Date.now();
      const runtime: RuntimeState = emptyRuntime(now);
      if (field === 'gate') {
        runtime.gate = {
          kind: 'cancel',
          host: null,
          openedAt: now,
          readyAt: now + 10_000,
          requiredPhrase: null,
          forceEndAvailable: false,
        };
      } else if (field === 'unlocks') {
        runtime.unlocks = [{ host: 'allowed.example', until: now + 60_000 }];
      } else {
        runtime.tabStates = {
          1: { muteUrl: null, priorMuted: false, stoppedDocumentId: 'document-id' },
        };
      }
      const local: FakeStorage = fakeStorage({
        ...localPolicy(setup),
        [LOCAL_RUNTIME]: runtime,
      });
      const sync: FakeStorage = fakeStorage({ [SYNC_SETTINGS]: SNAPSHOT.settings });
      const storage: PolicyStorage = policyStorage(local, sync);

      await expect(storage.deleteRemoteData('all')).rejects.toThrow(
        'stop the active session and blocking state before deleting all data',
      );

      expect(local.state.values[LOCAL_RUNTIME]).toEqual(runtime);
      expect(sync.state.values[SYNC_SETTINGS]).toEqual(SNAPSHOT.settings);
      expect(local.area.set).not.toHaveBeenCalled();
      expect(local.area.remove).not.toHaveBeenCalled();
      expect(sync.area.set).not.toHaveBeenCalled();
      expect(sync.area.remove).not.toHaveBeenCalled();
    },
  );

  it('does not resume an all-data journal until durable runtime is stopped', async (): Promise<void> => {
    const setup: SetupState = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'local',
      dataClear: { status: 'pending', scope: 'all', phase: 'remote' },
    };
    const runtime: RuntimeState = runtimeWithActiveSession(Date.now());
    const journal = { scope: 'all', phase: 'remote', inventory: [SYNC_SETTINGS] };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_RUNTIME]: runtime,
      [LOCAL_DATA_CLEAR_JOURNAL]: journal,
    });
    const sync: FakeStorage = fakeStorage({ [SYNC_SETTINGS]: SNAPSHOT.settings });
    const storage: PolicyStorage = policyStorage(local, sync);

    await expect(storage.initialize()).resolves.toBeUndefined();

    expect(local.state.values[LOCAL_RUNTIME]).toEqual(runtime);
    expect(local.state.values[LOCAL_DATA_CLEAR_JOURNAL]).toEqual(journal);
    expect(sync.state.values[SYNC_SETTINGS]).toEqual(SNAPSHOT.settings);
    expect(await storage.loadSetup()).toMatchObject({
      dataClear: { status: 'error', scope: 'all', phase: 'remote' },
      storageError: 'remote-deletion-failed',
    });
    expect(local.area.remove).not.toHaveBeenCalled();
    expect(sync.area.set).not.toHaveBeenCalled();
    expect(sync.area.remove).not.toHaveBeenCalled();
  });

  it('preserves stopped runtime and matcher cache when remote all-data deletion fails', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const runtime: RuntimeState = emptyRuntime(Date.now());
    runtime.commitCheckpoint = {
      bank: SNAPSHOT.bank,
      events: [],
      syncBank: true,
    };
    const cache = { matcher: true };
    const history: Record<string, unknown>[] = [{ id: 'event-1', type: 'attempt', at: Date.now() }];
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_RUNTIME]: runtime,
      [LOCAL_CACHES]: cache,
      [LOCAL_EVENTS]: history,
    });
    const sync: FakeStorage = fakeStorage({ [SYNC_SETTINGS]: SNAPSHOT.settings });
    sync.state.failRemove = new Error('remote removal unavailable');
    let retainedQuiescence: boolean = false;
    const storage: PolicyStorage = createPolicyStorage(local.area, sync.area, EMPTY_CHECKPOINT, {
      runExclusive: async <T>(
        operation: () => Promise<T>,
        retainQuiescence: () => boolean,
      ): Promise<T> => {
        try {
          return await operation();
        } catch (error: unknown) {
          retainedQuiescence = retainQuiescence();
          throw error;
        }
      },
    });

    await expect(storage.deleteRemoteData('all')).rejects.toThrow('remote removal unavailable');

    expect(retainedQuiescence).toBe(true);
    expect(local.state.values[LOCAL_RUNTIME]).toEqual(runtime);
    expect(local.state.values[LOCAL_CACHES]).toEqual(cache);
    expect(local.state.values[LOCAL_EVENTS]).toEqual(history);
    expect(local.state.values[LOCAL_SETTINGS]).toEqual(SNAPSHOT.settings);
    expect(local.state.values[LOCAL_DATA_CLEAR_JOURNAL]).toMatchObject({
      scope: 'all',
      phase: 'remote',
    });
  });

  it('retains a durable removal journal and error status after remote deletion fails', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage({ [SYNC_SETTINGS]: SNAPSHOT.settings });
    sync.state.failRemove = new Error('remote removal unavailable');
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();

    await expect(storage.deleteRemoteData('synced-policy')).rejects.toThrow(
      'remote removal unavailable',
    );

    expect(local.state.values[LOCAL_DATA_CLEAR_JOURNAL]).toEqual({
      scope: 'synced-policy',
      phase: 'remote',
      inventory: [SYNC_SETTINGS],
    });
    expect((await setupState(local)).syncWriteStatus).toBe('error');
    expect(local.state.values[LOCAL_SETTINGS]).toEqual(SNAPSHOT.settings);

    sync.state.failRemove = null;
    const restarted: PolicyStorage = policyStorage(local, sync);
    await restarted.initialize();

    expect(sync.state.values[SYNC_SETTINGS]).toBeUndefined();
    expect(local.state.values[LOCAL_DATA_CLEAR_JOURNAL]).toBeUndefined();
    expect((await setupState(local)).dataClear.status).toBe('idle');
  });

  it('preserves a failed deletion error when Local mode is selected again before and after restart', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage({ [SYNC_SETTINGS]: SNAPSHOT.settings });
    sync.state.failRemove = new Error('remote removal unavailable');
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();
    await expect(storage.deleteRemoteData('synced-policy')).rejects.toThrow(
      'remote removal unavailable',
    );
    const failedSetup: SetupState = await setupState(local);

    await expect(storage.selectLocalMode()).rejects.toThrow('data deletion');
    expect(await setupState(local)).toEqual(failedSetup);

    const restarted: PolicyStorage = policyStorage(local, sync);
    await restarted.initialize();
    const restartedFailure: SetupState = await restarted.loadSetup();
    await expect(restarted.selectLocalMode()).rejects.toThrow('data deletion');
    expect(await restarted.loadSetup()).toEqual(restartedFailure);
    expect(restartedFailure).toMatchObject({
      dataClear: { status: 'error', scope: 'synced-policy', phase: 'remote' },
      storageError: 'remote-deletion-failed',
    });
  });

  it('resumes an idle-setup deletion journal before normal publication recovery', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_DATA_CLEAR_JOURNAL]: {
        scope: 'synced-policy',
        phase: 'remote',
        inventory: [SYNC_SETTINGS],
      },
      [LOCAL_SYNC_JOURNAL]: {
        sets: { [SYNC_SETTINGS]: SNAPSHOT.settings },
        removes: [],
      },
    });
    const sync: FakeStorage = fakeStorage({ [SYNC_SETTINGS]: SNAPSHOT.settings });
    const storage: PolicyStorage = policyStorage(local, sync);

    await storage.initialize();

    expect(sync.state.values[SYNC_SETTINGS]).toBeUndefined();
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toEqual({ sets: {}, removes: [] });
    expect(local.state.values[LOCAL_DATA_CLEAR_JOURNAL]).toBeUndefined();
  });

  it('prevents a quota checkpoint from resurrecting deleted history', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const aggregateKey: string = 'aggm:device:2026-07';
    const aggregate = rollupMonth('2026-07', []);
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_SYNC_QUOTA_EVICTION]: {
        evicted: { [aggregateKey]: aggregate },
        setKeys: [],
      },
    });
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);

    await storage.deleteRemoteData('synced-policy');

    expect(sync.state.values[aggregateKey]).toBeUndefined();
    expect(local.state.values[LOCAL_SYNC_QUOTA_EVICTION]).toBeUndefined();
  });

  it('retries the local phase after remote success without clearing unrelated data', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const local: FakeStorage = fakeStorage({ ...localPolicy(setup), unrelated: 'keep' });
    const sync: FakeStorage = fakeStorage({ [SYNC_SETTINGS]: SNAPSHOT.settings });
    let retainedQuiescence: boolean = false;
    const storage: PolicyStorage = createPolicyStorage(local.area, sync.area, EMPTY_CHECKPOINT, {
      runExclusive: async <T>(
        operation: () => Promise<T>,
        retainQuiescence: () => boolean,
      ): Promise<T> => {
        try {
          return await operation();
        } catch (error: unknown) {
          retainedQuiescence = retainQuiescence();
          throw error;
        }
      },
    });
    let failLocalClear: boolean = true;
    vi.mocked(local.area.remove).mockImplementation(
      async (keys: string | string[]): Promise<void> => {
        const requested: string[] = typeof keys === 'string' ? [keys] : keys;
        if (failLocalClear && requested.includes(LOCAL_SETTINGS)) {
          throw new Error('local clear interrupted');
        }
        for (const key of requested) delete local.state.values[key];
      },
    );

    await expect(storage.deleteRemoteData('all')).rejects.toThrow('local clear interrupted');

    expect(retainedQuiescence).toBe(true);
    expect(sync.state.values[SYNC_SETTINGS]).toBeUndefined();
    expect(local.state.values[LOCAL_DATA_CLEAR_JOURNAL]).toMatchObject({
      scope: 'all',
      phase: 'local',
    });
    expect((await setupState(local)).storageError).toBe('local-clear-failed');

    failLocalClear = false;
    let barrierRuns: number = 0;
    const restarted: PolicyStorage = createPolicyStorage(local.area, sync.area, EMPTY_CHECKPOINT, {
      runExclusive: async <T>(operation: () => Promise<T>): Promise<T> => {
        barrierRuns += 1;
        return operation();
      },
    });
    await restarted.initialize();

    expect(barrierRuns).toBe(1);
    expect(local.state.values.unrelated).toBe('keep');
    expect(await restarted.loadSetup()).toEqual(DEFAULT_SETUP);
  });

  it('rejects remote deletion while sync mode can still publish', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'sync' };
    const storage: PolicyStorage = policyStorage(fakeStorage(localPolicy(setup)), fakeStorage());
    await storage.initialize();

    await expect(storage.deleteRemoteData('synced-policy')).rejects.toThrow(
      'disable sync before deleting',
    );
  });

  it.each(['pending', 'error'] as const)(
    'rejects enabling Sync while synced-policy deletion is %s without any remote write',
    async (status): Promise<void> => {
      const setup: SetupState = {
        ...DEFAULT_SETUP,
        storageMode: 'local',
        dataClear: { status, scope: 'synced-policy', phase: 'remote' },
        storageError: status === 'error' ? 'remote-deletion-failed' : null,
      };
      const local: FakeStorage = fakeStorage(localPolicy(setup));
      const sync: FakeStorage = fakeStorage();
      const storage: PolicyStorage = policyStorage(local, sync);
      await storage.initialize();
      vi.mocked(sync.area.get).mockClear();
      vi.mocked(sync.area.set).mockClear();
      vi.mocked(sync.area.remove).mockClear();

      await expect(storage.enableSync()).rejects.toThrow('data deletion');

      expect(await storage.storageMode()).toBe('local');
      expect(sync.area.get).not.toHaveBeenCalled();
      expect(sync.area.set).not.toHaveBeenCalled();
      expect(sync.area.remove).not.toHaveBeenCalled();
    },
  );

  it('serves validated setup state while a first Sync checkpoint is stalled', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    let releaseCheckpoint: () => void = (): void => undefined;
    let signalCheckpointStarted: () => void = (): void => undefined;
    const checkpointBlocked: Promise<void> = new Promise<void>((resolve: () => void): void => {
      releaseCheckpoint = resolve;
    });
    const checkpointStarted: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalCheckpointStarted = resolve;
    });
    const storage: PolicyStorage = createPolicyStorage(
      local.area,
      sync.area,
      {
        loadAggregateItems: async (): Promise<Record<string, unknown>> => {
          signalCheckpointStarted();
          await checkpointBlocked;
          return {};
        },
      },
      DIRECT_ALL_DATA_CLEAR_BARRIER,
    );
    await storage.initialize();

    const enabling: Promise<void> = storage.enableSync();
    await checkpointStarted;
    let setupRead: SetupState | null = null;
    const reading: Promise<void> = storage.loadSetup().then((value: SetupState): void => {
      setupRead = value;
    });
    for (let index: number = 0; index < 10; index += 1) await Promise.resolve();

    try {
      expect(setupRead).toEqual(setup);
    } finally {
      releaseCheckpoint();
      await Promise.all([enabling, reading]);
    }
  });

  it('preserves the advanced local phase when boot recovery fails after remote success', async (): Promise<void> => {
    const setup: SetupState = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'local',
      dataClear: { status: 'pending', scope: 'all', phase: 'remote' },
    };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_RUNTIME]: emptyRuntime(Date.now()),
      [LOCAL_DATA_CLEAR_JOURNAL]: {
        scope: 'all',
        phase: 'remote',
        inventory: [SYNC_SETTINGS],
      },
    });
    const sync: FakeStorage = fakeStorage({ [SYNC_SETTINGS]: DEFAULT_SETTINGS });
    const storage: PolicyStorage = policyStorage(local, sync);
    vi.mocked(local.area.remove).mockImplementation(
      async (keys: string | string[]): Promise<void> => {
        const requested: string[] = typeof keys === 'string' ? [keys] : keys;
        if (requested.includes(LOCAL_SETTINGS)) throw new Error('local clear unavailable');
        for (const key of requested) delete local.state.values[key];
      },
    );

    await storage.initialize();

    expect(local.state.values[LOCAL_DATA_CLEAR_JOURNAL]).toMatchObject({
      scope: 'all',
      phase: 'local',
    });
    expect(await storage.loadSetup()).toMatchObject({
      dataClear: { status: 'error', scope: 'all', phase: 'local' },
      storageError: 'local-clear-failed',
    });
  });

  it('clears detailed and aggregate history in local mode without touching policy', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_EVENTS]: [{ t: 'sessionCompleted', at: 1, focusedMs: 1 }],
      'agg:device:2026-08-31': emptyDaily('2026-08-31'),
      'aggm:device:2026-08': rollupMonth('2026-08', [emptyDaily('2026-08-31')]),
      'archive:clock-rebase:device:one': emptyDaily('2026-08-30'),
      [LOCAL_AGGREGATE_PRUNE]: { remove: [], set: {} },
      [LOCAL_AGGREGATE_TOMBSTONES]: ['agg:device:2026-08-30'],
      [LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]: { version: 1, items: {} },
    });
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();
    local.state.values['agg:malformed'] = { stale: true };
    local.state.values['aggm:malformed'] = { stale: true };
    local.state.values[LOCAL_SYNC_QUOTA_EVICTION] = {
      evicted: { 'agg:device:2026-08-30': emptyDaily('2026-08-30') },
      setKeys: [],
    };

    await expect(storage.clearLocalHistory()).resolves.toBe(true);
    await storage.finishLocalHistoryClear();

    expect(local.state.values[LOCAL_EVENTS]).toBeUndefined();
    expect(local.state.values['agg:device:2026-08-31']).toBeUndefined();
    expect(local.state.values['aggm:device:2026-08']).toBeUndefined();
    expect(local.state.values['archive:clock-rebase:device:one']).toBeUndefined();
    expect(local.state.values['agg:malformed']).toBeUndefined();
    expect(local.state.values['aggm:malformed']).toBeUndefined();
    expect(local.state.values[LOCAL_SYNC_QUOTA_EVICTION]).toBeUndefined();
    expect(local.state.values[LOCAL_AGGREGATE_PRUNE]).toBeUndefined();
    expect(local.state.values[LOCAL_AGGREGATE_TOMBSTONES]).toBeUndefined();
    expect(local.state.values[LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]).toBeUndefined();
    expect(local.state.values[LOCAL_SETTINGS]).toEqual(SNAPSHOT.settings);
    expect(local.state.values[LOCAL_LISTS]).toEqual(SNAPSHOT.lists);
    expect(local.state.values[LOCAL_BANK]).toEqual(SNAPSHOT.bank);
    expect(local.state.values[LOCAL_STREAK]).toEqual(SNAPSHOT.streak);

    await storage.enableSync();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sync.state.values['agg:device:2026-08-30']).toBeUndefined();
  });

  it('keeps a durable local-history transaction pending until runtime sanitization finishes', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_EVENTS]: [{ t: 'sessionCompleted', at: 1, focusedMs: 1 }],
      'agg:device:2026-08-31': emptyDaily('2026-08-31'),
    });
    const storage: PolicyStorage = policyStorage(local, fakeStorage());
    await storage.initialize();

    await expect(storage.clearLocalHistory()).resolves.toBe(true);

    expect(local.state.values[LOCAL_DATA_CLEAR_JOURNAL]).toEqual({
      scope: 'local-history',
      phase: 'runtime',
      inventory: [],
      clearAggregates: true,
      priorStorageError: null,
    });
    expect(await storage.loadSetup()).toMatchObject({
      completed: true,
      storageMode: 'local',
      dataClear: { status: 'pending', scope: 'local-history', phase: 'runtime' },
      storageError: null,
    });

    await storage.finishLocalHistoryClear();

    expect(local.state.values[LOCAL_DATA_CLEAR_JOURNAL]).toBeUndefined();
    expect(await storage.loadSetup()).toMatchObject({
      completed: true,
      storageMode: 'local',
      dataClear: { status: 'idle', scope: null, phase: null },
      storageError: null,
    });
  });

  it('upgrades a pending local-history journal written before prior errors were captured', async (): Promise<void> => {
    const setup: SetupState = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'local',
      dataClear: { status: 'pending', scope: 'local-history', phase: 'runtime' },
    };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_DATA_CLEAR_JOURNAL]: {
        scope: 'local-history',
        phase: 'runtime',
        inventory: [],
        clearAggregates: true,
      },
    });
    const storage: PolicyStorage = policyStorage(local, fakeStorage());

    await storage.initialize();

    expect(local.state.values[LOCAL_DATA_CLEAR_JOURNAL]).toEqual({
      scope: 'local-history',
      phase: 'runtime',
      inventory: [],
      clearAggregates: true,
      priorStorageError: null,
    });
    await storage.finishLocalHistoryClear();
    expect(await storage.loadSetup()).toMatchObject({
      storageError: null,
      dataClear: { status: 'idle', scope: null, phase: null },
    });
  });

  it('rejects an invalid prior error in a local-history journal', async (): Promise<void> => {
    const setup: SetupState = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'local',
      dataClear: { status: 'pending', scope: 'local-history', phase: 'runtime' },
    };
    const storage: PolicyStorage = policyStorage(
      fakeStorage({
        ...localPolicy(setup),
        [LOCAL_DATA_CLEAR_JOURNAL]: {
          scope: 'local-history',
          phase: 'runtime',
          inventory: [],
          clearAggregates: true,
          priorStorageError: 'not-a-storage-error',
        },
      }),
      fakeStorage(),
    );

    await expect(storage.initialize()).rejects.toThrow('invalid data clear journal');
  });

  it.each([
    {
      name: 'Sync publication',
      storageError: 'sync-publish-failed' as const,
      syncWriteStatus: 'error' as const,
      legacyImported: true,
    },
    {
      name: 'legacy migration',
      storageError: 'legacy-migration-failed' as const,
      syncWriteStatus: 'idle' as const,
      legacyImported: false,
    },
  ])(
    'restores a pre-existing $name error after a successful local-history clear',
    async ({ storageError, syncWriteStatus, legacyImported }): Promise<void> => {
      const setup: SetupState = {
        ...DEFAULT_SETUP,
        completed: true,
        storageMode: 'local',
        storageError,
        syncWriteStatus,
        legacyImported,
      };
      const local: FakeStorage = fakeStorage({
        ...localPolicy(setup),
        [LOCAL_EVENTS]: [{ t: 'sessionCompleted', at: 1, focusedMs: 1 }],
      });
      const storage: PolicyStorage = policyStorage(local, fakeStorage());
      await storage.initialize();

      await expect(storage.clearLocalHistory()).resolves.toBe(true);

      expect(local.state.values[LOCAL_DATA_CLEAR_JOURNAL]).toMatchObject({
        scope: 'local-history',
        phase: 'runtime',
        priorStorageError: storageError,
      });
      expect(await storage.loadSetup()).toMatchObject({
        storageError,
        syncWriteStatus,
        legacyImported,
        dataClear: { status: 'pending', scope: 'local-history', phase: 'runtime' },
      });

      await storage.finishLocalHistoryClear();

      expect(await storage.loadSetup()).toMatchObject({
        storageError,
        syncWriteStatus,
        legacyImported,
        dataClear: { status: 'idle', scope: null, phase: null },
      });
    },
  );

  it.each([
    {
      name: 'Sync publication',
      storageError: 'sync-publish-failed' as const,
      syncWriteStatus: 'error' as const,
      legacyImported: true,
    },
    {
      name: 'legacy migration',
      storageError: 'legacy-migration-failed' as const,
      syncWriteStatus: 'idle' as const,
      legacyImported: false,
    },
  ])(
    'recovers a failed local-history clear without losing the prior $name error',
    async ({ storageError, syncWriteStatus, legacyImported }): Promise<void> => {
      const setup: SetupState = {
        ...DEFAULT_SETUP,
        completed: true,
        storageMode: 'local',
        storageError,
        syncWriteStatus,
        legacyImported,
      };
      const event: EventRecord = { t: 'sessionCompleted', at: 1, focusedMs: 1 };
      const local: FakeStorage = fakeStorage({
        ...localPolicy(setup),
        [LOCAL_EVENTS]: [event],
      });
      const first: PolicyStorage = policyStorage(local, fakeStorage());
      await first.initialize();
      vi.mocked(local.area.remove).mockRejectedValueOnce(new Error('history unavailable'));

      await expect(first.clearLocalHistory()).rejects.toThrow('history unavailable');

      expect(local.state.values[LOCAL_EVENTS]).toEqual([event]);
      expect(local.state.values[LOCAL_DATA_CLEAR_JOURNAL]).toMatchObject({
        scope: 'local-history',
        phase: 'local',
        priorStorageError: storageError,
      });
      expect(await first.loadSetup()).toMatchObject({
        storageError: 'local-clear-failed',
        syncWriteStatus,
        legacyImported,
        dataClear: { status: 'error', scope: 'local-history', phase: 'local' },
      });

      const restarted: PolicyStorage = policyStorage(local, fakeStorage());
      await restarted.initialize();

      expect(local.state.values[LOCAL_EVENTS]).toBeUndefined();
      expect(local.state.values[LOCAL_DATA_CLEAR_JOURNAL]).toMatchObject({
        scope: 'local-history',
        phase: 'runtime',
        priorStorageError: storageError,
      });
      expect(await restarted.loadSetup()).toMatchObject({
        storageError,
        syncWriteStatus,
        legacyImported,
        dataClear: { status: 'pending', scope: 'local-history', phase: 'runtime' },
      });
      await restarted.finishLocalHistoryClear();
      expect(await restarted.loadSetup()).toMatchObject({
        storageError,
        syncWriteStatus,
        legacyImported,
        dataClear: { status: 'idle', scope: null, phase: null },
      });
    },
  );

  it('restores the exact runtime-phase status when transaction cleanup fails', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_EVENTS]: [{ t: 'sessionCompleted', at: 1, focusedMs: 1 }],
    });
    const storage: PolicyStorage = policyStorage(local, fakeStorage());
    await storage.initialize();
    await storage.clearLocalHistory();
    vi.mocked(local.area.remove).mockImplementationOnce(async (): Promise<void> => {
      throw new Error('journal cleanup unavailable');
    });

    await expect(storage.finishLocalHistoryClear()).rejects.toThrow('journal cleanup unavailable');

    expect(local.state.values[LOCAL_DATA_CLEAR_JOURNAL]).toMatchObject({
      scope: 'local-history',
      phase: 'runtime',
    });
    expect(await storage.loadSetup()).toMatchObject({
      dataClear: { status: 'error', scope: 'local-history', phase: 'runtime' },
      storageError: 'local-clear-failed',
    });

    await expect(storage.finishLocalHistoryClear()).resolves.toBeUndefined();
    expect(await storage.loadSetup()).toMatchObject({
      dataClear: { status: 'idle', scope: null, phase: null },
      storageError: null,
    });
  });

  it('rolls back history removal and retains an exact retry journal when removal fails', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const event: EventRecord = { t: 'sessionCompleted', at: 1, focusedMs: 1 };
    const aggregate: DailyAgg = emptyDaily('2026-08-31');
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_EVENTS]: [event],
      'agg:device:2026-08-31': aggregate,
    });
    const storage: PolicyStorage = policyStorage(local, fakeStorage());
    await storage.initialize();
    vi.mocked(local.area.remove).mockImplementationOnce(
      async (keys: string | string[]): Promise<void> => {
        const requested: string[] = typeof keys === 'string' ? [keys] : keys;
        for (const key of requested) delete local.state.values[key];
        throw new Error('history removal interrupted');
      },
    );

    await expect(storage.clearLocalHistory()).rejects.toThrow('history removal interrupted');

    expect(local.state.values[LOCAL_EVENTS]).toEqual([event]);
    expect(local.state.values['agg:device:2026-08-31']).toEqual(aggregate);
    expect(local.state.values[LOCAL_DATA_CLEAR_JOURNAL]).toMatchObject({
      scope: 'local-history',
      phase: 'local',
      clearAggregates: true,
    });
    expect(await storage.loadSetup()).toMatchObject({
      dataClear: { status: 'error', scope: 'local-history', phase: 'local' },
      storageError: 'local-clear-failed',
    });

    const restarted: PolicyStorage = policyStorage(local, fakeStorage());
    await restarted.initialize();
    await expect(restarted.pendingLocalHistoryClear()).resolves.toEqual({
      clearAggregates: true,
    });
    await expect(restarted.clearLocalHistory()).resolves.toBe(true);
    await restarted.finishLocalHistoryClear();

    expect(local.state.values[LOCAL_EVENTS]).toBeUndefined();
    expect(local.state.values['agg:device:2026-08-31']).toBeUndefined();
    expect(await restarted.loadSetup()).toMatchObject({
      dataClear: { status: 'idle', scope: null, phase: null },
      storageError: null,
    });
  });

  it('removes failed first-Sync aggregate intent while preserving policy retry across restart', async (): Promise<void> => {
    const policySettings: Settings = { ...DEFAULT_SETTINGS, theme: 'dark' };
    const setup: SetupState = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'local',
      syncWriteStatus: 'pending',
      storageError: 'sync-publish-failed',
    };
    const aggregateSetKey: string = syncAggKey('device-a', '2026-08-31');
    const aggregateRemoveKey: string = syncAggKey('device-a', '2026-08-30');
    const pruneKey: string = 'prune:device-a';
    const pruneValue: { remove: string[] } = { remove: [aggregateRemoveKey] };
    const aggregate: DailyAgg = { ...emptyDaily('2026-08-31'), focusMs: 42_000 };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_SETTINGS]: policySettings,
      [LOCAL_EVENTS]: [{ t: 'sessionCompleted', at: 1, focusedMs: 1 }],
      [aggregateSetKey]: aggregate,
      [LOCAL_SYNC_JOURNAL]: {
        sets: {
          [SYNC_SETTINGS]: policySettings,
          [aggregateSetKey]: aggregate,
          [pruneKey]: pruneValue,
        },
        removes: [aggregateRemoveKey],
      },
    });
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();
    const reconstructed: SyncJournal = structuredClone(
      local.state.values[LOCAL_SYNC_JOURNAL] as SyncJournal,
    );

    await expect(storage.clearLocalHistory()).resolves.toBe(true);

    const filtered: SyncJournal = local.state.values[LOCAL_SYNC_JOURNAL] as SyncJournal;
    expect(filtered.sets[SYNC_SETTINGS]).toEqual(policySettings);
    expect(filtered.sets[pruneKey]).toEqual(pruneValue);
    expect(filtered.sets[aggregateSetKey]).toBeUndefined();
    expect(filtered.removes).not.toContain(aggregateRemoveKey);
    expect(
      Object.keys(filtered.sets).filter((key: string): boolean => key.startsWith('agg')),
    ).toEqual([]);
    expect(filtered.removes.filter((key: string): boolean => key.startsWith('agg'))).toEqual([]);
    expect(
      Object.fromEntries(
        Object.entries(filtered.sets).filter(
          ([key]: [string, unknown]): boolean => !key.startsWith('agg'),
        ),
      ),
    ).toEqual(
      Object.fromEntries(
        Object.entries(reconstructed.sets).filter(
          ([key]: [string, unknown]): boolean => !key.startsWith('agg'),
        ),
      ),
    );
    expect(storage.hasPendingRemote(aggregateSetKey)).toBe(false);
    expect(storage.hasPendingRemote(aggregateRemoveKey)).toBe(false);
    expect(storage.hasPendingRemote(SYNC_SETTINGS)).toBe(true);
    expect(local.state.values[aggregateSetKey]).toBeUndefined();

    const interruptedRestart: PolicyStorage = policyStorage(local, sync);
    await interruptedRestart.initialize();
    await expect(interruptedRestart.pendingLocalHistoryClear()).resolves.toEqual({
      clearAggregates: true,
    });
    expect(local.state.values[aggregateSetKey]).toBeUndefined();
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toEqual(filtered);
    await interruptedRestart.finishLocalHistoryClear();

    const completedRestart: PolicyStorage = policyStorage(local, sync);
    await completedRestart.initialize();
    expect(completedRestart.hasPendingRemote(aggregateSetKey)).toBe(false);
    expect(completedRestart.hasPendingRemote(aggregateRemoveKey)).toBe(false);
    expect(completedRestart.hasPendingRemote(SYNC_SETTINGS)).toBe(true);
    await completedRestart.enableSync();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sync.state.values[SYNC_SETTINGS]).toEqual(policySettings);
    expect(sync.state.values[aggregateSetKey]).toBeUndefined();
    expect(local.state.values[aggregateSetKey]).toBeUndefined();
  });

  it.each(['publishing', 'remote-complete'] as const)(
    'strips aggregate history from the %s first-Sync checkpoint and live outbox',
    async (phase: 'publishing' | 'remote-complete'): Promise<void> => {
      const setup: SetupState = {
        ...DEFAULT_SETUP,
        completed: true,
        storageMode: 'local',
        syncWriteStatus: 'pending',
        storageError: 'sync-publish-failed',
      };
      const dailyKey: string = syncAggKey('device-a', '2026-08-31');
      const monthlyKey: string = 'aggm:device-a:2026-08';
      const removedKey: string = syncAggKey('device-a', '2026-08-30');
      const daily: DailyAgg = { ...emptyDaily('2026-08-31'), focusMs: 42_000 };
      const monthly: MonthlyAgg = rollupMonth('2026-08', [daily]);
      const pending: SyncJournal = {
        sets: {
          [SYNC_SETTINGS]: SNAPSHOT.settings,
          [dailyKey]: daily,
          [monthlyKey]: monthly,
        },
        removes: [SYNC_STREAK, removedKey],
      };
      const local: FakeStorage = fakeStorage({
        ...localPolicy(setup),
        [LOCAL_EVENTS]: [{ t: 'sessionCompleted', at: 1, focusedMs: 1 }],
        [dailyKey]: daily,
        [monthlyKey]: monthly,
        [LOCAL_SYNC_JOURNAL]: pending,
        [FIRST_SYNC_PUBLICATION_KEY]: {
          version: 1,
          phase,
          publication: pending,
        },
      });
      const storage: PolicyStorage = policyStorage(local, fakeStorage());
      await storage.initialize();

      await expect(storage.clearLocalHistory()).resolves.toBe(true);

      const filteredJournal: SyncJournal = local.state.values[LOCAL_SYNC_JOURNAL] as SyncJournal;
      const filteredCheckpoint = local.state.values[FIRST_SYNC_PUBLICATION_KEY] as {
        phase: string;
        publication: SyncJournal;
        version: number;
      };
      expect(filteredJournal).toEqual({
        sets: { [SYNC_SETTINGS]: SNAPSHOT.settings },
        removes: [SYNC_STREAK],
      });
      expect(filteredCheckpoint).toEqual({
        version: 1,
        phase,
        publication: filteredJournal,
      });
      expect(storage.hasPendingRemote(dailyKey)).toBe(false);
      expect(storage.hasPendingRemote(monthlyKey)).toBe(false);
      expect(storage.hasPendingRemote(removedKey)).toBe(false);
      expect(storage.hasPendingRemote(SYNC_SETTINGS)).toBe(true);
      expect(local.state.values[dailyKey]).toBeUndefined();
      expect(local.state.values[monthlyKey]).toBeUndefined();

      const restarted: PolicyStorage = policyStorage(local, fakeStorage());
      await restarted.initialize();
      await restarted.finishLocalHistoryClear();
      const completedRestart: PolicyStorage = policyStorage(local, fakeStorage());
      await completedRestart.initialize();

      expect(local.state.values[LOCAL_SYNC_JOURNAL]).toEqual(filteredJournal);
      expect(local.state.values[FIRST_SYNC_PUBLICATION_KEY]).toEqual(filteredCheckpoint);
      expect(completedRestart.hasPendingRemote(dailyKey)).toBe(false);
      expect(completedRestart.hasPendingRemote(monthlyKey)).toBe(false);
      expect(completedRestart.hasPendingRemote(removedKey)).toBe(false);
      expect(completedRestart.hasPendingRemote(SYNC_SETTINGS)).toBe(true);
    },
  );

  it('keeps checkpoint, outbox, and history exact when their filtered write fails', async (): Promise<void> => {
    const setup: SetupState = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'local',
      syncWriteStatus: 'pending',
      storageError: 'sync-publish-failed',
    };
    const dailyKey: string = syncAggKey('device-a', '2026-08-31');
    const monthlyKey: string = 'aggm:device-a:2026-08';
    const removedKey: string = syncAggKey('device-a', '2026-08-30');
    const daily: DailyAgg = { ...emptyDaily('2026-08-31'), focusMs: 42_000 };
    const monthly: MonthlyAgg = rollupMonth('2026-08', [daily]);
    const pending: SyncJournal = {
      sets: {
        [SYNC_SETTINGS]: SNAPSHOT.settings,
        [dailyKey]: daily,
        [monthlyKey]: monthly,
      },
      removes: [removedKey],
    };
    const checkpoint = { version: 1, phase: 'publishing', publication: pending } as const;
    const event: EventRecord = { t: 'sessionCompleted', at: 1, focusedMs: 1 };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_EVENTS]: [event],
      [dailyKey]: daily,
      [monthlyKey]: monthly,
      [LOCAL_SYNC_JOURNAL]: pending,
      [FIRST_SYNC_PUBLICATION_KEY]: checkpoint,
    });
    const storage: PolicyStorage = policyStorage(local, fakeStorage());
    await storage.initialize();
    let failFilteredCheckpoint: boolean = true;
    vi.mocked(local.area.set).mockImplementation(
      async (items: Record<string, unknown>): Promise<void> => {
        const candidate: unknown = items[FIRST_SYNC_PUBLICATION_KEY];
        if (
          failFilteredCheckpoint &&
          typeof candidate === 'object' &&
          candidate !== null &&
          !Object.hasOwn((candidate as { publication: SyncJournal }).publication.sets, dailyKey)
        ) {
          failFilteredCheckpoint = false;
          throw new Error('filtered checkpoint unavailable');
        }
        Object.assign(local.state.values, structuredClone(items));
      },
    );

    await expect(storage.clearLocalHistory()).rejects.toThrow('filtered checkpoint unavailable');

    expect(local.state.values[LOCAL_EVENTS]).toEqual([event]);
    expect(local.state.values[dailyKey]).toEqual(daily);
    expect(local.state.values[monthlyKey]).toEqual(monthly);
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toEqual(pending);
    expect(local.state.values[FIRST_SYNC_PUBLICATION_KEY]).toEqual(checkpoint);
    expect(storage.hasPendingRemote(dailyKey)).toBe(true);
    expect(storage.hasPendingRemote(monthlyKey)).toBe(true);
    expect(storage.hasPendingRemote(removedKey)).toBe(true);

    await expect(storage.clearLocalHistory()).resolves.toBe(true);
    const filteredJournal: SyncJournal = local.state.values[LOCAL_SYNC_JOURNAL] as SyncJournal;
    const filteredCheckpoint = local.state.values[FIRST_SYNC_PUBLICATION_KEY] as {
      publication: SyncJournal;
    };
    expect(filteredJournal).toEqual({
      sets: { [SYNC_SETTINGS]: SNAPSHOT.settings },
      removes: [],
    });
    expect(filteredCheckpoint.publication).toEqual(filteredJournal);
    expect(storage.hasPendingRemote(dailyKey)).toBe(false);
    expect(storage.hasPendingRemote(monthlyKey)).toBe(false);
    expect(storage.hasPendingRemote(removedKey)).toBe(false);
  });

  it('keeps history and aggregate publication intent pending when journal filtering fails', async (): Promise<void> => {
    const policySettings: Settings = { ...DEFAULT_SETTINGS, theme: 'dark' };
    const setup: SetupState = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'local',
      syncWriteStatus: 'pending',
    };
    const aggregateKey: string = syncAggKey('device-a', '2026-08-31');
    const aggregate: DailyAgg = { ...emptyDaily('2026-08-31'), focusMs: 42_000 };
    const event: EventRecord = { t: 'sessionCompleted', at: 1, focusedMs: 1 };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_SETTINGS]: policySettings,
      [LOCAL_EVENTS]: [event],
      [aggregateKey]: aggregate,
      [LOCAL_SYNC_JOURNAL]: {
        sets: { [SYNC_SETTINGS]: policySettings, [aggregateKey]: aggregate },
        removes: [],
      },
    });
    const storage: PolicyStorage = policyStorage(local, fakeStorage());
    await storage.initialize();
    let failFilteredJournal: boolean = true;
    vi.mocked(local.area.set).mockImplementation(
      async (items: Record<string, unknown>): Promise<void> => {
        const journal: SyncJournal | undefined = items[LOCAL_SYNC_JOURNAL] as
          | SyncJournal
          | undefined;
        if (
          failFilteredJournal &&
          journal !== undefined &&
          !Object.hasOwn(journal.sets, aggregateKey)
        ) {
          failFilteredJournal = false;
          throw new Error('filtered journal unavailable');
        }
        Object.assign(local.state.values, structuredClone(items));
      },
    );

    await expect(storage.clearLocalHistory()).rejects.toThrow('filtered journal unavailable');

    expect(local.state.values[LOCAL_EVENTS]).toEqual([event]);
    expect(local.state.values[aggregateKey]).toEqual(aggregate);
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toMatchObject({
      sets: { [SYNC_SETTINGS]: policySettings, [aggregateKey]: aggregate },
    });
    expect(await storage.loadSetup()).toMatchObject({
      dataClear: { status: 'error', scope: 'local-history', phase: 'local' },
      storageError: 'local-clear-failed',
    });

    await expect(storage.clearLocalHistory()).resolves.toBe(true);
    expect(local.state.values[LOCAL_SYNC_JOURNAL]).toMatchObject({
      sets: { [SYNC_SETTINGS]: policySettings },
    });
    expect(
      (local.state.values[LOCAL_SYNC_JOURNAL] as SyncJournal).sets[aggregateKey],
    ).toBeUndefined();
    await storage.finishLocalHistoryClear();
  });

  it('clears only detailed local events while Sync owns aggregate history', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'sync' };
    const aggregate = emptyDaily('2026-08-31');
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_EVENTS]: [{ t: 'sessionCompleted', at: 1, focusedMs: 1 }],
      'agg:device:2026-08-31': aggregate,
    });
    const storage: PolicyStorage = policyStorage(local, fakeStorage());
    await storage.initialize();

    await expect(storage.clearLocalHistory()).resolves.toBe(false);
    await storage.finishLocalHistoryClear();

    expect(local.state.values[LOCAL_EVENTS]).toBeUndefined();
    expect(local.state.values['agg:device:2026-08-31']).toEqual(aggregate);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeListsSyncSnapshot } from '../../../src/background/list-sync-codec';
import {
  createPolicyStorage,
  type PolicySnapshot,
  type PolicyStorage,
} from '../../../src/background/policy-storage';
import { emptyRuntime } from '../../../src/background/stores';
import type { SyncJournal } from '../../../src/background/sync-writer';
import { emptyDaily, rollupMonth } from '../../../src/core/stats';
import {
  CATEGORY_IDS,
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  DEFAULT_SETUP,
} from '../../../src/shared/constants';
import {
  LOCAL_BANK,
  LOCAL_CACHES,
  LOCAL_DATA_CLEAR_JOURNAL,
  LOCAL_DEVICE_ID,
  LOCAL_LISTS,
  LOCAL_POLICY_COMMIT,
  LOCAL_POLICY_GENERATION_PREFIX,
  LOCAL_SETTINGS,
  LOCAL_SETUP,
  LOCAL_STREAK,
  LOCAL_SYNC_JOURNAL,
  LOCAL_SYNC_QUOTA_EVICTION,
  SYNC_BANK,
  SYNC_LISTS,
  SYNC_SETTINGS,
  SYNC_STREAK,
} from '../../../src/shared/storage-keys';
import type { ListsConfig, Settings, SetupState, StreakState } from '../../../src/shared/types';

interface FakeAreaState {
  values: Record<string, unknown>;
  failGet: Error | null;
  failSet: Error | null;
  failRemove: Error | null;
  suppressNextSet: boolean;
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

function fakeStorage(initial: Record<string, unknown> = {}): FakeStorage {
  const state: FakeAreaState = {
    values: structuredClone(initial),
    failGet: null,
    failSet: null,
    failRemove: null,
    suppressNextSet: false,
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
        return selectedValues(state.values, keys);
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

const EMPTY_CHECKPOINT = {
  loadAggregateItems: async (): Promise<Record<string, unknown>> => ({}),
};

function policyStorage(local: FakeStorage, sync: FakeStorage): PolicyStorage {
  return createPolicyStorage(local.area, sync.area, EMPTY_CHECKPOINT);
}

async function setupState(local: FakeStorage): Promise<SetupState> {
  const value: unknown = (await local.area.get(LOCAL_SETUP))[LOCAL_SETUP];
  if (typeof value !== 'object' || value === null) throw new Error('setup missing');
  return value as SetupState;
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
      first.importLegacy(SNAPSHOT, emptyRuntime(Date.now()), null, { sets: {}, removes: [] }),
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
        'sync',
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
      first.importLegacy(SNAPSHOT, emptyRuntime(Date.now()), 'sync', {
        sets: { [SYNC_BANK]: SNAPSHOT.bank },
        removes: [],
      }),
    ).rejects.toThrow('setup repair interrupted');
    expect(local.state.values[LOCAL_POLICY_COMMIT]).toMatchObject({ source: 'generation' });

    sync.state.failGet = new Error('remote storage is offline');
    const restarted: PolicyStorage = policyStorage(local, sync);
    await restarted.initialize();

    expect((await setupState(local)).legacyImported).toBe(true);
    expect((await setupState(local)).storageMode).toBe('sync');
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
      first.importLegacy(SNAPSHOT, emptyRuntime(Date.now()), null, { sets: {}, removes: [] }),
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
    const storage: PolicyStorage = createPolicyStorage(local.area, sync.area, {
      loadAggregateItems: (): Promise<Record<string, unknown>> =>
        Promise.reject(new Error('aggregate checkpoint unavailable')),
    });
    await storage.initialize();

    await expect(storage.enableSync()).rejects.toThrow('aggregate checkpoint unavailable');

    expect((await setupState(local)).storageMode).toBe('local');
    expect((await setupState(local)).storageError).toBe('sync-publish-failed');
    expect(sync.area.set).not.toHaveBeenCalled();
  });

  it.each([SYNC_SETTINGS, SYNC_LISTS, SYNC_BANK, SYNC_STREAK])(
    'rejects a first-checkpoint contributor collision with %s',
    async (key: string): Promise<void> => {
      const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
      const local: FakeStorage = fakeStorage(localPolicy(setup));
      const sync: FakeStorage = fakeStorage();
      const storage: PolicyStorage = createPolicyStorage(local.area, sync.area, {
        loadAggregateItems: async (): Promise<Record<string, unknown>> => ({
          [key]: key === SYNC_BANK ? { balanceMs: 7 } : SNAPSHOT.settings,
        }),
      });

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

  it('resumes an empty sync writer when the final local-mode switch fails', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'sync' };
    const local: FakeStorage = fakeStorage(localPolicy(setup));
    const sync: FakeStorage = fakeStorage();
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();
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
    const nextBank = { balanceMs: 92_000 };
    await storage.setPolicy('bank', nextBank);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sync.state.values[SYNC_BANK]).toEqual(nextBank);
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

  it('clears every Focus Lock local key only after remote all-data deletion succeeds', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const local: FakeStorage = fakeStorage({
      ...localPolicy(setup),
      [LOCAL_CACHES]: { matcher: true },
      [LOCAL_DEVICE_ID]: 'device-id',
      unrelated: 'keep',
    });
    const sync: FakeStorage = fakeStorage({
      [SYNC_SETTINGS]: SNAPSHOT.settings,
      unrelated: 'keep',
    });
    const storage: PolicyStorage = policyStorage(local, sync);
    await storage.initialize();

    await storage.deleteRemoteData('all');

    expect(sync.state.values).toEqual({ unrelated: 'keep' });
    expect(local.state.values.unrelated).toBe('keep');
    expect(local.state.values[LOCAL_SETTINGS]).toBeUndefined();
    expect(local.state.values[LOCAL_CACHES]).toBeUndefined();
    expect(local.state.values[LOCAL_DEVICE_ID]).toBeUndefined();
    expect(await storage.loadSetup()).toEqual(DEFAULT_SETUP);
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
    const storage: PolicyStorage = policyStorage(local, sync);
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

    expect(sync.state.values[SYNC_SETTINGS]).toBeUndefined();
    expect(local.state.values[LOCAL_DATA_CLEAR_JOURNAL]).toMatchObject({
      scope: 'all',
      phase: 'local',
    });
    expect((await setupState(local)).storageError).toBe('local-clear-failed');

    failLocalClear = false;
    const restarted: PolicyStorage = policyStorage(local, sync);
    await restarted.initialize();

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
});

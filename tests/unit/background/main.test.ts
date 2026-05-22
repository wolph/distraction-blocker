import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnginePorts } from '../../../src/background/engine';
import { encodeListsForSync, LIST_SYNC_SHARD_KEYS } from '../../../src/background/list-sync-codec';
import { main } from '../../../src/background/main';
import { routeMessage } from '../../../src/background/router';
import { handleSyncChanges, missingSyncDefaults } from '../../../src/background/storage-sync';
import { SYNC_QUOTA_BYTES_TOTAL, syncItemBytes } from '../../../src/background/sync-quota';
import type { SyncJournal } from '../../../src/background/sync-writer';
import { ALL_CATEGORIES } from '../../../src/core/categories';
import {
  buildMatcherCache,
  type CompiledMatcherSet,
  evaluateUrl,
  type MatcherCacheBundle,
  type StoredMatcherCache,
} from '../../../src/core/matcher';
import { emptyDaily, rollupMonth } from '../../../src/core/stats';
import { CATEGORY_IDS, DEFAULT_LISTS, DEFAULT_SETTINGS } from '../../../src/shared/constants';
import type { Request } from '../../../src/shared/messages';
import {
  LOCAL_LISTS_SNAPSHOT,
  LOCAL_SYNC_QUOTA_EVICTION,
  SYNC_BANK,
  SYNC_LISTS,
  SYNC_SETTINGS,
  SYNC_STREAK,
} from '../../../src/shared/storage-keys';
import type {
  BankState,
  DailyAgg,
  ListsConfig,
  MonthlyAgg,
  Settings,
  StreakState,
} from '../../../src/shared/types';

interface BootScenario {
  journal: SyncJournal;
  localCache?: unknown;
  storedSync: Record<string, unknown>;
}

type RuntimeListener = (
  request: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean;
type AlarmListener = (alarm: chrome.alarms.Alarm) => void;
type RemovedListener = (tabId: number) => void;
type StorageListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void;

const mocks = vi.hoisted(
  (): {
    engineArguments: unknown[] | null;
    alarmListener: AlarmListener | null;
    bootGate: Promise<void> | null;
    dropTabCalls: number[];
    dropTabSignal: (() => void) | null;
    removedListener: RemovedListener | null;
    runtimeListener: RuntimeListener | null;
    storageListener: StorageListener | null;
    savedJournals: SyncJournal[];
    savedMatcherCaches: StoredMatcherCache[];
    matcherCacheSaveAttempts: number;
    matcherCacheSaveError: Error | null;
    scenario: BootScenario;
    bootTrace: string[];
    tickCalls: number;
    tickGate: Promise<void> | null;
    tickError: Error | null;
    dropTabError: Error | null;
    invalidationError: Error | null;
    invalidatedTabIds: number[];
    localState: Record<string, unknown>;
  } => ({
    engineArguments: null,
    alarmListener: null,
    bootGate: null,
    dropTabCalls: [],
    dropTabSignal: null,
    removedListener: null,
    runtimeListener: null,
    storageListener: null,
    savedJournals: [],
    savedMatcherCaches: [],
    matcherCacheSaveAttempts: 0,
    matcherCacheSaveError: null,
    scenario: {
      journal: { sets: {}, removes: [] },
      storedSync: {},
    },
    tickCalls: 0,
    tickGate: null,
    bootTrace: [],
    tickError: null,
    dropTabError: null,
    invalidationError: null,
    invalidatedTabIds: [],
    localState: {},
  }),
);

vi.mock('../../../src/background/audio', () => ({
  notify: vi.fn(),
  playSound: vi.fn(),
}));

vi.mock('../../../src/background/engine', () => ({
  Engine: class EngineMock {
    constructor(...args: unknown[]) {
      mocks.engineArguments = args;
    }

    workTargetSession(): null {
      return null;
    }

    async tick(): Promise<void> {
      mocks.bootTrace.push('tick');
      mocks.tickCalls += 1;
      if (mocks.tickCalls === 1 && mocks.tickGate !== null) await mocks.tickGate;
      if (mocks.tickCalls > 1 && mocks.tickError !== null) throw mocks.tickError;
    }

    async dropTab(tabId: number): Promise<void> {
      mocks.dropTabCalls.push(tabId);
      mocks.dropTabSignal?.();
      if (mocks.dropTabError !== null) throw mocks.dropTabError;
    }
  },
}));

vi.mock('../../../src/background/icon', () => ({ updateIcon: vi.fn() }));
vi.mock('../../../src/background/router', () => ({
  routeMessage: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('../../../src/background/stats-service', () => ({
  pruneAndRollup: vi.fn(() => ({ remove: [], set: {} })),
  runPrune: vi.fn(),
}));
vi.mock('../../../src/background/storage-sync', () => ({
  handleSyncChanges: vi.fn(),
  missingSyncDefaults: vi.fn((): Record<string, unknown> => ({})),
}));
vi.mock('../../../src/background/stores', async () => {
  const actual: typeof import('../../../src/background/stores') = await vi.importActual(
    '../../../src/background/stores',
  );
  return {
    appendEvents: vi.fn(),
    getDeviceId: vi.fn().mockResolvedValue('device-id'),
    loadBank: actual.loadBank,
    loadLists: actual.loadLists,
    loadMatcherCache: vi.fn().mockImplementation(async (): Promise<unknown> => {
      return structuredClone(mocks.scenario.localCache);
    }),
    loadRuntime: vi.fn().mockResolvedValue({}),
    loadSettings: actual.loadSettings,
    loadStreak: actual.loadStreak,
    loadSyncJournal: vi.fn().mockImplementation(async (): Promise<SyncJournal> => {
      if (mocks.bootGate !== null) await mocks.bootGate;
      return structuredClone(mocks.scenario.journal);
    }),
    mergeLists: actual.mergeLists,
    mergeSettings: actual.mergeSettings,
    parseBank: actual.parseBank,
    parseLiveLists: actual.parseLiveLists,
    parseLiveSettings: actual.parseLiveSettings,
    parseStreak: actual.parseStreak,
    saveRuntime: vi.fn(),
    saveMatcherCache: vi
      .fn()
      .mockImplementation(async (cache: StoredMatcherCache): Promise<void> => {
        mocks.bootTrace.push('saveMatcherCache');
        mocks.matcherCacheSaveAttempts += 1;
        if (mocks.matcherCacheSaveError !== null) throw mocks.matcherCacheSaveError;
        mocks.savedMatcherCaches.push(structuredClone(cache));
      }),
    saveSyncJournal: vi.fn().mockImplementation(async (journal: SyncJournal): Promise<void> => {
      mocks.savedJournals.push(structuredClone(journal));
    }),
  };
});
vi.mock('../../../src/background/tabs', () => ({
  applyBlockingFactory: vi.fn((): (() => void) => vi.fn()),
  invalidateRemovedTab: vi.fn((tabId: number): Promise<void> => {
    mocks.invalidatedTabIds.push(tabId);
    if (mocks.invalidationError !== null) return Promise.reject(mocks.invalidationError);
    return Promise.resolve();
  }),
  injectIntoExistingTabs: vi.fn(),
  registerTabListeners: vi.fn(),
}));

function setScenario(journaledStreak: StreakState, syncedStreak: StreakState): void {
  mocks.scenario = {
    journal: { sets: { [SYNC_STREAK]: journaledStreak }, removes: [] },
    storedSync: { [SYNC_STREAK]: syncedStreak },
  };
}

function oversizedHostRules(prefix: string): ListsConfig['custom'] {
  return Array.from({ length: 600 }, (_value: unknown, index: number) => ({
    kind: 'host' as const,
    pattern: `${prefix}-${index}.example`,
  }));
}

function oversizedSettings(id: string): Settings {
  return {
    ...DEFAULT_SETTINGS,
    schedule: [
      {
        id,
        days: [1],
        start: '09:00',
        end: '10:00',
        mode: 'blacklist',
        strictness: 'friction',
        cycling: null,
        intention: 'x'.repeat(8_192),
        enabled: true,
      },
    ],
  };
}

function stubChrome(): void {
  vi.stubGlobal('chrome', {
    alarms: {
      clear: vi.fn().mockResolvedValue(true),
      create: vi.fn().mockResolvedValue(undefined),
      onAlarm: {
        addListener: vi.fn((listener: AlarmListener): void => {
          mocks.alarmListener = listener;
        }),
      },
    },
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onMessage: {
        addListener: vi.fn((listener: RuntimeListener): void => {
          mocks.runtimeListener = listener;
        }),
      },
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
    storage: {
      onChanged: {
        addListener: vi.fn((listener: StorageListener): void => {
          mocks.storageListener = listener;
        }),
      },
      local: {
        get: vi.fn(async (keys: string | string[]): Promise<Record<string, unknown>> => {
          const requested: string[] = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            requested
              .filter((key: string): boolean => Object.hasOwn(mocks.localState, key))
              .map((key: string): [string, unknown] => [key, mocks.localState[key]]),
          );
        }),
        set: vi.fn(async (items: Record<string, unknown>): Promise<void> => {
          Object.assign(mocks.localState, structuredClone(items));
        }),
        remove: vi.fn(async (keys: string | string[]): Promise<void> => {
          const requested: string[] = typeof keys === 'string' ? [keys] : keys;
          for (const key of requested) delete mocks.localState[key];
        }),
      },
      sync: {
        get: vi
          .fn()
          .mockImplementation(
            async (keys: string | string[] | null): Promise<Record<string, unknown>> => {
              if (keys === null) return structuredClone(mocks.scenario.storedSync);
              const requested: string[] = Array.isArray(keys) ? keys : [keys];
              return Object.fromEntries(
                requested
                  .filter((key: string): boolean => Object.hasOwn(mocks.scenario.storedSync, key))
                  .map((key: string): [string, unknown] => [key, mocks.scenario.storedSync[key]]),
              );
            },
          ),
        getBytesInUse: vi.fn(
          async (): Promise<number> =>
            Object.entries(mocks.scenario.storedSync).reduce(
              (total: number, [key, value]: [string, unknown]): number =>
                total + syncItemBytes(key, value),
              0,
            ),
        ),
        remove: vi.fn(async (keys: string | string[]): Promise<void> => {
          const requested: string[] = typeof keys === 'string' ? [keys] : keys;
          for (const key of requested) delete mocks.scenario.storedSync[key];
        }),
        set: vi.fn(async (items: Record<string, unknown>): Promise<void> => {
          Object.assign(mocks.scenario.storedSync, structuredClone(items));
        }),
      },
    },
    tabs: {
      query: vi.fn().mockResolvedValue([]),
      onCreated: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
      onReplaced: { addListener: vi.fn() },
      onRemoved: {
        addListener: vi.fn((listener: RemovedListener): void => {
          mocks.removedListener = listener;
        }),
      },
    },
  });
}

async function finishBoot(): Promise<void> {
  main();
  const listener: RuntimeListener | null = mocks.runtimeListener;
  if (listener === null) throw new Error('runtime listener was not registered');
  await new Promise<void>((resolve: () => void): void => {
    listener({ type: 'getSnapshot' }, {}, (): void => resolve());
  });
}

function runtimeListener(): RuntimeListener {
  const listener: RuntimeListener | null = mocks.runtimeListener;
  if (listener === null) throw new Error('runtime listener was not registered');
  return listener;
}

async function dispatchRuntime(
  request: unknown,
  sender: chrome.runtime.MessageSender = {},
): Promise<unknown> {
  return new Promise<unknown>((resolve: (response: unknown) => void): void => {
    expect(runtimeListener()(request, sender, resolve)).toBe(true);
  });
}

function engineStreak(): StreakState | null {
  if (mocks.engineArguments === null) throw new Error('engine was not constructed');
  return mocks.engineArguments[4] as StreakState | null;
}

function engineSettings(): Settings {
  if (mocks.engineArguments === null) throw new Error('engine was not constructed');
  return mocks.engineArguments[1] as Settings;
}

function engineLists(): ListsConfig {
  if (mocks.engineArguments === null) throw new Error('engine was not constructed');
  return mocks.engineArguments[2] as ListsConfig;
}

function engineBank(): BankState {
  if (mocks.engineArguments === null) throw new Error('engine was not constructed');
  return mocks.engineArguments[3] as BankState;
}

function engineMatcherSet(): CompiledMatcherSet {
  if (mocks.engineArguments === null) throw new Error('engine was not constructed');
  return mocks.engineArguments[7] as CompiledMatcherSet;
}

function enginePorts(): EnginePorts {
  if (mocks.engineArguments === null) throw new Error('engine was not constructed');
  return mocks.engineArguments[0] as EnginePorts;
}

function expectJournaled(streak: StreakState): void {
  expect(mocks.savedJournals).toContainEqual({
    sets: { [SYNC_STREAK]: streak },
    removes: [],
  });
}

beforeEach((): void => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 7, 29, 12, 0));
  mocks.engineArguments = null;
  mocks.alarmListener = null;
  mocks.bootGate = null;
  mocks.dropTabCalls = [];
  mocks.dropTabSignal = null;
  mocks.removedListener = null;
  mocks.runtimeListener = null;
  mocks.storageListener = null;
  mocks.savedJournals = [];
  mocks.savedMatcherCaches = [];
  mocks.matcherCacheSaveAttempts = 0;
  mocks.matcherCacheSaveError = null;
  mocks.scenario = { journal: { sets: {}, removes: [] }, storedSync: {} };
  mocks.tickCalls = 0;
  mocks.tickGate = null;
  mocks.bootTrace = [];
  mocks.tickError = null;
  mocks.dropTabError = null;
  mocks.invalidationError = null;
  mocks.invalidatedTabIds = [];
  mocks.localState = {};
  stubChrome();
});

afterEach((): void => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('background runtime request boundary', () => {
  it('rejects invalid input before the worker is ready', async (): Promise<void> => {
    let releaseBoot: () => void = (): void => undefined;
    mocks.bootGate = new Promise<void>((resolve: () => void): void => {
      releaseBoot = resolve;
    });
    vi.mocked(routeMessage).mockClear();
    main();
    const responses: unknown[] = [];
    const sendResponse: (response: unknown) => void = (response: unknown): void => {
      responses.push(response);
    };

    try {
      expect(runtimeListener()({}, {}, sendResponse)).toBe(true);
      await Promise.resolve();

      expect(responses).toEqual([{ ok: false, error: 'invalid request' }]);
      expect(routeMessage).not.toHaveBeenCalled();
      expect(mocks.engineArguments).toBeNull();
    } finally {
      releaseBoot();
      await dispatchRuntime({ type: 'getSnapshot' });
    }
  });

  it('rejects invalid input after the worker is ready', async (): Promise<void> => {
    await finishBoot();
    vi.mocked(routeMessage).mockClear();

    await expect(dispatchRuntime({ type: 'unknown' })).resolves.toEqual({
      ok: false,
      error: 'invalid request',
    });
  });

  it('does not route invalid input', async (): Promise<void> => {
    await finishBoot();
    vi.mocked(routeMessage).mockClear();

    await dispatchRuntime(null);

    expect(routeMessage).not.toHaveBeenCalled();
  });

  it('dispatches one valid parsed request', async (): Promise<void> => {
    const request: Request = { type: 'getSnapshot' };
    const sender: chrome.runtime.MessageSender = { id: 'extension-id' };
    vi.mocked(routeMessage).mockClear();
    main();

    await expect(dispatchRuntime(request, sender)).resolves.toEqual({ ok: true });
    expect(routeMessage).toHaveBeenCalledExactlyOnceWith(expect.anything(), request, sender);
    expect(vi.mocked(routeMessage).mock.calls[0]?.[1]).toBe(request);
  });
});

describe('background matcher cache boot', () => {
  it('passes a valid cache to the engine without rewriting it', async () => {
    const valid: MatcherCacheBundle = buildMatcherCache(DEFAULT_LISTS, ALL_CATEGORIES);
    mocks.scenario.localCache = valid.stored;

    await finishBoot();

    expect([...engineMatcherSet().blacklist.hosts]).toEqual([...valid.compiled.blacklist.hosts]);
    expect([...engineMatcherSet().whitelist.hosts]).toEqual([...valid.compiled.whitelist.hosts]);
    expect(mocks.savedMatcherCaches).toEqual([]);
    expect(mocks.bootTrace).toEqual(['tick']);
  });

  it.each([
    ['missing', undefined],
    [
      'list-stale',
      buildMatcherCache(
        {
          ...DEFAULT_LISTS,
          custom: [{ kind: 'host' as const, pattern: 'old.example' }],
        },
        ALL_CATEGORIES,
      ).stored,
    ],
    ['category-stale', buildMatcherCache(DEFAULT_LISTS, []).stored],
    [
      'corrupt',
      {
        ...buildMatcherCache(DEFAULT_LISTS, ALL_CATEGORIES).stored,
        compiledSignature: 'corrupt',
      },
    ],
  ])(
    'rebuilds and saves a %s cache before worker readiness and tick',
    async (_label: string, raw: unknown): Promise<void> => {
      const expected: MatcherCacheBundle = buildMatcherCache(DEFAULT_LISTS, ALL_CATEGORIES);
      mocks.scenario.localCache = raw;

      await finishBoot();

      expect(mocks.savedMatcherCaches).toEqual([expected.stored]);
      expect(mocks.bootTrace).toEqual(['saveMatcherCache', 'tick']);
      expect([...engineMatcherSet().blacklist.hosts]).toEqual([
        ...expected.compiled.blacklist.hosts,
      ]);
      expect([...engineMatcherSet().whitelist.hosts]).toEqual([
        ...expected.compiled.whitelist.hosts,
      ]);
    },
  );

  it('reports a rebuilt cache save failure, boots with rebuilt matchers, and retries next boot', async () => {
    const lists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'blocked.example' }],
    };
    const expected: MatcherCacheBundle = buildMatcherCache(lists, ALL_CATEGORIES);
    const cacheError: Error = new Error('local cache unavailable');
    const consoleError = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    mocks.scenario.storedSync = { [SYNC_LISTS]: lists };
    mocks.matcherCacheSaveError = cacheError;

    await finishBoot();

    expect(mocks.tickCalls).toBe(1);
    expect(mocks.matcherCacheSaveAttempts).toBe(1);
    expect(mocks.savedMatcherCaches).toEqual([]);
    expect(consoleError).toHaveBeenCalledWith('focus-lock background error', cacheError);
    expect(
      evaluateUrl(engineMatcherSet().blacklist, 'https://blocked.example/page', [], Date.now())
        .blocked,
    ).toBe(true);

    mocks.matcherCacheSaveError = null;
    await finishBoot();

    expect(mocks.matcherCacheSaveAttempts).toBe(2);
    expect(mocks.savedMatcherCaches).toEqual([expected.stored]);
    expect(mocks.tickCalls).toBe(2);
  });
});

describe('background pending lists tracking', () => {
  it('applies complete live list snapshots in listener arrival order', async () => {
    await finishBoot();
    vi.mocked(handleSyncChanges).mockClear();
    const first = await encodeListsForSync({
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'first.example' }],
    });
    const second = await encodeListsForSync({
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'second.example' }],
    });
    let releaseFirstRead: () => void = (): void => {
      throw new Error('first list snapshot read did not start');
    };
    let signalFirstRead: () => void = (): void => {
      throw new Error('first list snapshot signal was not initialized');
    };
    const firstReadStarted: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalFirstRead = resolve;
    });
    let listReads: number = 0;
    const syncGetMock = vi.mocked(chrome.storage.sync.get) as unknown as {
      mockImplementation: (
        implementation: (
          keys: string | string[] | Record<string, unknown> | null | undefined,
        ) => Promise<Record<string, unknown>>,
      ) => void;
    };
    syncGetMock.mockImplementation(
      async (
        keys: string | string[] | Record<string, unknown> | null | undefined,
      ): Promise<Record<string, unknown>> => {
        if (Array.isArray(keys) && keys.includes(SYNC_LISTS)) {
          listReads += 1;
          if (listReads === 1) {
            signalFirstRead();
            await new Promise<void>((resolve: () => void): void => {
              releaseFirstRead = resolve;
            });
            return structuredClone(first.sets);
          }
          return structuredClone(second.sets);
        }
        return {};
      },
    );
    const listener: StorageListener | null = mocks.storageListener;
    if (listener === null) throw new Error('storage listener was not registered');

    listener({ [SYNC_LISTS]: { newValue: first.sets[SYNC_LISTS] } }, 'sync');
    await firstReadStarted;
    listener({ [SYNC_LISTS]: { newValue: second.sets[SYNC_LISTS] } }, 'sync');
    await vi.waitFor((): void => expect(listReads).toBe(2));
    await Promise.resolve();
    await Promise.resolve();
    releaseFirstRead();
    await vi.waitFor((): void => expect(handleSyncChanges).toHaveBeenCalledTimes(2));

    expect(
      vi.mocked(handleSyncChanges).mock.calls.map((call: unknown[]): unknown => call[5]),
    ).toEqual([first.sets, second.sets]);
  });

  it('reads the complete list snapshot when a category shard changes', async () => {
    const exclusions: ListsConfig['exclusions'] = {};
    for (const categoryId of CATEGORY_IDS) {
      exclusions[categoryId] = Array.from(
        { length: 60 },
        (_value: unknown, index: number): string => `${categoryId}-${index}.example`,
      );
    }
    const lists: ListsConfig = { ...DEFAULT_LISTS, exclusions };
    const encoding = await encodeListsForSync(lists);
    mocks.scenario.storedSync = structuredClone(encoding.sets);
    await finishBoot();
    vi.mocked(handleSyncChanges).mockClear();
    const shardKey: string = LIST_SYNC_SHARD_KEYS[0] as string;
    const listener: StorageListener | null = mocks.storageListener;
    if (listener === null) throw new Error('storage listener was not registered');

    listener({ [shardKey]: { newValue: encoding.sets[shardKey] } }, 'sync');

    await vi.waitFor((): void => expect(handleSyncChanges).toHaveBeenCalled());
    expect(vi.mocked(handleSyncChanges).mock.calls.at(-1)?.[5]).toEqual(encoding.sets);
  });

  it('reports a local lists write pending until SyncWriter flushes it', async () => {
    await finishBoot();
    const localLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'local.example' }],
    };

    enginePorts().queueSync(SYNC_LISTS, localLists);
    expect(enginePorts().hasPendingSync(SYNC_LISTS)).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(enginePorts().hasPendingSync(SYNC_LISTS)).toBe(false);
  });

  it('tracks a replayed lists journal before the worker becomes ready', async () => {
    const pendingLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'replayed.example' }],
    };
    mocks.scenario.journal = { sets: { [SYNC_LISTS]: pendingLists }, removes: [] };

    await finishBoot();

    expect(enginePorts().hasPendingSync(SYNC_LISTS)).toBe(true);
  });

  it('captures replayed lists pending state when a live event arrives during slow boot', async () => {
    vi.mocked(handleSyncChanges).mockClear();
    let releaseTick: () => void = (): void => {};
    mocks.tickGate = new Promise((resolve: () => void): void => {
      releaseTick = resolve;
    });
    const replayedLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'replayed.example' }],
    };
    const liveLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'live.example' }],
    };
    mocks.scenario.journal = { sets: { [SYNC_LISTS]: replayedLists }, removes: [] };

    main();
    await vi.waitFor((): void => expect(mocks.engineArguments).not.toBeNull());
    const listener: StorageListener | null = mocks.storageListener;
    if (listener === null) throw new Error('storage listener was not registered');
    expect(enginePorts().hasPendingSync(SYNC_LISTS)).toBe(true);
    listener({ [SYNC_LISTS]: { newValue: liveLists } }, 'sync');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(enginePorts().hasPendingSync(SYNC_LISTS)).toBe(false);

    releaseTick();
    await vi.waitFor((): void => expect(handleSyncChanges).toHaveBeenCalled());
    expect(vi.mocked(handleSyncChanges).mock.calls.at(-1)?.[4]).toBe(true);
  });

  it('captures replayed lists pending state when the event arrives before writer creation', async () => {
    let releaseJournalLoad: () => void = (): void => {};
    mocks.bootGate = new Promise((resolve: () => void): void => {
      releaseJournalLoad = resolve;
    });
    const replayedLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'replayed.example' }],
    };
    const liveLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'live.example' }],
    };
    mocks.scenario.journal = { sets: { [SYNC_LISTS]: replayedLists }, removes: [] };

    main();
    const listener: StorageListener | null = mocks.storageListener;
    if (listener === null) throw new Error('storage listener was not registered');
    listener({ [SYNC_LISTS]: { newValue: liveLists } }, 'sync');
    releaseJournalLoad();

    await vi.waitFor((): void => expect(handleSyncChanges).toHaveBeenCalled());
    expect(vi.mocked(handleSyncChanges).mock.calls.at(-1)?.[4]).toBe(true);
  });

  it('does not reconcile a pre-writer live event when the journal has no pending lists', async () => {
    const priorHandleCalls: number = vi.mocked(handleSyncChanges).mock.calls.length;
    let releaseJournalLoad: () => void = (): void => {};
    mocks.bootGate = new Promise((resolve: () => void): void => {
      releaseJournalLoad = resolve;
    });
    const liveLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'live.example' }],
    };

    main();
    const listener: StorageListener | null = mocks.storageListener;
    if (listener === null) throw new Error('storage listener was not registered');
    listener({ [SYNC_LISTS]: { newValue: liveLists } }, 'sync');
    releaseJournalLoad();

    await vi.waitFor((): void => {
      expect(vi.mocked(handleSyncChanges).mock.calls.length).toBeGreaterThan(priorHandleCalls);
    });
    expect(vi.mocked(handleSyncChanges).mock.calls[priorHandleCalls]?.[4]).toBe(false);
  });
});

describe('background boot state convergence', () => {
  it('keeps the local snapshot when a recognizable split base is invalid at boot', async () => {
    const localLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'keep-local.example' }],
    };
    mocks.localState[LOCAL_LISTS_SNAPSHOT] = localLists;
    mocks.scenario.storedSync = {
      [SYNC_LISTS]: {
        format: 'category-shards-v1',
        revision: '0'.repeat(64),
        custom: [{ kind: 'host', pattern: 'must-not-apply.example' }],
        whitelist: [],
        unexpected: true,
      },
    };

    await finishBoot();

    expect(engineLists()).toEqual(localLists);
  });

  it('repairs an incomplete sharded journal from the local canonical snapshot', async () => {
    const localLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'local-canonical.example' }],
    };
    const exclusions: ListsConfig['exclusions'] = {};
    for (const categoryId of CATEGORY_IDS) {
      exclusions[categoryId] = Array.from(
        { length: 60 },
        (_value: unknown, index: number): string => `${categoryId}-${index}.example`,
      );
    }
    const incomplete = await encodeListsForSync({ ...DEFAULT_LISTS, exclusions });
    delete incomplete.sets[LIST_SYNC_SHARD_KEYS[0] as string];
    mocks.scenario.journal = { sets: incomplete.sets, removes: [] };
    mocks.localState[LOCAL_LISTS_SNAPSHOT] = localLists;

    await finishBoot();

    expect(engineLists()).toEqual(localLists);
    const expected = await encodeListsForSync(localLists);
    expect(mocks.savedJournals.at(-1)).toEqual({
      sets: expected.sets,
      removes: expected.removes,
    });
  });

  it('removes stale list shards when a missing base is restored as unsplit', async () => {
    const exclusions: ListsConfig['exclusions'] = {};
    for (const categoryId of CATEGORY_IDS) {
      exclusions[categoryId] = Array.from(
        { length: 60 },
        (_value: unknown, index: number): string => `${categoryId}-${index}.example`,
      );
    }
    const encoding = await encodeListsForSync({ ...DEFAULT_LISTS, exclusions });
    const staleShards: Record<string, unknown> = { ...encoding.sets };
    delete staleShards[SYNC_LISTS];
    mocks.scenario.storedSync = staleShards;
    vi.mocked(missingSyncDefaults).mockReturnValueOnce({ [SYNC_LISTS]: DEFAULT_LISTS });

    await finishBoot();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mocks.scenario.storedSync[SYNC_LISTS]).toEqual(DEFAULT_LISTS);
    for (const key of LIST_SYNC_SHARD_KEYS) {
      expect(mocks.scenario.storedSync).not.toHaveProperty(key);
    }
  });

  it('rolls back a quota eviction checkpoint when the SyncWriter journal is empty', async () => {
    const evictedMonthKey: string = 'aggm:old-device:2024-01';
    const evictedMonth = rollupMonth('2024-01', []);
    mocks.localState[LOCAL_SYNC_QUOTA_EVICTION] = {
      evicted: { [evictedMonthKey]: evictedMonth },
      setKeys: [SYNC_SETTINGS],
    };

    await finishBoot();

    expect(chrome.storage.sync.set).toHaveBeenCalledWith({
      [evictedMonthKey]: evictedMonth,
    });
    expect(mocks.localState[LOCAL_SYNC_QUOTA_EVICTION]).toBeUndefined();
  });

  it('compacts oldest monthly history before a journal replay would exceed total quota', async () => {
    const evictedMonthKey: string = 'aggm:old-device:2024-01';
    const pendingSettings: Settings = { ...DEFAULT_SETTINGS, retentionDays: 14 };
    const evictedMonth = rollupMonth('2024-01', []);
    evictedMonth.attempts = { ['m'.repeat(3_750)]: 1 };
    const storedSync: Record<string, unknown> = {
      [evictedMonthKey]: evictedMonth,
    };
    for (let index: number = 0; index < 12; index++) {
      storedSync[`agg:old-device:2026-08-${String(index + 1).padStart(2, '0')}`] = 'd'.repeat(
        7_600,
      );
    }
    const bytesBeforePadding: number = Object.entries(storedSync).reduce(
      (total: number, [key, value]: [string, unknown]): number => total + syncItemBytes(key, value),
      0,
    );
    const paddingKey: string = 'plugin:padding';
    const incomingBytes: number = syncItemBytes(SYNC_SETTINGS, pendingSettings);
    const paddingLength: number =
      SYNC_QUOTA_BYTES_TOTAL -
      Math.floor(incomingBytes / 2) -
      bytesBeforePadding -
      syncItemBytes(paddingKey, '');
    storedSync[paddingKey] = 'p'.repeat(paddingLength);
    mocks.scenario = {
      journal: { sets: { [SYNC_SETTINGS]: pendingSettings }, removes: [] },
      storedSync,
    };

    await finishBoot();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(chrome.storage.sync.remove).toHaveBeenCalledWith([evictedMonthKey]);
    expect(vi.mocked(chrome.storage.sync.remove).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(chrome.storage.sync.set).mock.invocationCallOrder[0] ?? 0,
    );
    expect(chrome.storage.sync.set).toHaveBeenCalledWith({ [SYNC_SETTINGS]: pendingSettings });
  });

  it('replaces malformed pending settings with valid sync state before boot and flush', async () => {
    const synced: Settings = {
      ...DEFAULT_SETTINGS,
      defaultMode: 'whitelist',
      retentionDays: 30,
    };
    mocks.scenario = {
      journal: { sets: { [SYNC_SETTINGS]: null }, removes: [] },
      storedSync: { [SYNC_SETTINGS]: synced },
    };

    await finishBoot();

    expect(engineSettings()).toEqual(synced);
    expect(mocks.savedJournals).toContainEqual({
      sets: { [SYNC_SETTINGS]: synced },
      removes: [],
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chrome.storage.sync.set).toHaveBeenCalledWith({ [SYNC_SETTINGS]: synced });
  });

  it('replaces malformed pending lists with valid sync state before boot and flush', async () => {
    const synced: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'synced.example' }],
    };
    mocks.scenario = {
      journal: { sets: { [SYNC_LISTS]: null }, removes: [] },
      storedSync: { [SYNC_LISTS]: synced },
    };

    await finishBoot();

    expect(engineLists()).toEqual(synced);
    expect(mocks.savedJournals).toContainEqual({
      sets: { [SYNC_LISTS]: synced },
      removes: [...LIST_SYNC_SHARD_KEYS],
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chrome.storage.sync.set).toHaveBeenCalledWith({ [SYNC_LISTS]: synced });
  });

  it('replaces malformed pending bank with valid sync state before boot and flush', async () => {
    const synced: BankState = { balanceMs: 42_000 };
    mocks.scenario = {
      journal: { sets: { [SYNC_BANK]: { balanceMs: -1 } }, removes: [] },
      storedSync: { [SYNC_BANK]: synced },
    };

    await finishBoot();

    expect(engineBank()).toEqual(synced);
    expect(mocks.savedJournals).toContainEqual({
      sets: { [SYNC_BANK]: synced },
      removes: [],
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chrome.storage.sync.set).toHaveBeenCalledWith({ [SYNC_BANK]: synced });
  });

  it('defaults malformed pending base state when sync has no valid fallback', async () => {
    const fallbackStreak: StreakState = {
      current: 0,
      freezeTokens: 0,
      lastCountedDate: null,
      lastFreezeGrantDate: null,
      activeDays: [],
      activeMonth: '2026-08',
    };
    const expectedSets: Record<string, unknown> = {
      [SYNC_SETTINGS]: DEFAULT_SETTINGS,
      [SYNC_LISTS]: DEFAULT_LISTS,
      [SYNC_BANK]: { balanceMs: 0 },
      [SYNC_STREAK]: fallbackStreak,
    };
    mocks.scenario = {
      journal: {
        sets: {
          [SYNC_SETTINGS]: null,
          [SYNC_LISTS]: null,
          [SYNC_BANK]: { balanceMs: -1 },
          [SYNC_STREAK]: { current: 3, activeDays: null },
        },
        removes: [],
      },
      storedSync: {
        [SYNC_SETTINGS]: 'invalid',
        [SYNC_LISTS]: 42,
        [SYNC_BANK]: { balanceMs: -2 },
        [SYNC_STREAK]: { current: -1 },
      },
    };

    await finishBoot();

    expect(engineSettings()).toEqual(DEFAULT_SETTINGS);
    expect(engineLists()).toEqual(DEFAULT_LISTS);
    expect(engineBank()).toEqual({ balanceMs: 0 });
    expect(engineStreak()).toEqual(fallbackStreak);
    expect(mocks.savedJournals).toContainEqual({
      sets: expectedSets,
      removes: [...LIST_SYNC_SHARD_KEYS],
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chrome.storage.sync.set).toHaveBeenCalledWith(expectedSets);
  });

  it('preserves valid pending base state over older sync state', async () => {
    const pendingSettings: Settings = { ...DEFAULT_SETTINGS, retentionDays: 14 };
    const syncedSettings: Settings = { ...DEFAULT_SETTINGS, retentionDays: 30 };
    const pendingLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'pending.example' }],
    };
    const syncedLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'synced.example' }],
    };
    const pendingBank: BankState = { balanceMs: 42_000 };
    const syncedBank: BankState = { balanceMs: 21_000 };
    const pendingStreak: StreakState = {
      current: 3,
      freezeTokens: 1,
      lastCountedDate: '2026-08-28',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [26, 27, 28],
      activeMonth: '2026-08',
    };
    const syncedStreak: StreakState = {
      ...pendingStreak,
      current: 2,
      lastCountedDate: '2026-08-27',
      activeDays: [26, 27],
    };
    const pendingSets: Record<string, unknown> = {
      [SYNC_SETTINGS]: pendingSettings,
      [SYNC_LISTS]: pendingLists,
      [SYNC_BANK]: pendingBank,
      [SYNC_STREAK]: pendingStreak,
    };
    mocks.scenario = {
      journal: { sets: pendingSets, removes: [] },
      storedSync: {
        [SYNC_SETTINGS]: syncedSettings,
        [SYNC_LISTS]: syncedLists,
        [SYNC_BANK]: syncedBank,
        [SYNC_STREAK]: syncedStreak,
      },
    };

    await finishBoot();

    expect(engineSettings()).toEqual(pendingSettings);
    expect(engineLists()).toEqual(pendingLists);
    expect(engineBank()).toEqual(pendingBank);
    expect(engineStreak()).toEqual(pendingStreak);
    expect(mocks.savedJournals).toContainEqual({
      sets: pendingSets,
      removes: [...LIST_SYNC_SHARD_KEYS],
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chrome.storage.sync.set).toHaveBeenCalledWith(pendingSets);
  });

  it('drops oversized pending settings and lists before selecting valid stored Sync', async () => {
    const pendingSettings: Settings = oversizedSettings('pending');
    const pendingLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: oversizedHostRules('pending'),
    };
    const syncedSettings: Settings = { ...DEFAULT_SETTINGS, retentionDays: 14 };
    const syncedLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'synced.example' }],
    };
    mocks.scenario = {
      journal: {
        sets: {
          [SYNC_SETTINGS]: pendingSettings,
          [SYNC_LISTS]: pendingLists,
        },
        removes: [],
      },
      storedSync: {
        [SYNC_SETTINGS]: syncedSettings,
        [SYNC_LISTS]: syncedLists,
      },
    };

    await finishBoot();

    expect(engineSettings()).toEqual(syncedSettings);
    expect(engineLists()).toEqual(syncedLists);
    expect(mocks.savedJournals).toContainEqual({ sets: {}, removes: [] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chrome.storage.sync.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ [SYNC_SETTINGS]: expect.anything() }),
    );
    expect(chrome.storage.sync.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ [SYNC_LISTS]: expect.anything() }),
    );
  });

  it('replaces oversized pending settings and lists with bounded defaults when Sync is absent', async () => {
    const pendingSettings: Settings = oversizedSettings('pending');
    const pendingLists: ListsConfig = {
      ...DEFAULT_LISTS,
      whitelist: oversizedHostRules('pending'),
    };
    mocks.scenario = {
      journal: {
        sets: {
          [SYNC_SETTINGS]: pendingSettings,
          [SYNC_LISTS]: pendingLists,
        },
        removes: [],
      },
      storedSync: {},
    };

    await finishBoot();

    expect(engineSettings()).toEqual(DEFAULT_SETTINGS);
    expect(engineLists()).toEqual(DEFAULT_LISTS);
    expect(mocks.savedJournals).toContainEqual({ sets: {}, removes: [] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });

  it('accepts oversized schema-valid values already stored in Sync without rewriting them', async () => {
    const syncedSettings: Settings = oversizedSettings('synced');
    const syncedLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: oversizedHostRules('synced'),
    };
    mocks.scenario = {
      journal: { sets: {}, removes: [] },
      storedSync: {
        [SYNC_SETTINGS]: syncedSettings,
        [SYNC_LISTS]: syncedLists,
      },
    };

    await finishBoot();

    expect(engineSettings()).toEqual(syncedSettings);
    expect(engineLists()).toEqual(syncedLists);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });

  it('drops oversized pending aggregate and archive values before boot flush', async () => {
    const aggregateKey: string = 'agg:device-a:2026-08-28';
    const archiveKey: string = 'archive:clock-rebase:device-a:2026-08-28:1:test';
    const oversizedAggregate: DailyAgg = {
      ...emptyDaily('2026-08-28'),
      attempts: { [`${'x'.repeat(8_192)}.example`]: 1 },
    };
    const oversizedArchive: DailyAgg = {
      ...emptyDaily('2026-08-28'),
      attempts: { [`${'y'.repeat(8_192)}.example`]: 1 },
    };
    mocks.scenario = {
      journal: {
        sets: {
          [aggregateKey]: oversizedAggregate,
          [archiveKey]: oversizedArchive,
        },
        removes: [],
      },
      storedSync: {},
    };

    await finishBoot();

    expect(mocks.savedJournals).toContainEqual({ sets: {}, removes: [] });
    await vi.advanceTimersByTimeAsync(10_000);
    for (const [items] of vi.mocked(chrome.storage.sync.set).mock.calls) {
      expect(items).not.toHaveProperty(aggregateKey);
      expect(items).not.toHaveProperty(archiveKey);
    }
  });

  it('replaces a malformed pending daily aggregate with valid sync history', async () => {
    const key: string = 'agg:device-a:2026-08-28';
    const synced: DailyAgg = { ...emptyDaily('2026-08-28'), focusMs: 60_000 };
    mocks.scenario = {
      journal: {
        sets: { [key]: { ...synced, sessionsStarted: 0.5 } },
        removes: [],
      },
      storedSync: { [key]: synced },
    };

    await finishBoot();

    expect(mocks.savedJournals).toContainEqual({ sets: { [key]: synced }, removes: [] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chrome.storage.sync.set).toHaveBeenCalledWith({ [key]: synced });
  });

  it('replaces a malformed pending monthly aggregate with valid sync history', async () => {
    const key: string = 'aggm:device-a:2026-08';
    const synced: MonthlyAgg = rollupMonth('2026-08', [
      { ...emptyDaily('2026-08-28'), focusMs: 60_000 },
    ]);
    mocks.scenario = {
      journal: {
        sets: { [key]: { ...synced, sessionsCompleted: 0.5 } },
        removes: [],
      },
      storedSync: { [key]: synced },
    };

    await finishBoot();

    expect(mocks.savedJournals).toContainEqual({ sets: { [key]: synced }, removes: [] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chrome.storage.sync.set).toHaveBeenCalledWith({ [key]: synced });
  });

  it('drops malformed pending aggregates when sync has no valid history', async () => {
    const dailyKey: string = 'agg:device-a:2026-08-28';
    const monthlyKey: string = 'aggm:device-a:2026-08';
    mocks.scenario = {
      journal: {
        sets: {
          [dailyKey]: { ...emptyDaily('2026-08-28'), sessionsStarted: 0.5 },
          [monthlyKey]: {
            ...rollupMonth('2026-08', []),
            sessionsCompleted: 0.5,
          },
        },
        removes: [],
      },
      storedSync: {
        [dailyKey]: { ...emptyDaily('2026-08-28'), attemptsOther: 0.5 },
        [monthlyKey]: { ...rollupMonth('2026-08', []), unlocksTaken: 0.5 },
      },
    };

    await finishBoot();

    expect(mocks.savedJournals).toContainEqual({ sets: {}, removes: [] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });

  it('rejects pending aggregates whose embedded period does not match the key', async () => {
    const dailyKey: string = 'agg:device-a:2026-08-28';
    const monthlyKey: string = 'aggm:device-a:2026-08';
    const syncedDaily: DailyAgg = emptyDaily('2026-08-28');
    const syncedMonthly: MonthlyAgg = rollupMonth('2026-08', []);
    const expectedSets: Record<string, unknown> = {
      [dailyKey]: syncedDaily,
      [monthlyKey]: syncedMonthly,
    };
    mocks.scenario = {
      journal: {
        sets: {
          [dailyKey]: emptyDaily('2026-08-27'),
          [monthlyKey]: rollupMonth('2026-07', []),
        },
        removes: [],
      },
      storedSync: expectedSets,
    };

    await finishBoot();

    expect(mocks.savedJournals).toContainEqual({ sets: expectedSets, removes: [] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chrome.storage.sync.set).toHaveBeenCalledWith(expectedSets);
  });

  it('preserves valid pending aggregates with matching key periods', async () => {
    const dailyKey: string = 'agg:device-a:2026-08-28';
    const monthlyKey: string = 'aggm:device-a:2026-08';
    const pendingDaily: DailyAgg = { ...emptyDaily('2026-08-28'), focusMs: 60_000 };
    const syncedDaily: DailyAgg = { ...pendingDaily, focusMs: 30_000 };
    const pendingMonthly: MonthlyAgg = rollupMonth('2026-08', [pendingDaily]);
    const syncedMonthly: MonthlyAgg = rollupMonth('2026-08', [syncedDaily]);
    const pendingSets: Record<string, unknown> = {
      [dailyKey]: pendingDaily,
      [monthlyKey]: pendingMonthly,
    };
    mocks.scenario = {
      journal: { sets: pendingSets, removes: [] },
      storedSync: {
        [dailyKey]: syncedDaily,
        [monthlyKey]: syncedMonthly,
      },
    };

    await finishBoot();

    expect(mocks.savedJournals).toContainEqual({ sets: pendingSets, removes: [] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chrome.storage.sync.set).toHaveBeenCalledWith(pendingSets);
  });

  it('preserves unknown pending keys and aggregate removals', async () => {
    const unknownKey: string = 'plugin:opaque-state';
    const removedKey: string = 'agg:device-a:2026-08-27';
    const unknownValue: Record<string, unknown> = { opaque: true };
    mocks.scenario = {
      journal: {
        sets: { [unknownKey]: unknownValue },
        removes: [removedKey],
      },
      storedSync: {},
    };

    await finishBoot();

    expect(mocks.savedJournals).toContainEqual({
      sets: { [unknownKey]: unknownValue },
      removes: [removedKey],
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chrome.storage.sync.set).toHaveBeenCalledWith({ [unknownKey]: unknownValue });
    expect(chrome.storage.sync.remove).toHaveBeenCalledWith([removedKey]);
  });

  it('replaces an older journal streak with newer sync progress before engine creation', async () => {
    const journaled: StreakState = {
      current: 2,
      freezeTokens: 0,
      lastCountedDate: '2026-08-27',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [26, 27],
      activeMonth: '2026-08',
    };
    const synced: StreakState = {
      ...journaled,
      current: 3,
      lastCountedDate: '2026-08-28',
      activeDays: [26, 27, 28],
    };
    setScenario(journaled, synced);

    await finishBoot();

    expect(engineStreak()).toEqual(synced);
    expectJournaled(synced);
  });

  it('merges equal-marker journal and sync progress before engine creation', async () => {
    const journaled: StreakState = {
      current: 3,
      freezeTokens: 2,
      lastCountedDate: '2026-08-28',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [25, 28],
      activeMonth: '2026-08',
    };
    const synced: StreakState = {
      ...journaled,
      current: 5,
      freezeTokens: 1,
      activeDays: [24, 25, 26, 27],
    };
    const merged: StreakState = {
      ...synced,
      freezeTokens: 2,
      activeDays: [24, 25, 26, 27, 28],
    };
    setScenario(journaled, synced);

    await finishBoot();

    expect(engineStreak()).toEqual(merged);
    expectJournaled(merged);
  });

  it('rebases future boot streak data to today before engine creation', async () => {
    const future: StreakState = {
      current: 5,
      freezeTokens: 2,
      lastCountedDate: '2026-09-01',
      lastFreezeGrantDate: '2026-09-01',
      activeDays: [1],
      activeMonth: '2026-09',
    };
    const corrected: StreakState = {
      current: 0,
      freezeTokens: 2,
      lastCountedDate: null,
      lastFreezeGrantDate: null,
      activeDays: [],
      activeMonth: '2026-08',
    };
    setScenario(future, future);

    await finishBoot();

    expect(engineStreak()).toEqual(corrected);
    expectJournaled(corrected);
  });

  it('ignores malformed journal streak data before rebasing boot state', async () => {
    const synced: StreakState = {
      current: 3,
      freezeTokens: 1,
      lastCountedDate: '2026-08-28',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [26, 27, 28],
      activeMonth: '2026-08',
    };
    setScenario(synced, synced);
    mocks.scenario.journal.sets[SYNC_STREAK] = {
      ...synced,
      activeDays: null,
    };

    await finishBoot();

    expect(engineStreak()).toEqual(synced);
    expectJournaled(synced);
  });

  it('defaults malformed journal streak data when sync has no valid streak', async () => {
    const fallback: StreakState = {
      current: 0,
      freezeTokens: 0,
      lastCountedDate: null,
      lastFreezeGrantDate: null,
      activeDays: [],
      activeMonth: '2026-08',
    };
    mocks.scenario = {
      journal: {
        sets: { [SYNC_STREAK]: { current: 3, activeDays: null } },
        removes: [],
      },
      storedSync: {},
    };

    await finishBoot();

    expect(engineStreak()).toEqual(fallback);
    expectJournaled(fallback);
  });
});

describe('background detached listener errors', () => {
  it('invalidates a removed tab synchronously before boot finishes', async () => {
    let releaseBoot: () => void = (): void => {
      throw new Error('boot resolver was not initialized');
    };
    mocks.bootGate = new Promise((resolve: () => void): void => {
      releaseBoot = resolve;
    });
    const dropped: Promise<void> = new Promise((resolve: () => void): void => {
      mocks.dropTabSignal = resolve;
    });
    main();
    if (mocks.removedListener === null) throw new Error('tab removal listener was not registered');

    mocks.removedListener(7);

    expect(mocks.invalidatedTabIds).toEqual([7]);
    expect(mocks.dropTabCalls).toEqual([]);

    releaseBoot();
    await dropped;

    expect(mocks.dropTabCalls).toEqual([7]);
  });

  it('reports each rejected tab-removal branch once', async () => {
    const invalidationError = new Error('tab cleanup unavailable');
    const dropTabError = new Error('runtime storage unavailable');
    const consoleError = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    await finishBoot();
    mocks.invalidationError = invalidationError;
    mocks.dropTabError = dropTabError;
    if (mocks.removedListener === null) throw new Error('tab removal listener was not registered');

    mocks.removedListener(7);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(consoleError).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledWith('focus-lock background error', invalidationError);
    expect(consoleError).toHaveBeenCalledWith('focus-lock background error', dropTabError);
  });

  it('reports alarm and tab-removal rejections', async () => {
    const error = new Error('local storage unavailable');
    let reportCount: number = 0;
    let signalReported: () => void = (): void => {};
    const reported: Promise<void> = new Promise((resolve: () => void): void => {
      signalReported = resolve;
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation((): void => {
      reportCount += 1;
      if (reportCount === 2) signalReported();
    });
    await finishBoot();
    mocks.tickError = error;
    mocks.dropTabError = error;
    if (mocks.alarmListener === null) throw new Error('alarm listener was not registered');
    if (mocks.removedListener === null) throw new Error('tab removal listener was not registered');

    mocks.alarmListener({
      name: 'tick',
      persistAcrossSessions: false,
      scheduledTime: Date.now(),
    });
    mocks.removedListener(7);
    await reported;

    expect(consoleError).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenNthCalledWith(1, 'focus-lock background error', error);
    expect(consoleError).toHaveBeenNthCalledWith(2, 'focus-lock background error', error);
  });
});

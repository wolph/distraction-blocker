import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Engine } from '../../../src/background/engine';
import type { PolicyStorage } from '../../../src/background/policy-storage';
import { routeMessage } from '../../../src/background/router';
import { type AggregateStorage, fetchStats } from '../../../src/background/stats-service';
import { readEvents } from '../../../src/background/stores';
import {
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  DEFAULT_SETUP,
  emptySnapshot,
} from '../../../src/shared/constants';
import type { StatsBundle } from '../../../src/shared/messages';
import type { EventRecord, SetupState } from '../../../src/shared/types';

vi.mock('../../../src/background/audio', () => ({ playSound: vi.fn() }));
vi.mock('../../../src/background/stats-service', () => ({ fetchStats: vi.fn() }));
vi.mock('../../../src/background/stores', () => ({ readEvents: vi.fn() }));

const overlay: ReturnType<Engine['statsOverlay']> = {
  deviceId: 'devA',
  todayAgg: {
    date: '2026-08-29',
    focusMs: 0,
    sessionsStarted: 0,
    sessionsCompleted: 0,
    attempts: {},
    attemptsOther: 0,
    pausesTaken: 0,
    pauseMsSpent: 0,
    unlocksTaken: 0,
    resisted: 0,
  },
  streak: null,
  pendingEvents: [],
};
const engine: Engine = { statsOverlay: vi.fn(() => overlay) } as unknown as Engine;
const sender: chrome.runtime.MessageSender = {};
const stats: StatsBundle = {
  days: [],
  months: [],
  streak: {
    current: 0,
    freezeTokens: 0,
    lastCountedDate: null,
    lastFreezeGrantDate: null,
    activeDays: [],
    activeMonth: '2026-08',
  },
  recentSessions: [],
  totals: {
    focusMsToday: 0,
    focusMsWeek: 0,
    attemptsToday: 0,
    resistedToday: 0,
  },
};

function onboardingStorage(
  overrides: Partial<Record<keyof PolicyStorage, unknown>> = {},
): PolicyStorage {
  return {
    loadSetup: vi.fn().mockResolvedValue(structuredClone(DEFAULT_SETUP)),
    updateSetup: vi.fn().mockResolvedValue(undefined),
    markSetupCompleted: vi.fn().mockResolvedValue(undefined),
    selectLocalMode: vi.fn().mockResolvedValue(undefined),
    enableSync: vi.fn().mockResolvedValue(undefined),
    storageMode: vi.fn().mockResolvedValue('local'),
    deleteRemoteData: vi.fn().mockResolvedValue(undefined),
    clearLocalHistory: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as PolicyStorage;
}

describe('routeMessage onboarding wiring', (): void => {
  it('returns setup state without exposing a broad setup writer', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, websiteAccess: 'denied' };
    const storage: PolicyStorage = onboardingStorage({
      loadSetup: vi.fn().mockResolvedValue(setup),
    });

    await expect(routeMessage(engine, { type: 'getSetupState' }, sender, storage)).resolves.toEqual(
      setup,
    );
  });

  it.each([
    ['granted', 'ready', true, true],
    ['denied', 'unavailable', false, true],
    ['granted', 'error', true, false],
  ] as const)(
    'reports %s permission with %s registration truthfully',
    async (permission, status, granted, ok): Promise<void> => {
      const reconcileWebsiteAccess = vi.fn().mockResolvedValue({ permission, status });

      const result: unknown = await routeMessage(
        engine,
        { type: 'reconcileWebsiteAccess' },
        sender,
        onboardingStorage(),
        { reconcileWebsiteAccess, removeOnboardingDraft: vi.fn(), reportError: vi.fn() },
      );

      expect(result).toMatchObject({ ok, granted, registration: status });
      if (!ok) {
        expect(result).toMatchObject({
          error:
            'Website access is granted, but Focus Lock could not enable blocking. Retry setup or reload the extension.',
        });
      }
    },
  );

  it('dismisses only the website-access notice', async (): Promise<void> => {
    const storage: PolicyStorage = onboardingStorage();
    const dismissWebsiteAccessNotice = vi.fn().mockResolvedValue(undefined);

    await expect(
      routeMessage(engine, { type: 'dismissWebsiteAccessNotice' }, sender, storage, {
        reconcileWebsiteAccess: vi.fn(),
        dismissWebsiteAccessNotice,
        removeOnboardingDraft: vi.fn(),
        reportError: vi.fn(),
      }),
    ).resolves.toEqual({ ok: true });

    expect(dismissWebsiteAccessNotice).toHaveBeenCalledOnce();
    expect(storage.updateSetup).not.toHaveBeenCalled();
  });

  it.each(['local', 'sync'] as const)(
    'commits policy, %s mode, completion, then draft cleanup',
    async (storageMode): Promise<void> => {
      const order: string[] = [];
      const setupEngine: Engine = {
        updateSettings: vi.fn(async (): Promise<{ ok: true }> => {
          order.push('settings');
          return { ok: true };
        }),
        updateLists: vi.fn(async (): Promise<{ ok: true }> => {
          order.push('lists');
          return { ok: true };
        }),
      } as unknown as Engine;
      const storage: PolicyStorage = onboardingStorage({
        selectLocalMode: vi.fn(async (): Promise<void> => {
          order.push('local');
        }),
        enableSync: vi.fn(async (): Promise<void> => {
          order.push('sync');
        }),
        markSetupCompleted: vi.fn(async (): Promise<void> => {
          order.push('completed');
        }),
      });
      const removeOnboardingDraft = vi.fn(async (): Promise<void> => {
        order.push('draft');
      });

      await expect(
        routeMessage(
          setupEngine,
          { type: 'completeSetup', storageMode, settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS },
          sender,
          storage,
          { reconcileWebsiteAccess: vi.fn(), removeOnboardingDraft, reportError: vi.fn() },
        ),
      ).resolves.toEqual({ ok: true });

      expect(order).toEqual(
        storageMode === 'local'
          ? ['local', 'settings', 'lists', 'completed', 'draft']
          : ['settings', 'lists', 'sync', 'completed', 'draft'],
      );
    },
  );

  it('leaves local mode unchanged when a pending deletion rejects a Sync mode request', async (): Promise<void> => {
    const storage: PolicyStorage = onboardingStorage({
      enableSync: vi
        .fn()
        .mockRejectedValue(new Error('finish the pending data deletion before enabling Sync')),
    });

    await expect(
      routeMessage(
        engine,
        { type: 'setStorageMode', storageMode: 'sync', deleteRemote: false },
        sender,
        storage,
      ),
    ).rejects.toThrow('finish the pending data deletion before enabling Sync');

    expect(storage.enableSync).toHaveBeenCalledOnce();
    expect(storage.selectLocalMode).not.toHaveBeenCalled();
  });

  it('keeps setup incomplete when a pending deletion rejects Sync completion', async (): Promise<void> => {
    const setupEngine: Engine = {
      updateSettings: vi.fn().mockResolvedValue({ ok: true }),
      updateLists: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as Engine;
    const storage: PolicyStorage = onboardingStorage({
      enableSync: vi
        .fn()
        .mockRejectedValue(new Error('finish the pending data deletion before enabling Sync')),
    });

    await expect(
      routeMessage(
        setupEngine,
        {
          type: 'completeSetup',
          storageMode: 'sync',
          settings: DEFAULT_SETTINGS,
          lists: DEFAULT_LISTS,
        },
        sender,
        storage,
      ),
    ).rejects.toThrow('finish the pending data deletion before enabling Sync');

    expect(storage.markSetupCompleted).not.toHaveBeenCalled();
  });

  it('quiesces a failed Sync completion before writing a replacement local policy', async (): Promise<void> => {
    let storageMode: 'local' | 'sync' = 'sync';
    let remoteWrites: number = 0;
    const storage: PolicyStorage = onboardingStorage({
      selectLocalMode: vi.fn(async (): Promise<void> => {
        storageMode = 'local';
      }),
    });
    const setupEngine: Engine = {
      updateSettings: vi.fn(async (): Promise<{ ok: true }> => {
        if (storageMode === 'sync') remoteWrites += 1;
        return { ok: true };
      }),
      updateLists: vi.fn(async (): Promise<{ ok: true }> => {
        if (storageMode === 'sync') remoteWrites += 1;
        return { ok: true };
      }),
    } as unknown as Engine;

    await expect(
      routeMessage(
        setupEngine,
        {
          type: 'completeSetup',
          storageMode: 'local',
          settings: DEFAULT_SETTINGS,
          lists: DEFAULT_LISTS,
        },
        sender,
        storage,
      ),
    ).resolves.toEqual({ ok: true });

    expect(remoteWrites).toBe(0);
    expect(storage.selectLocalMode).toHaveBeenCalledOnce();
  });

  it('keeps setup incomplete and the draft when policy persistence fails', async (): Promise<void> => {
    const setupEngine: Engine = {
      updateSettings: vi.fn().mockResolvedValue({ ok: true }),
      updateLists: vi.fn().mockResolvedValue({ ok: false, error: 'lists rejected' }),
    } as unknown as Engine;
    const storage: PolicyStorage = onboardingStorage();
    const removeOnboardingDraft = vi.fn();

    await expect(
      routeMessage(
        setupEngine,
        {
          type: 'completeSetup',
          storageMode: 'local',
          settings: DEFAULT_SETTINGS,
          lists: DEFAULT_LISTS,
        },
        sender,
        storage,
        { reconcileWebsiteAccess: vi.fn(), removeOnboardingDraft, reportError: vi.fn() },
      ),
    ).resolves.toEqual({ ok: false, error: 'lists rejected' });
    expect(storage.selectLocalMode).toHaveBeenCalledOnce();
    expect(storage.markSetupCompleted).not.toHaveBeenCalled();
    expect(removeOnboardingDraft).not.toHaveBeenCalled();
  });

  it('keeps completed setup when stale-draft cleanup fails', async (): Promise<void> => {
    const reportError = vi.fn();
    const storage: PolicyStorage = onboardingStorage();
    const setupEngine: Engine = {
      updateSettings: vi.fn().mockResolvedValue({ ok: true }),
      updateLists: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as Engine;

    await expect(
      routeMessage(
        setupEngine,
        {
          type: 'completeSetup',
          storageMode: 'local',
          settings: DEFAULT_SETTINGS,
          lists: DEFAULT_LISTS,
        },
        sender,
        storage,
        {
          reconcileWebsiteAccess: vi.fn(),
          removeOnboardingDraft: vi.fn().mockRejectedValue(new Error('remove failed')),
          reportError,
        },
      ),
    ).resolves.toEqual({ ok: true });
    expect(storage.markSetupCompleted).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledOnce();
  });

  it('keeps the draft when setup completion persistence fails', async (): Promise<void> => {
    const storage: PolicyStorage = onboardingStorage({
      markSetupCompleted: vi.fn().mockRejectedValue(new Error('completion unavailable')),
    });
    const setupEngine: Engine = {
      updateSettings: vi.fn().mockResolvedValue({ ok: true }),
      updateLists: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as Engine;
    const removeOnboardingDraft = vi.fn();

    await expect(
      routeMessage(
        setupEngine,
        {
          type: 'completeSetup',
          storageMode: 'local',
          settings: DEFAULT_SETTINGS,
          lists: DEFAULT_LISTS,
        },
        sender,
        storage,
        { reconcileWebsiteAccess: vi.fn(), removeOnboardingDraft, reportError: vi.fn() },
      ),
    ).rejects.toThrow('completion unavailable');
    expect(removeOnboardingDraft).not.toHaveBeenCalled();
  });

  it('changes to local mode before optionally deleting remote data', async (): Promise<void> => {
    const order: string[] = [];
    const storage: PolicyStorage = onboardingStorage({
      storageMode: vi.fn().mockResolvedValue('sync'),
      selectLocalMode: vi.fn(async (): Promise<void> => {
        order.push('local');
      }),
      deleteRemoteData: vi.fn(async (): Promise<void> => {
        order.push('delete');
      }),
    });

    await expect(
      routeMessage(
        engine,
        { type: 'setStorageMode', storageMode: 'local', deleteRemote: true },
        sender,
        storage,
      ),
    ).resolves.toEqual({ ok: true });
    expect(order).toEqual(['local', 'delete']);
    expect(storage.deleteRemoteData).toHaveBeenCalledWith('synced-policy');
  });

  it('does not report a failed remote deletion as a successful mode change', async (): Promise<void> => {
    const storage: PolicyStorage = onboardingStorage({
      deleteRemoteData: vi.fn().mockRejectedValue(new Error('remote deletion failed')),
    });

    await expect(
      routeMessage(
        engine,
        { type: 'setStorageMode', storageMode: 'local', deleteRemote: true },
        sender,
        storage,
      ),
    ).rejects.toThrow('remote deletion failed');
  });

  it('clears local history through the serialized storage adapter', async (): Promise<void> => {
    const storage: PolicyStorage = onboardingStorage();
    const historyEngine: Engine = {
      runWithLocalHistoryClear: vi.fn(
        async (operation: () => Promise<boolean>): Promise<boolean> => operation(),
      ),
    } as unknown as Engine;

    await expect(
      routeMessage(
        historyEngine,
        { type: 'clearFocusLockData', scope: 'local-history' },
        sender,
        storage,
      ),
    ).resolves.toEqual({ ok: true, scope: 'local-history', status: 'cleared' });
    expect(storage.clearLocalHistory).toHaveBeenCalledOnce();
  });

  it('returns the pending local-history scope when durable removal fails', async (): Promise<void> => {
    const storage: PolicyStorage = onboardingStorage({
      clearLocalHistory: vi.fn().mockRejectedValue(new Error('local history unavailable')),
    });
    const historyEngine: Engine = {
      runWithLocalHistoryClear: vi.fn(
        async (operation: () => Promise<boolean>): Promise<boolean> => operation(),
      ),
    } as unknown as Engine;

    await expect(
      routeMessage(
        historyEngine,
        { type: 'clearFocusLockData', scope: 'local-history' },
        sender,
        storage,
      ),
    ).resolves.toEqual({
      ok: false,
      error: 'local history unavailable',
      scope: 'local-history',
      status: 'pending',
    });
  });

  it('returns the pending scope when synced-policy deletion requires disabled Sync', async (): Promise<void> => {
    const storage: PolicyStorage = onboardingStorage({
      storageMode: vi.fn().mockResolvedValue('sync'),
    });

    await expect(
      routeMessage(engine, { type: 'clearFocusLockData', scope: 'synced-policy' }, sender, storage),
    ).resolves.toEqual({
      ok: false,
      error: 'Disable Sync before deleting synced data',
      scope: 'synced-policy',
      status: 'pending',
    });
    expect(storage.deleteRemoteData).not.toHaveBeenCalled();
  });

  it('returns the pending synced-policy scope when storage-mode loading fails', async (): Promise<void> => {
    const storage: PolicyStorage = onboardingStorage({
      storageMode: vi.fn().mockRejectedValue(new Error('mode unavailable')),
    });

    await expect(
      routeMessage(engine, { type: 'clearFocusLockData', scope: 'synced-policy' }, sender, storage),
    ).resolves.toEqual({
      ok: false,
      error: 'mode unavailable',
      scope: 'synced-policy',
      status: 'pending',
    });
    expect(storage.deleteRemoteData).not.toHaveBeenCalled();
  });

  it('quiesces Sync, clears all data through its Engine barrier, then reconciles permission', async (): Promise<void> => {
    const order: string[] = [];
    const storage: PolicyStorage = onboardingStorage({
      storageMode: vi.fn().mockResolvedValue('sync'),
      selectLocalMode: vi.fn(async (): Promise<void> => {
        order.push('local');
      }),
      deleteRemoteData: vi.fn(async (): Promise<void> => {
        order.push('delete');
      }),
    });
    const clearingEngine: Engine = {} as Engine;
    const reconcileWebsiteAccess = vi.fn(async () => {
      order.push('reconcile');
      return { permission: 'granted' as const, status: 'ready' as const };
    });

    await expect(
      routeMessage(clearingEngine, { type: 'clearFocusLockData', scope: 'all' }, sender, storage, {
        reconcileWebsiteAccess,
        removeOnboardingDraft: vi.fn(),
        reportError: vi.fn(),
      }),
    ).resolves.toEqual({ ok: true, scope: 'all', status: 'cleared' });
    expect(order).toEqual(['local', 'delete', 'reconcile']);
    expect(storage.deleteRemoteData).toHaveBeenCalledWith('all');
  });

  it('preserves data and does not reconcile when all-data remote deletion fails', async (): Promise<void> => {
    const clearingEngine: Engine = {} as Engine;
    const setupCompleted = vi.fn();
    const storage: PolicyStorage = onboardingStorage({
      deleteRemoteData: vi.fn().mockRejectedValue(new Error('remote deletion unavailable')),
      loadSetup: vi.fn().mockResolvedValue({
        ...DEFAULT_SETUP,
        completed: true,
        storageMode: 'local',
        dataClear: { status: 'error', scope: 'all', phase: 'remote' },
      } satisfies SetupState),
    });
    const reconcileWebsiteAccess = vi.fn();

    await expect(
      routeMessage(clearingEngine, { type: 'clearFocusLockData', scope: 'all' }, sender, storage, {
        reconcileWebsiteAccess,
        removeOnboardingDraft: vi.fn(),
        reportError: vi.fn(),
        setupCompleted,
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'remote deletion unavailable',
      scope: 'all',
      status: 'pending',
    });
    expect(reconcileWebsiteAccess).not.toHaveBeenCalled();
    expect(setupCompleted).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('keeps live completion aligned when all-data storage-mode loading fails early', async (): Promise<void> => {
    const setupCompleted = vi.fn();
    const completedSetup: SetupState = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'local',
    };
    const storage: PolicyStorage = onboardingStorage({
      storageMode: vi.fn().mockRejectedValue(new Error('mode unavailable')),
      loadSetup: vi.fn().mockResolvedValue(completedSetup),
    });

    await expect(
      routeMessage({} as Engine, { type: 'clearFocusLockData', scope: 'all' }, sender, storage, {
        reconcileWebsiteAccess: vi.fn(),
        removeOnboardingDraft: vi.fn(),
        reportError: vi.fn(),
        setupCompleted,
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'mode unavailable',
      scope: 'all',
      status: 'pending',
    });

    expect(completedSetup).toMatchObject({ completed: true, dataClear: { status: 'idle' } });
    expect(storage.loadSetup).toHaveBeenCalledOnce();
    expect(setupCompleted).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('keeps live completion aligned when local-mode selection fails before deletion', async (): Promise<void> => {
    const setupCompleted = vi.fn();
    const completedSetup: SetupState = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'sync',
    };
    const storage: PolicyStorage = onboardingStorage({
      storageMode: vi.fn().mockResolvedValue('sync'),
      selectLocalMode: vi.fn().mockRejectedValue(new Error('local mode unavailable')),
      loadSetup: vi.fn().mockResolvedValue(completedSetup),
    });

    await expect(
      routeMessage({} as Engine, { type: 'clearFocusLockData', scope: 'all' }, sender, storage, {
        reconcileWebsiteAccess: vi.fn(),
        removeOnboardingDraft: vi.fn(),
        reportError: vi.fn(),
        setupCompleted,
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'local mode unavailable',
      scope: 'all',
      status: 'pending',
    });

    expect(completedSetup).toMatchObject({ completed: true, dataClear: { status: 'idle' } });
    expect(storage.loadSetup).toHaveBeenCalledOnce();
    expect(storage.deleteRemoteData).not.toHaveBeenCalled();
    expect(setupCompleted).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('clears live completion when Engine reset fails after durable all-data deletion', async (): Promise<void> => {
    const setupCompleted = vi.fn();
    const storage: PolicyStorage = onboardingStorage({
      storageMode: vi.fn().mockResolvedValue('local'),
      deleteRemoteData: vi.fn().mockRejectedValue(new Error('device rehydration unavailable')),
      loadSetup: vi.fn().mockResolvedValue(structuredClone(DEFAULT_SETUP)),
    });

    await expect(
      routeMessage({} as Engine, { type: 'clearFocusLockData', scope: 'all' }, sender, storage, {
        reconcileWebsiteAccess: vi.fn(),
        removeOnboardingDraft: vi.fn(),
        reportError: vi.fn(),
        setupCompleted,
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'device rehydration unavailable',
      scope: 'all',
      status: 'pending',
    });

    expect(storage.loadSetup).toHaveBeenCalledOnce();
    expect(setupCompleted).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('retries a boot-restored null-mode all-data local phase without selecting a mode', async (): Promise<void> => {
    const storage: PolicyStorage = onboardingStorage({
      storageMode: vi.fn().mockResolvedValue(null),
    });

    await expect(
      routeMessage({} as Engine, { type: 'clearFocusLockData', scope: 'all' }, sender, storage),
    ).resolves.toEqual({ ok: true, scope: 'all', status: 'cleared' });
    expect(storage.selectLocalMode).not.toHaveBeenCalled();
    expect(storage.deleteRemoteData).toHaveBeenCalledWith('all');
  });
});

describe('routeMessage stats wiring', () => {
  beforeEach((): void => {
    vi.clearAllMocks();
  });

  afterEach((): void => {
    vi.restoreAllMocks();
  });

  it('delegates getStats with the requested range and current time', async () => {
    const now: number = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.mocked(fetchStats).mockResolvedValue(stats);

    const local = {} as chrome.storage.StorageArea;
    const aggregateStorage: AggregateStorage = { local, sync: null };
    const withAggregateStorage = vi.fn(
      async (operation: (storage: AggregateStorage) => Promise<unknown>): Promise<unknown> =>
        operation(aggregateStorage),
    );
    const policyStorage: PolicyStorage = {
      withAggregateStorage:
        withAggregateStorage as unknown as PolicyStorage['withAggregateStorage'],
    } as unknown as PolicyStorage;
    const result: unknown = await routeMessage(
      engine,
      { type: 'getStats', days: 14 },
      sender,
      policyStorage,
    );

    expect(result).toBe(stats);
    expect(withAggregateStorage).toHaveBeenCalledOnce();
    expect(fetchStats).toHaveBeenCalledWith(14, now, overlay, aggregateStorage);
  });

  it('exports the local event log as formatted JSON', async () => {
    const events: EventRecord[] = [
      {
        t: 'sessionCompleted',
        at: 123,
        focusedMs: 60_000,
      },
    ];
    vi.mocked(readEvents).mockResolvedValue(events);

    const result: unknown = await routeMessage(engine, { type: 'exportEvents' }, sender);

    expect(result).toEqual({ json: JSON.stringify(events, null, 2) });
  });
});

describe('routeMessage session ending wiring', () => {
  it('delegates the honest session-end request to the engine', async (): Promise<void> => {
    const requestSessionEnd = vi.fn().mockResolvedValue({ ok: true });
    const endingEngine: Engine = { requestSessionEnd } as unknown as Engine;

    expect(await routeMessage(endingEngine, { type: 'requestSessionEnd' }, sender)).toEqual({
      ok: true,
    });
    expect(requestSessionEnd).toHaveBeenCalledTimes(1);
  });

  it('rejects deprecated force end without invoking the engine', async (): Promise<void> => {
    const forceEndGate = vi.fn().mockResolvedValue({ ok: true });
    const endingEngine: Engine = { forceEndGate } as unknown as Engine;

    expect(await routeMessage(endingEngine, { type: 'forceEndGate' }, sender)).toEqual({
      ok: false,
      error: 'Force end is no longer available. Choose a Flexible session before starting.',
    });
    expect(forceEndGate).not.toHaveBeenCalled();
  });
});

describe('routeMessage tab identity wiring', () => {
  it('binds a stopped fresh document to its URL', async () => {
    const url: string = 'https://blocked.example/page';
    const documentId = 'document-one';
    const markStopped = vi.fn().mockResolvedValue(undefined);
    const rebindTab = vi.fn();
    const blockingEngine: Engine = {
      verdictFor: vi.fn(() => ({ blocked: true, reason: 'custom', matchedPattern: url })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      rebindTab,
      markStopped,
      snapshotPersisted: vi.fn().mockResolvedValue(emptySnapshot(0)),
    } as unknown as Engine;
    const tabSender: chrome.runtime.MessageSender = {
      tab: { id: 7, url } as chrome.tabs.Tab,
      url,
      documentId,
    };

    await routeMessage(
      blockingEngine,
      { type: 'getBlockState', url, docState: 'fresh' },
      tabSender,
    );

    expect(markStopped).toHaveBeenCalledWith(7, url, documentId);
    expect(rebindTab).not.toHaveBeenCalled();
  });

  it('fails closed when a fresh sender has no document identity', async () => {
    const url: string = 'https://blocked.example/page';
    const markStopped = vi.fn().mockResolvedValue(undefined);
    const blockingEngine: Engine = {
      verdictFor: vi.fn(() => ({ blocked: true, reason: 'custom', matchedPattern: url })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      rebindTab: vi.fn(),
      markStopped,
      snapshotPersisted: vi.fn().mockResolvedValue(emptySnapshot(0)),
    } as unknown as Engine;

    await routeMessage(
      blockingEngine,
      { type: 'getBlockState', url, docState: 'fresh' },
      { tab: { id: 7, url } as chrome.tabs.Tab, url },
    );

    expect(markStopped).not.toHaveBeenCalled();
  });

  it('ignores stale block-state mutations after the tab navigates', async () => {
    const oldUrl: string = 'https://blocked.example/old';
    const newUrl: string = 'https://allowed.example/new';
    const recordAttempt = vi.fn().mockResolvedValue(undefined);
    const rebindTab = vi.fn();
    const markStopped = vi.fn().mockResolvedValue(undefined);
    const blockingEngine: Engine = {
      verdictFor: vi.fn(() => ({ blocked: true, reason: 'custom', matchedPattern: oldUrl })),
      recordAttempt,
      rebindTab,
      markStopped,
      snapshotPersisted: vi.fn().mockResolvedValue(emptySnapshot(0)),
    } as unknown as Engine;
    const staleSender: chrome.runtime.MessageSender = {
      tab: { id: 7, url: newUrl } as chrome.tabs.Tab,
      url: oldUrl,
    };

    await routeMessage(
      blockingEngine,
      { type: 'getBlockState', url: oldUrl, docState: 'fresh' },
      staleSender,
    );

    expect(rebindTab).not.toHaveBeenCalled();
    expect(recordAttempt).not.toHaveBeenCalled();
    expect(markStopped).not.toHaveBeenCalled();
  });
});

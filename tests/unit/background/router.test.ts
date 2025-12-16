import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlarmNameV2, ScheduledAlarmV2 } from '../../../src/background/alarms-v2';
import { Engine, type EnginePorts } from '../../../src/background/engine';
import { readEventsV2 } from '../../../src/background/event-log-v2';
import type { PolicyStorage } from '../../../src/background/policy-storage';
import { routeMessage } from '../../../src/background/router';
import { emptyRuntimeV2 } from '../../../src/background/runtime-store-v2';
import type { RuntimeStateV2 } from '../../../src/background/runtime-v2-types';
import { type AggregateStorage, fetchStats } from '../../../src/background/stats-service';
import {
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  DEFAULT_SETUP,
  rulesFromLists,
} from '../../../src/shared/constants';
import type {
  DocumentContentCommand,
  DocumentEnforcementCommand,
} from '../../../src/shared/enforcement-v2';
import type { StatsBundle } from '../../../src/shared/messages';
import { isWebsiteAccessReconciliation } from '../../../src/shared/runtime-validation';
import type {
  DailyAgg,
  EventRecord,
  ListsConfig,
  OnboardingDraft,
  SessionConfig,
  SetupState,
} from '../../../src/shared/types';

vi.mock('../../../src/background/audio', () => ({ playSound: vi.fn() }));
vi.mock('../../../src/background/stats-service', () => ({ fetchStats: vi.fn() }));
vi.mock('../../../src/background/event-log-v2', async () => {
  const actual: typeof import('../../../src/background/event-log-v2') = await vi.importActual(
    '../../../src/background/event-log-v2',
  );
  return { ...actual, readEventsV2: vi.fn() };
});

/** The engine fixture boots on one fixed enforcement epoch so its runtime parses. */
const ENGINE_EPOCH_ID: string = '30000000-0000-4000-8000-0000000000a1';

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
    focusMsLast7Days: 0,
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
    finishLocalHistoryClear: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as PolicyStorage;
}

/** Every v2 identity the runtime parses is a UUID, so the fixture mints real ones. */
function uuidMinter(): () => string {
  let minted: number = 0;
  return (): string => {
    minted += 1;
    return `40000000-0000-4000-8000-${String(minted).padStart(12, '0')}`;
  };
}

function realBlockingEngine(options?: {
  now?: () => number;
  saveRuntime?: (runtime: RuntimeStateV2) => Promise<void> | void;
}): Engine {
  const now: () => number = options?.now ?? ((): number => new Date(2026, 7, 31, 12, 0).getTime());
  // The controller reads its alarms back, so the fixture remembers what it was asked to schedule.
  const alarms: Map<string, ScheduledAlarmV2> = new Map<string, ScheduledAlarmV2>();
  const ports: EnginePorts = {
    now,
    newId: uuidMinter(),
    rehydrateAfterDataClear: async (): Promise<string> => 'device-rehydrated',
    saveRuntime: async (runtime: RuntimeStateV2): Promise<void> => options?.saveRuntime?.(runtime),
    saveMatcherCache: async (): Promise<void> => undefined,
    queueSync: (): void => undefined,
    supersedeSync: (): void => undefined,
    removeSync: (): void => undefined,
    persistSyncJournal: async (): Promise<void> => undefined,
    appendEvents: async (): Promise<void> => undefined,
    broadcast: (): void => undefined,
    applyBlocking: async (): Promise<void> => undefined,
    playSound: (): void => undefined,
    notify: (): void => undefined,
    updateIcon: (): void => undefined,
    scheduleWake: (): void => undefined,
    prune: async (): Promise<void> => undefined,
    reportError: (): void => undefined,
    websiteBlockingReady: (): boolean => true,
    hasPendingSync: (): boolean => false,
    auditEnforcement: async (): Promise<'ready'> => 'ready',
    targets: {
      queryTopFrameTabs: async (): Promise<Array<{ tabId: number; url: string | null }>> => [],
      topFrameDocumentId: async (): Promise<string | null> => null,
      readTargetGeneration: (): number => 0,
      now,
    },
    transport: {
      sendToDocument: async (): Promise<unknown> => undefined,
    },
    alarms: {
      create: async (name: AlarmNameV2, when: number): Promise<void> => {
        alarms.set(name, { scheduledTime: when, periodInMinutes: null });
      },
      createPeriodic: async (name: AlarmNameV2, periodInMinutes: number): Promise<void> => {
        alarms.set(name, { scheduledTime: now(), periodInMinutes });
      },
      get: async (name: AlarmNameV2): Promise<ScheduledAlarmV2 | null> => alarms.get(name) ?? null,
      clear: async (name: AlarmNameV2): Promise<void> => {
        alarms.delete(name);
      },
    },
    loadAggregates: async (): Promise<Record<string, DailyAgg>> => ({}),
    clearBlockingForNonBlockingPhase: async (): Promise<void> => undefined,
    restoreTabClaims: async (): Promise<number[]> => [],
    reloadStoppedDocuments: async (): Promise<void> => undefined,
  };
  return new Engine(
    ports,
    DEFAULT_SETTINGS,
    { ...DEFAULT_LISTS, custom: [{ kind: 'host', pattern: 'facebook.com' }] },
    { balanceMs: 0 },
    null,
    emptyRuntimeV2(now(), ENGINE_EPOCH_ID),
    'device-id',
  );
}

/** The one blocked enforcement command the router reads a stopped page out of. */
function blockingCommand(url: string, documentId: string): DocumentEnforcementCommand {
  return {
    version: 1,
    command: 'apply-enforcement',
    operationId: '40000000-0000-4000-8000-0000000000ff',
    enforcementEpoch: ENGINE_EPOCH_ID,
    sessionId: null,
    reservedSessionId: null,
    basePolicyRevision: 1,
    runtimeRevision: 1,
    documentId,
    expectedUrl: url,
    presentation: 'active',
    verdict: { blocked: true, reason: 'custom', categoryId: null, matchedPattern: url },
    overlay: null,
  };
}

describe('routeMessage onboarding wiring', (): void => {
  it('returns an exact operational cleanup failure', async (): Promise<void> => {
    const storage: PolicyStorage = onboardingStorage({
      loadSetup: vi.fn().mockResolvedValue({ ...DEFAULT_SETUP, completed: true }),
    });

    await expect(
      routeMessage(engine, { type: 'cleanupOnboardingDraft' }, sender, storage, {
        reconcileWebsiteAccess: vi.fn(),
        removeOnboardingDraft: vi.fn().mockRejectedValue(new Error('storage remove failed')),
        reportError: vi.fn(),
      }),
    ).resolves.toEqual({ ok: false, error: 'storage remove failed' });
  });

  it('returns an exact operational completion failure', async (): Promise<void> => {
    const authoritative: OnboardingDraft = {
      version: 1,
      revision: 8,
      step: 3,
      settings: DEFAULT_SETTINGS,
      lists: DEFAULT_LISTS,
      websiteAccessChoice: 'deferred',
      syncEnabled: false,
    };
    const storage: PolicyStorage = onboardingStorage({
      selectLocalMode: vi.fn().mockRejectedValue(new Error('policy storage failed')),
    });

    await expect(
      routeMessage(
        engine,
        { type: 'completeOnboarding', revision: 8, storageMode: 'local' },
        sender,
        storage,
        {
          reconcileWebsiteAccess: vi.fn(),
          loadOnboardingDraft: vi
            .fn()
            .mockResolvedValue({ ok: true, draft: authoritative, invalid: false }),
          removeOnboardingDraft: vi.fn(),
          reportError: vi.fn(),
        },
      ),
    ).resolves.toEqual({ ok: false, error: 'policy storage failed' });
  });

  it('rejects stale-tab completion before committing any policy', async (): Promise<void> => {
    const authoritative: OnboardingDraft = {
      version: 1,
      revision: 8,
      step: 3,
      settings: DEFAULT_SETTINGS,
      lists: DEFAULT_LISTS,
      websiteAccessChoice: 'deferred',
      syncEnabled: true,
    };
    const setupEngine: Engine = {
      updateSettings: vi.fn().mockResolvedValue({ ok: true }),
      updateLists: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as Engine;
    const storage: PolicyStorage = onboardingStorage();

    await expect(
      routeMessage(
        setupEngine,
        { type: 'completeOnboarding', revision: 7, storageMode: 'sync' },
        sender,
        storage,
        {
          reconcileWebsiteAccess: vi.fn(),
          loadOnboardingDraft: vi
            .fn()
            .mockResolvedValue({ ok: true, draft: authoritative, invalid: false }),
          removeOnboardingDraft: vi.fn(),
          reportError: vi.fn(),
        },
      ),
    ).resolves.toEqual({
      ok: false,
      error: 'Setup changed in another tab. Reload setup before finishing.',
      conflict: true,
      completed: false,
      draft: authoritative,
    });
    expect(setupEngine.updateSettings).not.toHaveBeenCalled();
    expect(setupEngine.updateLists).not.toHaveBeenCalled();
    expect(storage.enableSync).not.toHaveBeenCalled();
    expect(storage.markSetupCompleted).not.toHaveBeenCalled();
  });

  it('completes from the revision-checked authoritative draft', async (): Promise<void> => {
    const authoritative: OnboardingDraft = {
      version: 1,
      revision: 8,
      step: 3,
      settings: { ...DEFAULT_SETTINGS, retentionDays: 30 },
      lists: { ...DEFAULT_LISTS, categories: { ...DEFAULT_LISTS.categories, news: true } },
      websiteAccessChoice: 'deferred',
      syncEnabled: false,
    };
    const setupEngine: Engine = {
      updateSettings: vi.fn().mockResolvedValue({ ok: true }),
      updateLists: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as Engine;
    const storage: PolicyStorage = onboardingStorage();

    await expect(
      routeMessage(
        setupEngine,
        { type: 'completeOnboarding', revision: 8, storageMode: 'local' },
        sender,
        storage,
        {
          reconcileWebsiteAccess: vi.fn(),
          loadOnboardingDraft: vi
            .fn()
            .mockResolvedValue({ ok: true, draft: authoritative, invalid: false }),
          removeOnboardingDraft: vi.fn(),
          reportError: vi.fn(),
        },
      ),
    ).resolves.toEqual({ ok: true });
    expect(setupEngine.updateSettings).toHaveBeenCalledWith(authoritative.settings);
    expect(setupEngine.updateLists).toHaveBeenCalledWith(authoritative.lists);
    expect(storage.markSetupCompleted).toHaveBeenCalledOnce();
  });

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
    ['granted', 'ready', { ok: true, granted: true, registration: 'ready' }],
    [
      'granted',
      'unavailable',
      {
        ok: false,
        error:
          'Focus Lock received an inconsistent website access state. Retry setup or reload the extension.',
      },
    ],
    [
      'granted',
      'error',
      {
        ok: false,
        error:
          'Website access is granted, but Focus Lock could not enable blocking. Retry setup or reload the extension.',
        granted: true,
        registration: 'error',
      },
    ],
    [
      'denied',
      'ready',
      {
        ok: false,
        error:
          'Focus Lock received an inconsistent website access state. Retry setup or reload the extension.',
      },
    ],
    ['denied', 'unavailable', { ok: true, granted: false, registration: 'unavailable' }],
    [
      'denied',
      'error',
      {
        ok: false,
        error:
          'Website access is unavailable, and Focus Lock could not finish blocking cleanup. Retry setup or reload the extension.',
        granted: false,
        registration: 'error',
      },
    ],
    [
      'unknown',
      'ready',
      {
        ok: false,
        error: 'Focus Lock could not check website access. Retry setup or reload the extension.',
      },
    ],
    [
      'unknown',
      'unavailable',
      {
        ok: false,
        error: 'Focus Lock could not check website access. Retry setup or reload the extension.',
      },
    ],
    [
      'unknown',
      'error',
      {
        ok: false,
        error: 'Focus Lock could not check website access. Retry setup or reload the extension.',
        registration: 'error',
      },
    ],
  ] as const)(
    'maps %s permission with %s registration to an exact reconciliation response',
    async (permission, status, expected): Promise<void> => {
      const reconcileWebsiteAccess = vi.fn().mockResolvedValue({ permission, status });

      const result: unknown = await routeMessage(
        engine,
        { type: 'reconcileWebsiteAccess' },
        sender,
        onboardingStorage(),
        { reconcileWebsiteAccess, removeOnboardingDraft: vi.fn(), reportError: vi.fn() },
      );

      expect(result).toEqual(expected);
      expect(isWebsiteAccessReconciliation(result)).toBe(true);
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

  it('retries the authoritative Sync journal and reports durable completion', async (): Promise<void> => {
    const retrySync = vi.fn(async (): Promise<void> => {});
    const storage: PolicyStorage = onboardingStorage({
      retrySync,
      loadSetup: vi.fn().mockResolvedValue({
        ...DEFAULT_SETUP,
        completed: true,
        storageMode: 'sync',
        syncWriteStatus: 'idle',
      }),
    });

    await expect(
      routeMessage(engine, { type: 'retrySync' } as never, sender, storage),
    ).resolves.toEqual({ ok: true, syncWriteStatus: 'idle' });
    expect(retrySync).toHaveBeenCalledOnce();
    expect(storage.enableSync).not.toHaveBeenCalled();
  });

  it('reports an authoritative Sync retry failure instead of returning success', async (): Promise<void> => {
    const storage: PolicyStorage = onboardingStorage({
      retrySync: vi.fn().mockRejectedValue(new Error('8192-byte limit')),
      loadSetup: vi.fn().mockResolvedValue({
        ...DEFAULT_SETUP,
        completed: true,
        storageMode: 'sync',
        syncWriteStatus: 'error',
        storageError: 'sync-publish-failed',
      }),
    });

    await expect(routeMessage(engine, { type: 'retrySync' }, sender, storage)).rejects.toThrow(
      '8192-byte limit',
    );
    expect(storage.loadSetup).not.toHaveBeenCalled();
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

  it.each(['enableSync', 'selectLocalMode'] as const)(
    'keeps a live session blocking, and counts no attempt, while %s holds the Engine storage barrier',
    async (transition: 'enableSync' | 'selectLocalMode'): Promise<void> => {
      const blockingEngine: Engine = realBlockingEngine();
      const config: SessionConfig = {
        mode: 'blacklist',
        strictness: 'friction',
        duration: { kind: 'timed', minutes: 25 },
        cycling: null,
        intention: 'finish the launch',
        source: 'manual',
        scheduleOccurrence: null,
        rules: rulesFromLists({
          ...DEFAULT_LISTS,
          custom: [{ kind: 'host', pattern: 'facebook.com' }],
        }),
      };
      await blockingEngine.startSession(config);
      let releaseBarrier: () => void = (): void => undefined;
      let signalBarrierHeld: () => void = (): void => undefined;
      const barrierBlocked: Promise<void> = new Promise<void>((resolve: () => void): void => {
        releaseBarrier = resolve;
      });
      const barrierHeld: Promise<void> = new Promise<void>((resolve: () => void): void => {
        signalBarrierHeld = resolve;
      });
      const holdBarrier: () => Promise<void> = (): Promise<void> =>
        blockingEngine.runWithAggregateStorageBarrier(async (): Promise<void> => {
          signalBarrierHeld();
          await barrierBlocked;
        });
      const storage: PolicyStorage = onboardingStorage({
        [transition]: vi.fn(holdBarrier),
      });
      const changingMode: Promise<unknown> = routeMessage(
        blockingEngine,
        {
          type: 'setStorageMode',
          storageMode: transition === 'enableSync' ? 'sync' : 'local',
          deleteRemote: false,
        },
        sender,
        storage,
      );
      await barrierHeld;
      const url: string = 'https://facebook.com/feed';

      let answer: unknown;
      try {
        // Switching where policy is stored does not end the session, so the page this pull is for
        // stays blocked for the whole transition. Only a pending all-data clear answers nothing.
        answer = await routeMessage(
          blockingEngine,
          { type: 'getBlockState', url, docState: 'fresh' },
          {
            url,
            tab: { id: 7, url } as chrome.tabs.Tab,
            documentId: 'document-id',
          },
        );
      } finally {
        releaseBarrier();
        await changingMode;
      }
      const commands: DocumentContentCommand[] = (answer as { commands: DocumentContentCommand[] })
        .commands;
      const enforcement: DocumentEnforcementCommand[] = commands.filter(
        (command: DocumentContentCommand): command is DocumentEnforcementCommand =>
          command.command === 'apply-enforcement',
      );
      expect(enforcement).toHaveLength(1);
      expect(enforcement[0]?.verdict.blocked).toBe(true);
      // The page is stopped, so the claim the closure reloads it from is kept: only the profile
      // erase refuses that write, and a mode switch is not one.
      expect(blockingEngine.tabFacts(7, url, 'document-id').wasStopped).toBe(true);
      // The attempt is the exception. It lands in the aggregate a quiesced barrier is rewriting,
      // so the count is dropped rather than written past it.
      expect(blockingEngine.statsOverlay().todayAgg.attempts['facebook.com']).toBeUndefined();
    },
  );

  it('clears local history through the serialized storage adapter', async (): Promise<void> => {
    const storage: PolicyStorage = onboardingStorage();
    const historyEngine: Engine = {
      runWithLocalHistoryClear: vi.fn(
        async (
          operation: () => Promise<boolean>,
          finish: () => Promise<void>,
        ): Promise<boolean> => {
          const result: boolean = await operation();
          await finish();
          return result;
        },
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
    expect(storage.finishLocalHistoryClear).toHaveBeenCalledOnce();
  });

  it('keeps the exact local-history scope pending when runtime sanitization fails', async (): Promise<void> => {
    const storage: PolicyStorage = onboardingStorage({
      clearLocalHistory: vi.fn().mockResolvedValue(true),
    });
    const historyEngine: Engine = {
      runWithLocalHistoryClear: vi.fn(
        async (operation: () => Promise<boolean>): Promise<boolean> => {
          await operation();
          throw new Error('sanitized runtime unavailable');
        },
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
      error: 'sanitized runtime unavailable',
      scope: 'local-history',
      status: 'pending',
    });
    expect(storage.finishLocalHistoryClear).not.toHaveBeenCalled();
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
    vi.mocked(readEventsV2).mockResolvedValue(events);

    const result: unknown = await routeMessage(engine, { type: 'exportEvents' }, sender);

    expect(result).toEqual({ json: JSON.stringify(events, null, 2) });
  });
});

describe('routeMessage session category override wiring', (): void => {
  it('starts and enforces an edited category without changing persistent lists', async (): Promise<void> => {
    const blockingEngine: Engine = realBlockingEngine();
    const before: ListsConfig = blockingEngine.getLists();
    const config: SessionConfig = {
      mode: 'blacklist',
      strictness: 'friction',
      duration: { kind: 'timed', minutes: 25 },
      cycling: null,
      intention: 'finish the launch',
      source: 'manual',
      scheduleOccurrence: null,
      rules: {
        ...rulesFromLists(before),
        categories: { ...before.categories, social: true },
      },
    };

    await expect(
      routeMessage(blockingEngine, { type: 'startSession', config }, sender),
    ).resolves.toEqual({ ok: true, code: 'ok' });
    const url: string = 'https://instagram.com/explore';
    await expect(
      routeMessage(
        blockingEngine,
        { type: 'getBlockState', url, docState: 'fresh' },
        {
          url,
          tab: { id: 17, url } as chrome.tabs.Tab,
          documentId: 'category-override-document',
        },
      ),
    ).resolves.toMatchObject({
      commands: expect.arrayContaining([
        expect.objectContaining({
          command: 'apply-enforcement',
          verdict: expect.objectContaining({ blocked: true }),
          overlay: expect.objectContaining({ presentation: 'active', phase: 'focus' }),
        }),
      ]),
    });
    expect(blockingEngine.getLists()).toEqual(before);
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
});

describe('routeMessage tab identity wiring', () => {
  it('binds a stopped fresh document to its URL', async () => {
    const url: string = 'https://blocked.example/page';
    const documentId = 'document-one';
    const markStopped = vi.fn().mockResolvedValue(undefined);
    const rebindTab = vi.fn();
    const documentCommandsFor = vi.fn().mockResolvedValue([blockingCommand(url, documentId)]);
    const blockingEngine: Engine = {
      documentCommandsFor,
      rebindTab,
      markStopped,
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

    expect(documentCommandsFor).toHaveBeenCalledWith({ tabId: 7, documentId, url }, 'navigation');
    expect(markStopped).toHaveBeenCalledWith(7, url, documentId);
    expect(rebindTab).not.toHaveBeenCalled();
  });

  it('fails closed when a fresh sender has no document identity', async () => {
    const url: string = 'https://blocked.example/page';
    const markStopped = vi.fn().mockResolvedValue(undefined);
    const documentCommandsFor = vi.fn().mockResolvedValue([blockingCommand(url, 'document-one')]);
    const blockingEngine: Engine = {
      documentCommandsFor,
      rebindTab: vi.fn(),
      markStopped,
    } as unknown as Engine;

    await expect(
      routeMessage(
        blockingEngine,
        { type: 'getBlockState', url, docState: 'fresh' },
        { tab: { id: 7, url } as chrome.tabs.Tab, url },
      ),
    ).resolves.toEqual({ commands: [] });

    expect(documentCommandsFor).not.toHaveBeenCalled();
    expect(markStopped).not.toHaveBeenCalled();
  });

  it('ignores stale block-state mutations after the tab navigates', async () => {
    const oldUrl: string = 'https://blocked.example/old';
    const newUrl: string = 'https://allowed.example/new';
    const rebindTab = vi.fn();
    const markStopped = vi.fn().mockResolvedValue(undefined);
    const documentCommandsFor = vi
      .fn()
      .mockResolvedValue([blockingCommand(oldUrl, 'document-one')]);
    const blockingEngine: Engine = {
      documentCommandsFor,
      rebindTab,
      markStopped,
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
    expect(documentCommandsFor).not.toHaveBeenCalled();
    expect(markStopped).not.toHaveBeenCalled();
  });
});

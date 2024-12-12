import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../../src/background/main';
import type { SyncJournal } from '../../../src/background/sync-writer';
import { SYNC_STREAK } from '../../../src/shared/storage-keys';
import type { StreakState } from '../../../src/shared/types';

interface BootScenario {
  journal: SyncJournal;
  journaledStreak: StreakState | null;
  syncedStreak: StreakState | null;
}

type RuntimeListener = (
  request: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean;
type AlarmListener = (alarm: chrome.alarms.Alarm) => void;
type RemovedListener = (tabId: number) => void;

const mocks = vi.hoisted(
  (): {
    engineArguments: unknown[] | null;
    alarmListener: AlarmListener | null;
    bootGate: Promise<void> | null;
    dropTabCalls: number[];
    dropTabSignal: (() => void) | null;
    removedListener: RemovedListener | null;
    runtimeListener: RuntimeListener | null;
    savedJournals: SyncJournal[];
    scenario: BootScenario;
    tickCalls: number;
    tickError: Error | null;
    dropTabError: Error | null;
    invalidationError: Error | null;
    invalidatedTabIds: number[];
  } => ({
    engineArguments: null,
    alarmListener: null,
    bootGate: null,
    dropTabCalls: [],
    dropTabSignal: null,
    removedListener: null,
    runtimeListener: null,
    savedJournals: [],
    scenario: {
      journal: { sets: {}, removes: [] },
      journaledStreak: null,
      syncedStreak: null,
    },
    tickCalls: 0,
    tickError: null,
    dropTabError: null,
    invalidationError: null,
    invalidatedTabIds: [],
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

    async tick(): Promise<void> {
      mocks.tickCalls += 1;
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
vi.mock('../../../src/background/stats-service', () => ({ runPrune: vi.fn() }));
vi.mock('../../../src/background/storage-sync', () => ({
  handleSyncChanges: vi.fn(),
  missingSyncDefaults: vi.fn((): Record<string, unknown> => ({})),
}));
vi.mock('../../../src/background/stores', () => ({
  appendEvents: vi.fn(),
  getDeviceId: vi.fn().mockResolvedValue('device-id'),
  loadBank: vi.fn().mockResolvedValue({ balanceMs: 0 }),
  loadLists: vi.fn().mockResolvedValue({}),
  loadRuntime: vi.fn().mockResolvedValue({}),
  loadSettings: vi.fn().mockResolvedValue({}),
  loadStreak: vi
    .fn()
    .mockImplementation(async (journal?: SyncJournal): Promise<StreakState | null> => {
      return journal === undefined ? mocks.scenario.syncedStreak : mocks.scenario.journaledStreak;
    }),
  loadSyncJournal: vi.fn().mockImplementation(async (): Promise<SyncJournal> => {
    if (mocks.bootGate !== null) await mocks.bootGate;
    return structuredClone(mocks.scenario.journal);
  }),
  saveRuntime: vi.fn(),
  saveSyncJournal: vi.fn().mockImplementation(async (journal: SyncJournal): Promise<void> => {
    mocks.savedJournals.push(structuredClone(journal));
  }),
}));
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
    journaledStreak,
    syncedStreak,
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
      onChanged: { addListener: vi.fn() },
      sync: {
        get: vi.fn().mockImplementation(
          async (): Promise<Record<string, unknown>> => ({
            [SYNC_STREAK]: mocks.scenario.syncedStreak,
          }),
        ),
        remove: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
      },
    },
    tabs: {
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
    listener({}, {}, (): void => resolve());
  });
}

function engineStreak(): StreakState | null {
  if (mocks.engineArguments === null) throw new Error('engine was not constructed');
  return mocks.engineArguments[4] as StreakState | null;
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
  mocks.savedJournals = [];
  mocks.tickCalls = 0;
  mocks.tickError = null;
  mocks.dropTabError = null;
  mocks.invalidationError = null;
  mocks.invalidatedTabIds = [];
  stubChrome();
});

afterEach((): void => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('background boot streak convergence', () => {
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

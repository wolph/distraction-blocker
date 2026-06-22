import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Engine } from '../../../src/background/engine';
import { routeMessage } from '../../../src/background/router';
import { fetchStats } from '../../../src/background/stats-service';
import { readEvents } from '../../../src/background/stores';
import type { WorkTargetService } from '../../../src/background/work-target';
import { emptySnapshot } from '../../../src/shared/constants';
import type { StatsBundle } from '../../../src/shared/messages';
import type { EventRecord } from '../../../src/shared/types';

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

    const result: unknown = await routeMessage(engine, { type: 'getStats', days: 14 }, sender);

    expect(result).toBe(stats);
    expect(fetchStats).toHaveBeenCalledWith(14, now, overlay);
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

describe('work target routing', (): void => {
  it('routes target operations through the injected service with sender identity', async (): Promise<void> => {
    const getWorkTabs: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({ ok: true, tabs: [] });
    const service: import('../../../src/background/work-target').WorkTargetService = {
      getWorkTabs,
    } as unknown as import('../../../src/background/work-target').WorkTargetService;
    await routeMessage(
      engine,
      { type: 'getWorkTabs', mode: 'blacklist', windowId: 4 },
      sender,
      service,
    );
    expect(getWorkTabs).toHaveBeenCalledWith('blacklist', 4, sender);
  });
  it('keeps legacy start requests on the existing engine path', async (): Promise<void> => {
    const startSession: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({ ok: true });
    const legacyEngine: Engine = { startSession } as unknown as Engine;
    const config: import('../../../src/shared/types').SessionConfig = {
      mode: 'blacklist',
      strictness: 'friction',
      durationMin: 25,
      cycling: null,
      intention: '',
      source: 'manual',
      scheduleEntryId: null,
    };
    await routeMessage(legacyEngine, { type: 'startSession', config }, sender);
    expect(startSession).toHaveBeenCalledWith(config);
  });
});

it('routes icon requests through the trusted work target service', async (): Promise<void> => {
  const getWorkTabIcon: ReturnType<typeof vi.fn> = vi
    .fn()
    .mockResolvedValue({ ok: true, icon: null });
  const supplied: WorkTargetService = { getWorkTabIcon } as unknown as WorkTargetService;
  const sender: chrome.runtime.MessageSender = { id: 'extension' };
  expect(
    await routeMessage(
      {} as Engine,
      { type: 'getWorkTabIcon', sessionId: 'one', tabId: 7 },
      sender,
      supplied,
    ),
  ).toEqual({ ok: true, icon: null });
  expect(getWorkTabIcon).toHaveBeenCalledWith('one', 7, sender);
});

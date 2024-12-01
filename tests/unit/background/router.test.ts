import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Engine } from '../../../src/background/engine';
import { routeMessage } from '../../../src/background/router';
import { fetchStats } from '../../../src/background/stats-service';
import { readEvents } from '../../../src/background/stores';
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

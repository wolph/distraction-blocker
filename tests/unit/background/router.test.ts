import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Engine } from '../../../src/background/engine';
import { routeMessage } from '../../../src/background/router';
import { fetchStats } from '../../../src/background/stats-service';
import { readEvents } from '../../../src/background/stores';
import type { StatsBundle } from '../../../src/shared/messages';
import type { EventRecord } from '../../../src/shared/types';

vi.mock('../../../src/background/audio', () => ({ playSound: vi.fn() }));
vi.mock('../../../src/background/stats-service', () => ({ fetchStats: vi.fn() }));
vi.mock('../../../src/background/stores', () => ({ readEvents: vi.fn() }));

const engine: Engine = {} as Engine;
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
    expect(fetchStats).toHaveBeenCalledWith(14, now);
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

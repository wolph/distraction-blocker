import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type AggregateStorage,
  buildStats,
  fetchStats,
  pruneAndRollup,
} from '../../../src/background/stats-service';
import { rollupMonth } from '../../../src/core/stats';
import type { StatsBundle } from '../../../src/shared/messages';
import {
  LOCAL_AGGREGATE_PRUNE,
  LOCAL_AGGREGATE_TOMBSTONES,
  LOCAL_DEVICE_ID,
  LOCAL_EVENTS,
} from '../../../src/shared/storage-keys';
import type { DailyAgg, EventRecord } from '../../../src/shared/types';
import { pairSessionRowsV2, type SessionRowV2 } from '../../../src/stats/session-rows-v2';

const ORIGINAL_TZ: string | undefined = process.env.TZ;

function daily(date: string, focusMs: number = 0): DailyAgg {
  return {
    date,
    focusMs,
    sessionsStarted: 0,
    sessionsCompleted: 0,
    attempts: {},
    attemptsOther: 0,
    pausesTaken: 0,
    pauseMsSpent: 0,
    pauseMsEarned: 0,
    unlocksTaken: 0,
    unlockMsSpent: 0,
    resisted: 0,
  };
}

function calendarDates(from: string, count: number): string[] {
  const cursor: Date = new Date(`${from}T00:00:00Z`);
  const dates: string[] = [];
  for (let index: number = 0; index < count; index++) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function previousCalendarDate(date: string): string {
  const cursor: Date = new Date(`${date}T00:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() - 1);
  return cursor.toISOString().slice(0, 10);
}

function syncDailies(dates: string[]): Record<string, unknown> {
  return Object.fromEntries(
    dates.map((date: string): [string, DailyAgg] => [`agg:devA:${date}`, daily(date, 1)]),
  );
}

interface FakeArea {
  area: chrome.storage.SyncStorageArea;
  state: Record<string, unknown>;
}

function fakeArea(initial: Record<string, unknown>): FakeArea {
  const state: Record<string, unknown> = structuredClone(initial);
  const area: chrome.storage.SyncStorageArea = {
    get: vi.fn(
      async (
        keys?: string | string[] | Record<string, unknown> | null,
      ): Promise<Record<string, unknown>> => {
        if (keys === null || keys === undefined) return structuredClone(state);
        const requested: string[] =
          typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        return Object.fromEntries(
          requested
            .filter((key: string): boolean => Object.hasOwn(state, key))
            .map((key: string): [string, unknown] => [key, structuredClone(state[key])]),
        );
      },
    ),
    set: vi.fn(async (items: Record<string, unknown>): Promise<void> => {
      Object.assign(state, structuredClone(items));
    }),
    remove: vi.fn(async (keys: string | string[]): Promise<void> => {
      for (const key of typeof keys === 'string' ? [keys] : keys) delete state[key];
    }),
  } as unknown as chrome.storage.SyncStorageArea;
  return { area, state };
}

interface RangeCase {
  label: string;
  localNow: [number, number, number, number, number];
  days: number;
  from: string;
}

interface MixedSessionCase {
  legacyFirst: boolean;
  retainedSessionId: string | undefined;
  pauseMs: number;
  unlockMs: number;
}

function identityAssigned(at: number, startedAt: number, sessionId: string): EventRecord {
  return {
    t: 'sessionIdentityAssigned',
    at,
    startedAt,
    sessionId,
  };
}

const RANGE_CASES: RangeCase[] = [
  {
    label: 'spring seven-day range',
    localNow: [2026, 2, 30, 0, 30],
    days: 7,
    from: '2026-03-24',
  },
  {
    label: 'spring thirty-day range',
    localNow: [2026, 3, 1, 0, 30],
    days: 30,
    from: '2026-03-03',
  },
  {
    label: 'autumn seven-day range',
    localNow: [2026, 9, 25, 23, 30],
    days: 7,
    from: '2026-10-19',
  },
  {
    label: 'autumn thirty-day range',
    localNow: [2026, 9, 25, 23, 30],
    days: 30,
    from: '2026-09-26',
  },
];

describe('stats-service storage modes', (): void => {
  afterEach((): void => {
    vi.unstubAllGlobals();
  });

  it('reads only local aggregates when Sync is disabled', async (): Promise<void> => {
    const now: number = new Date(2026, 7, 31, 12, 0).getTime();
    const date: string = '2026-08-31';
    const local: FakeArea = fakeArea({
      [LOCAL_DEVICE_ID]: 'devA',
      [LOCAL_EVENTS]: [],
      [`agg:devA:${date}`]: daily(date, 10),
    });
    const sync: FakeArea = fakeArea({ [`agg:devB:${date}`]: daily(date, 1_000) });
    vi.stubGlobal('chrome', { storage: { local: local.area, sync: sync.area } });
    const storage: AggregateStorage = { local: local.area, sync: null };

    const bundle: StatsBundle = await fetchStats(7, now, null, storage);

    expect(bundle.totals.focusMsToday).toBe(10);
    expect(sync.area.get).not.toHaveBeenCalled();
  });

  it('merges remote devices while overlaying this device local value once', async (): Promise<void> => {
    const now: number = new Date(2026, 7, 31, 12, 0).getTime();
    const date: string = '2026-08-31';
    const local: FakeArea = fakeArea({
      [LOCAL_DEVICE_ID]: 'devA',
      [LOCAL_EVENTS]: [],
      [`agg:devA:${date}`]: daily(date, 20),
    });
    const sync: FakeArea = fakeArea({
      [`agg:devA:${date}`]: daily(date, 10),
      [`agg:devB:${date}`]: daily(date, 30),
    });
    vi.stubGlobal('chrome', { storage: { local: local.area, sync: sync.area } });
    const storage: AggregateStorage = { local: local.area, sync: sync.area };

    const bundle: StatsBundle = await fetchStats(7, now, null, storage);

    expect(bundle.totals.focusMsToday).toBe(50);
    expect(bundle.days).toEqual([expect.objectContaining({ date, focusMs: 50 })]);
  });

  it('applies a pending remote tombstone before merging a local monthly rollup', async (): Promise<void> => {
    const now: number = new Date(2026, 7, 31, 12, 0).getTime();
    const oldDate: string = '2026-08-01';
    const oldKey: string = `agg:devA:${oldDate}`;
    const monthKey: string = 'aggm:devA:2026-08';
    const aggregate: DailyAgg = daily(oldDate, 10);
    const local: FakeArea = fakeArea({
      [LOCAL_DEVICE_ID]: 'devA',
      [LOCAL_EVENTS]: [],
      [monthKey]: rollupMonth('2026-08', [aggregate]),
      [LOCAL_AGGREGATE_TOMBSTONES]: [oldKey],
    });
    const sync: FakeArea = fakeArea({ [oldKey]: aggregate });
    vi.stubGlobal('chrome', { storage: { local: local.area, sync: sync.area } });

    const bundle: StatsBundle = await fetchStats(31, now, null, {
      local: local.area,
      sync: sync.area,
    });

    expect(bundle.days).toEqual([]);
    expect(bundle.months).toEqual([expect.objectContaining({ month: '2026-08', focusMs: 10 })]);
  });

  it('projects an interrupted local prune without counting its daily twice', async (): Promise<void> => {
    const now: number = new Date(2026, 7, 31, 12, 0).getTime();
    const oldDate: string = '2026-08-01';
    const oldKey: string = `agg:devA:${oldDate}`;
    const monthKey: string = 'aggm:devA:2026-08';
    const aggregate: DailyAgg = daily(oldDate, 10);
    const monthly = rollupMonth('2026-08', [aggregate]);
    const local: FakeArea = fakeArea({
      [LOCAL_DEVICE_ID]: 'devA',
      [LOCAL_EVENTS]: [],
      [oldKey]: aggregate,
      [monthKey]: monthly,
      [LOCAL_AGGREGATE_PRUNE]: { set: { [monthKey]: monthly }, remove: [oldKey] },
    });
    vi.stubGlobal('chrome', { storage: { local: local.area, sync: fakeArea({}).area } });

    const bundle: StatsBundle = await fetchStats(31, now, null, {
      local: local.area,
      sync: null,
    });

    expect(bundle.days).toEqual([]);
    expect(bundle.months).toEqual([expect.objectContaining({ month: '2026-08', focusMs: 10 })]);
  });
});

function started(at: number, sessionId?: string): EventRecord {
  return {
    t: 'sessionStarted',
    at,
    source: 'manual',
    mode: 'blacklist',
    strictness: 'friction',
    durationMin: 25,
    intention: `session ${at}`,
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

describe.sequential('stats-service local calendar ranges', (): void => {
  beforeAll((): void => {
    process.env.TZ = 'Europe/Amsterdam';
  });

  afterAll((): void => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });

  it.each(RANGE_CASES)('keeps the exact $label', ({ localNow, days, from }: RangeCase): void => {
    const expected: string[] = calendarDates(from, days);
    const outside: string = previousCalendarDate(from);
    const now: number = new Date(...localNow).getTime();
    const bundle: StatsBundle = buildStats(
      'devA',
      syncDailies([outside, ...expected]),
      [],
      days,
      now,
    );

    expect(bundle.days.map((aggregate: DailyAgg): string => aggregate.date)).toEqual(expected);
    expect(bundle.totals.focusMsLast7Days).toBe(7);
  });

  it('totals focus from exactly the last seven local dates when only one day is requested', (): void => {
    const now: number = new Date(2026, 7, 28, 14, 0, 0).getTime();
    const dates: string[] = calendarDates('2026-08-21', 8);
    const syncItems: Record<string, unknown> = Object.fromEntries(
      dates.map((date: string): [string, DailyAgg] => [
        `agg:devA:${date}`,
        daily(date, 20 * 60_000),
      ]),
    );

    const bundle: StatsBundle = buildStats('devA', syncItems, [], 1, now);

    expect(bundle.days.map((aggregate: DailyAgg): string => aggregate.date)).toEqual([
      '2026-08-28',
    ]);
    expect(bundle.totals.focusMsLast7Days).toBe(140 * 60_000);
  });

  it('promotes a legacy start through an explicit persisted identity marker', (): void => {
    const migratedEvents: EventRecord[] = [
      started(1),
      identityAssigned(2, 1, 'migrated'),
      { t: 'pauseTaken', at: 3, ms: 11, sessionId: 'migrated' },
      { t: 'unlockTaken', at: 4, host: 'example.com', ms: 13, sessionId: 'migrated' },
      { t: 'sessionCompleted', at: 5, focusedMs: 17, sessionId: 'migrated' },
    ];
    const events: EventRecord[] = [...migratedEvents];
    for (let index: number = 0; index < 49; index++) {
      const sessionId: string = `filler-${index}`;
      events.push(started(10 + index * 2, sessionId));
      events.push({
        t: 'sessionCompleted',
        at: 11 + index * 2,
        focusedMs: 1,
        sessionId,
      });
    }

    const recent: EventRecord[] = buildStats('devA', {}, events, 7, Date.now()).recentSessions;
    const retainedMigration: EventRecord[] = recent.filter(
      (event: EventRecord): boolean => event.at <= 5,
    );

    expect(retainedMigration).toEqual([...migratedEvents].reverse());
    expect(
      recent.filter((event: EventRecord): boolean => event.t === 'sessionStarted'),
    ).toHaveLength(50);
    expect(pairSessionRowsV2(retainedMigration)).toEqual([
      expect.objectContaining({
        outcome: 'Completed',
        focusedMs: 17,
        pauseMs: 11,
        unlockMs: 13,
      }),
    ]);
  });

  it('ignores duplicate id-less terminals after the legacy row closes', (): void => {
    const events: EventRecord[] = [
      started(1, 'identified'),
      started(2),
      { t: 'sessionCanceled', at: 3, focusedMs: 3 },
      { t: 'sessionCompleted', at: 4, focusedMs: 999 },
      { t: 'sessionCompleted', at: 5, focusedMs: 5, sessionId: 'identified' },
    ];

    const recent: EventRecord[] = buildStats('devA', {}, events, 7, Date.now()).recentSessions;
    const rows: SessionRowV2[] = pairSessionRowsV2(recent);

    expect(recent).not.toContainEqual(events[3]);
    expect(rows).toEqual([
      expect.objectContaining({ outcome: 'Ended early', focusedMs: 3 }),
      expect.objectContaining({ outcome: 'Completed', focusedMs: 5 }),
    ]);
  });

  it.each([
    {
      label: 'spring transition',
      localNow: [2026, 2, 30, 0, 30] as RangeCase['localNow'],
      cutoff: '2026-03-24',
    },
    {
      label: 'autumn transition',
      localNow: [2026, 9, 25, 23, 30] as RangeCase['localNow'],
      cutoff: '2026-10-19',
    },
  ])('prunes before the exact local-date cutoff at the $label', ({ localNow, cutoff }): void => {
    const outside: string = previousCalendarDate(cutoff);
    const now: number = new Date(...localNow).getTime();
    const plan: ReturnType<typeof pruneAndRollup> = pruneAndRollup(
      'devA',
      syncDailies([outside, cutoff]),
      7,
      now,
    );

    expect(plan.remove).toEqual([`agg:devA:${outside}`]);
  });

  it.each([0, 1.5, 100_000_001, Number.MAX_SAFE_INTEGER])(
    'rejects an unsafe retention boundary %s before planning removals',
    (retentionDays: number): void => {
      const now: number = new Date(2026, 2, 30, 0, 30).getTime();
      const today: string = '2026-03-30';

      expect(
        (): ReturnType<typeof pruneAndRollup> =>
          pruneAndRollup('devA', syncDailies([today]), retentionDays, now),
      ).toThrow('retentionDays');
    },
  );
});

describe('stats-service recent session cap', (): void => {
  it('keeps every event needed for a retained long session', (): void => {
    const events: EventRecord[] = [started(1, 'long-session')];
    for (let index: number = 0; index < 30; index++) {
      events.push({ t: 'pauseTaken', at: 2 + index, ms: 1_000, sessionId: 'long-session' });
      events.push({
        t: 'unlockTaken',
        at: 32 + index,
        host: 'example.com',
        ms: 2_000,
        sessionId: 'long-session',
      });
    }
    events.push({
      t: 'sessionCompleted',
      at: 100,
      focusedMs: 60_000,
      sessionId: 'long-session',
    });

    const recent: EventRecord[] = buildStats('devA', {}, events, 7, Date.now()).recentSessions;

    expect(recent).toHaveLength(62);
    expect(recent.at(-1)).toMatchObject({ t: 'sessionStarted', sessionId: 'long-session' });
    expect(
      recent
        .filter(
          (event: EventRecord): event is Extract<EventRecord, { t: 'pauseTaken' }> =>
            event.t === 'pauseTaken',
        )
        .reduce((total: number, event): number => total + event.ms, 0),
    ).toBe(30_000);
    expect(
      recent
        .filter(
          (event: EventRecord): event is Extract<EventRecord, { t: 'unlockTaken' }> =>
            event.t === 'unlockTaken',
        )
        .reduce((total: number, event): number => total + event.ms, 0),
    ).toBe(60_000);
  });

  it('caps complete identified sessions after grouping their events', (): void => {
    const events: EventRecord[] = [];
    for (let index: number = 0; index < 51; index++) {
      const sessionId: string = `session-${index}`;
      const at: number = index * 10;
      events.push(started(at, sessionId));
      events.push({ t: 'pauseTaken', at: at + 1, ms: index + 1, sessionId });
      events.push({ t: 'unlockTaken', at: at + 2, host: 'example.com', ms: index + 2, sessionId });
      events.push({ t: 'sessionCompleted', at: at + 3, focusedMs: index + 3, sessionId });
    }

    const recent: EventRecord[] = buildStats('devA', {}, events, 7, Date.now()).recentSessions;
    const retainedIds: Set<string> = new Set(
      recent.flatMap((event: EventRecord): string[] =>
        'sessionId' in event && event.sessionId !== undefined ? [event.sessionId] : [],
      ),
    );

    expect(recent).toHaveLength(200);
    expect(retainedIds.size).toBe(50);
    expect(retainedIds.has('session-0')).toBe(false);
    expect(retainedIds.has('session-1')).toBe(true);
    expect(retainedIds.has('session-50')).toBe(true);
  });

  it('preserves complete legacy session groups while applying the row cap', (): void => {
    const events: EventRecord[] = [];
    for (let index: number = 0; index < 51; index++) {
      const at: number = index * 10;
      events.push(started(at));
      events.push({ t: 'pauseTaken', at: at + 1, ms: index + 1 });
      events.push({ t: 'sessionCompleted', at: at + 2, focusedMs: index + 2 });
    }

    const recent: EventRecord[] = buildStats('devA', {}, events, 7, Date.now()).recentSessions;

    expect(recent).toHaveLength(150);
    expect(recent.at(-1)).toMatchObject({ t: 'sessionStarted', at: 10 });
    expect(recent[0]).toMatchObject({ t: 'sessionCompleted', at: 502 });
  });

  it('keeps a legacy open session when an identified session starts', (): void => {
    const events: EventRecord[] = [
      started(1),
      started(2, 'identified'),
      { t: 'sessionCompleted', at: 3, focusedMs: 30_000, sessionId: 'identified' },
      { t: 'sessionCompleted', at: 4, focusedMs: 40_000 },
    ];

    const recent: EventRecord[] = buildStats('devA', {}, events, 7, Date.now()).recentSessions;

    expect(recent).toEqual([...events].reverse());
  });

  it.each([
    { legacyFirst: true, retainedSessionId: 'identified', pauseMs: 101, unlockMs: 103 },
    { legacyFirst: false, retainedSessionId: undefined, pauseMs: 11, unlockMs: 13 },
  ])(
    'keeps mixed legacy and identified totals with legacyFirst=$legacyFirst',
    ({ legacyFirst, retainedSessionId, pauseMs, unlockMs }: MixedSessionCase): void => {
      const legacyStart: EventRecord = started(1);
      const identifiedStart: EventRecord = started(2, 'identified');
      const events: EventRecord[] = [
        ...(legacyFirst ? [legacyStart, identifiedStart] : [identifiedStart, legacyStart]),
        { t: 'pauseTaken', at: 3, ms: 11 },
        { t: 'pauseTaken', at: 4, ms: 101, sessionId: 'identified' },
        { t: 'unlockTaken', at: 5, host: 'legacy.example', ms: 13 },
        {
          t: 'unlockTaken',
          at: 6,
          host: 'identified.example',
          ms: 103,
          sessionId: 'identified',
        },
        { t: 'sessionCompleted', at: 7, focusedMs: 999, sessionId: 'unmatched' },
        { t: 'sessionCanceled', at: 8, focusedMs: 17 },
        { t: 'sessionCompleted', at: 9, focusedMs: 107, sessionId: 'identified' },
        { t: 'sessionCanceled', at: 10, focusedMs: 999 },
      ];
      for (let index: number = 0; index < 49; index++) {
        const sessionId: string = `filler-${index}`;
        events.push(started(20 + index * 2, sessionId));
        events.push({
          t: 'sessionCompleted',
          at: 21 + index * 2,
          focusedMs: 1,
          sessionId,
        });
      }

      const recent: EventRecord[] = buildStats('devA', {}, events, 7, Date.now()).recentSessions;
      const mixed: EventRecord[] = recent.filter((event: EventRecord): boolean => event.at < 20);
      const retainedIdentity: Array<string | undefined> = mixed.map(
        (event: EventRecord): string | undefined => event.sessionId,
      );
      const retainedPauseMs: number = mixed.reduce(
        (total: number, event: EventRecord): number =>
          event.t === 'pauseTaken' ? total + event.ms : total,
        0,
      );
      const retainedUnlockMs: number = mixed.reduce(
        (total: number, event: EventRecord): number =>
          event.t === 'unlockTaken' ? total + event.ms : total,
        0,
      );
      const retainedFocusedMs: number = mixed.reduce(
        (total: number, event: EventRecord): number =>
          event.t === 'sessionCompleted' || event.t === 'sessionCanceled'
            ? total + event.focusedMs
            : total,
        0,
      );
      const pairedRows: SessionRowV2[] = pairSessionRowsV2(mixed);

      expect(new Set(retainedIdentity)).toEqual(new Set([retainedSessionId]));
      expect(retainedPauseMs).toBe(pauseMs);
      expect(retainedUnlockMs).toBe(unlockMs);
      expect(retainedFocusedMs).toBe(legacyFirst ? 107 : 17);
      expect(pairedRows).toHaveLength(1);
      expect(pairedRows[0]).toMatchObject({
        outcome: legacyFirst ? 'Completed' : 'Ended early',
        focusedMs: legacyFirst ? 107 : 17,
        pauseMs,
        unlockMs,
      });
    },
  );

  it('groups 50,000 unmatched identified starts with linear identity access', (): void => {
    let identityReads: number = 0;
    const events: EventRecord[] = Array.from(
      { length: 50_000 },
      (_unused: unknown, index: number): EventRecord => {
        const event: EventRecord = started(index);
        Object.defineProperty(event, 'sessionId', {
          enumerable: true,
          get: (): string => {
            identityReads += 1;
            if (identityReads > 200_000) throw new Error('quadratic identity scan');
            return `open-${index}`;
          },
        });
        return event;
      },
    );

    expect((): EventRecord[] => {
      return buildStats('devA', {}, events, 7, Date.now()).recentSessions;
    }).not.toThrow();
    expect(identityReads).toBeLessThanOrEqual(200_000);
  });
});

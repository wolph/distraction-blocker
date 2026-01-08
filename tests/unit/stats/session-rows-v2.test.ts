import { describe, expect, it } from 'vitest';
import { statsOutcomeLabelV2, statsPlanLabelV2 } from '../../../src/shared/session-copy';
import type {
  LegacyEventRecord,
  SessionDuration,
  SessionEndedEventV2,
  SessionEndReasonV2,
  SessionEventRecordV2,
  SessionOutcomeV2,
  SessionStartedEventV2,
} from '../../../src/shared/types';
import { pairSessionRowsV2, type SessionRowV2 } from '../../../src/stats/session-rows-v2';

const MIN: number = 60_000;
const T9: number = new Date(2026, 8, 3, 9, 0, 0).getTime();
const T925: number = new Date(2026, 8, 3, 9, 25, 0).getTime();
const T11: number = new Date(2026, 8, 3, 11, 0, 0).getTime();
const T1110: number = new Date(2026, 8, 3, 11, 10, 0).getTime();
const T13: number = new Date(2026, 8, 3, 13, 0, 0).getTime();

const SESSION_A: string = '018c2212-3d9d-7b8c-9f11-7cc087988c09';
const SESSION_B: string = '018c2212-3d9d-7b8c-9f11-7cc087988c10';

const TIMED_50: SessionDuration = { kind: 'timed', minutes: 50 };
const UNTIL_STOPPED: SessionDuration = { kind: 'until-stopped' };

function v2Start(
  at: number,
  sessionId: string,
  duration: SessionDuration,
  intention: string = 'thesis chapter',
  source: 'manual' | 'schedule' = 'manual',
): SessionStartedEventV2 {
  return {
    version: 2,
    t: 'sessionStarted',
    eventId: `${sessionId}:start`,
    at,
    sessionId,
    source,
    mode: 'blacklist',
    strictness: 'flexible',
    duration,
    intention,
    scheduleOccurrence: null,
  };
}

function v2End(
  at: number,
  sessionId: string,
  outcome: SessionOutcomeV2,
  reason: SessionEndReasonV2,
  focusedMs: number,
  duration: SessionDuration = UNTIL_STOPPED,
): SessionEndedEventV2 {
  return {
    version: 2,
    t: 'sessionEnded',
    eventId: `${sessionId}:end`,
    at,
    sessionId,
    outcome,
    reason,
    focusedMs,
    duration,
    source: 'manual',
    scheduleOccurrence: null,
  };
}

function legacyStart(
  at: number,
  durationMin: number,
  intention: string,
  source: 'manual' | 'schedule' = 'manual',
  sessionId?: string,
): LegacyEventRecord {
  return {
    t: 'sessionStarted',
    at,
    source,
    mode: 'blacklist',
    strictness: 'friction',
    durationMin,
    intention,
    sessionId,
  };
}

/** Input order matches StatsBundle.recentSessions, which is newest first. */
function newestFirst(events: readonly SessionEventRecordV2[]): SessionEventRecordV2[] {
  return [...events].reverse();
}

describe('pairSessionRowsV2', (): void => {
  it('pairs a v2 start with its v2 end by sessionId', (): void => {
    const rows: SessionRowV2[] = pairSessionRowsV2(
      newestFirst([
        v2Start(T9, SESSION_A, UNTIL_STOPPED, 'thesis chapter'),
        v2End(T925, SESSION_A, 'completed', 'manual-completed', 25 * MIN),
      ]),
    );

    expect(rows).toEqual([
      {
        startedAt: T9,
        plan: statsPlanLabelV2(UNTIL_STOPPED),
        intention: 'thesis chapter',
        source: 'manual',
        outcome: statsOutcomeLabelV2('manual-completed'),
        outcomeKind: 'completed',
        focusedMs: 25 * MIN,
        pauseMs: 0,
        unlockMs: 0,
      },
    ]);
    expect(rows[0]?.plan).toBe('Until stopped');
    expect(rows[0]?.outcome).toBe('Completed manually');
  });

  it('reports a canceled v2 end as ended with the reason wording', (): void => {
    const rows: SessionRowV2[] = pairSessionRowsV2(
      newestFirst([
        v2Start(T9, SESSION_A, TIMED_50, 'email sweep', 'schedule'),
        v2End(T925, SESSION_A, 'canceled', 'website-access-lost', 12 * MIN, TIMED_50),
      ]),
    );

    expect(rows[0]).toEqual({
      startedAt: T9,
      plan: statsPlanLabelV2(TIMED_50),
      intention: 'email sweep',
      source: 'schedule',
      outcome: statsOutcomeLabelV2('website-access-lost'),
      outcomeKind: 'ended',
      focusedMs: 12 * MIN,
      pauseMs: 0,
      unlockMs: 0,
    });
    expect(rows[0]?.plan).toBe('50 m');
    expect(rows[0]?.outcome).toBe('Ended: website access lost');
  });

  it('maps every v2 end reason to its outcome kind and wording', (): void => {
    const reasons: readonly [SessionEndReasonV2, SessionOutcomeV2, 'completed' | 'ended'][] = [
      ['timer-completed', 'completed', 'completed'],
      ['manual-completed', 'completed', 'completed'],
      ['manual-canceled', 'canceled', 'ended'],
      ['website-access-lost', 'canceled', 'ended'],
      ['content-registration-failed', 'canceled', 'ended'],
      ['alarm-failed', 'canceled', 'ended'],
      ['tab-enforcement-failed', 'canceled', 'ended'],
      ['invalid-active-state', 'canceled', 'ended'],
    ];

    for (const [reason, outcome, kind] of reasons) {
      const rows: SessionRowV2[] = pairSessionRowsV2(
        newestFirst([
          v2Start(T9, SESSION_A, TIMED_50),
          v2End(T925, SESSION_A, outcome, reason, MIN, TIMED_50),
        ]),
      );
      expect(rows[0]?.outcome).toBe(statsOutcomeLabelV2(reason));
      expect(rows[0]?.outcomeKind).toBe(kind);
    }
  });

  it('pairs a legacy start bound by sessionIdentityAssigned with a later v2 end', (): void => {
    const rows: SessionRowV2[] = pairSessionRowsV2(
      newestFirst([
        legacyStart(T9, 50, 'migrated session'),
        { t: 'sessionIdentityAssigned', at: T11, startedAt: T9, sessionId: SESSION_A },
        v2End(T1110, SESSION_A, 'canceled', 'invalid-active-state', 30 * MIN, TIMED_50),
      ]),
    );

    expect(rows).toEqual([
      {
        startedAt: T9,
        plan: statsPlanLabelV2(TIMED_50),
        intention: 'migrated session',
        source: 'manual',
        outcome: statsOutcomeLabelV2('invalid-active-state'),
        outcomeKind: 'ended',
        focusedMs: 30 * MIN,
        pauseMs: 0,
        unlockMs: 0,
      },
    ]);
  });

  it('reports a legacy start closed by a legacy end in the shared column casing', (): void => {
    const completed: SessionRowV2[] = pairSessionRowsV2(
      newestFirst([
        legacyStart(T9, 25, 'thesis chapter'),
        { t: 'sessionCompleted', at: T925, focusedMs: 25 * MIN },
      ]),
    );
    expect(completed[0]).toEqual({
      startedAt: T9,
      plan: '25 m',
      intention: 'thesis chapter',
      source: 'manual',
      outcome: 'Completed',
      outcomeKind: 'completed',
      focusedMs: 25 * MIN,
      pauseMs: 0,
      unlockMs: 0,
    });

    const canceled: SessionRowV2[] = pairSessionRowsV2(
      newestFirst([
        legacyStart(T9, 25, 'thesis chapter'),
        { t: 'sessionCanceled', at: T925, focusedMs: 8 * MIN },
      ]),
    );
    expect(canceled[0]?.outcome).toBe('Ended early');
    expect(canceled[0]?.outcomeKind).toBe('ended');
    expect(canceled[0]?.focusedMs).toBe(8 * MIN);
  });

  it('reads a legacy input the way the v1 session log read it', (): void => {
    const legacy: LegacyEventRecord[] = [
      legacyStart(T9, 25, 'thesis chapter'),
      { t: 'pauseTaken', at: T9 + 5 * MIN, ms: 5 * MIN },
      { t: 'unlockTaken', at: T9 + 6 * MIN, ms: 5 * MIN, host: 'news.example' },
      { t: 'sessionCompleted', at: T925, focusedMs: 20 * MIN },
    ];
    const v2Row: SessionRowV2 | undefined = pairSessionRowsV2(newestFirst(legacy))[0];

    // The values the deleted v1 `pairSessions` produced for this exact history, stated directly
    // now that the v1 pairing is gone and this builder is the only reader of legacy history. Only
    // the outcome casing moved: one Outcome column cannot spell the same result two ways.
    expect(v2Row).toMatchObject({
      startedAt: T9,
      intention: 'thesis chapter',
      source: 'manual',
      outcome: 'Completed',
      focusedMs: 20 * MIN,
      pauseMs: 5 * MIN,
      unlockMs: 5 * MIN,
    });
    expect(v2Row?.plan).toBe(statsPlanLabelV2({ kind: 'timed', minutes: 25 }));
  });

  it('runs a dangling newest start and ends a displaced one with unknown focus', (): void => {
    const rows: SessionRowV2[] = pairSessionRowsV2(
      newestFirst([
        v2Start(T9, SESSION_A, TIMED_50, 'displaced'),
        v2Start(T13, SESSION_B, UNTIL_STOPPED, 'still going'),
      ]),
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      startedAt: T13,
      intention: 'still going',
      outcome: 'Running',
      outcomeKind: 'running',
      focusedMs: null,
    });
    expect(rows[1]).toMatchObject({
      startedAt: T9,
      intention: 'displaced',
      outcome: 'Ended early',
      outcomeKind: 'ended',
      focusedMs: null,
    });
  });

  it('accumulates pause and unlock spends by sessionId', (): void => {
    const rows: SessionRowV2[] = pairSessionRowsV2(
      newestFirst([
        v2Start(T9, SESSION_A, TIMED_50, 'a'),
        v2Start(T11, SESSION_B, TIMED_50, 'b'),
        { t: 'pauseTaken', at: T11 + MIN, ms: 5 * MIN, sessionId: SESSION_B },
        { t: 'pauseTaken', at: T11 + 2 * MIN, ms: 3 * MIN, sessionId: SESSION_B },
        {
          t: 'unlockTaken',
          at: T11 + 3 * MIN,
          host: 'youtube.com',
          ms: 4 * MIN,
          sessionId: SESSION_B,
        },
        v2End(T1110, SESSION_B, 'completed', 'timer-completed', 40 * MIN, TIMED_50),
      ]),
    );

    const sessionB: SessionRowV2 | undefined = rows.find(
      (row: SessionRowV2): boolean => row.intention === 'b',
    );
    expect(sessionB?.pauseMs).toBe(8 * MIN);
    expect(sessionB?.unlockMs).toBe(4 * MIN);
    const sessionA: SessionRowV2 | undefined = rows.find(
      (row: SessionRowV2): boolean => row.intention === 'a',
    );
    expect(sessionA?.pauseMs).toBe(0);
    expect(sessionA?.unlockMs).toBe(0);
  });

  it('attaches an unidentified spend to the newest open row', (): void => {
    const rows: SessionRowV2[] = pairSessionRowsV2(
      newestFirst([
        v2Start(T9, SESSION_A, TIMED_50, 'a'),
        v2Start(T11, SESSION_B, TIMED_50, 'b'),
        // A spend written before the worker learned to stamp its session id.
        { t: 'pauseTaken', at: T11 + MIN, ms: 5 * MIN },
        { t: 'unlockTaken', at: T11 + 2 * MIN, host: 'youtube.com', ms: 4 * MIN },
        v2End(T1110, SESSION_B, 'completed', 'timer-completed', 40 * MIN, TIMED_50),
      ]),
    );

    const sessionB: SessionRowV2 | undefined = rows.find(
      (row: SessionRowV2): boolean => row.intention === 'b',
    );
    expect(sessionB?.pauseMs).toBe(5 * MIN);
    expect(sessionB?.unlockMs).toBe(4 * MIN);
    const sessionA: SessionRowV2 | undefined = rows.find(
      (row: SessionRowV2): boolean => row.intention === 'a',
    );
    expect(sessionA?.pauseMs).toBe(0);
    expect(sessionA?.unlockMs).toBe(0);
  });

  it('gives an open legacy row the unidentified spend ahead of a newer v2 row', (): void => {
    const rows: SessionRowV2[] = pairSessionRowsV2(
      newestFirst([
        legacyStart(T9, 25, 'legacy'),
        v2Start(T11, SESSION_B, TIMED_50, 'v2'),
        { t: 'pauseTaken', at: T11 + MIN, ms: 5 * MIN },
      ]),
    );

    const legacy: SessionRowV2 | undefined = rows.find(
      (row: SessionRowV2): boolean => row.intention === 'legacy',
    );
    const v2: SessionRowV2 | undefined = rows.find(
      (row: SessionRowV2): boolean => row.intention === 'v2',
    );
    expect(legacy?.pauseMs).toBe(5 * MIN);
    expect(v2?.pauseMs).toBe(0);
  });

  it('drops an unidentified terminal that owns no open row', (): void => {
    const rows: SessionRowV2[] = pairSessionRowsV2(
      newestFirst([
        v2Start(T11, SESSION_B, TIMED_50, 'v2'),
        { t: 'sessionCompleted', at: T1110, focusedMs: 40 * MIN },
      ]),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      intention: 'v2',
      outcome: 'Running',
      outcomeKind: 'running',
      focusedMs: null,
    });
  });

  it('returns rows newest first and caps the list at twenty', (): void => {
    const events: SessionEventRecordV2[] = [];
    for (let index: number = 0; index < 25; index += 1) {
      const sessionId: string = `018c2212-3d9d-7b8c-9f11-7cc0879${String(index).padStart(5, '0')}`;
      events.push(v2Start(T9 + index * MIN, sessionId, TIMED_50, `session ${index}`));
      events.push(
        v2End(T9 + index * MIN + 30_000, sessionId, 'completed', 'timer-completed', MIN, TIMED_50),
      );
    }

    const rows: SessionRowV2[] = pairSessionRowsV2(newestFirst(events));

    expect(rows).toHaveLength(20);
    expect(rows[0]?.intention).toBe('session 24');
    expect(rows[19]?.intention).toBe('session 5');
    for (let index: number = 1; index < rows.length; index += 1) {
      expect(rows[index - 1]?.startedAt).toBeGreaterThan(rows[index]?.startedAt ?? 0);
    }
  });

  it('drops a v2 end whose session never started without throwing', (): void => {
    const rows: SessionRowV2[] = pairSessionRowsV2([
      v2End(T925, SESSION_B, 'completed', 'timer-completed', 25 * MIN, TIMED_50),
    ]);

    expect(rows).toEqual([]);
  });

  it('leaves an unrelated session open when an orphaned v2 end arrives', (): void => {
    const rows: SessionRowV2[] = pairSessionRowsV2(
      newestFirst([
        v2Start(T9, SESSION_A, UNTIL_STOPPED, 'still going'),
        v2End(T925, SESSION_B, 'completed', 'timer-completed', 25 * MIN, TIMED_50),
      ]),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ intention: 'still going', outcomeKind: 'running' });
  });

  it('returns no rows for an empty history', (): void => {
    expect(pairSessionRowsV2([])).toEqual([]);
  });
});

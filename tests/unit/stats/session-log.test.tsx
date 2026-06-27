/** @vitest-environment jsdom */
import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventRecord } from '../../../src/shared/types';
import { pairSessions, SessionLog, type SessionRow } from '../../../src/stats/SessionLog';

afterEach(cleanup);

function started(
  at: number,
  durationMin: number | null,
  intention: string,
  source: 'manual' | 'schedule',
  sessionId?: string,
): EventRecord {
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

function identityAssigned(at: number, startedAt: number, sessionId: string): EventRecord {
  return {
    t: 'sessionIdentityAssigned',
    at,
    startedAt,
    sessionId,
  };
}

const T9: number = new Date(2026, 7, 28, 9, 0, 0).getTime();
const T925: number = new Date(2026, 7, 28, 9, 25, 0).getTime();
const T11: number = new Date(2026, 7, 28, 11, 0, 0).getTime();
const T1110: number = new Date(2026, 7, 28, 11, 10, 0).getTime();
const T13: number = new Date(2026, 7, 28, 13, 0, 0).getTime();

/** Newest first, matching StatsBundle.recentSessions. */
const EVENTS: EventRecord[] = [
  started(T13, 15, '', 'manual'),
  { t: 'sessionCanceled', at: T1110, focusedMs: 8 * 60_000 },
  started(T11, 50, 'email sweep', 'schedule'),
  { t: 'sessionCompleted', at: T925, focusedMs: 25 * 60_000 },
  started(T9, 25, 'thesis chapter', 'manual'),
];

describe('pairSessions', () => {
  it('preserves indefinite duration and displays its manual unlock label', (): void => {
    const events: EventRecord[] = [started(T13, null, 'Write the next page', 'manual')];
    expect(pairSessions(events)[0]?.plannedMin).toBeNull();
    const view: ReturnType<typeof render> = render(<SessionLog events={events} />);
    expect(view.getByText('Until manual unlock')).toBeTruthy();
    expect(view.container.textContent).not.toContain('NaN');
  });
  it('pairs starts with completions and cancels, dangling start runs', () => {
    const rows: SessionRow[] = pairSessions(EVENTS);
    expect(rows.length).toBe(3);
    // newest first
    expect(rows[0]).toEqual({
      startedAt: T13,
      plannedMin: 15,
      intention: '',
      source: 'manual',
      outcome: 'running',
      focusedMs: null,
      pauseMs: 0,
      unlockMs: 0,
    });
    expect(rows[1]).toEqual({
      startedAt: T11,
      plannedMin: 50,
      intention: 'email sweep',
      source: 'schedule',
      outcome: 'ended early',
      focusedMs: 8 * 60_000,
      pauseMs: 0,
      unlockMs: 0,
    });
    expect(rows[2]).toEqual({
      startedAt: T9,
      plannedMin: 25,
      intention: 'thesis chapter',
      source: 'manual',
      outcome: 'completed',
      focusedMs: 25 * 60_000,
      pauseMs: 0,
      unlockMs: 0,
    });
  });

  it('pairs by session id and totals pause and unlock durations', () => {
    const events: EventRecord[] = [
      { t: 'sessionCompleted', at: T1110, focusedMs: 8 * 60_000, sessionId: 'later' },
      { t: 'unlockTaken', at: T11 + 3_000, host: 'x.com', ms: 90_000, sessionId: 'later' },
      { t: 'pauseTaken', at: T11 + 2_000, ms: 120_000, sessionId: 'later' },
      { t: 'sessionCanceled', at: T11 + 1_000, focusedMs: 1, sessionId: 'earlier' },
      started(T11, 25, 'later', 'manual', 'later'),
      started(T9, 25, 'earlier', 'manual', 'earlier'),
    ];

    const rows: SessionRow[] = pairSessions(events);

    expect(rows[0]).toMatchObject({
      intention: 'later',
      outcome: 'completed',
      pauseMs: 120_000,
      unlockMs: 90_000,
    });
    expect(rows[1]).toMatchObject({ intention: 'earlier', outcome: 'ended early' });
  });

  it('keeps multiple identified sessions open for interleaved events', () => {
    const events: EventRecord[] = [
      { t: 'sessionCanceled', at: T11 + 4_000, focusedMs: 7_000, sessionId: 'second' },
      { t: 'sessionCompleted', at: T11 + 3_000, focusedMs: 20_000, sessionId: 'first' },
      { t: 'unlockTaken', at: T11 + 2_000, host: 'x.com', ms: 90_000, sessionId: 'second' },
      { t: 'pauseTaken', at: T11 + 1_000, ms: 120_000, sessionId: 'first' },
      started(T11, 25, 'second', 'manual', 'second'),
      started(T9, 25, 'first', 'manual', 'first'),
    ];

    expect(pairSessions(events)).toEqual([
      {
        startedAt: T11,
        plannedMin: 25,
        intention: 'second',
        source: 'manual',
        outcome: 'ended early',
        focusedMs: 7_000,
        pauseMs: 0,
        unlockMs: 90_000,
      },
      {
        startedAt: T9,
        plannedMin: 25,
        intention: 'first',
        source: 'manual',
        outcome: 'completed',
        focusedMs: 20_000,
        pauseMs: 120_000,
        unlockMs: 0,
      },
    ]);
  });

  it('ends an older identified session after a later identified session closes', () => {
    const events: EventRecord[] = [
      { t: 'sessionCompleted', at: T1110, focusedMs: 10 * 60_000, sessionId: 'later' },
      started(T11, 25, 'later', 'manual', 'later'),
      started(T9, 25, 'older', 'manual', 'older'),
    ];

    expect(pairSessions(events)).toEqual([
      {
        startedAt: T11,
        plannedMin: 25,
        intention: 'later',
        source: 'manual',
        outcome: 'completed',
        focusedMs: 10 * 60_000,
        pauseMs: 0,
        unlockMs: 0,
      },
      {
        startedAt: T9,
        plannedMin: 25,
        intention: 'older',
        source: 'manual',
        outcome: 'ended early',
        focusedMs: null,
        pauseMs: 0,
        unlockMs: 0,
      },
    ]);
  });

  it('closes a start that is followed by another start without an end event', () => {
    const rows: SessionRow[] = pairSessions([
      started(T11, 25, 'later', 'manual'),
      started(T9, 25, 'earlier', 'manual'),
    ]);
    expect(rows.length).toBe(2);
    expect(rows[0]?.outcome).toBe('running');
    expect(rows[1]?.outcome).toBe('ended early');
    expect(rows[1]?.focusedMs).toBeNull();
  });

  it('caps at twenty rows, newest first', () => {
    const events: EventRecord[] = [];
    for (let i = 0; i < 25; i += 1) {
      const at: number = T9 + i * 3_600_000;
      events.unshift(started(at, 25, `s${i}`, 'manual'));
      events.unshift({ t: 'sessionCompleted', at: at + 25 * 60_000, focusedMs: 25 * 60_000 });
    }
    const rows: SessionRow[] = pairSessions(events);
    expect(rows.length).toBe(20);
    expect(rows[0]?.intention).toBe('s24');
  });
  it.each([true, false])(
    'keeps mixed legacy and identified totals with legacyFirst=%s',
    (legacyFirst: boolean): void => {
      const chronological: EventRecord[] = [
        ...(legacyFirst
          ? [started(T9, 25, 'legacy', 'manual'), started(T11, 25, 'identified', 'manual', 'id')]
          : [started(T9, 25, 'identified', 'manual', 'id'), started(T11, 25, 'legacy', 'manual')]),
        { t: 'pauseTaken', at: T11 + 1_000, ms: 11 },
        { t: 'pauseTaken', at: T11 + 2_000, ms: 101, sessionId: 'id' },
        { t: 'unlockTaken', at: T11 + 3_000, host: 'legacy.example', ms: 13 },
        { t: 'unlockTaken', at: T11 + 4_000, host: 'id.example', ms: 103, sessionId: 'id' },
        {
          t: 'sessionCompleted',
          at: T11 + 5_000,
          focusedMs: 999_000,
          sessionId: 'unmatched',
        },
        { t: 'sessionCanceled', at: T11 + 6_000, focusedMs: 17 },
        { t: 'sessionCompleted', at: T11 + 7_000, focusedMs: 107, sessionId: 'id' },
      ];

      const rows: SessionRow[] = pairSessions(chronological.reverse());
      const legacy: SessionRow | undefined = rows.find(
        (row: SessionRow): boolean => row.intention === 'legacy',
      );
      const identified: SessionRow | undefined = rows.find(
        (row: SessionRow): boolean => row.intention === 'identified',
      );

      expect(legacy).toMatchObject({
        outcome: 'ended early',
        focusedMs: 17,
        pauseMs: 11,
        unlockMs: 13,
      });
      expect(identified).toMatchObject({
        outcome: 'completed',
        focusedMs: 107,
        pauseMs: 101,
        unlockMs: 103,
      });
    },
  );

  it('does not let an unmatched identified terminal close a legacy session', (): void => {
    const events: EventRecord[] = [
      { t: 'sessionCanceled', at: T11 + 2_000, focusedMs: 40_000 },
      {
        t: 'sessionCompleted',
        at: T11 + 1_000,
        focusedMs: 999_000,
        sessionId: 'unmatched',
      },
      started(T11, 25, 'legacy', 'manual'),
    ];

    expect(pairSessions(events)).toEqual([
      {
        startedAt: T11,
        plannedMin: 25,
        intention: 'legacy',
        source: 'manual',
        outcome: 'ended early',
        focusedMs: 40_000,
        pauseMs: 0,
        unlockMs: 0,
      },
    ]);
  });

  it('pairs an upgraded legacy start after its explicit identity marker', (): void => {
    const events: EventRecord[] = [
      { t: 'sessionCompleted', at: T11 + 3_000, focusedMs: 17, sessionId: 'migrated' },
      { t: 'pauseTaken', at: T11 + 2_000, ms: 11, sessionId: 'migrated' },
      identityAssigned(T11 + 1_000, T11, 'migrated'),
      started(T11, 25, 'legacy', 'manual'),
    ];

    expect(pairSessions(events)).toEqual([
      {
        startedAt: T11,
        plannedMin: 25,
        intention: 'legacy',
        source: 'manual',
        outcome: 'completed',
        focusedMs: 17,
        pauseMs: 11,
        unlockMs: 0,
      },
    ]);
  });

  it('does not let a duplicate legacy terminal close an identified row', (): void => {
    const events: EventRecord[] = [
      { t: 'sessionCompleted', at: T11 + 4_000, focusedMs: 5, sessionId: 'identified' },
      { t: 'sessionCompleted', at: T11 + 3_000, focusedMs: 999 },
      { t: 'sessionCanceled', at: T11 + 2_000, focusedMs: 3 },
      started(T11 + 1_000, 25, 'legacy', 'manual'),
      started(T11, 25, 'identified', 'manual', 'identified'),
    ];

    expect(pairSessions(events)).toEqual([
      expect.objectContaining({ intention: 'legacy', focusedMs: 3 }),
      expect.objectContaining({ intention: 'identified', focusedMs: 5 }),
    ]);
  });
});

describe('SessionLog', () => {
  it('renders a row per session with outcome chips', () => {
    const { container } = render(<SessionLog events={EVENTS} />);
    expect(container.querySelectorAll('tbody tr').length).toBe(3);
    expect(container.querySelectorAll('.chip.completed').length).toBe(1);
    expect(container.querySelectorAll('.chip.neutral').length).toBe(1);
    expect(container.querySelectorAll('.chip.running').length).toBe(1);
    expect(container.textContent).toContain('thesis chapter');
    expect(container.textContent).toContain('ended early');
    expect(container.textContent).toContain('All sites');
    expect(container.textContent).toContain('One site');
  });

  it('renders the quiet first-run line with no sessions', () => {
    const { container } = render(<SessionLog events={[]} />);
    expect(container.textContent).toContain('Your first session will appear here.');
  });
});

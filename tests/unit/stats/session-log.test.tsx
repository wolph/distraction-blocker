/** @vitest-environment jsdom */
import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventRecord } from '../../../src/shared/types';
import { pairSessions, SessionLog, type SessionRow } from '../../../src/stats/SessionLog';

afterEach(cleanup);

function started(
  at: number,
  durationMin: number,
  intention: string,
  source: 'manual' | 'schedule',
): EventRecord {
  return {
    t: 'sessionStarted',
    at,
    source,
    mode: 'blacklist',
    strictness: 'friction',
    durationMin,
    intention,
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
    });
    expect(rows[1]).toEqual({
      startedAt: T11,
      plannedMin: 50,
      intention: 'email sweep',
      source: 'schedule',
      outcome: 'ended early',
      focusedMs: 8 * 60_000,
    });
    expect(rows[2]).toEqual({
      startedAt: T9,
      plannedMin: 25,
      intention: 'thesis chapter',
      source: 'manual',
      outcome: 'completed',
      focusedMs: 25 * 60_000,
    });
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
  });

  it('renders the quiet first-run line with no sessions', () => {
    const { container } = render(<SessionLog events={[]} />);
    expect(container.textContent).toContain('Your first session will appear here.');
  });
});

import type { VNode } from 'preact';
import {
  projectedSessionFocusedMsV2,
  remainingPhaseMsV2,
  remainingSessionMsV2,
} from '../shared/live';
import {
  BREAK_CLOCK_LABEL,
  FOCUS_PHASE_CLOCK_LABEL,
  FOCUS_TIME_LABEL,
  PAUSE_CLOCK_LABEL,
  TOTAL_SESSION_CLOCK_LABEL,
  UNTIL_STOPPED_LABEL,
} from '../shared/session-copy';
import { formatClock } from '../shared/time';
import type { SessionSnapshotV2 } from '../shared/types';

interface ClockRow {
  key: string;
  value: string;
  label: string;
}

/** The remaining phase clock for a paused or break phase, absent when the phase has no end. */
function phaseCountdownRow(snapshot: SessionSnapshotV2, now: number): ClockRow | null {
  const remainingMs: number | null = remainingPhaseMsV2(snapshot, now);
  if (remainingMs === null) return null;
  return {
    key: 'phase',
    value: formatClock(remainingMs),
    label: snapshot.phase === 'paused' ? PAUSE_CLOCK_LABEL : BREAK_CLOCK_LABEL,
  };
}

/**
 * An indefinite session has no total-session countdown, so it reports settled focus
 * instead. The projection freezes outside focus and never runs past a finite end.
 */
function indefiniteRows(snapshot: SessionSnapshotV2, now: number): ClockRow[] {
  const focusTime: ClockRow = {
    key: 'focus-time',
    value: formatClock(projectedSessionFocusedMsV2(snapshot, now)),
    label: FOCUS_TIME_LABEL,
  };
  if (snapshot.phase === 'focus') return [focusTime];
  const countdown: ClockRow | null = phaseCountdownRow(snapshot, now);
  return countdown === null ? [focusTime] : [countdown, focusTime];
}

/**
 * A timed session always ends at `sessionEndsAt`. A phase transition never shortens
 * that, so the total session is its own labelled row whenever the phase ends sooner.
 */
function timedRows(snapshot: SessionSnapshotV2, now: number, sessionMs: number): ClockRow[] {
  const total: ClockRow = {
    key: 'session',
    value: formatClock(sessionMs),
    label: TOTAL_SESSION_CLOCK_LABEL,
  };
  if (snapshot.phase !== 'focus') {
    const countdown: ClockRow | null = phaseCountdownRow(snapshot, now);
    return countdown === null ? [total] : [countdown, total];
  }
  const phaseMs: number | null = remainingPhaseMsV2(snapshot, now);
  if (phaseMs === null || snapshot.phaseEndsAt === snapshot.sessionEndsAt) return [total];
  return [{ key: 'phase', value: formatClock(phaseMs), label: FOCUS_PHASE_CLOCK_LABEL }, total];
}

function clockRows(snapshot: SessionSnapshotV2, now: number): ClockRow[] {
  if (snapshot.lifecycle.kind !== 'active' || snapshot.phase === 'idle') return [];
  const sessionMs: number | null = remainingSessionMsV2(snapshot, now);
  return sessionMs === null ? indefiniteRows(snapshot, now) : timedRows(snapshot, now, sessionMs);
}

export interface ClockStackProps {
  snapshot: SessionSnapshotV2;
  now: number;
}

/**
 * Labelled clocks for one active session. A timed cycling session shows its focus
 * phase and its total session as separate rows so the phase length is never mistaken
 * for the session length.
 *
 * This replaces the v1 progress ring, and nothing takes over the visual progress that
 * ring carried. That is deliberate: an indefinite session has no proportion to draw, and
 * a ring that appears for one duration and not the other reads as a missing element
 * rather than as a difference. The toolbar icon still draws phase progress.
 */
export function ClockStack({ snapshot, now }: ClockStackProps): VNode {
  const rows: ClockRow[] = clockRows(snapshot, now);
  const indefinite: boolean =
    rows.length > 0 && snapshot.lifecycle.kind === 'active' && snapshot.sessionEndsAt === null;

  return (
    <div class="clock-stack">
      {rows.map(
        (row: ClockRow, index: number): VNode => (
          <div
            key={row.key}
            class={
              index === 0 ? 'clock-stack__row' : 'clock-stack__row clock-stack__row--secondary'
            }
          >
            <span class="clock-stack__value">{row.value}</span>
            <span class="clock-stack__label">{row.label}</span>
          </div>
        ),
      )}
      {indefinite ? <p class="clock-stack__note">{UNTIL_STOPPED_LABEL}</p> : null}
    </div>
  );
}

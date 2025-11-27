import { MIN_BREAK_BEFORE_EARLY_MS } from '../shared/constants';
import { CoreError } from '../shared/errors';
import { minToMs } from '../shared/time';
import type {
  CycleConfig,
  NormalizedSessionConfigV1,
  NormalizedSessionStateV1,
  Phase,
} from '../shared/types';

/*
 * Timing semantics, the contract plan 03 codes against:
 *
 * - The session wall clock never stops. sessionEndsAt is fixed at start.
 * - Cycling splits the session into focus phases separated by breaks.
 *   Every longEvery-th break is long. Phases clamp to sessionEndsAt,
 *   and a phase that would start with no time left completes the session.
 * - Pausing (spending budget) does not stop the session or the cycle
 *   timetable. pausedFrom remembers the phase to restore. A pause that
 *   outlives its phase resumes into whatever phase the timetable says.
 * - focusedMs counts real focused time only: phase time actually spent
 *   in focus, minus paused stretches. phaseStartedAt doubles as "when
 *   focus counting last resumed" for this bookkeeping.
 */

export type MachineEvent =
  | { type: 'phaseChanged'; from: Phase; to: Phase; at: number }
  | { type: 'completed'; at: number; focusedMs: number };

export function startSession(
  config: NormalizedSessionConfigV1,
  now: number,
  sessionId?: string,
): NormalizedSessionStateV1 {
  const sessionEndsAt: number = now + minToMs(config.durationMin);
  const focusEnd: number =
    config.cycling === null
      ? sessionEndsAt
      : Math.min(now + minToMs(config.cycling.focusMin), sessionEndsAt);
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    config,
    startedAt: now,
    sessionEndsAt,
    phase: 'focus',
    phaseStartedAt: now,
    phaseEndsAt: focusEnd,
    cycleIndex: 0,
    pausedFrom: null,
    focusedMs: 0,
  };
}

function breakLenMs(state: NormalizedSessionStateV1): number {
  const c: CycleConfig | null = state.config.cycling;
  if (c === null) return 0;
  const isLong: boolean = (state.cycleIndex + 1) % c.longEvery === 0;
  return minToMs(isLong ? c.longBreakMin : c.shortBreakMin);
}

/**
 * Catch-up transition function. Given persisted state and the current
 * time, fast-forwards through every transition that should have
 * happened (missed alarms, worker restarts), returning the state that
 * is correct now (null when the session completed) plus the events
 * passed through, in order.
 */
export function advance(
  state: NormalizedSessionStateV1,
  now: number,
): { next: NormalizedSessionStateV1 | null; events: MachineEvent[] } {
  let s: NormalizedSessionStateV1 = { ...state };
  const events: MachineEvent[] = [];

  for (;;) {
    const boundary: number = Math.min(s.phaseEndsAt, s.sessionEndsAt);
    if (now < boundary) return { next: s, events };

    if (s.phase === 'focus') {
      // Math.max guards the resume-after-phase-end path: a pause that
      // outlives its focus phase restores with phaseStartedAt past
      // phaseEndsAt, which must count as zero focus, not negative.
      s.focusedMs += Math.max(0, Math.min(boundary, s.phaseEndsAt) - s.phaseStartedAt);
    }
    if (boundary >= s.sessionEndsAt) {
      events.push({ type: 'completed', at: s.sessionEndsAt, focusedMs: s.focusedMs });
      return { next: null, events };
    }
    if (s.phase === 'focus') {
      const len: number = breakLenMs(s);
      // The - 1 makes a break that exactly touches sessionEndsAt complete
      // the session instead of scheduling a zero-length focus cycle.
      if (len === 0 || boundary + len >= s.sessionEndsAt - 1) {
        events.push({ type: 'completed', at: boundary, focusedMs: s.focusedMs });
        return { next: null, events };
      }
      events.push({ type: 'phaseChanged', from: 'focus', to: 'break', at: boundary });
      s = {
        ...s,
        phase: 'break',
        phaseStartedAt: boundary,
        phaseEndsAt: boundary + len,
        pausedFrom: null,
      };
    } else if (s.phase === 'break') {
      const c: CycleConfig | null = s.config.cycling;
      const focusLen: number = c === null ? 0 : minToMs(c.focusMin);
      events.push({ type: 'phaseChanged', from: 'break', to: 'focus', at: boundary });
      s = {
        ...s,
        phase: 'focus',
        cycleIndex: s.cycleIndex + 1,
        phaseStartedAt: boundary,
        phaseEndsAt: Math.min(boundary + focusLen, s.sessionEndsAt),
        pausedFrom: null,
      };
    } else {
      const from: { phase: 'focus' | 'break'; phaseEndsAt: number } | null = s.pausedFrom;
      if (from === null) throw new CoreError('not-cancelable', 'paused without pausedFrom');
      events.push({ type: 'phaseChanged', from: 'paused', to: from.phase, at: boundary });
      s = {
        ...s,
        phase: from.phase,
        phaseStartedAt: boundary,
        phaseEndsAt: from.phaseEndsAt,
        pausedFrom: null,
      };
    }
  }
}

/** Session clock keeps running during a pause. Throws CoreError when not in focus. */
export function beginPause(
  state: NormalizedSessionStateV1,
  now: number,
  pauseMs: number,
): NormalizedSessionStateV1 {
  if (state.phase !== 'focus') throw new CoreError('not-cancelable', 'pause only during focus');
  return {
    ...state,
    focusedMs: state.focusedMs + (now - state.phaseStartedAt),
    phase: 'paused',
    phaseStartedAt: now,
    phaseEndsAt: now + pauseMs,
    pausedFrom: { phase: 'focus', phaseEndsAt: state.phaseEndsAt },
  };
}

export function endPauseEarly(
  state: NormalizedSessionStateV1,
  now: number,
): NormalizedSessionStateV1 {
  if (state.phase !== 'paused' || state.pausedFrom === null) {
    throw new CoreError('not-cancelable', 'not paused');
  }
  return {
    ...state,
    phase: state.pausedFrom.phase,
    phaseStartedAt: now,
    phaseEndsAt: state.pausedFrom.phaseEndsAt,
    pausedFrom: null,
  };
}

/** Throws CoreError('break-too-short') before MIN_BREAK_BEFORE_EARLY_MS of break has elapsed. */
export function startNextFocusEarly(
  state: NormalizedSessionStateV1,
  now: number,
): NormalizedSessionStateV1 {
  if (state.phase !== 'break') throw new CoreError('break-too-short', 'not on a break');
  if (now - state.phaseStartedAt < MIN_BREAK_BEFORE_EARLY_MS) {
    throw new CoreError('break-too-short', 'give the break two minutes first');
  }
  const c: CycleConfig | null = state.config.cycling;
  const focusLen: number = c === null ? 0 : minToMs(c.focusMin);
  return {
    ...state,
    phase: 'focus',
    cycleIndex: state.cycleIndex + 1,
    phaseStartedAt: now,
    phaseEndsAt: Math.min(now + focusLen, state.sessionEndsAt),
    pausedFrom: null,
  };
}

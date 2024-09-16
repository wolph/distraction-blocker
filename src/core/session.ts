import type { Phase, SessionConfig, SessionState } from '../shared/types';

export type MachineEvent =
  | { type: 'phaseChanged'; from: Phase; to: Phase; at: number }
  | { type: 'completed'; at: number; focusedMs: number };

export function startSession(config: SessionConfig, now: number): SessionState {
  throw new Error('not implemented, plan 02');
}

/**
 * Catch-up transition function. Given persisted state and the current
 * time, fast-forwards through every transition that should have
 * happened (missed alarms, worker restarts), returning the state that
 * is correct now (null when the session completed) plus the events
 * passed through, in order.
 */
export function advance(
  state: SessionState,
  now: number,
): { next: SessionState | null; events: MachineEvent[] } {
  throw new Error('not implemented, plan 02');
}

/** Session clock keeps running during a pause. Throws CoreError when not in focus or break. */
export function beginPause(state: SessionState, now: number, pauseMs: number): SessionState {
  throw new Error('not implemented, plan 02');
}

export function endPauseEarly(state: SessionState, now: number): SessionState {
  throw new Error('not implemented, plan 02');
}

/** Throws CoreError('break-too-short') before MIN_BREAK_BEFORE_EARLY_MS of break has elapsed. */
export function startNextFocusEarly(state: SessionState, now: number): SessionState {
  throw new Error('not implemented, plan 02');
}

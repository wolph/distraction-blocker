import { MIN_BREAK_BEFORE_EARLY_MS } from '../shared/constants';
import { CoreError } from '../shared/errors';
import type { CycleConfig, SessionConfigV2, SessionStateV2 } from '../shared/types';

const MINUTE_MS: number = 60_000;

export type SessionPhaseEventV2 = {
  type: 'phaseChanged';
  from: 'focus';
  to: 'break';
  at: number;
};

export type SessionAdvanceResultV2 =
  | {
      kind: 'active';
      state: SessionStateV2;
      sessionFocusedMs: number;
      events: SessionPhaseEventV2[];
    }
  | {
      kind: 'resume-required';
      state: SessionStateV2;
      trigger: 'pause-expired' | 'break-expired';
      boundaryAt: number;
      sessionFocusedMs: number;
      events: SessionPhaseEventV2[];
    }
  | {
      kind: 'timer-completed';
      state: SessionStateV2;
      endedAt: number;
      sessionFocusedMs: number;
      events: SessionPhaseEventV2[];
    };

function invalidArithmetic(message: string): never {
  throw new CoreError('invalid-rule', message);
}

function assertSafeNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalidArithmetic(`${label} must be a non-negative safe integer`);
  }
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    invalidArithmetic(`${label} must be a positive safe integer`);
  }
}

function minuteDurationMs(minutes: number, label: string): number {
  const milliseconds: number = Math.round(minutes * MINUTE_MS);
  assertPositiveSafeInteger(milliseconds, label);
  return milliseconds;
}

function checkedAdd(left: number, right: number, label: string): number {
  assertSafeNonNegativeInteger(left, `${label} left operand`);
  assertSafeNonNegativeInteger(right, `${label} right operand`);
  const result: number = left + right;
  assertSafeNonNegativeInteger(result, label);
  return result;
}

function checkedSubtract(larger: number, smaller: number, label: string): number {
  assertSafeNonNegativeInteger(larger, `${label} larger operand`);
  assertSafeNonNegativeInteger(smaller, `${label} smaller operand`);
  const result: number = larger - smaller;
  assertSafeNonNegativeInteger(result, label);
  return result;
}

function cloneState(state: SessionStateV2): SessionStateV2 {
  return structuredClone(state);
}

function assertCycleArithmetic(cycling: CycleConfig): void {
  minuteDurationMs(cycling.focusMin, 'focus duration');
  minuteDurationMs(cycling.shortBreakMin, 'short break duration');
  minuteDurationMs(cycling.longBreakMin, 'long break duration');
  assertPositiveSafeInteger(cycling.longEvery, 'long break interval');
}

function assertStateArithmetic(state: SessionStateV2): void {
  assertSafeNonNegativeInteger(state.startedAt, 'session start');
  assertSafeNonNegativeInteger(state.phaseStartedAt, 'phase start');
  assertSafeNonNegativeInteger(state.cycleIndex, 'cycle index');
  assertSafeNonNegativeInteger(state.focusedMs, 'settled focus');
  if (state.phaseStartedAt < state.startedAt) {
    invalidArithmetic('phase start cannot precede session start');
  }
  if (state.sessionEndsAt !== null) {
    assertSafeNonNegativeInteger(state.sessionEndsAt, 'session end');
    if (state.sessionEndsAt < state.phaseStartedAt) {
      invalidArithmetic('session end cannot precede phase start');
    }
  }
  if (state.phaseEndsAt !== null) {
    assertSafeNonNegativeInteger(state.phaseEndsAt, 'phase end');
    if (state.phaseEndsAt < state.phaseStartedAt) {
      invalidArithmetic('phase end cannot precede phase start');
    }
    if (state.sessionEndsAt !== null && state.phaseEndsAt > state.sessionEndsAt) {
      invalidArithmetic('phase end cannot exceed session end');
    }
  }
  if (state.pausedFrom !== null && state.pausedFrom.phaseEndsAt !== null) {
    assertSafeNonNegativeInteger(state.pausedFrom.phaseEndsAt, 'saved phase end');
    if (state.pausedFrom.phaseEndsAt < state.phaseStartedAt) {
      invalidArithmetic('saved phase end cannot precede pause start');
    }
    if (state.sessionEndsAt !== null && state.pausedFrom.phaseEndsAt > state.sessionEndsAt) {
      invalidArithmetic('saved phase end cannot exceed session end');
    }
  }
}

export function startSessionV2(
  config: SessionConfigV2,
  activationAt: number,
  sessionId: string,
): SessionStateV2 {
  assertSafeNonNegativeInteger(activationAt, 'activation timestamp');
  const detachedConfig: SessionConfigV2 = structuredClone(config);

  if (detachedConfig.duration.kind === 'until-stopped') {
    if (detachedConfig.strictness === 'hard' || detachedConfig.cycling !== null) {
      invalidArithmetic('until-stopped sessions cannot be Hard and cannot cycle');
    }
    return {
      version: 2,
      sessionId,
      config: detachedConfig,
      startedAt: activationAt,
      sessionEndsAt: null,
      phase: 'focus',
      phaseStartedAt: activationAt,
      phaseEndsAt: null,
      cycleIndex: 0,
      pausedFrom: null,
      focusedMs: 0,
    };
  }

  const sessionDurationMs: number = minuteDurationMs(
    detachedConfig.duration.minutes,
    'session duration',
  );
  const sessionEndsAt: number = checkedAdd(activationAt, sessionDurationMs, 'session end');
  let phaseEndsAt: number = sessionEndsAt;
  if (detachedConfig.cycling !== null) {
    assertCycleArithmetic(detachedConfig.cycling);
    const focusDurationMs: number = minuteDurationMs(
      detachedConfig.cycling.focusMin,
      'focus duration',
    );
    const configuredFocusEnd: number = checkedAdd(activationAt, focusDurationMs, 'focus end');
    phaseEndsAt = Math.min(configuredFocusEnd, sessionEndsAt);
  }

  return {
    version: 2,
    sessionId,
    config: detachedConfig,
    startedAt: activationAt,
    sessionEndsAt,
    phase: 'focus',
    phaseStartedAt: activationAt,
    phaseEndsAt,
    cycleIndex: 0,
    pausedFrom: null,
    focusedMs: 0,
  };
}

export function focusedMsAtV2(state: SessionStateV2, at: number): number {
  assertSafeNonNegativeInteger(at, 'focus observation timestamp');
  assertSafeNonNegativeInteger(state.focusedMs, 'settled focus');
  if (state.phase !== 'focus') return state.focusedMs;

  assertSafeNonNegativeInteger(state.phaseStartedAt, 'focus phase start');
  if (at <= state.phaseStartedAt) return state.focusedMs;

  let projectionEnd: number = at;
  if (state.phaseEndsAt !== null) {
    assertSafeNonNegativeInteger(state.phaseEndsAt, 'focus phase end');
    projectionEnd = Math.min(projectionEnd, state.phaseEndsAt);
  }
  if (state.sessionEndsAt !== null) {
    assertSafeNonNegativeInteger(state.sessionEndsAt, 'session end');
    projectionEnd = Math.min(projectionEnd, state.sessionEndsAt);
  }
  const elapsedMs: number = checkedSubtract(
    projectionEnd,
    state.phaseStartedAt,
    'focus projection',
  );
  return checkedAdd(state.focusedMs, elapsedMs, 'projected focus');
}

function activeResult(
  state: SessionStateV2,
  at: number,
  events: SessionPhaseEventV2[],
): SessionAdvanceResultV2 {
  return {
    kind: 'active',
    state,
    sessionFocusedMs: focusedMsAtV2(state, at),
    events,
  };
}

function resumeRequiredResult(
  state: SessionStateV2,
  trigger: 'pause-expired' | 'break-expired',
  boundaryAt: number,
  events: SessionPhaseEventV2[],
): SessionAdvanceResultV2 {
  return {
    kind: 'resume-required',
    state,
    trigger,
    boundaryAt,
    sessionFocusedMs: state.focusedMs,
    events,
  };
}

function timerCompletedResult(
  state: SessionStateV2,
  endedAt: number,
  events: SessionPhaseEventV2[],
): SessionAdvanceResultV2 {
  if (state.phase !== 'focus') {
    return {
      kind: 'timer-completed',
      state,
      endedAt,
      sessionFocusedMs: state.focusedMs,
      events,
    };
  }

  const sessionFocusedMs: number = focusedMsAtV2(state, endedAt);
  const completedState: SessionStateV2 = {
    ...state,
    phaseStartedAt: endedAt,
    phaseEndsAt: endedAt,
    pausedFrom: null,
    focusedMs: sessionFocusedMs,
  };
  return {
    kind: 'timer-completed',
    state: completedState,
    endedAt,
    sessionFocusedMs,
    events,
  };
}

function nextBreakDurationMs(state: SessionStateV2, completedFocusCount: number): number {
  const cycling: CycleConfig | null = state.config.cycling;
  if (cycling === null) invalidArithmetic('a cycling focus boundary requires cycling settings');
  assertCycleArithmetic(cycling);
  const minutes: number =
    completedFocusCount % cycling.longEvery === 0 ? cycling.longBreakMin : cycling.shortBreakMin;
  return minuteDurationMs(minutes, 'next break duration');
}

export function advanceSessionV2(state: SessionStateV2, at: number): SessionAdvanceResultV2 {
  assertSafeNonNegativeInteger(at, 'advance timestamp');
  assertStateArithmetic(state);
  const current: SessionStateV2 = cloneState(state);
  const events: SessionPhaseEventV2[] = [];

  if (at < current.phaseStartedAt) return activeResult(current, at, events);

  const phaseEndsAt: number | null = current.phaseEndsAt;
  const sessionEndsAt: number | null = current.sessionEndsAt;
  if (
    sessionEndsAt !== null &&
    at >= sessionEndsAt &&
    (phaseEndsAt === null || sessionEndsAt <= phaseEndsAt)
  ) {
    return timerCompletedResult(current, sessionEndsAt, events);
  }
  if (phaseEndsAt === null || at < phaseEndsAt) return activeResult(current, at, events);

  if (current.phase === 'paused') {
    return resumeRequiredResult(current, 'pause-expired', phaseEndsAt, events);
  }
  if (current.phase === 'break') {
    return resumeRequiredResult(current, 'break-expired', phaseEndsAt, events);
  }
  if (sessionEndsAt === null) {
    invalidArithmetic('finite focus boundaries require a finite session end');
  }

  const settledFocusMs: number = focusedMsAtV2(current, phaseEndsAt);
  const nextCycleIndex: number = checkedAdd(current.cycleIndex, 1, 'cycle index');
  const breakDurationMs: number = nextBreakDurationMs(current, nextCycleIndex);
  const breakEndsAt: number = checkedAdd(phaseEndsAt, breakDurationMs, 'break end');

  if (breakEndsAt < sessionEndsAt) {
    const event: SessionPhaseEventV2 = {
      type: 'phaseChanged',
      from: 'focus',
      to: 'break',
      at: phaseEndsAt,
    };
    events.push(event);
    const breakState: SessionStateV2 = {
      ...current,
      phase: 'break',
      phaseStartedAt: phaseEndsAt,
      phaseEndsAt: breakEndsAt,
      cycleIndex: nextCycleIndex,
      pausedFrom: null,
      focusedMs: settledFocusMs,
    };
    if (at >= breakEndsAt) {
      return resumeRequiredResult(breakState, 'break-expired', breakEndsAt, events);
    }
    return activeResult(breakState, at, events);
  }

  const tailState: SessionStateV2 = {
    ...current,
    phase: 'focus',
    phaseStartedAt: phaseEndsAt,
    phaseEndsAt: sessionEndsAt,
    cycleIndex: nextCycleIndex,
    pausedFrom: null,
    focusedMs: settledFocusMs,
  };
  if (at >= sessionEndsAt) return timerCompletedResult(tailState, sessionEndsAt, events);
  return activeResult(tailState, at, events);
}

export function beginPauseV2(state: SessionStateV2, at: number, pauseMs: number): SessionStateV2 {
  assertSafeNonNegativeInteger(at, 'pause timestamp');
  assertSafeNonNegativeInteger(pauseMs, 'pause duration');
  assertStateArithmetic(state);
  if (state.phase !== 'focus') {
    throw new CoreError('not-cancelable', 'pause is available only during focus');
  }
  if (at < state.phaseStartedAt) invalidArithmetic('pause timestamp cannot precede focus start');

  let boundaryAt: number | null = state.phaseEndsAt;
  if (state.sessionEndsAt !== null) {
    boundaryAt =
      boundaryAt === null ? state.sessionEndsAt : Math.min(boundaryAt, state.sessionEndsAt);
  }
  if (boundaryAt !== null && at >= boundaryAt) {
    invalidArithmetic('settle the current boundary before pausing');
  }

  const configuredPauseEnd: number = checkedAdd(at, pauseMs, 'pause end');
  const phaseEndsAt: number =
    state.sessionEndsAt === null
      ? configuredPauseEnd
      : Math.min(configuredPauseEnd, state.sessionEndsAt);
  const focusedMs: number = focusedMsAtV2(state, at);
  const detached: SessionStateV2 = cloneState(state);
  return {
    ...detached,
    phase: 'paused',
    phaseStartedAt: at,
    phaseEndsAt,
    pausedFrom: { phase: 'focus', phaseEndsAt: state.phaseEndsAt },
    focusedMs,
  };
}

function freshFocusEnd(state: SessionStateV2, activationAt: number): number {
  const cycling: CycleConfig | null = state.config.cycling;
  if (cycling === null) invalidArithmetic('resuming a break requires cycling settings');
  const focusDurationMs: number = minuteDurationMs(cycling.focusMin, 'focus duration');
  return checkedAdd(activationAt, focusDurationMs, 'focus end');
}

export function commitResumeV2(state: SessionStateV2, activationAt: number): SessionStateV2 {
  assertSafeNonNegativeInteger(activationAt, 'resume activation timestamp');
  assertStateArithmetic(state);
  if (state.phase !== 'paused' && state.phase !== 'break') {
    throw new CoreError('not-cancelable', 'only a pause or break can resume');
  }
  if (activationAt < state.phaseStartedAt) {
    invalidArithmetic('resume activation cannot precede the non-blocking phase');
  }
  if (state.sessionEndsAt !== null && activationAt >= state.sessionEndsAt) {
    invalidArithmetic('settle timer completion before resuming');
  }

  let resumedFromPhase: 'focus' | 'break';
  let savedPhaseEndsAt: number | null;
  if (state.phase === 'break') {
    resumedFromPhase = 'break';
    savedPhaseEndsAt = state.phaseEndsAt;
  } else {
    if (state.pausedFrom === null) invalidArithmetic('paused state requires a saved phase');
    resumedFromPhase = state.pausedFrom.phase;
    savedPhaseEndsAt = state.pausedFrom.phaseEndsAt;
  }
  let phaseEndsAt: number | null;

  if (resumedFromPhase === 'focus') {
    if (savedPhaseEndsAt === null) {
      if (state.sessionEndsAt !== null) {
        invalidArithmetic('timed paused focus requires a saved finite focus end');
      }
      phaseEndsAt = null;
    } else {
      const unfinishedFocusMs: number = checkedSubtract(
        savedPhaseEndsAt,
        state.phaseStartedAt,
        'unfinished focus',
      );
      const configuredFocusEnd: number = checkedAdd(
        activationAt,
        unfinishedFocusMs,
        'resumed focus end',
      );
      phaseEndsAt =
        state.sessionEndsAt === null
          ? configuredFocusEnd
          : Math.min(configuredFocusEnd, state.sessionEndsAt);
    }
  } else {
    const configuredFocusEnd: number = freshFocusEnd(state, activationAt);
    if (state.sessionEndsAt === null) {
      invalidArithmetic('a resumed break requires a finite session end');
    }
    phaseEndsAt = Math.min(configuredFocusEnd, state.sessionEndsAt);
  }

  const detached: SessionStateV2 = cloneState(state);
  return {
    ...detached,
    phase: 'focus',
    phaseStartedAt: activationAt,
    phaseEndsAt,
    pausedFrom: null,
  };
}

export function assertCanStartNextFocusEarlyV2(state: SessionStateV2, at: number): void {
  assertSafeNonNegativeInteger(at, 'early focus timestamp');
  assertStateArithmetic(state);
  if (state.phase !== 'break') {
    throw new CoreError('break-too-short', 'not on a break');
  }
  if (at < state.phaseStartedAt) {
    invalidArithmetic('early focus timestamp cannot precede break start');
  }
  if (
    state.phaseEndsAt === null ||
    at >= state.phaseEndsAt ||
    (state.sessionEndsAt !== null && at >= state.sessionEndsAt)
  ) {
    invalidArithmetic('settle the current boundary before resuming focus');
  }
  const elapsedBreakMs: number = checkedSubtract(at, state.phaseStartedAt, 'elapsed break');
  if (elapsedBreakMs < MIN_BREAK_BEFORE_EARLY_MS) {
    throw new CoreError('break-too-short', 'give the break two minutes first');
  }
}

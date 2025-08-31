import { describe, expect, it } from 'vitest';
import {
  advanceSessionV2,
  beginPauseV2,
  commitResumeV2,
  focusedMsAtV2,
  type SessionAdvanceResultV2,
  startSessionV2,
} from '../../../src/core/session-v2';
import type { SessionConfigV2, SessionStateV2 } from '../../../src/shared/types';
import {
  MANUAL_INDEFINITE_CONFIG,
  MANUAL_TIMED_CONFIG,
  NOW,
  SESSION_ID,
} from '../shared/v2-runtime-fixtures';

const MINUTE_MS: number = 60_000;

function config(minutes: number, longEvery: number = 4): SessionConfigV2 {
  return {
    ...structuredClone(MANUAL_TIMED_CONFIG),
    duration: { kind: 'timed', minutes },
    cycling: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery },
  };
}

function resumeState(result: SessionAdvanceResultV2): SessionStateV2 {
  expect(result.kind).toBe('resume-required');
  return result.state;
}

describe('advanceSessionV2', (): void => {
  it('projects focus before a boundary without settling the durable cursor', (): void => {
    const initial: SessionStateV2 = startSessionV2(config(50), NOW, SESSION_ID);
    const result: SessionAdvanceResultV2 = advanceSessionV2(initial, NOW + MINUTE_MS);

    expect(result).toMatchObject({ kind: 'active', sessionFocusedMs: MINUTE_MS, events: [] });
    expect(result.state.focusedMs).toBe(0);
    expect(result.state).toEqual(initial);
  });

  it('counts browser-closed focus but never projects focus during break or pause', (): void => {
    const indefinite: SessionStateV2 = startSessionV2(MANUAL_INDEFINITE_CONFIG, NOW, SESSION_ID);
    const closedResult: SessionAdvanceResultV2 = advanceSessionV2(
      indefinite,
      NOW + 3 * 60 * MINUTE_MS,
    );
    const cycling: SessionStateV2 = startSessionV2(config(50), NOW, SESSION_ID);
    const breakResult: SessionAdvanceResultV2 = advanceSessionV2(cycling, NOW + 26 * MINUTE_MS);
    const paused: SessionStateV2 = beginPauseV2(indefinite, NOW + MINUTE_MS, 5 * MINUTE_MS);
    const pauseResult: SessionAdvanceResultV2 = advanceSessionV2(paused, NOW + 2 * MINUTE_MS);

    expect(closedResult.sessionFocusedMs).toBe(3 * 60 * MINUTE_MS);
    expect(breakResult.sessionFocusedMs).toBe(25 * MINUTE_MS);
    expect(pauseResult.sessionFocusedMs).toBe(MINUTE_MS);
  });

  it('settles a focus boundary, increments the cycle, and emits the break event', (): void => {
    const initial: SessionStateV2 = startSessionV2(config(50), NOW, SESSION_ID);
    const result: SessionAdvanceResultV2 = advanceSessionV2(initial, NOW + 25 * MINUTE_MS);

    expect(result).toMatchObject({
      kind: 'active',
      sessionFocusedMs: 25 * MINUTE_MS,
      events: [{ type: 'phaseChanged', from: 'focus', to: 'break', at: NOW + 25 * MINUTE_MS }],
      state: {
        phase: 'break',
        phaseStartedAt: NOW + 25 * MINUTE_MS,
        phaseEndsAt: NOW + 30 * MINUTE_MS,
        cycleIndex: 1,
        focusedMs: 25 * MINUTE_MS,
      },
    });
  });

  it('uses a long break when the completed focus number is divisible by longEvery', (): void => {
    let state: SessionStateV2 = startSessionV2(config(180), NOW, SESSION_ID);
    const resumeBoundaries: number[] = [30, 60, 90];
    for (const boundaryMinutes of resumeBoundaries) {
      state = resumeState(advanceSessionV2(state, NOW + boundaryMinutes * MINUTE_MS));
      state = commitResumeV2(state, NOW + boundaryMinutes * MINUTE_MS);
    }

    const fourth: SessionAdvanceResultV2 = advanceSessionV2(state, NOW + 115 * MINUTE_MS);

    expect(fourth.state.phase).toBe('break');
    expect(fourth.state.cycleIndex).toBe(4);
    expect(fourth.state.phaseEndsAt).toBe(NOW + 130 * MINUTE_MS);
  });

  it.each([30, 28])(
    'keeps a %i-minute exact or short tail in focus until the fixed end',
    (minutes: number): void => {
      const initial: SessionStateV2 = startSessionV2(config(minutes), NOW, SESSION_ID);
      const boundary: SessionAdvanceResultV2 = advanceSessionV2(initial, NOW + 25 * MINUTE_MS);
      const completed: SessionAdvanceResultV2 = advanceSessionV2(
        boundary.state,
        NOW + minutes * MINUTE_MS,
      );

      expect(boundary.kind).toBe('active');
      expect(boundary.state.phase).toBe('focus');
      expect(boundary.state.phaseStartedAt).toBe(NOW + 25 * MINUTE_MS);
      expect(boundary.state.phaseEndsAt).toBe(NOW + minutes * MINUTE_MS);
      expect(boundary.state.cycleIndex).toBe(1);
      expect(completed).toMatchObject({
        kind: 'timer-completed',
        endedAt: NOW + minutes * MINUTE_MS,
        sessionFocusedMs: minutes * MINUTE_MS,
      });
    },
  );

  it('stops at break expiry and retains the durable non-blocking phase', (): void => {
    const initial: SessionStateV2 = startSessionV2(config(50), NOW, SESSION_ID);
    const atExpiry: SessionAdvanceResultV2 = advanceSessionV2(initial, NOW + 30 * MINUTE_MS);
    const farFuture: SessionAdvanceResultV2 = advanceSessionV2(initial, NOW + 10_000 * MINUTE_MS);

    expect(atExpiry).toMatchObject({
      kind: 'resume-required',
      trigger: 'break-expired',
      boundaryAt: NOW + 30 * MINUTE_MS,
      sessionFocusedMs: 25 * MINUTE_MS,
      state: { phase: 'break', cycleIndex: 1, phaseEndsAt: NOW + 30 * MINUTE_MS },
    });
    expect(farFuture).toMatchObject({
      kind: 'resume-required',
      trigger: 'break-expired',
      boundaryAt: NOW + 30 * MINUTE_MS,
      sessionFocusedMs: 25 * MINUTE_MS,
      state: { phase: 'break' },
    });
  });

  it('lets completion win when phase and session boundaries are equal', (): void => {
    const initial: SessionStateV2 = startSessionV2(MANUAL_TIMED_CONFIG, NOW, SESSION_ID);
    const result: SessionAdvanceResultV2 = advanceSessionV2(initial, NOW + 25 * MINUTE_MS);

    expect(result.kind).toBe('timer-completed');
    expect(result).toMatchObject({
      endedAt: NOW + 25 * MINUTE_MS,
      sessionFocusedMs: 25 * MINUTE_MS,
      events: [],
    });
  });

  it('makes focus completion accounting idempotent and preserves non-crediting phases', (): void => {
    const initial: SessionStateV2 = startSessionV2(MANUAL_TIMED_CONFIG, NOW, SESSION_ID);
    const focusCompletion: SessionAdvanceResultV2 = advanceSessionV2(initial, NOW + 30 * MINUTE_MS);
    expect(focusCompletion.kind).toBe('timer-completed');
    expect(focusCompletion.state.phaseStartedAt).toBe(NOW + 25 * MINUTE_MS);
    expect(focusCompletion.state.phaseEndsAt).toBe(NOW + 25 * MINUTE_MS);
    expect(focusedMsAtV2(focusCompletion.state, NOW + 25 * MINUTE_MS)).toBe(25 * MINUTE_MS);

    const breakAtEnd: SessionStateV2 = {
      ...startSessionV2(config(30), NOW, SESSION_ID),
      phase: 'break',
      phaseStartedAt: NOW + 25 * MINUTE_MS,
      phaseEndsAt: NOW + 30 * MINUTE_MS,
      cycleIndex: 1,
      focusedMs: 25 * MINUTE_MS,
    };
    const breakCompletion: SessionAdvanceResultV2 = advanceSessionV2(
      breakAtEnd,
      NOW + 30 * MINUTE_MS,
    );

    expect(breakCompletion.kind).toBe('timer-completed');
    expect(breakCompletion.state).toEqual(breakAtEnd);
    expect(breakCompletion.sessionFocusedMs).toBe(25 * MINUTE_MS);

    const pausedAtEnd: SessionStateV2 = beginPauseV2(initial, NOW + 10 * MINUTE_MS, 20 * MINUTE_MS);
    const pauseCompletion: SessionAdvanceResultV2 = advanceSessionV2(
      pausedAtEnd,
      NOW + 30 * MINUTE_MS,
    );

    expect(pauseCompletion.kind).toBe('timer-completed');
    expect(pauseCompletion.state).toEqual(pausedAtEnd);
    expect(pauseCompletion.sessionFocusedMs).toBe(10 * MINUTE_MS);
  });

  it('never completes or creates a break for indefinite focus', (): void => {
    const initial: SessionStateV2 = startSessionV2(MANUAL_INDEFINITE_CONFIG, NOW, SESSION_ID);
    const result: SessionAdvanceResultV2 = advanceSessionV2(initial, NOW + 1_000_000);

    expect(result.kind).toBe('active');
    expect(result.state.phase).toBe('focus');
    expect(result.state.sessionEndsAt).toBeNull();
    expect(result.state.phaseEndsAt).toBeNull();
  });

  it('treats clock rollback as a settled no-op without mutating input', (): void => {
    const initial: SessionStateV2 = startSessionV2(MANUAL_TIMED_CONFIG, NOW, SESSION_ID);
    const snapshot: SessionStateV2 = structuredClone(initial);
    const result: SessionAdvanceResultV2 = advanceSessionV2(initial, NOW - 1);

    expect(result).toMatchObject({ kind: 'active', sessionFocusedMs: 0, events: [] });
    expect(result.state).toEqual(snapshot);
    expect(initial).toEqual(snapshot);
  });

  it('detaches nested input and output state in both mutation directions', (): void => {
    const input: SessionStateV2 = startSessionV2(config(50), NOW, SESSION_ID);
    const inputSnapshot: SessionStateV2 = structuredClone(input);
    const result: SessionAdvanceResultV2 = advanceSessionV2(input, NOW + MINUTE_MS);
    const resultSnapshot: SessionStateV2 = structuredClone(result.state);

    input.config.rules.sessionBlacklist.push({ kind: 'host', pattern: 'input.example' });
    expect(result.state).toEqual(resultSnapshot);

    result.state.config.rules.sessionAllowlist.push({ kind: 'host', pattern: 'output.example' });
    if (result.state.config.cycling !== null) result.state.config.cycling.focusMin = 40;
    expect(input).not.toEqual(inputSnapshot);
    expect(input.config.rules.sessionAllowlist).toEqual(
      inputSnapshot.config.rules.sessionAllowlist,
    );
    expect(input.config.cycling).toEqual(inputSnapshot.config.cycling);
  });
});

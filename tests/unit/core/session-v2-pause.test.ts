import { describe, expect, it } from 'vitest';
import {
  advanceSessionV2,
  assertCanStartNextFocusEarlyV2,
  beginPauseV2,
  commitResumeV2,
  type SessionAdvanceResultV2,
  startSessionV2,
} from '../../../src/core/session-v2';
import { CoreError } from '../../../src/shared/errors';
import type { SessionConfigV2, SessionStateV2 } from '../../../src/shared/types';
import {
  MANUAL_INDEFINITE_CONFIG,
  MANUAL_TIMED_CONFIG,
  NOW,
  SESSION_ID,
} from '../shared/v2-runtime-fixtures';

const MINUTE_MS: number = 60_000;

function config(minutes: number = 50): SessionConfigV2 {
  return {
    ...structuredClone(MANUAL_TIMED_CONFIG),
    duration: { kind: 'timed', minutes },
    cycling: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 },
  };
}

function breakState(): SessionStateV2 {
  const result: SessionAdvanceResultV2 = advanceSessionV2(
    startSessionV2(config(), NOW, SESSION_ID),
    NOW + 25 * MINUTE_MS,
  );
  expect(result.state.phase).toBe('break');
  return result.state;
}

describe('beginPauseV2', (): void => {
  it('pauses only focus and credits it exactly through pause start', (): void => {
    const initial: SessionStateV2 = startSessionV2(config(), NOW, SESSION_ID);
    const paused: SessionStateV2 = beginPauseV2(initial, NOW + 10 * MINUTE_MS, 5 * MINUTE_MS);

    expect(paused).toMatchObject({
      phase: 'paused',
      phaseStartedAt: NOW + 10 * MINUTE_MS,
      phaseEndsAt: NOW + 15 * MINUTE_MS,
      pausedFrom: { phase: 'focus', phaseEndsAt: NOW + 25 * MINUTE_MS },
      focusedMs: 10 * MINUTE_MS,
    });
    expect(
      (): SessionStateV2 => beginPauseV2(breakState(), NOW + 26 * MINUTE_MS, MINUTE_MS),
    ).toThrowError(CoreError);
  });

  it('rejects rollback and any action at or beyond a finite phase or session boundary', (): void => {
    const initial: SessionStateV2 = startSessionV2(config(), NOW, SESSION_ID);
    const tail: SessionStateV2 = {
      ...initial,
      phaseStartedAt: NOW + 25 * MINUTE_MS,
      phaseEndsAt: NOW + 50 * MINUTE_MS,
      cycleIndex: 1,
      focusedMs: 25 * MINUTE_MS,
    };

    expect((): SessionStateV2 => beginPauseV2(initial, NOW - 1, MINUTE_MS)).toThrow(CoreError);
    expect((): SessionStateV2 => beginPauseV2(initial, NOW + 25 * MINUTE_MS, MINUTE_MS)).toThrow(
      CoreError,
    );
    expect((): SessionStateV2 => beginPauseV2(tail, NOW + 50 * MINUTE_MS, MINUTE_MS)).toThrow(
      CoreError,
    );
  });

  it('caps a timed pause at the fixed end and gives indefinite pause a finite end', (): void => {
    const timed: SessionStateV2 = startSessionV2(config(), NOW, SESSION_ID);
    const capped: SessionStateV2 = beginPauseV2(timed, NOW + 24 * MINUTE_MS, 40 * MINUTE_MS);
    const indefinite: SessionStateV2 = beginPauseV2(
      startSessionV2(MANUAL_INDEFINITE_CONFIG, NOW, SESSION_ID),
      NOW + MINUTE_MS,
      5 * MINUTE_MS,
    );

    expect(capped.phaseEndsAt).toBe(NOW + 50 * MINUTE_MS);
    expect(indefinite.sessionEndsAt).toBeNull();
    expect(indefinite.phaseEndsAt).toBe(NOW + 6 * MINUTE_MS);
    expect(indefinite.pausedFrom).toEqual({ phase: 'focus', phaseEndsAt: null });
  });

  it('reports pause expiry without mutating the durable state into focus', (): void => {
    const paused: SessionStateV2 = beginPauseV2(
      startSessionV2(config(), NOW, SESSION_ID),
      NOW + 10 * MINUTE_MS,
      5 * MINUTE_MS,
    );
    const result: SessionAdvanceResultV2 = advanceSessionV2(paused, NOW + 15 * MINUTE_MS);

    expect(result).toMatchObject({
      kind: 'resume-required',
      trigger: 'pause-expired',
      boundaryAt: NOW + 15 * MINUTE_MS,
      state: { phase: 'paused', phaseEndsAt: NOW + 15 * MINUTE_MS },
    });
    expect(result.state).toEqual(paused);
  });
});

describe('commitResumeV2', (): void => {
  it('starts focus credit at durable activation and preserves unfinished focus duration', (): void => {
    const paused: SessionStateV2 = beginPauseV2(
      startSessionV2(config(), NOW, SESSION_ID),
      NOW + 24 * MINUTE_MS,
      5 * MINUTE_MS,
    );
    const resumed: SessionStateV2 = commitResumeV2(paused, NOW + 30 * MINUTE_MS);

    expect(resumed).toMatchObject({
      phase: 'focus',
      phaseStartedAt: NOW + 30 * MINUTE_MS,
      phaseEndsAt: NOW + 31 * MINUTE_MS,
      focusedMs: 24 * MINUTE_MS,
      pausedFrom: null,
    });
  });

  it('resumes direct break and paused-from-break as fresh capped focus without incrementing', (): void => {
    const onBreak: SessionStateV2 = breakState();
    const direct: SessionStateV2 = commitResumeV2(onBreak, NOW + 30 * MINUTE_MS);
    const pausedFromBreak: SessionStateV2 = {
      ...structuredClone(onBreak),
      phase: 'paused',
      phaseStartedAt: NOW + 27 * MINUTE_MS,
      phaseEndsAt: NOW + 29 * MINUTE_MS,
      pausedFrom: { phase: 'break', phaseEndsAt: NOW + 30 * MINUTE_MS },
    };
    const resumedPausedBreak: SessionStateV2 = commitResumeV2(
      pausedFromBreak,
      NOW + 29 * MINUTE_MS,
    );

    expect(direct).toMatchObject({
      phase: 'focus',
      cycleIndex: 1,
      phaseStartedAt: NOW + 30 * MINUTE_MS,
      phaseEndsAt: NOW + 50 * MINUTE_MS,
    });
    expect(resumedPausedBreak).toMatchObject({
      phase: 'focus',
      cycleIndex: 1,
      phaseStartedAt: NOW + 29 * MINUTE_MS,
      phaseEndsAt: NOW + 50 * MINUTE_MS,
    });
  });

  it('restores indefinite focus with null ends', (): void => {
    const paused: SessionStateV2 = beginPauseV2(
      startSessionV2(MANUAL_INDEFINITE_CONFIG, NOW, SESSION_ID),
      NOW + MINUTE_MS,
      5 * MINUTE_MS,
    );
    const resumed: SessionStateV2 = commitResumeV2(paused, NOW + 10 * MINUTE_MS);

    expect(resumed.phase).toBe('focus');
    expect(resumed.phaseStartedAt).toBe(NOW + 10 * MINUTE_MS);
    expect(resumed.sessionEndsAt).toBeNull();
    expect(resumed.phaseEndsAt).toBeNull();
  });

  it('rejects fixed-end expiry, rollback, and non-resumable phases', (): void => {
    const paused: SessionStateV2 = beginPauseV2(
      startSessionV2(config(), NOW, SESSION_ID),
      NOW + MINUTE_MS,
      5 * MINUTE_MS,
    );

    expect((): SessionStateV2 => commitResumeV2(paused, NOW)).toThrow(CoreError);
    expect((): SessionStateV2 => commitResumeV2(paused, NOW + 50 * MINUTE_MS)).toThrow(CoreError);
    expect(
      (): SessionStateV2 =>
        commitResumeV2(startSessionV2(config(), NOW, SESSION_ID), NOW + MINUTE_MS),
    ).toThrow(CoreError);
  });

  it('uses one resume commit for early pause and eligible early break ends', (): void => {
    const paused: SessionStateV2 = beginPauseV2(
      startSessionV2(config(), NOW, SESSION_ID),
      NOW + 10 * MINUTE_MS,
      5 * MINUTE_MS,
    );
    const earlyPause: SessionStateV2 = commitResumeV2(paused, NOW + 12 * MINUTE_MS);
    const onBreak: SessionStateV2 = breakState();
    assertCanStartNextFocusEarlyV2(onBreak, NOW + 27 * MINUTE_MS);
    const earlyBreak: SessionStateV2 = commitResumeV2(onBreak, NOW + 27 * MINUTE_MS);

    expect(earlyPause.phaseStartedAt).toBe(NOW + 12 * MINUTE_MS);
    expect(earlyBreak.phaseStartedAt).toBe(NOW + 27 * MINUTE_MS);
    expect(earlyBreak.cycleIndex).toBe(1);
  });

  it('rejects unsafe pause, resume, and focus arithmetic', (): void => {
    const initial: SessionStateV2 = startSessionV2(config(), NOW, SESSION_ID);
    const unsafeFocus: SessionStateV2 = { ...initial, focusedMs: Number.MAX_SAFE_INTEGER };
    const onBreak: SessionStateV2 = breakState();
    const unsafeCycling: SessionStateV2 = {
      ...onBreak,
      config: {
        ...onBreak.config,
        cycling: {
          focusMin: Number.MAX_SAFE_INTEGER,
          shortBreakMin: 5,
          longBreakMin: 15,
          longEvery: 4,
        },
      },
    };

    expect((): SessionStateV2 => beginPauseV2(initial, NOW + MINUTE_MS, -1)).toThrow(CoreError);
    expect(
      (): SessionStateV2 => beginPauseV2(initial, NOW + MINUTE_MS, Number.MAX_SAFE_INTEGER),
    ).toThrow(CoreError);
    expect((): SessionStateV2 => beginPauseV2(unsafeFocus, NOW + MINUTE_MS, MINUTE_MS)).toThrow(
      CoreError,
    );
    expect((): SessionStateV2 => commitResumeV2(onBreak, Number.MAX_SAFE_INTEGER + 1)).toThrow(
      CoreError,
    );
    expect((): SessionStateV2 => commitResumeV2(unsafeCycling, NOW + 27 * MINUTE_MS)).toThrow(
      CoreError,
    );
  });

  it('detaches nested values from inputs in both mutation directions', (): void => {
    const initial: SessionStateV2 = startSessionV2(config(), NOW, SESSION_ID);
    const paused: SessionStateV2 = beginPauseV2(initial, NOW + MINUTE_MS, 5 * MINUTE_MS);
    const initialSnapshot: SessionStateV2 = structuredClone(initial);
    const pausedSnapshot: SessionStateV2 = structuredClone(paused);

    initial.config.rules.sessionBlacklist.push({ kind: 'host', pattern: 'input.example' });
    expect(paused).toEqual(pausedSnapshot);
    paused.config.rules.sessionAllowlist.push({ kind: 'host', pattern: 'output.example' });
    expect(initial.config.rules.sessionAllowlist).toEqual(
      initialSnapshot.config.rules.sessionAllowlist,
    );

    const resumed: SessionStateV2 = commitResumeV2(pausedSnapshot, NOW + 2 * MINUTE_MS);
    const resumedSnapshot: SessionStateV2 = structuredClone(resumed);
    pausedSnapshot.config.rules.sessionBlacklist.push({ kind: 'host', pattern: 'later.example' });
    const mutatedResumeInput: SessionStateV2 = structuredClone(pausedSnapshot);
    expect(resumed).toEqual(resumedSnapshot);
    resumed.config.rules.sessionAllowlist.push({ kind: 'host', pattern: 'reverse.example' });
    expect(pausedSnapshot).toEqual(mutatedResumeInput);
  });
});

describe('assertCanStartNextFocusEarlyV2', (): void => {
  it('requires two minutes without mutating the break', (): void => {
    const onBreak: SessionStateV2 = breakState();
    const snapshot: SessionStateV2 = structuredClone(onBreak);

    expect((): void => assertCanStartNextFocusEarlyV2(onBreak, NOW + 26 * MINUTE_MS)).toThrowError(
      CoreError,
    );
    expect((): void => assertCanStartNextFocusEarlyV2(onBreak, NOW + 27 * MINUTE_MS)).not.toThrow();
    expect(onBreak).toEqual(snapshot);
  });

  it('rejects rollback and exact phase or session boundaries for settlement first', (): void => {
    const onBreak: SessionStateV2 = breakState();

    expect((): void => assertCanStartNextFocusEarlyV2(onBreak, NOW + 24 * MINUTE_MS)).toThrow(
      CoreError,
    );
    expect((): void => assertCanStartNextFocusEarlyV2(onBreak, NOW + 30 * MINUTE_MS)).toThrow(
      CoreError,
    );
    expect((): void =>
      assertCanStartNextFocusEarlyV2(
        { ...onBreak, phaseEndsAt: NOW + 50 * MINUTE_MS },
        NOW + 50 * MINUTE_MS,
      ),
    ).toThrow(CoreError);
  });
});

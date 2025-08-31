import { describe, expect, it } from 'vitest';
import { focusedMsAtV2, startSessionV2 } from '../../../src/core/session-v2';
import { CoreError } from '../../../src/shared/errors';
import { isSessionConfigV2 } from '../../../src/shared/runtime-validation';
import type { SessionConfigV2, SessionStateV2 } from '../../../src/shared/types';
import {
  MANUAL_INDEFINITE_CONFIG,
  MANUAL_TIMED_CONFIG,
  NOW,
  OCCURRENCE,
  SCHEDULED_INDEFINITE_CONFIG,
  SESSION_ID,
} from '../shared/v2-runtime-fixtures';

const MINUTE_MS: number = 60_000;

function cyclingConfig(minutes: number = 50): SessionConfigV2 {
  return {
    ...structuredClone(MANUAL_TIMED_CONFIG),
    duration: { kind: 'timed', minutes },
    cycling: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 },
  };
}

describe('startSessionV2', (): void => {
  it('uses the rounded timed duration for manual and normalized scheduled starts', (): void => {
    const manual: SessionStateV2 = startSessionV2(MANUAL_TIMED_CONFIG, NOW, SESSION_ID);
    const scheduledConfig: SessionConfigV2 = {
      ...structuredClone(MANUAL_TIMED_CONFIG),
      source: 'schedule',
      scheduleOccurrence: structuredClone(OCCURRENCE),
      duration: { kind: 'timed', minutes: 60_001 / MINUTE_MS },
    };
    const scheduled: SessionStateV2 = startSessionV2(scheduledConfig, 0, SESSION_ID);

    expect(manual.sessionEndsAt).toBe(NOW + 25 * MINUTE_MS);
    expect(scheduled.sessionEndsAt).toBe(60_001);
    expect(scheduled.phaseEndsAt).toBe(60_001);
  });

  it('keeps the first focus boundary separate from the fixed 50-minute end', (): void => {
    const state: SessionStateV2 = startSessionV2(cyclingConfig(), NOW, SESSION_ID);

    expect(state.phaseEndsAt).toBe(NOW + 25 * MINUTE_MS);
    expect(state.sessionEndsAt).toBe(NOW + 50 * MINUTE_MS);
  });

  it('starts manual and scheduled until-stopped sessions without finite ends', (): void => {
    const manual: SessionStateV2 = startSessionV2(MANUAL_INDEFINITE_CONFIG, NOW, SESSION_ID);
    const scheduled: SessionStateV2 = startSessionV2(SCHEDULED_INDEFINITE_CONFIG, NOW, SESSION_ID);

    expect(manual.sessionEndsAt).toBeNull();
    expect(manual.phaseEndsAt).toBeNull();
    expect(scheduled.sessionEndsAt).toBeNull();
    expect(scheduled.phaseEndsAt).toBeNull();
  });

  it('accepts until-stopped only through the Flexible non-cycling contract', (): void => {
    const hardConfig: SessionConfigV2 = {
      ...structuredClone(MANUAL_INDEFINITE_CONFIG),
      strictness: 'hard',
    };
    const cycling: SessionConfigV2 = {
      ...structuredClone(MANUAL_INDEFINITE_CONFIG),
      cycling: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 },
    };

    expect(isSessionConfigV2(MANUAL_INDEFINITE_CONFIG)).toBe(true);
    expect(isSessionConfigV2(SCHEDULED_INDEFINITE_CONFIG)).toBe(true);
    expect(isSessionConfigV2(hardConfig)).toBe(false);
    expect(isSessionConfigV2(cycling)).toBe(false);
    expect((): SessionStateV2 => startSessionV2(hardConfig, NOW, SESSION_ID)).toThrow(CoreError);
    expect((): SessionStateV2 => startSessionV2(cycling, NOW, SESSION_ID)).toThrow(CoreError);
  });

  it('returns the complete initial v2 accounting state', (): void => {
    const state: SessionStateV2 = startSessionV2(MANUAL_TIMED_CONFIG, NOW, SESSION_ID);

    expect(state).toMatchObject({
      version: 2,
      sessionId: SESSION_ID,
      startedAt: NOW,
      phase: 'focus',
      phaseStartedAt: NOW,
      cycleIndex: 0,
      pausedFrom: null,
      focusedMs: 0,
    });
  });

  it('detaches rules, domain arrays, cycling, and schedule occurrence from the caller', (): void => {
    const config: SessionConfigV2 = {
      ...cyclingConfig(),
      source: 'schedule',
      scheduleOccurrence: structuredClone(OCCURRENCE),
    };
    const state: SessionStateV2 = startSessionV2(config, NOW, SESSION_ID);
    const returnedSnapshot: SessionConfigV2 = structuredClone(state.config);

    config.rules.sessionAllowlist.push({ kind: 'host', pattern: 'example.com' });
    config.rules.categories.social = !config.rules.categories.social;
    config.rules.exclusions.social?.push('later.example');
    if (config.cycling !== null) config.cycling.focusMin = 40;
    if (config.scheduleOccurrence !== null) config.scheduleOccurrence.entryId = 'changed';

    expect(state.config).toEqual(returnedSnapshot);
  });

  it('rejects unsafe timestamps, durations, endpoints, and focus projections', (): void => {
    const unsafeDuration: SessionConfigV2 = {
      ...structuredClone(MANUAL_TIMED_CONFIG),
      duration: { kind: 'timed', minutes: Number.MAX_SAFE_INTEGER },
    };
    const unsafeFocus: SessionConfigV2 = {
      ...cyclingConfig(),
      cycling: {
        focusMin: Number.MAX_SAFE_INTEGER,
        shortBreakMin: 5,
        longBreakMin: 15,
        longEvery: 4,
      },
    };
    const state: SessionStateV2 = startSessionV2(MANUAL_INDEFINITE_CONFIG, NOW, SESSION_ID);
    const unsafeSettled: SessionStateV2 = { ...state, focusedMs: Number.MAX_SAFE_INTEGER };

    expect((): SessionStateV2 => startSessionV2(MANUAL_TIMED_CONFIG, -1, SESSION_ID)).toThrow(
      CoreError,
    );
    expect((): SessionStateV2 => startSessionV2(MANUAL_TIMED_CONFIG, 0.5, SESSION_ID)).toThrow(
      CoreError,
    );
    expect(
      (): SessionStateV2 =>
        startSessionV2(MANUAL_TIMED_CONFIG, Number.MAX_SAFE_INTEGER, SESSION_ID),
    ).toThrow(CoreError);
    expect((): SessionStateV2 => startSessionV2(unsafeDuration, 0, SESSION_ID)).toThrow(CoreError);
    expect((): SessionStateV2 => startSessionV2(unsafeFocus, 0, SESSION_ID)).toThrow(CoreError);
    expect((): number => focusedMsAtV2(unsafeSettled, NOW + 1)).toThrow(CoreError);
    expect((): number => focusedMsAtV2(state, Number.MAX_SAFE_INTEGER + 1)).toThrow(CoreError);
  });
});

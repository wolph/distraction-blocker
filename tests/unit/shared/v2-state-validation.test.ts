import { describe, expect, it } from 'vitest';
import { isSessionStateV2 } from '../../../src/shared/runtime-validation';
import type { SessionStateV2 } from '../../../src/shared/types';
import {
  MANUAL_INDEFINITE_CONFIG,
  MANUAL_TIMED_CONFIG,
  NOW,
  OCCURRENCE,
  SESSION_ID,
} from './v2-runtime-fixtures';

const TIMED_FOCUS_STATE: SessionStateV2 = {
  version: 2,
  sessionId: SESSION_ID,
  config: MANUAL_TIMED_CONFIG,
  startedAt: NOW,
  sessionEndsAt: NOW + 25 * 60_000,
  phase: 'focus',
  phaseStartedAt: NOW,
  phaseEndsAt: NOW + 25 * 60_000,
  cycleIndex: 0,
  pausedFrom: null,
  focusedMs: 0,
};
const INDEFINITE_FOCUS_STATE: SessionStateV2 = {
  ...TIMED_FOCUS_STATE,
  config: MANUAL_INDEFINITE_CONFIG,
  sessionEndsAt: null,
  phaseEndsAt: null,
};
const INDEFINITE_PAUSED_STATE: SessionStateV2 = {
  ...INDEFINITE_FOCUS_STATE,
  phase: 'paused',
  phaseStartedAt: NOW + 60_000,
  phaseEndsAt: NOW + 6 * 60_000,
  pausedFrom: { phase: 'focus', phaseEndsAt: null },
  focusedMs: 60_000,
};

describe('v2 persisted session state matrix', (): void => {
  it.each([
    TIMED_FOCUS_STATE,
    {
      ...TIMED_FOCUS_STATE,
      config: {
        ...MANUAL_TIMED_CONFIG,
        duration: { kind: 'timed', minutes: 50 },
        cycling: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 },
      },
      sessionEndsAt: NOW + 50 * 60_000,
      phase: 'break',
      phaseStartedAt: NOW + 25 * 60_000,
      phaseEndsAt: NOW + 30 * 60_000,
      cycleIndex: 1,
    },
    {
      ...TIMED_FOCUS_STATE,
      phase: 'paused',
      phaseStartedAt: NOW + 60_000,
      phaseEndsAt: NOW + 6 * 60_000,
      pausedFrom: { phase: 'focus', phaseEndsAt: NOW + 25 * 60_000 },
      focusedMs: 60_000,
    },
    INDEFINITE_FOCUS_STATE,
    INDEFINITE_PAUSED_STATE,
    {
      ...TIMED_FOCUS_STATE,
      config: {
        ...MANUAL_TIMED_CONFIG,
        duration: { kind: 'timed', minutes: 60_001 / 60_000 },
        source: 'schedule',
        scheduleOccurrence: OCCURRENCE,
      },
      startedAt: 0,
      sessionEndsAt: 60_001,
      phaseStartedAt: 0,
      phaseEndsAt: 60_001,
    },
  ])('accepts legal state %#', (value: unknown): void => {
    expect(isSessionStateV2(value)).toBe(true);
  });

  it.each([
    { ...TIMED_FOCUS_STATE, version: 1 },
    { ...TIMED_FOCUS_STATE, sessionId: 'not-a-uuid' },
    { ...TIMED_FOCUS_STATE, sessionEndsAt: null },
    { ...TIMED_FOCUS_STATE, phaseEndsAt: null },
    {
      ...TIMED_FOCUS_STATE,
      config: {
        ...MANUAL_TIMED_CONFIG,
        duration: { kind: 'timed', minutes: 50 },
      },
    },
    {
      ...TIMED_FOCUS_STATE,
      startedAt: Number.MAX_SAFE_INTEGER - 1,
      sessionEndsAt: Number.MAX_SAFE_INTEGER,
      phaseStartedAt: Number.MAX_SAFE_INTEGER - 1,
      phaseEndsAt: Number.MAX_SAFE_INTEGER,
    },
    {
      ...TIMED_FOCUS_STATE,
      config: {
        ...MANUAL_TIMED_CONFIG,
        rules: {
          ...MANUAL_TIMED_CONFIG.rules,
          sessionAllowlist: [{ kind: 'host', pattern: 'HTTPS://Docs.Python.org/guide/' }],
        },
      },
    },
    { ...TIMED_FOCUS_STATE, phaseEndsAt: (TIMED_FOCUS_STATE.sessionEndsAt as number) + 1 },
    { ...TIMED_FOCUS_STATE, pausedFrom: { phase: 'focus', phaseEndsAt: NOW + 1 } },
    { ...TIMED_FOCUS_STATE, phase: 'break' },
    {
      ...TIMED_FOCUS_STATE,
      phase: 'paused',
      phaseStartedAt: NOW + 60_000,
      phaseEndsAt: NOW + 6 * 60_000,
      pausedFrom: { phase: 'focus', phaseEndsAt: NOW + 30_000 },
      focusedMs: 60_000,
    },
    { ...INDEFINITE_FOCUS_STATE, sessionEndsAt: NOW + 1 },
    { ...INDEFINITE_FOCUS_STATE, phaseEndsAt: NOW + 1 },
    { ...INDEFINITE_FOCUS_STATE, phase: 'break' },
    { ...INDEFINITE_PAUSED_STATE, phaseEndsAt: null },
    { ...INDEFINITE_PAUSED_STATE, pausedFrom: null },
    {
      ...INDEFINITE_PAUSED_STATE,
      pausedFrom: { phase: 'break', phaseEndsAt: null },
    },
    {
      ...INDEFINITE_PAUSED_STATE,
      pausedFrom: { phase: 'focus', phaseEndsAt: NOW + 1 },
    },
    { ...INDEFINITE_PAUSED_STATE, focusedMs: Number.POSITIVE_INFINITY },
    { ...INDEFINITE_PAUSED_STATE, extra: true },
  ])('rejects illegal state %#', (value: unknown): void => {
    expect(isSessionStateV2(value)).toBe(false);
  });

  it('rejects mutable accessor boundaries', (): void => {
    const rootAccessor: Record<string, unknown> = { ...TIMED_FOCUS_STATE };
    Object.defineProperty(rootAccessor, 'phase', {
      enumerable: true,
      get: (): string => 'focus',
    });

    const configAccessor: Record<string, unknown> = { ...MANUAL_TIMED_CONFIG };
    Object.defineProperty(configAccessor, 'duration', {
      enumerable: true,
      get: (): SessionStateV2['config']['duration'] => ({ kind: 'timed', minutes: 25 }),
    });

    const pausedFromAccessor: Record<string, unknown> = {
      phase: 'focus',
      phaseEndsAt: null,
    };
    Object.defineProperty(pausedFromAccessor, 'phase', {
      enumerable: true,
      get: (): string => 'focus',
    });

    expect(isSessionStateV2(rootAccessor)).toBe(false);
    expect(isSessionStateV2({ ...TIMED_FOCUS_STATE, config: configAccessor })).toBe(false);
    expect(isSessionStateV2({ ...INDEFINITE_PAUSED_STATE, pausedFrom: pausedFromAccessor })).toBe(
      false,
    );
  });

  it('rejects a stateful nested config accessor', (): void => {
    const cycling: Record<string, unknown> = {
      shortBreakMin: 5,
      longBreakMin: 15,
      longEvery: 4,
    };
    let focusMinReads: number = 0;
    Object.defineProperty(cycling, 'focusMin', {
      enumerable: true,
      get: (): number => {
        focusMinReads += 1;
        return focusMinReads === 1 ? 25 : 0;
      },
    });

    expect(
      isSessionStateV2({
        ...TIMED_FOCUS_STATE,
        config: { ...MANUAL_TIMED_CONFIG, cycling },
      }),
    ).toBe(false);
  });
});

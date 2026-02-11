import { describe, expect, it } from 'vitest';
import { DEFAULT_LISTS, emptySnapshotV2, rulesFromLists } from '../../../src/shared/constants';
import {
  growBank,
  projectedSessionFocusedMsV2,
  remainingPhaseMsV2,
  remainingSessionMsV2,
} from '../../../src/shared/live';
import type { SessionConfigV2, SessionSnapshotV2 } from '../../../src/shared/types';

describe('growBank', (): void => {
  const BANK_MS: number = 6_000;
  const ACCRUAL: number = 0.5;
  const CAP_MS: number = 10_000;
  const CAPTURED_AT: number = 1_000;

  it('grows the bank at the accrual rate, clamped to the cap', (): void => {
    expect(growBank(BANK_MS, ACCRUAL, CAP_MS, CAPTURED_AT, 5_000)).toBe(8_000);
    expect(growBank(BANK_MS, ACCRUAL, CAP_MS, CAPTURED_AT, 60_000)).toBe(CAP_MS);
  });

  it('never shrinks the bank for a time before the capture', (): void => {
    expect(growBank(BANK_MS, ACCRUAL, CAP_MS, CAPTURED_AT, 0)).toBe(BANK_MS);
    expect(growBank(BANK_MS, ACCRUAL, CAP_MS, CAPTURED_AT, CAPTURED_AT)).toBe(BANK_MS);
  });

  it('returns the captured value when nothing accrues', (): void => {
    expect(growBank(BANK_MS, 0, CAP_MS, CAPTURED_AT, 60_000)).toBe(BANK_MS);
  });
});

const v2Config: SessionConfigV2 = {
  mode: 'blacklist',
  strictness: 'flexible',
  duration: { kind: 'until-stopped' },
  cycling: null,
  intention: '',
  source: 'manual',
  scheduleOccurrence: null,
  rules: rulesFromLists(DEFAULT_LISTS),
};

const v2Snap: SessionSnapshotV2 = {
  ...emptySnapshotV2(10_000),
  lifecycle: {
    kind: 'active',
    endAuthority: { kind: 'immediate', actionLabel: 'End session' },
  },
  phase: 'focus',
  config: v2Config,
  startedAt: 1_000,
  phaseStartedAt: 1_000,
  phaseEndsAt: null,
  sessionEndsAt: null,
  sessionFocusedMs: 9_000,
  bankAccrualPerMs: 0.5,
};

describe('v2 live clock projection', (): void => {
  it('distinguishes no fixed end from a zero countdown', (): void => {
    expect(remainingPhaseMsV2(v2Snap, 20_000)).toBeNull();
    expect(remainingSessionMsV2(v2Snap, 20_000)).toBeNull();
    const timed: SessionSnapshotV2 = {
      ...v2Snap,
      config: { ...v2Config, duration: { kind: 'timed', minutes: 1 } },
      phaseEndsAt: 60_000,
      sessionEndsAt: 60_000,
    };
    expect(remainingPhaseMsV2(timed, 70_000)).toBe(0);
    expect(remainingSessionMsV2(timed, 70_000)).toBe(0);
  });

  it('adds focus only after the settled snapshot timestamp', (): void => {
    expect(projectedSessionFocusedMsV2(v2Snap, 15_000)).toBe(14_000);
    expect(projectedSessionFocusedMsV2(v2Snap, 5_000)).toBe(9_000);
  });

  it('uses the supplied current time for finite countdowns', (): void => {
    const timed: SessionSnapshotV2 = {
      ...v2Snap,
      config: { ...v2Config, duration: { kind: 'timed', minutes: 1 } },
      phaseEndsAt: 60_000,
      sessionEndsAt: 70_000,
    };
    expect(remainingPhaseMsV2(timed, 5_000)).toBe(55_000);
    expect(remainingSessionMsV2(timed, 5_000)).toBe(65_000);
  });

  it('caps timed focus at both phase and session ends', (): void => {
    const phaseFirst: SessionSnapshotV2 = {
      ...v2Snap,
      config: { ...v2Config, duration: { kind: 'timed', minutes: 1 } },
      phaseEndsAt: 14_000,
      sessionEndsAt: 15_000,
    };
    const sessionFirst: SessionSnapshotV2 = {
      ...phaseFirst,
      phaseEndsAt: 16_000,
      sessionEndsAt: 13_000,
    };
    expect(projectedSessionFocusedMsV2(phaseFirst, 20_000)).toBe(13_000);
    expect(projectedSessionFocusedMsV2(sessionFirst, 20_000)).toBe(12_000);
  });

  it.each(['idle', 'paused', 'break'] as const)(
    'adds no focus in %s',
    (phase: 'idle' | 'paused' | 'break'): void => {
      let snapshot: SessionSnapshotV2;
      if (phase === 'idle') {
        snapshot = emptySnapshotV2(10_000);
      } else if (phase === 'paused') {
        snapshot = {
          ...v2Snap,
          phase: 'paused',
          phaseEndsAt: 20_000,
          bankAccrualPerMs: 0,
        };
      } else {
        snapshot = {
          ...v2Snap,
          phase: 'break',
          config: {
            ...v2Config,
            duration: { kind: 'timed', minutes: 1 },
            cycling: {
              focusMin: 0.25,
              shortBreakMin: 0.05,
              longBreakMin: 0.1,
              longEvery: 4,
            },
          },
          phaseEndsAt: 20_000,
          sessionEndsAt: 60_000,
          bankAccrualPerMs: 0,
        };
      }
      expect(projectedSessionFocusedMsV2(snapshot, 15_000)).toBe(phase === 'idle' ? 0 : 9_000);
    },
  );

  it('adds no focus for a non-active lifecycle carrying stale focus fields', (): void => {
    const stale: SessionSnapshotV2 = {
      ...v2Snap,
      lifecycle: {
        kind: 'error',
        code: 'transition-cleanup-failed',
        retryAvailable: true,
        endAuthority: { kind: 'hidden' },
      },
    };
    expect(projectedSessionFocusedMsV2(stale, 15_000)).toBe(9_000);
  });
});

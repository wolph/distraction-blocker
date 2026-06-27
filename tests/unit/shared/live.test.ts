import { describe, expect, it } from 'vitest';
import { emptySnapshot } from '../../../src/shared/constants';
import { extrapolatedBank, phaseProgress, remainingPhaseMs } from '../../../src/shared/live';
import type { SessionSnapshot } from '../../../src/shared/types';

const snap: SessionSnapshot = {
  ...emptySnapshot(1_000),
  phase: 'focus',
  phaseStartedAt: 0,
  phaseEndsAt: 11_000,
  bankMs: 6_000,
  bankAccrualPerMs: 0.5,
  bankCapMs: 10_000,
};

describe('live extrapolation', () => {
  it('counts down the phase and clamps at zero', () => {
    expect(remainingPhaseMs(snap, 6_000)).toBe(5_000);
    expect(remainingPhaseMs(snap, 20_000)).toBe(0);
  });
  it('grows the bank at the accrual rate, clamped to the cap', () => {
    expect(extrapolatedBank(snap, 5_000)).toBe(8_000);
    expect(extrapolatedBank(snap, 60_000)).toBe(10_000);
  });
  it('continues accrual without deadlines and keeps its progress finite', (): void => {
    const indefinite: SessionSnapshot = { ...snap, phaseEndsAt: null, sessionEndsAt: null };
    expect(extrapolatedBank(indefinite, 5_000)).toBe(8_000);
    expect(extrapolatedBank(indefinite, 60_000)).toBe(10_000);
    expect(phaseProgress(indefinite, 60_000)).toBe(0);
  });
  it('reports phase progress in [0, 1]', () => {
    expect(phaseProgress(snap, 5_500)).toBeCloseTo(0.5);
    expect(
      phaseProgress({ ...snap, phase: 'idle', phaseStartedAt: null, phaseEndsAt: null }, 5),
    ).toBe(0);
  });
});

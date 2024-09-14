import type { SessionSnapshot } from './types';

export function remainingPhaseMs(snap: SessionSnapshot, nowMs: number): number {
  if (snap.phaseEndsAt === null) return 0;
  return Math.max(0, snap.phaseEndsAt - nowMs);
}

export function extrapolatedBank(snap: SessionSnapshot, nowMs: number): number {
  const grown: number = snap.bankMs + Math.max(0, nowMs - snap.at) * snap.bankAccrualPerMs;
  return Math.min(snap.bankCapMs, grown);
}

export function phaseProgress(snap: SessionSnapshot, nowMs: number): number {
  if (snap.phaseStartedAt === null || snap.phaseEndsAt === null) return 0;
  const span: number = snap.phaseEndsAt - snap.phaseStartedAt;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (nowMs - snap.phaseStartedAt) / span));
}

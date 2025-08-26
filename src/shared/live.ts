import type { SessionSnapshot, SessionSnapshotV2 } from './types';

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

function settledNow(snap: SessionSnapshotV2, nowMs: number): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < snap.at) return snap.at;
  return nowMs;
}

export function remainingPhaseMsV2(snap: SessionSnapshotV2, nowMs: number): number | null {
  if (snap.phaseEndsAt === null) return null;
  return Math.max(0, snap.phaseEndsAt - settledNow(snap, nowMs));
}

export function remainingSessionMsV2(snap: SessionSnapshotV2, nowMs: number): number | null {
  if (snap.sessionEndsAt === null) return null;
  return Math.max(0, snap.sessionEndsAt - settledNow(snap, nowMs));
}

export function projectedSessionFocusedMsV2(snap: SessionSnapshotV2, nowMs: number): number {
  if (snap.lifecycle.kind !== 'active' || snap.phase !== 'focus') {
    return snap.sessionFocusedMs;
  }
  const projectionStart: number = Math.max(snap.at, snap.phaseStartedAt ?? snap.at);
  let projectionEnd: number = Math.max(projectionStart, settledNow(snap, nowMs));
  if (snap.phaseEndsAt !== null) projectionEnd = Math.min(projectionEnd, snap.phaseEndsAt);
  if (snap.sessionEndsAt !== null) projectionEnd = Math.min(projectionEnd, snap.sessionEndsAt);
  return snap.sessionFocusedMs + Math.max(0, projectionEnd - projectionStart);
}

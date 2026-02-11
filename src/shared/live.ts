import type { SessionSnapshotV2 } from './types';

/**
 * The pause bank grown from the moment it was captured to `nowMs`, capped. Shape-free on
 * purpose: the popup grows it from a snapshot and the blocked page grows it from a frozen
 * overlay view, and one arithmetic rule serves both without either learning the other's type.
 * A `nowMs` before the capture never shrinks the bank, so a snapshot that arrives late reads
 * as the value it was captured with rather than as a smaller one.
 */
export function growBank(
  bankMs: number,
  accrualPerMs: number,
  capMs: number,
  capturedAt: number,
  nowMs: number,
): number {
  return Math.min(capMs, bankMs + Math.max(0, nowMs - capturedAt) * accrualPerMs);
}

export function remainingPhaseMsV2(snap: SessionSnapshotV2, nowMs: number): number | null {
  if (snap.phaseEndsAt === null) return null;
  return Math.max(0, snap.phaseEndsAt - nowMs);
}

export function remainingSessionMsV2(snap: SessionSnapshotV2, nowMs: number): number | null {
  if (snap.sessionEndsAt === null) return null;
  return Math.max(0, snap.sessionEndsAt - nowMs);
}

export function projectedSessionFocusedMsV2(snap: SessionSnapshotV2, nowMs: number): number {
  if (snap.lifecycle.kind !== 'active' || snap.phase !== 'focus') {
    return snap.sessionFocusedMs;
  }
  const projectionStart: number = Math.max(snap.at, snap.phaseStartedAt ?? snap.at);
  let projectionEnd: number = Math.max(projectionStart, nowMs);
  if (snap.phaseEndsAt !== null) projectionEnd = Math.min(projectionEnd, snap.phaseEndsAt);
  if (snap.sessionEndsAt !== null) projectionEnd = Math.min(projectionEnd, snap.sessionEndsAt);
  return snap.sessionFocusedMs + Math.max(0, projectionEnd - projectionStart);
}

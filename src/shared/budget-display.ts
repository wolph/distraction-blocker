import { extrapolatedBank } from './live';
import { formatClock } from './time';
import type { SessionSnapshot } from './types';

export interface AccessAvailability {
  affordable: boolean;
  waitMs: number | null;
  message: string | null;
}

/** Describe when this spend becomes affordable within the current focus block. */
export function accessAvailability(
  snapshot: SessionSnapshot,
  now: number,
  costMs: number,
): AccessAvailability {
  const endsAt: number = Math.min(snapshot.phaseEndsAt ?? now, snapshot.sessionEndsAt ?? now);
  if (now >= endsAt) return { affordable: false, waitMs: null, message: 'Updating session' };
  const bank: number = extrapolatedBank(snapshot, Math.min(now, endsAt));
  if (bank >= costMs) return { affordable: true, waitMs: 0, message: null };
  const unavailable: (message: string) => AccessAvailability = (
    message: string,
  ): AccessAvailability => ({ affordable: false, waitMs: null, message });
  if (costMs > snapshot.bankCapMs) return unavailable('Cost exceeds the credit limit');
  if (snapshot.phase !== 'focus') return unavailable('Credit earning resumes during focus');
  if (snapshot.bankAccrualPerMs <= 0) return unavailable('Credit earning is turned off');
  const rawWait: number = (costMs - bank) / snapshot.bankAccrualPerMs;
  if (!Number.isFinite(rawWait) || rawWait >= Math.max(0, endsAt - now)) {
    return unavailable('Not enough time in this focus block');
  }
  const waitMs: number = Math.ceil(rawWait / 1_000) * 1_000;
  return { affordable: false, waitMs, message: `Ready in ${formatClock(waitMs)}` };
}

/** Focus time needed for the bank to reach its next whole pause minute. */
export function msUntilNextEarnedMinute(
  bankMs: number,
  accrualPerMs: number,
  capMs: number,
): number | null {
  if (
    !Number.isFinite(bankMs) ||
    !Number.isFinite(accrualPerMs) ||
    !Number.isFinite(capMs) ||
    accrualPerMs <= 0 ||
    capMs < 0
  ) {
    return null;
  }
  const balanceMs: number = Math.max(0, bankMs);
  const remainderMs: number = balanceMs % 60_000;
  const pauseMsNeeded: number = remainderMs === 0 ? 60_000 : 60_000 - remainderMs;
  if (balanceMs + pauseMsNeeded > capMs) return null;
  const focusMsNeeded: number = pauseMsNeeded / accrualPerMs;
  if (!Number.isFinite(focusMsNeeded)) return null;
  const roundedMs: number = Math.ceil(focusMsNeeded / 1_000) * 1_000;
  return Number.isFinite(roundedMs) ? roundedMs : null;
}

import { CoreError } from '../shared/errors';
import type { BankState, PauseEconomy } from '../shared/types';

export function accrue(bank: BankState, focusMsDelta: number, eco: PauseEconomy): BankState {
  const earned: number = Math.max(0, focusMsDelta) * eco.earnRatio;
  return { balanceMs: Math.min(eco.capMs, bank.balanceMs + earned) };
}

/** Throws CoreError('insufficient-budget'). */
export function spend(bank: BankState, ms: number): BankState {
  if (ms > bank.balanceMs) {
    throw new CoreError('insufficient-budget', 'not enough pause budget banked');
  }
  return { balanceMs: bank.balanceMs - ms };
}

/** ms of continued focus until costMs is affordable, 0 when affordable now. */
export function msUntilAffordable(bank: BankState, costMs: number, eco: PauseEconomy): number {
  if (bank.balanceMs >= costMs) return 0;
  return Math.ceil((costMs - bank.balanceMs) / eco.earnRatio);
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

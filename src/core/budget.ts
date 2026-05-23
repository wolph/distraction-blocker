import { CoreError } from '../shared/errors';
import type { BankState, PauseEconomy } from '../shared/types';

export { msUntilNextEarnedMinute } from '../shared/budget-display';

export function accrue(bank: BankState, focusMsDelta: number, eco: PauseEconomy): BankState {
  const earned: number = Math.max(0, focusMsDelta) * eco.earnRatio;
  return { balanceMs: Math.min(eco.capMs, bank.balanceMs + earned) };
}

/** Throws CoreError('insufficient-budget'). */
export function spend(bank: BankState, ms: number): BankState {
  if (ms > bank.balanceMs) {
    throw new CoreError('insufficient-budget', 'not enough site access credit');
  }
  return { balanceMs: bank.balanceMs - ms };
}

/** ms of continued focus until costMs is affordable, 0 when affordable now. */
export function msUntilAffordable(bank: BankState, costMs: number, eco: PauseEconomy): number {
  if (bank.balanceMs >= costMs) return 0;
  return Math.ceil((costMs - bank.balanceMs) / eco.earnRatio);
}

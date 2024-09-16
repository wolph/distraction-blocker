import type { BankState, PauseEconomy } from '../shared/types';

export function accrue(bank: BankState, focusMsDelta: number, eco: PauseEconomy): BankState {
  throw new Error('not implemented, plan 02');
}

/** Throws CoreError('insufficient-budget'). */
export function spend(bank: BankState, ms: number): BankState {
  throw new Error('not implemented, plan 02');
}

/** ms of continued focus until costMs is affordable, 0 when affordable now. */
export function msUntilAffordable(bank: BankState, costMs: number, eco: PauseEconomy): number {
  throw new Error('not implemented, plan 02');
}

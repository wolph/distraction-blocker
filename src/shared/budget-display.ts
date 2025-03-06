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

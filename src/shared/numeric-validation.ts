export const MINUTE_MS: number = 60_000;
export const DAY_MS: number = 86_400_000;
export const DATE_MAX_MS: number = 8_640_000_000_000_000;
export const MAX_RELATIVE_DURATION_MS: number = DATE_MAX_MS / 2;
export const MIN_RELATIVE_MINUTES: number = 0.5 / MINUTE_MS;
export const MAX_RELATIVE_MINUTES: number = MAX_RELATIVE_DURATION_MS / MINUTE_MS;
export const MAX_SAFE_DAY_COUNT: number = Math.min(
  Math.floor(Number.MAX_SAFE_INTEGER / DAY_MS),
  Math.floor(DATE_MAX_MS / DAY_MS),
);

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isPositiveMinuteValue(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return false;
  const milliseconds: number = Math.round(value * MINUTE_MS);
  return milliseconds > 0 && Number.isSafeInteger(milliseconds);
}

export function isRelativeMillisecondDuration(value: unknown, allowZero: boolean): value is number {
  if (!isNonNegativeInteger(value) || (!allowZero && value === 0)) return false;
  return value <= MAX_RELATIVE_DURATION_MS;
}

export function isRelativeMinuteDuration(value: unknown): value is number {
  if (!isPositiveMinuteValue(value)) return false;
  return isRelativeMillisecondDuration(Math.round(value * MINUTE_MS), false);
}

export function isSafeDayCount(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return false;
  const milliseconds: number = value * DAY_MS;
  return Number.isSafeInteger(milliseconds) && milliseconds <= DATE_MAX_MS;
}

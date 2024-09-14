import { describe, expect, it } from 'vitest';
import {
  formatBadge,
  formatClock,
  localDateStr,
  localMonthStr,
  minToMs,
} from '../../../src/shared/time';

describe('formatBadge', () => {
  it('shows hours and minutes above one hour', () => {
    expect(formatBadge(65 * 60_000)).toBe('1h05');
    expect(formatBadge(2 * 3600_000)).toBe('2h00');
  });
  it('shows minutes below one hour, rounding up so 0:59 left reads 1m', () => {
    expect(formatBadge(25 * 60_000)).toBe('25m');
    expect(formatBadge(59_000)).toBe('1m');
  });
  it('never goes negative', () => {
    expect(formatBadge(-5)).toBe('0m');
  });
});

describe('formatClock', () => {
  it('renders m:ss and h:mm:ss', () => {
    expect(formatClock(83_000)).toBe('1:23');
    expect(formatClock(3_723_000)).toBe('1:02:03');
    expect(formatClock(0)).toBe('0:00');
  });
});

describe('local date helpers', () => {
  it('formats local date and month', () => {
    const at: number = new Date(2026, 7, 28, 14, 0, 0).getTime();
    expect(localDateStr(at)).toBe('2026-08-28');
    expect(localMonthStr(at)).toBe('2026-08');
  });
});

describe('minToMs', () => {
  it('converts fractional minutes', () => {
    expect(minToMs(0.1)).toBe(6_000);
  });
});

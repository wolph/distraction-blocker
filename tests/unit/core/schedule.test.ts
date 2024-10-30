import { describe, expect, it } from 'vitest';
import { activeEntry, nextStart, validateEntry, windowEnd } from '../../../src/core/schedule';
import type { ScheduleEntry } from '../../../src/shared/types';

function entry(partial: Partial<ScheduleEntry>): ScheduleEntry {
  return {
    id: 'e1',
    days: [1, 2, 3, 4, 5],
    start: '09:00',
    end: '12:30',
    mode: 'blacklist',
    strictness: 'hard',
    cycling: null,
    intention: 'morning deep work',
    enabled: true,
    ...partial,
  };
}

// 2026-08-28 is a Friday (day 5), 2026-08-30 a Sunday.
const friday1000 = new Date(2026, 7, 28, 10, 0);
const friday1300 = new Date(2026, 7, 28, 13, 0);
const sunday1000 = new Date(2026, 7, 30, 10, 0);

describe('activeEntry', () => {
  it('matches day and window, end exclusive', () => {
    expect(activeEntry([entry({})], friday1000)?.id).toBe('e1');
    expect(activeEntry([entry({})], friday1300)).toBeNull();
    expect(activeEntry([entry({})], sunday1000)).toBeNull();
    expect(activeEntry([entry({ enabled: false })], friday1000)).toBeNull();
    expect(activeEntry([entry({})], new Date(2026, 7, 28, 12, 30))).toBeNull();
  });
});

describe('windowEnd', () => {
  it('returns the end as an absolute local Date', () => {
    expect(windowEnd(entry({}), friday1000).getTime()).toBe(
      new Date(2026, 7, 28, 12, 30).getTime(),
    );
  });
});

describe('nextStart', () => {
  it('finds later today, next matching day, and null with nothing enabled', () => {
    const at = new Date(2026, 7, 28, 8, 0);
    expect(nextStart([entry({})], at)?.startsAt.getTime()).toBe(
      new Date(2026, 7, 28, 9, 0).getTime(),
    );
    expect(nextStart([entry({})], friday1300)?.startsAt.getTime()).toBe(
      new Date(2026, 7, 31, 9, 0).getTime(),
    );
    expect(nextStart([entry({ enabled: false })], at)).toBeNull();
  });
});

describe('validateEntry', () => {
  it('rejects bad times, inverted windows, empty days', () => {
    expect(validateEntry(entry({}))).toBeNull();
    expect(validateEntry(entry({ start: '9am' }))).toMatch(/time/i);
    expect(validateEntry(entry({ start: '13:00', end: '09:00' }))).toMatch(/before/i);
    expect(validateEntry(entry({ days: [] }))).toMatch(/day/i);
  });
});

import { describe, expect, it } from 'vitest';
import {
  activeEntry,
  scheduleEntriesOverlap,
  validateEntry,
  windowEnd,
} from '../../../src/core/schedule';
import type { NormalizedScheduleEntryV1 } from '../../../src/shared/types';
import { isTimezoneChild, runSuiteInTimezone } from '../timezone-child';

const DST_CHILD_FLAG: string = 'FOCUS_LOCK_AMSTERDAM_DST_CHILD';
const isAmsterdamChild: boolean = isTimezoneChild(DST_CHILD_FLAG);

function entry(partial: Partial<NormalizedScheduleEntryV1>): NormalizedScheduleEntryV1 {
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

describe('validateEntry', () => {
  it('rejects bad times, inverted windows, empty days', () => {
    expect(validateEntry(entry({}))).toBeNull();
    expect(validateEntry(entry({ start: '9am' }))).toMatch(/time/i);
    expect(validateEntry(entry({ start: '13:00', end: '09:00' }))).toMatch(/before/i);
    expect(validateEntry(entry({ days: [] }))).toMatch(/day/i);
  });
});

describe('scheduleEntriesOverlap', (): void => {
  it('matches enabled shared-day half-open schedule windows', (): void => {
    const first: NormalizedScheduleEntryV1 = entry({
      id: 'first',
      days: [1],
      start: '09:00',
      end: '12:00',
    });
    expect(
      scheduleEntriesOverlap(
        first,
        entry({ id: 'overlap', days: [1], start: '11:00', end: '13:00' }),
      ),
    ).toBe(true);
    expect(
      scheduleEntriesOverlap(
        first,
        entry({ id: 'adjacent', days: [1], start: '12:00', end: '13:00' }),
      ),
    ).toBe(false);
    expect(
      scheduleEntriesOverlap(
        first,
        entry({ id: 'other-day', days: [2], start: '11:00', end: '13:00' }),
      ),
    ).toBe(false);
    expect(
      scheduleEntriesOverlap(
        first,
        entry({ id: 'disabled', days: [1], start: '11:00', end: '13:00', enabled: false }),
      ),
    ).toBe(false);
    expect(scheduleEntriesOverlap(first, entry({ id: 'first' }))).toBe(false);
  });
});

describe.runIf(!isAmsterdamChild)('schedule timezone isolation', () => {
  it('passes the DST cases in a Europe/Amsterdam child process', () => {
    expect((): string =>
      runSuiteInTimezone('Europe/Amsterdam', DST_CHILD_FLAG, import.meta.url),
    ).not.toThrow();
  });
});

describe.runIf(isAmsterdamChild)('Europe/Amsterdam DST schedule evaluation', () => {
  it('keeps the spring start and end on their configured wall-clock times', () => {
    const sundayEntry: NormalizedScheduleEntryV1 = entry({
      days: [0],
      start: '03:30',
      end: '04:30',
    });
    const duringWindow: Date = new Date(2026, 2, 29, 3, 45);

    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Europe/Amsterdam');
    expect(activeEntry([sundayEntry], duringWindow)?.id).toBe('e1');
    expect(windowEnd(sundayEntry, duringWindow).toISOString()).toBe('2026-03-29T02:30:00.000Z');
  });

  it('keeps the autumn start and end on their configured wall-clock times', () => {
    const sundayEntry: NormalizedScheduleEntryV1 = entry({
      days: [0],
      start: '09:00',
      end: '10:00',
    });
    const duringWindow: Date = new Date(2026, 9, 25, 9, 30);

    expect(activeEntry([sundayEntry], duringWindow)?.id).toBe('e1');
    expect(windowEnd(sundayEntry, duringWindow).toISOString()).toBe('2026-10-25T09:00:00.000Z');
  });
});

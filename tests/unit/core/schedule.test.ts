import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { activeEntry, nextStart, validateEntry, windowEnd } from '../../../src/core/schedule';
import type { ScheduleEntry } from '../../../src/shared/types';

const DST_CHILD_FLAG = 'FOCUS_LOCK_AMSTERDAM_DST_CHILD';
const isAmsterdamChild: boolean = process.env[DST_CHILD_FLAG] === '1';

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

describe.runIf(!isAmsterdamChild)('schedule timezone isolation', () => {
  it('passes the DST cases in a Europe/Amsterdam child process', () => {
    const vitestPath: string = fileURLToPath(
      new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url),
    );
    const testPath: string = fileURLToPath(import.meta.url);

    expect((): void => {
      execFileSync(process.execPath, [vitestPath, 'run', testPath], {
        env: { ...process.env, TZ: 'Europe/Amsterdam', [DST_CHILD_FLAG]: '1' },
        stdio: 'pipe',
      });
    }).not.toThrow();
  });
});

describe.runIf(isAmsterdamChild)('Europe/Amsterdam DST schedule evaluation', () => {
  it('keeps the spring start and end on their configured wall-clock times', () => {
    const sundayEntry: ScheduleEntry = entry({ days: [0], start: '03:30', end: '04:30' });
    const beforeTransition: Date = new Date(2026, 2, 28, 12, 0);
    const duringWindow: Date = new Date(2026, 2, 29, 3, 45);
    const found: ReturnType<typeof nextStart> = nextStart([sundayEntry], beforeTransition);

    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Europe/Amsterdam');
    expect(found?.startsAt.toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(activeEntry([sundayEntry], duringWindow)?.id).toBe('e1');
    expect(windowEnd(sundayEntry, duringWindow).toISOString()).toBe('2026-03-29T02:30:00.000Z');
  });

  it('keeps the autumn start and end on their configured wall-clock times', () => {
    const sundayEntry: ScheduleEntry = entry({ days: [0], start: '09:00', end: '10:00' });
    const beforeTransition: Date = new Date(2026, 9, 24, 12, 0);
    const duringWindow: Date = new Date(2026, 9, 25, 9, 30);
    const found: ReturnType<typeof nextStart> = nextStart([sundayEntry], beforeTransition);

    expect(found?.startsAt.toISOString()).toBe('2026-10-25T08:00:00.000Z');
    expect(activeEntry([sundayEntry], duringWindow)?.id).toBe('e1');
    expect(windowEnd(sundayEntry, duringWindow).toISOString()).toBe('2026-10-25T09:00:00.000Z');
  });
});

/** @vitest-environment jsdom */
import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import type { StatsBundle } from '../../../src/shared/messages';
import type { DailyAgg, EventRecord } from '../../../src/shared/types';
import { attemptsByHour, Charts, topSites } from '../../../src/stats/Charts';
import { BarChart } from '../../../src/stats/charts/BarChart';
import { HBarChart } from '../../../src/stats/charts/HBarChart';

afterEach(cleanup);

const NOW: number = new Date(2026, 7, 28, 14, 0, 0).getTime();

function day(date: string, overrides: Partial<DailyAgg>): DailyAgg {
  return {
    date,
    focusMs: 0,
    sessionsStarted: 0,
    sessionsCompleted: 0,
    attempts: {},
    attemptsOther: 0,
    pausesTaken: 0,
    pauseMsSpent: 0,
    unlocksTaken: 0,
    resisted: 0,
    ...overrides,
  };
}

function bundleWith(days: DailyAgg[]): StatsBundle {
  return {
    days,
    months: [],
    streak: {
      current: 0,
      freezeTokens: 0,
      lastCountedDate: null,
      lastFreezeGrantDate: null,
      activeDays: [],
      activeMonth: '2026-08',
    },
    recentSessions: [],
    totals: { focusMsToday: 0, focusMsWeek: 0, attemptsToday: 0, resistedToday: 0 },
  };
}

describe('BarChart', () => {
  it('renders one mark per datum with proportional heights', () => {
    const { container } = render(
      <BarChart
        data={[
          { label: 'a', value: 10 },
          { label: 'b', value: 20 },
          { label: 'c', value: 0 },
        ]}
        format={(v: number): string => `${v} m`}
      />,
    );
    const marks: Element[] = Array.from(container.querySelectorAll('.bar-mark'));
    expect(marks.length).toBe(3);
    const heights: number[] = marks.map((m: Element): number =>
      Number(m.getAttribute('data-h') ?? '-1'),
    );
    expect(heights[2]).toBe(0);
    expect((heights[1] ?? 0) / (heights[0] ?? 1)).toBeCloseTo(2, 5);
  });

  it('renders the quiet empty line for empty and all-zero data', () => {
    const empty = render(<BarChart data={[]} format={(v: number): string => String(v)} />);
    expect(empty.container.textContent).toContain('No data yet.');
    const zeros = render(
      <BarChart
        data={[
          { label: 'a', value: 0 },
          { label: 'b', value: 0 },
        ]}
        format={(v: number): string => String(v)}
      />,
    );
    expect(zeros.container.querySelectorAll('.bar-mark').length).toBe(0);
    expect(zeros.container.textContent).toContain('No data yet.');
  });
});

describe('HBarChart', () => {
  it('renders one row per datum with the formatted value at the tip', () => {
    const { container } = render(
      <HBarChart
        data={[
          { label: 'facebook.com', value: 12 },
          { label: 'youtube.com', value: 4 },
        ]}
        format={(v: number): string => String(v)}
      />,
    );
    expect(container.querySelectorAll('.hbar-mark').length).toBe(2);
    expect(container.textContent).toContain('facebook.com');
    expect(container.textContent).toContain('12');
  });

  it('renders the quiet empty line with no data', () => {
    const { container } = render(<HBarChart data={[]} format={(v: number): string => String(v)} />);
    expect(container.textContent).toContain('No data yet.');
  });
});

describe('topSites', () => {
  it('merges attempts across days, caps at ten sites plus other', () => {
    const hosts: Record<string, number> = {};
    for (let i = 0; i < 12; i += 1) hosts[`site${i}.com`] = 12 - i;
    const bundle: StatsBundle = bundleWith([
      day('2026-08-27', { attempts: hosts, attemptsOther: 3 }),
      day('2026-08-28', { attempts: { 'site0.com': 5 }, attemptsOther: 1 }),
    ]);
    const rows: Array<{ label: string; value: number }> = topSites(bundle);
    expect(rows.length).toBe(11);
    expect(rows[0]).toEqual({ label: 'site0.com', value: 17 });
    const other: { label: string; value: number } | undefined = rows[10];
    // two hosts past the top ten (2 + 1) plus attemptsOther (3 + 1)
    expect(other).toEqual({ label: 'other', value: 7 });
  });
});

describe('attemptsByHour', () => {
  it('buckets attempt events by local hour and ignores other events', () => {
    const at = (hour: number): number => new Date(2026, 7, 28, hour, 30, 0).getTime();
    const events: EventRecord[] = [
      {
        t: 'attempt',
        at: at(9),
        url: 'https://x.com/',
        host: 'x.com',
        tabId: 1,
        kind: 'navigation',
      },
      { t: 'attempt', at: at(9), url: 'https://x.com/', host: 'x.com', tabId: 1, kind: 'existing' },
      {
        t: 'attempt',
        at: at(14),
        url: 'https://y.com/',
        host: 'y.com',
        tabId: 2,
        kind: 'navigation',
      },
      { t: 'sessionCompleted', at: at(15), focusedMs: 0 },
    ];
    const buckets: number[] = attemptsByHour(events);
    expect(buckets.length).toBe(24);
    expect(buckets[9]).toBe(2);
    expect(buckets[14]).toBe(1);
    expect(buckets.reduce((a: number, b: number): number => a + b, 0)).toBe(3);
  });
});

describe('Charts', () => {
  it('renders the four chart sections and the local-only caption', () => {
    const bundle: StatsBundle = bundleWith([
      day('2026-08-28', { focusMs: 30 * 60_000, attempts: { 'x.com': 2 } }),
    ]);
    const { container } = render(<Charts bundle={bundle} events={[]} now={NOW} />);
    const text: string = container.textContent ?? '';
    expect(text).toContain('Focus minutes per day');
    expect(text).toContain('Blocked attempts per day');
    expect(text).toContain('Top blocked sites');
    expect(text).toContain('Attempts by hour of day');
    expect(text).toContain('this machine only');
  });
});

/** @vitest-environment jsdom */
import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import type { StatsBundle } from '../../../src/shared/messages';
import type { DailyAgg, PauseEconomy, StreakState } from '../../../src/shared/types';
import { formatDuration } from '../../../src/stats/format';
import { Streak } from '../../../src/stats/Streak';
import { Tiles } from '../../../src/stats/Tiles';

const NOW: number = new Date(2026, 7, 28, 14, 0, 0).getTime();

const ECONOMY: PauseEconomy = {
  earnRatio: 5 / 30,
  capMs: 30 * 60_000,
  pauseMs: 5 * 60_000,
  unlockMs: 5 * 60_000,
};

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
    pauseMsEarned: 0,
    unlocksTaken: 0,
    unlockMsSpent: 0,
    resisted: 0,
    ...overrides,
  };
}

const STREAK: StreakState = {
  current: 4,
  freezeTokens: 2,
  lastCountedDate: '2026-08-28',
  lastFreezeGrantDate: '2026-08-24',
  activeDays: [25, 26, 27, 28],
  activeMonth: '2026-08',
};

const BUNDLE: StatsBundle = {
  days: [
    day('2026-08-27', { focusMs: 50 * 60_000, sessionsStarted: 1, sessionsCompleted: 1 }),
    day('2026-08-28', {
      focusMs: 65 * 60_000,
      sessionsStarted: 2,
      sessionsCompleted: 1,
      attempts: { 'facebook.com': 3, 'youtube.com': 2 },
      attemptsOther: 1,
      pausesTaken: 1,
      pauseMsSpent: 5 * 60_000,
      pauseMsEarned: 17 * 60_000,
      unlocksTaken: 1,
      unlockMsSpent: 2 * 60_000,
      resisted: 2,
    }),
  ],
  months: [],
  streak: STREAK,
  recentSessions: [],
  totals: {
    focusMsToday: 65 * 60_000,
    focusMsWeek: 115 * 60_000,
    attemptsToday: 6,
    resistedToday: 2,
  },
};

const EMPTY: StatsBundle = {
  days: [],
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

afterEach(cleanup);

function tileValue(container: Element, label: string): string {
  const labels: Element[] = Array.from(container.querySelectorAll('.tile-label'));
  const match: Element | undefined = labels.find(
    (el: Element): boolean => el.textContent === label,
  );
  if (match === undefined) throw new Error(`no tile labeled ${label}`);
  const value: Element | null = match.parentElement?.querySelector('.tile-value') ?? null;
  return value?.textContent ?? '';
}

describe('formatDuration', () => {
  it('renders human units, minutes padded under an hour marker', () => {
    expect(formatDuration(65 * 60_000)).toBe('1 h 05 m');
    expect(formatDuration(125 * 60_000)).toBe('2 h 05 m');
    expect(formatDuration(45 * 60_000)).toBe('45 m');
    expect(formatDuration(0)).toBe('0 m');
  });
  it('never goes negative', () => {
    expect(formatDuration(-5)).toBe('0 m');
  });
});

describe('Tiles', () => {
  it('renders the six tile values from the bundle', () => {
    const { container } = render(<Tiles bundle={BUNDLE} economy={ECONOMY} now={NOW} />);
    expect(tileValue(container, 'Focus today')).toBe('1 h 05 m');
    expect(tileValue(container, 'Focus this week')).toBe('1 h 55 m');
    expect(tileValue(container, 'Current streak')).toBe('4 days');
    expect(tileValue(container, 'Attempts blocked today')).toBe('6');
    expect(tileValue(container, 'Temptations resisted today')).toBe('2');
    expect(tileValue(container, 'Pause spent today')).toBe('7 m');
    expect(container.textContent).toContain('of 17 m earned');
    expect(container.textContent).toContain('2 freezes banked');
  });

  it('renders the quiet zero-state line for an empty bundle', () => {
    const { container } = render(<Tiles bundle={EMPTY} economy={ECONOMY} now={NOW} />);
    expect(container.textContent).toContain('Stats appear after your first session.');
    expect(container.querySelectorAll('.tile').length).toBe(0);
  });
});

describe('Streak', () => {
  it('renders the chain, freeze chips, and one calendar dot per active day', () => {
    const { container } = render(<Streak streak={STREAK} now={NOW} />);
    expect(container.querySelector('.streak-chain')?.textContent).toContain('4');
    expect(container.querySelectorAll('.freeze-chip').length).toBe(2);
    expect(container.querySelectorAll('.cal-day.active').length).toBe(4);
    // August has 31 day cells regardless of activity
    expect(container.querySelectorAll('.cal-day').length).toBe(31);
    expect(container.textContent).toContain('4 active days this month');
  });

  it('renders a quiet first-run line when there is no streak yet', () => {
    const { container } = render(<Streak streak={EMPTY.streak} now={NOW} />);
    expect(container.textContent).toContain('Your streak starts with your first focus day.');
  });
});

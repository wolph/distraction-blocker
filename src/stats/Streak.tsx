import type { JSX } from 'preact';
import type { StreakState } from '../shared/types';

export interface StreakProps {
  streak: StreakState;
  now: number;
}

function daysInMonth(activeMonth: string): number {
  const year: number = Number(activeMonth.slice(0, 4));
  const month: number = Number(activeMonth.slice(5, 7));
  return new Date(year, month, 0).getDate();
}

function monthTitle(activeMonth: string): string {
  const year: number = Number(activeMonth.slice(0, 4));
  const month: number = Number(activeMonth.slice(5, 7));
  const d: Date = new Date(year, month - 1, 1);
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function activeDatesLabel(activeMonth: string, activeDays: number[]): string {
  const month: string = monthTitle(activeMonth);
  const days: number[] = [...new Set(activeDays)].sort(
    (left: number, right: number): number => left - right,
  );
  if (days.length === 0) return `No active dates in ${month}.`;
  return `Active dates in ${month}: ${days.join(', ')}.`;
}

function SnowflakeGlyph(): JSX.Element {
  return (
    <svg class="glyph snowflake" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 1v14M2 4.5l12 7M2 11.5l12-7M8 1 6 3M8 1l2 2M8 15l-2-2M8 15l2-2"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
      />
    </svg>
  );
}

export function Streak(props: StreakProps): JSX.Element {
  const streak: StreakState = props.streak;
  const hasHistory: boolean = streak.current > 0 || streak.activeDays.length > 0;
  if (!hasHistory) {
    return (
      <section class="card streak-card">
        <h2>Streak</h2>
        <p class="empty-line">Your streak starts with your first focus day.</p>
      </section>
    );
  }
  const total: number = daysInMonth(streak.activeMonth);
  const active: Set<number> = new Set(streak.activeDays);
  const dayCells: number[] = Array.from(
    { length: total },
    (_: unknown, i: number): number => i + 1,
  );
  const freezeChips: number[] = Array.from(
    { length: streak.freezeTokens },
    (_: unknown, i: number): number => i,
  );
  return (
    <section class="card streak-card">
      <h2>Streak</h2>
      <div class="streak-top">
        <div class="streak-chain">
          <span class="streak-number">{streak.current}</span>
          <span class="streak-unit">{streak.current === 1 ? 'day' : 'days'}</span>
        </div>
        <div
          class="freeze-chips"
          role="img"
          aria-label={`${streak.freezeTokens} freeze tokens banked`}
        >
          {freezeChips.map(
            (i: number): JSX.Element => (
              <span class="freeze-chip" key={i} title="Streak freeze: one missed day, covered">
                <SnowflakeGlyph />
              </span>
            ),
          )}
        </div>
      </div>
      <div class="streak-calendar">
        <p class="cal-title">
          {streak.activeDays.length} active days this month ({monthTitle(streak.activeMonth)})
        </p>
        <div
          class="cal-grid"
          role="img"
          aria-label={activeDatesLabel(streak.activeMonth, streak.activeDays)}
        >
          {dayCells.map(
            (dayNum: number): JSX.Element => (
              <span
                class={active.has(dayNum) ? 'cal-day active' : 'cal-day'}
                key={dayNum}
                title={`${streak.activeMonth}-${String(dayNum).padStart(2, '0')}`}
              />
            ),
          )}
        </div>
      </div>
    </section>
  );
}

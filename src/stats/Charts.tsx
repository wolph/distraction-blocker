import type { JSX } from 'preact';
import type { StatsBundle } from '../shared/messages';
import { localDateStr } from '../shared/time';
import type { DailyAgg, EventRecord } from '../shared/types';
import { BarChart, type ChartDatum } from './charts/BarChart';
import { HBarChart } from './charts/HBarChart';
import { formatMinutes } from './format';

export interface ChartsProps {
  bundle: StatsBundle;
  /** local event log for the hour-of-day chart, null while loading */
  events: EventRecord[] | null;
  now: number;
}

const DAYS_SHOWN = 14;
const TOP_SITES = 10;

/** A continuous day range ending today, gaps filled with zero. */
function dailySeries(
  bundle: StatsBundle,
  now: number,
  pick: (d: DailyAgg) => number,
): ChartDatum[] {
  const byDate: Map<string, DailyAgg> = new Map(
    bundle.days.map((d: DailyAgg): [string, DailyAgg] => [d.date, d]),
  );
  const base: Date = new Date(now);
  const out: ChartDatum[] = [];
  for (let i = DAYS_SHOWN - 1; i >= 0; i -= 1) {
    const day: Date = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i, 12);
    const agg: DailyAgg | undefined = byDate.get(localDateStr(day.getTime()));
    out.push({
      label: day.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
      value: agg === undefined ? 0 : pick(agg),
    });
  }
  return out;
}

function dayAttempts(d: DailyAgg): number {
  const named: number = Object.values(d.attempts).reduce(
    (sum: number, n: number): number => sum + n,
    0,
  );
  return named + d.attemptsOther;
}

/** Attempts merged across the loaded days, top ten sites plus "other". */
export function topSites(bundle: StatsBundle): ChartDatum[] {
  const merged: Map<string, number> = new Map();
  let other = 0;
  for (const d of bundle.days) {
    other += d.attemptsOther;
    for (const [host, count] of Object.entries(d.attempts)) {
      merged.set(host, (merged.get(host) ?? 0) + count);
    }
  }
  const sorted: Array<[string, number]> = [...merged.entries()].sort(
    (a: [string, number], b: [string, number]): number => b[1] - a[1],
  );
  const rows: ChartDatum[] = sorted
    .slice(0, TOP_SITES)
    .map(([label, value]: [string, number]): ChartDatum => ({ label, value }));
  for (const [, value] of sorted.slice(TOP_SITES)) other += value;
  if (other > 0) rows.push({ label: 'other', value: other });
  return rows;
}

/** Blocked attempts bucketed by local hour, from the local event log. */
export function attemptsByHour(events: EventRecord[]): number[] {
  const buckets: number[] = new Array<number>(24).fill(0);
  for (const event of events) {
    if (event.t !== 'attempt') continue;
    const hour: number = new Date(event.at).getHours();
    buckets[hour] = (buckets[hour] ?? 0) + 1;
  }
  return buckets;
}

function hourSeries(events: EventRecord[]): ChartDatum[] {
  return attemptsByHour(events).map(
    (value: number, hour: number): ChartDatum => ({
      label: `${String(hour).padStart(2, '0')}:00`,
      value,
    }),
  );
}

export function Charts(props: ChartsProps): JSX.Element {
  const focus: ChartDatum[] = dailySeries(props.bundle, props.now, (d: DailyAgg): number =>
    Math.round(d.focusMs / 60_000),
  );
  const attempts: ChartDatum[] = dailySeries(props.bundle, props.now, dayAttempts);
  const sites: ChartDatum[] = topSites(props.bundle);
  const hours: ChartDatum[] = hourSeries(props.events ?? []);
  return (
    <div class="charts">
      <section class="card">
        <h2>Focus minutes per day</h2>
        <BarChart
          data={focus}
          format={formatMinutes}
          tickFormat={(v: number): string => `${v}m`}
          color="var(--focus-series)"
          emptyLine="Focus minutes appear after your first session."
        />
      </section>
      <section class="card">
        <h2>Blocked attempts per day</h2>
        <BarChart
          data={attempts}
          format={(v: number): string => `${v} blocked`}
          color="var(--attempts-series)"
          emptyLine="Blocked attempts show up here once a session catches one."
        />
      </section>
      <section class="card">
        <h2>Top blocked sites</h2>
        <HBarChart
          data={sites}
          format={(v: number): string => String(v)}
          color="var(--attempts-series)"
          emptyLine="Nothing blocked yet. That is a fine start."
        />
      </section>
      <section class="card">
        <h2>
          Attempts by hour of day <span class="caption">this machine only</span>
        </h2>
        <HBarChart
          data={hours}
          format={(v: number): string => String(v)}
          color="var(--attempts-series)"
          emptyLine="Hourly patterns appear after your first blocked attempt."
        />
      </section>
    </div>
  );
}

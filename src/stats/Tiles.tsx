import type { JSX } from 'preact';
import { formatDuration } from '../shared/format';
import type { StatsBundle } from '../shared/messages';
import { localDateStr } from '../shared/time';
import type { DailyAgg, MonthlyAgg, PauseEconomy } from '../shared/types';

export interface TilesProps {
  bundle: StatsBundle;
  economy: PauseEconomy;
  now: number;
}

interface TileSpec {
  label: string;
  value: string;
  subline: string | null;
}

function aggregateHasActivity(aggregate: DailyAgg | MonthlyAgg): boolean {
  return (
    aggregate.focusMs > 0 ||
    aggregate.sessionsStarted > 0 ||
    aggregate.sessionsCompleted > 0 ||
    Object.values(aggregate.attempts).some((attempts: number): boolean => attempts > 0) ||
    aggregate.attemptsOther > 0 ||
    aggregate.pausesTaken > 0 ||
    aggregate.pauseMsSpent > 0 ||
    (aggregate.pauseMsEarned ?? 0) > 0 ||
    aggregate.unlocksTaken > 0 ||
    (aggregate.unlockMsSpent ?? 0) > 0 ||
    aggregate.resisted > 0
  );
}

function isEmptyBundle(bundle: StatsBundle): boolean {
  return (
    bundle.recentSessions.length === 0 &&
    !bundle.days.some(aggregateHasActivity) &&
    !bundle.months.some(aggregateHasActivity)
  );
}

function todayAgg(bundle: StatsBundle, now: number): DailyAgg | null {
  const today: string = localDateStr(now);
  return bundle.days.find((d: DailyAgg): boolean => d.date === today) ?? null;
}

function buildTiles(bundle: StatsBundle, now: number): TileSpec[] {
  const today: DailyAgg | null = todayAgg(bundle, now);
  const pauseMs: number = today?.pauseMsSpent ?? 0;
  const unlockMs: number = today?.unlockMsSpent ?? 0;
  const spentMs: number = pauseMs + unlockMs;
  const earnedMs: number = today?.pauseMsEarned ?? 0;
  const spendingSubline: string =
    spentMs > 0
      ? `All sites ${formatDuration(pauseMs)}, one site ${formatDuration(unlockMs)}, ${formatDuration(earnedMs)} earned`
      : `${formatDuration(earnedMs)} earned`;
  return [
    { label: 'Focus today', value: formatDuration(bundle.totals.focusMsToday), subline: null },
    {
      label: 'Focus in the last 7 days',
      value: formatDuration(bundle.totals.focusMsLast7Days),
      subline: null,
    },
    { label: 'Attempts blocked today', value: String(bundle.totals.attemptsToday), subline: null },
    {
      label: 'Gate requests dismissed today',
      value: String(bundle.totals.resistedToday),
      subline: null,
    },
    {
      label: 'Site access credit spent today',
      value: formatDuration(spentMs),
      subline: spendingSubline,
    },
  ];
}

export function Tiles(props: TilesProps): JSX.Element {
  if (isEmptyBundle(props.bundle)) {
    return <p class="empty-line">Stats appear after your first session.</p>;
  }
  const tiles: TileSpec[] = buildTiles(props.bundle, props.now);
  return (
    <div class="tile-row">
      {tiles.map(
        (tile: TileSpec): JSX.Element => (
          <div class="tile" key={tile.label}>
            <span class="tile-label">{tile.label}</span>
            <span class="tile-value">{tile.value}</span>
            {tile.subline === null ? null : <span class="tile-subline">{tile.subline}</span>}
          </div>
        ),
      )}
    </div>
  );
}

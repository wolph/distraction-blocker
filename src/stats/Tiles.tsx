import type { JSX } from 'preact';
import type { StatsBundle } from '../shared/messages';
import { localDateStr } from '../shared/time';
import type { DailyAgg, PauseEconomy } from '../shared/types';
import { formatDuration } from './format';

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

export function isEmptyBundle(bundle: StatsBundle): boolean {
  return bundle.days.length === 0 && bundle.recentSessions.length === 0;
}

function todayAgg(bundle: StatsBundle, now: number): DailyAgg | null {
  const today: string = localDateStr(now);
  return bundle.days.find((d: DailyAgg): boolean => d.date === today) ?? null;
}

function buildTiles(bundle: StatsBundle, now: number): TileSpec[] {
  const today: DailyAgg | null = todayAgg(bundle, now);
  const spentMs: number = today === null ? 0 : today.pauseMsSpent + (today.unlockMsSpent ?? 0);
  const earnedMs: number = today?.pauseMsEarned ?? 0;
  const freezes: number = bundle.streak.freezeTokens;
  return [
    { label: 'Focus today', value: formatDuration(bundle.totals.focusMsToday), subline: null },
    { label: 'Focus this week', value: formatDuration(bundle.totals.focusMsWeek), subline: null },
    {
      label: 'Current streak',
      value: `${bundle.streak.current} ${bundle.streak.current === 1 ? 'day' : 'days'}`,
      subline: `${freezes} ${freezes === 1 ? 'freeze' : 'freezes'} banked`,
    },
    { label: 'Attempts blocked today', value: String(bundle.totals.attemptsToday), subline: null },
    {
      label: 'Temptations resisted today',
      value: String(bundle.totals.resistedToday),
      subline: null,
    },
    {
      label: 'Pause spent today',
      value: formatDuration(spentMs),
      subline: `of ${formatDuration(earnedMs)} earned`,
    },
  ];
}

function FlameGlyph(): JSX.Element {
  return (
    <svg class="glyph flame" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.5c.6 2.2-1.9 3.6-1.9 6a2 2 0 0 0 .5 1.3C6.7 6.6 9 6.3 9 4.2c1.7 1.2 2.9 3 2.9 4.9A3.9 3.9 0 0 1 8 13a3.9 3.9 0 0 1-3.9-3.9C4.1 5.6 6.9 4.1 8 1.5Z" />
    </svg>
  );
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
            <span class="tile-value">
              {tile.label === 'Current streak' ? <FlameGlyph /> : null}
              {tile.value}
            </span>
            {tile.subline === null ? null : <span class="tile-subline">{tile.subline}</span>}
          </div>
        ),
      )}
    </div>
  );
}

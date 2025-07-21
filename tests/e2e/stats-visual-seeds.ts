import type { StatsBundle } from '../../src/shared/messages';
import type { DailyAgg, EventRecord, StorageMode } from '../../src/shared/types';

export type StatsVisualStateId =
  | 'all-hours-boundaries-local'
  | 'no-activity-local'
  | 'one-active-hour-sync';

export interface StatsVisualState {
  id: StatsVisualStateId;
  hasSessions: boolean;
  storageMode: StorageMode;
}

export interface StatsVisualSeed {
  bundle: StatsBundle;
  events: EventRecord[];
  storageMode: StorageMode;
}

export const STATS_VISUAL_STATES: readonly StatsVisualState[] = [
  { id: 'no-activity-local', hasSessions: false, storageMode: 'local' },
  { id: 'one-active-hour-sync', hasSessions: true, storageMode: 'sync' },
  { id: 'all-hours-boundaries-local', hasSessions: true, storageMode: 'local' },
];

function localDate(now: number, daysAgo: number): string {
  const date: Date = new Date(now);
  date.setDate(date.getDate() - daysAgo);
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function localTime(now: number, daysAgo: number, hour: number, minute: number = 0): number {
  const date: Date = new Date(now);
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
}

function daily(
  now: number,
  values: Partial<Omit<DailyAgg, 'attempts' | 'date'>> & { attempts?: Record<string, number> },
): DailyAgg {
  return {
    attempts: values.attempts ?? {},
    attemptsOther: values.attemptsOther ?? 0,
    date: localDate(now, 1),
    focusMs: values.focusMs ?? 0,
    pauseMsEarned: values.pauseMsEarned ?? 0,
    pauseMsSpent: values.pauseMsSpent ?? 0,
    pausesTaken: values.pausesTaken ?? 0,
    resisted: values.resisted ?? 0,
    sessionsCompleted: values.sessionsCompleted ?? 0,
    sessionsStarted: values.sessionsStarted ?? 0,
    unlockMsSpent: values.unlockMsSpent ?? 0,
    unlocksTaken: values.unlocksTaken ?? 0,
  };
}

function attempt(at: number, hour: number): EventRecord {
  return {
    at,
    host: `hour-${String(hour).padStart(2, '0')}.blocked.example`,
    kind: 'navigation',
    t: 'attempt',
    tabId: hour + 1,
    url: `https://hour-${String(hour).padStart(2, '0')}.blocked.example/work`,
  };
}

function bundle(now: number, days: DailyAgg[], events: EventRecord[]): StatsBundle {
  const previousDate: Date = new Date(now);
  previousDate.setDate(previousDate.getDate() - 1);
  const recentSessions: EventRecord[] = events
    .filter(
      (event: EventRecord): boolean =>
        event.t === 'sessionStarted' ||
        event.t === 'sessionCompleted' ||
        event.t === 'sessionCanceled' ||
        event.t === 'sessionIdentityAssigned' ||
        event.t === 'pauseTaken' ||
        event.t === 'unlockTaken',
    )
    .sort((left: EventRecord, right: EventRecord): number => right.at - left.at);
  const focusMsLast7Days: number = days.reduce(
    (total: number, day: DailyAgg): number => total + day.focusMs,
    0,
  );
  return {
    days,
    months: [],
    recentSessions,
    streak: {
      activeDays: days.length === 0 ? [] : [previousDate.getDate()],
      activeMonth: localDate(now, 1).slice(0, 7),
      current: days.length === 0 ? 0 : 1,
      freezeTokens: days.length === 0 ? 0 : 1,
      lastCountedDate: days.length === 0 ? null : localDate(now, 1),
      lastFreezeGrantDate: null,
    },
    totals: {
      attemptsToday: 0,
      focusMsLast7Days,
      focusMsToday: 0,
      resistedToday: 0,
    },
  };
}

function oneActiveHour(now: number): StatsVisualSeed {
  const sessionId: string = 'stats-one-hour-completed';
  const events: EventRecord[] = [
    {
      at: localTime(now, 1, 8, 30),
      durationMin: 60,
      intention: 'Prepare the release summary',
      mode: 'blacklist',
      sessionId,
      source: 'manual',
      strictness: 'friction',
      t: 'sessionStarted',
    },
    attempt(localTime(now, 1, 9, 10), 9),
    {
      at: localTime(now, 1, 9, 30),
      focusedMs: 60 * 60_000,
      sessionId,
      t: 'sessionCompleted',
    },
  ];
  const days: DailyAgg[] = [
    daily(now, {
      attempts: { 'research.example.org': 1 },
      focusMs: 60 * 60_000,
      pauseMsEarned: 10 * 60_000,
      sessionsCompleted: 1,
      sessionsStarted: 1,
    }),
  ];
  return { bundle: bundle(now, days, events), events, storageMode: 'sync' };
}

function allHoursBoundaries(now: number): StatsVisualSeed {
  const longDomain: string =
    'a-very-long-research-subdomain-for-layout-boundary-verification.example.org';
  const completedId: string = 'stats-boundary-completed';
  const canceledId: string = 'stats-boundary-canceled';
  const events: EventRecord[] = Array.from({ length: 24 }, (_unused: unknown, hour: number) =>
    attempt(localTime(now, 1, hour, 10), hour),
  );
  events.push(
    {
      at: localTime(now, 1, 6),
      durationMin: 90,
      intention: 'Complete the long-domain evidence review without truncating session details',
      mode: 'blacklist',
      sessionId: completedId,
      source: 'schedule',
      strictness: 'hard',
      t: 'sessionStarted',
    },
    {
      at: localTime(now, 1, 7, 30),
      focusedMs: 90 * 60_000,
      sessionId: completedId,
      t: 'sessionCompleted',
    },
    {
      at: localTime(now, 1, 18),
      durationMin: 120,
      intention: 'Investigate seven-digit attempt totals and responsive session records',
      mode: 'blacklist',
      sessionId: canceledId,
      source: 'manual',
      strictness: 'friction',
      t: 'sessionStarted',
    },
    {
      at: localTime(now, 1, 18, 25),
      focusedMs: 25 * 60_000,
      sessionId: canceledId,
      t: 'sessionCanceled',
    },
  );
  events.sort((left: EventRecord, right: EventRecord): number => left.at - right.at);
  const days: DailyAgg[] = [
    daily(now, {
      attempts: { [longDomain]: 1_234_567, 'short.example': 98_765 },
      attemptsOther: 7_654_321,
      focusMs: 115 * 60_000,
      pauseMsEarned: 19 * 60_000,
      pauseMsSpent: 3 * 60_000,
      pausesTaken: 1,
      resisted: 1_000_000,
      sessionsCompleted: 1,
      sessionsStarted: 2,
      unlockMsSpent: 2 * 60_000,
      unlocksTaken: 1,
    }),
  ];
  return { bundle: bundle(now, days, events), events, storageMode: 'local' };
}

export function buildStatsVisualSeed(state: StatsVisualStateId, now: number): StatsVisualSeed {
  if (state === 'one-active-hour-sync') return oneActiveHour(now);
  if (state === 'all-hours-boundaries-local') return allHoursBoundaries(now);
  return { bundle: bundle(now, [], []), events: [], storageMode: 'local' };
}

import { DEFAULT_LISTS, rulesFromLists } from '../../../src/shared/constants';
import type {
  ScheduleEntryV2,
  ScheduleOccurrenceRef,
  SessionConfigV2,
  SessionEndedEventV2,
  SessionStartedEventV2,
} from '../../../src/shared/types';

export const NOW: number = 1_700_000_000_000;
export const SESSION_ID: string = '018c2212-3d9d-7b8c-9f11-7cc087988c09';
export const OCCURRENCE: ScheduleOccurrenceRef = {
  version: 1,
  token: 'weekday@2026-09-02',
  entryId: 'weekday',
  localStartDate: '2026-09-02',
};
export const MANUAL_TIMED_CONFIG: SessionConfigV2 = {
  mode: 'blacklist',
  strictness: 'friction',
  duration: { kind: 'timed', minutes: 25 },
  cycling: null,
  intention: 'Review the release',
  source: 'manual',
  scheduleOccurrence: null,
  rules: rulesFromLists(DEFAULT_LISTS),
};
export const MANUAL_INDEFINITE_CONFIG: SessionConfigV2 = {
  ...MANUAL_TIMED_CONFIG,
  strictness: 'flexible',
  duration: { kind: 'until-stopped' },
  cycling: null,
};
export const SCHEDULED_INDEFINITE_CONFIG: SessionConfigV2 = {
  ...MANUAL_INDEFINITE_CONFIG,
  source: 'schedule',
  scheduleOccurrence: OCCURRENCE,
};
export const WINDOW_ENTRY: ScheduleEntryV2 = {
  id: 'weekday',
  days: [1, 2, 3, 4, 5],
  start: '09:00',
  end: '17:00',
  duration: { kind: 'window' },
  mode: 'blacklist',
  strictness: 'hard',
  cycling: null,
  intention: '',
  enabled: true,
};
export const STARTED: SessionStartedEventV2 = {
  version: 2,
  t: 'sessionStarted',
  eventId: `${SESSION_ID}:start`,
  at: NOW,
  sessionId: SESSION_ID,
  source: 'manual',
  mode: 'blacklist',
  strictness: 'flexible',
  duration: { kind: 'until-stopped' },
  intention: 'Review the release',
  scheduleOccurrence: null,
};
export const ENDED: SessionEndedEventV2 = {
  version: 2,
  t: 'sessionEnded',
  eventId: `${SESSION_ID}:end`,
  at: NOW + 30_000,
  sessionId: SESSION_ID,
  outcome: 'completed',
  reason: 'manual-completed',
  focusedMs: 30_000,
  duration: { kind: 'until-stopped' },
  source: 'manual',
  scheduleOccurrence: null,
};

export function sparseArray<T>(length: number, values: Readonly<Record<number, T>> = {}): T[] {
  const result: T[] = new Array<T>(length);
  for (const [index, value] of Object.entries(values)) result[Number(index)] = value;
  return result;
}

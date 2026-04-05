import {
  HANDLED_SCHEDULE_OCCURRENCE_RETENTION_MS,
  MAX_HANDLED_SCHEDULE_OCCURRENCES,
} from '../shared/constants';
import { CoreError } from '../shared/errors';
import type {
  HandledScheduleOccurrence,
  ScheduleEntryV2,
  ScheduleOccurrenceRef,
} from '../shared/types';
import { toMinutes } from './schedule';

export interface ResolvedScheduleOccurrenceV2 {
  entry: ScheduleEntryV2;
  occurrence: ScheduleOccurrenceRef;
  windowStartsAt: number;
  windowEndsAt: number;
}

export interface CapturedScheduleWindowV2 {
  windowStartsAt: number;
  windowEndsAt: number;
}

function invalidSchedule(message: string): never {
  throw new CoreError('invalid-schedule', message);
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalidSchedule(`${label} must be a non-negative safe-integer timestamp`);
  }
}

function dateForObservation(at: number): Date {
  assertNonNegativeSafeInteger(at, 'schedule observation time');
  const date: Date = new Date(at);
  const year: number = date.getFullYear();
  if (Number.isNaN(date.getTime()) || year < 1000 || year > 9999) {
    invalidSchedule('schedule observation time must have a four-digit local year');
  }
  return date;
}

function localDateString(date: Date): string {
  const year: string = String(date.getFullYear()).padStart(4, '0');
  const month: string = String(date.getMonth() + 1).padStart(2, '0');
  const day: string = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function absoluteBoundary(date: Date, minutes: number, label: string): number {
  const boundary: number = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    Math.floor(minutes / 60),
    minutes % 60,
  ).getTime();
  assertNonNegativeSafeInteger(boundary, label);
  return boundary;
}

function compareNumbers(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints: number[] = Array.from(
    left,
    (value: string): number => value.codePointAt(0) as number,
  );
  const rightPoints: number[] = Array.from(
    right,
    (value: string): number => value.codePointAt(0) as number,
  );
  const sharedLength: number = Math.min(leftPoints.length, rightPoints.length);
  for (let index: number = 0; index < sharedLength; index += 1) {
    const compared: number = compareNumbers(
      leftPoints[index] as number,
      rightPoints[index] as number,
    );
    if (compared !== 0) return compared;
  }
  return compareNumbers(leftPoints.length, rightPoints.length);
}

function compareResolvedOccurrences(
  left: ResolvedScheduleOccurrenceV2,
  right: ResolvedScheduleOccurrenceV2,
): number {
  const startOrder: number = compareNumbers(left.windowStartsAt, right.windowStartsAt);
  if (startOrder !== 0) return startOrder;
  const endOrder: number = compareNumbers(left.windowEndsAt, right.windowEndsAt);
  if (endOrder !== 0) return endOrder;
  return compareUnicodeCodePoints(left.occurrence.token, right.occurrence.token);
}

export function resolveOpenScheduleOccurrencesV2(
  entries: readonly ScheduleEntryV2[],
  at: number,
): ResolvedScheduleOccurrenceV2[] {
  const observed: Date = dateForObservation(at);
  const weekday: number = observed.getDay();
  const localMinutes: number = observed.getHours() * 60 + observed.getMinutes();
  const localStartDate: string = localDateString(observed);
  const resolved: ResolvedScheduleOccurrenceV2[] = [];

  for (const entry of entries) {
    if (!entry.enabled || !entry.days.includes(weekday)) continue;
    const startMinutes: number = toMinutes(entry.start);
    const endMinutes: number = toMinutes(entry.end);
    // A malformed time parses to NaN, and both halves of the comparison below are then false, so
    // the entry would read as open and `absoluteBoundary` would throw, taking down the resolution
    // of every well-formed entry beside it. Skip the one bad entry instead. Nothing can store a
    // malformed time today, so this is defence in depth, which is why it skips rather than errors.
    if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes)) continue;
    if (localMinutes < startMinutes || localMinutes >= endMinutes) continue;

    const windowStartsAt: number = absoluteBoundary(
      observed,
      startMinutes,
      'schedule window start',
    );
    const windowEndsAt: number = absoluteBoundary(observed, endMinutes, 'schedule window end');
    if (windowStartsAt >= windowEndsAt) {
      invalidSchedule('schedule window must have increasing absolute bounds');
    }

    const clonedEntry: ScheduleEntryV2 = structuredClone(entry);
    const token: string = scheduleOccurrenceTokenV2(entry.id, localStartDate);
    resolved.push({
      entry: clonedEntry,
      occurrence: {
        version: 1,
        token,
        entryId: entry.id,
        localStartDate,
      },
      windowStartsAt,
      windowEndsAt,
    });
  }

  return resolved.sort(compareResolvedOccurrences);
}

/**
 * The one occurrence identity grammar: an entry and the local day its window opened on. Every
 * producer and the stored-value validator spell it this way, so it lives here once.
 */
/** How far ahead the next-window search looks, which is one week plus the day it starts on. */
const NEXT_WINDOW_DAYS_SEARCHED: number = 8;

/**
 * The next window any enabled entry opens strictly after `at`, or null when none opens within the
 * week ahead.
 *
 * This is the same question `resolveOpenScheduleOccurrencesV2` answers about the present instant,
 * asked about the future, so it reads its boundaries through the same helpers rather than repeating
 * the arithmetic. Two resolvers with their own arithmetic drift, and a drift here is one the user
 * sees: the popup announces a start the schedule check will not take.
 */
export function nextScheduleWindowStartV2(
  entries: readonly ScheduleEntryV2[],
  at: number,
): { entry: ScheduleEntryV2; startsAt: number } | null {
  const observed: Date = dateForObservation(at);
  let best: { entry: ScheduleEntryV2; startsAt: number } | null = null;
  for (const entry of entries) {
    if (!entry.enabled) continue;
    const startMinutes: number = toMinutes(entry.start);
    for (let ahead: number = 0; ahead < NEXT_WINDOW_DAYS_SEARCHED; ahead++) {
      const day: Date = new Date(
        observed.getFullYear(),
        observed.getMonth(),
        observed.getDate() + ahead,
      );
      if (!entry.days.includes(day.getDay())) continue;
      const startsAt: number = absoluteBoundary(day, startMinutes, 'schedule window start');
      // A day whose start has already passed is not this entry's next one, so the search moves on
      // to the following day rather than giving up on the entry.
      if (startsAt <= at) continue;
      if (best === null || startsAt < best.startsAt) {
        best = { entry: structuredClone(entry), startsAt };
      }
      break;
    }
  }
  return best;
}

export function scheduleOccurrenceTokenV2(entryId: string, localStartDate: string): string {
  return `${entryId}@${localStartDate}`;
}

/** The local day an instant belongs to, in the same date arithmetic the resolver uses. */
export function localStartDateForV2(at: number): string {
  return localDateString(new Date(at));
}

export function selectScheduleCandidateV2(
  entries: readonly ScheduleEntryV2[],
  handledOccurrences: readonly HandledScheduleOccurrence[],
  at: number,
): ResolvedScheduleOccurrenceV2 | null {
  const resolved: ResolvedScheduleOccurrenceV2[] = resolveOpenScheduleOccurrencesV2(entries, at);
  const liveHandledTokens: Set<string> = new Set<string>();
  for (const occurrence of handledOccurrences) {
    if (occurrence.expiresAt > at) liveHandledTokens.add(occurrence.token);
  }

  for (const candidate of resolved) {
    if (liveHandledTokens.has(candidate.occurrence.token)) continue;
    if (candidate.entry.duration.kind === 'window' && candidate.windowEndsAt <= at) continue;
    return candidate;
  }
  return null;
}

export function capturedScheduleWindowContainsV2(
  window: CapturedScheduleWindowV2,
  at: number,
): boolean {
  assertNonNegativeSafeInteger(window.windowStartsAt, 'captured schedule window start');
  assertNonNegativeSafeInteger(window.windowEndsAt, 'captured schedule window end');
  assertNonNegativeSafeInteger(at, 'schedule observation time');
  if (window.windowStartsAt >= window.windowEndsAt) {
    invalidSchedule('captured schedule window must have increasing bounds');
  }
  return window.windowStartsAt <= at && at < window.windowEndsAt;
}

export function createHandledScheduleOccurrenceV2(
  occurrence: ScheduleOccurrenceRef,
  handledAt: number,
  reason: HandledScheduleOccurrence['reason'],
): HandledScheduleOccurrence {
  assertNonNegativeSafeInteger(handledAt, 'handled schedule occurrence time');
  const expiresAt: number = handledAt + HANDLED_SCHEDULE_OCCURRENCE_RETENTION_MS;
  assertNonNegativeSafeInteger(expiresAt, 'handled schedule occurrence expiry');
  return {
    ...structuredClone(occurrence),
    handledAt,
    reason,
    expiresAt,
  };
}

function compareHandledOccurrences(
  left: HandledScheduleOccurrence,
  right: HandledScheduleOccurrence,
): number {
  const timeOrder: number = compareNumbers(left.handledAt, right.handledAt);
  if (timeOrder !== 0) return timeOrder;
  return compareUnicodeCodePoints(left.token, right.token);
}

function retainHandledScheduleOccurrences(
  current: readonly HandledScheduleOccurrence[],
  additions: readonly HandledScheduleOccurrence[],
  at: number,
): HandledScheduleOccurrence[] {
  assertNonNegativeSafeInteger(at, 'handled schedule occurrence observation time');
  const unique: Map<string, HandledScheduleOccurrence> = new Map<
    string,
    HandledScheduleOccurrence
  >();

  for (const occurrence of [...current, ...additions]) {
    assertNonNegativeSafeInteger(occurrence.handledAt, 'handled schedule occurrence time');
    assertNonNegativeSafeInteger(occurrence.expiresAt, 'handled schedule occurrence expiry');
    if (occurrence.expiresAt <= at || unique.has(occurrence.token)) continue;
    unique.set(occurrence.token, structuredClone(occurrence));
  }

  const canonical: HandledScheduleOccurrence[] = [...unique.values()].sort(
    compareHandledOccurrences,
  );
  const firstRetainedIndex: number = Math.max(
    0,
    canonical.length - MAX_HANDLED_SCHEDULE_OCCURRENCES,
  );
  return canonical.slice(firstRetainedIndex);
}

export function pruneHandledScheduleOccurrencesV2(
  occurrences: readonly HandledScheduleOccurrence[],
  at: number,
): HandledScheduleOccurrence[] {
  return retainHandledScheduleOccurrences(occurrences, [], at);
}

export function mergeHandledScheduleOccurrencesV2(
  current: readonly HandledScheduleOccurrence[],
  additions: readonly HandledScheduleOccurrence[],
  at: number,
): HandledScheduleOccurrence[] {
  return retainHandledScheduleOccurrences(current, additions, at);
}

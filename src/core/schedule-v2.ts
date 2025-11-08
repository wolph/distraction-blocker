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

function toMinutes(value: string): number {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
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

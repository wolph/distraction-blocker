/**
 * Pure builders for the immutable closure projection: focus settlement through the immutable end,
 * local-date focus splitting, bank and aggregate projection, the reason and outcome mapping, and
 * the schedule occurrences a closure records as handled.
 *
 * Nothing here touches storage or a browser API, and no input is mutated. The finished projection
 * is validated with the landed detached validator, so a value this module returns is always a value
 * the storage boundary accepts. A value that cannot satisfy the contract raises
 * `CoreError('invalid-rule', ...)` instead of reaching a caller.
 */

import { accrue } from '../core/budget';
import {
  createHandledScheduleOccurrenceV2,
  mergeHandledScheduleOccurrencesV2,
} from '../core/schedule-v2';
import { focusedMsAtV2 } from '../core/session-v2';
import { capAttempts, emptyDaily } from '../core/stats';
import { TOP_SITES_DAILY } from '../shared/constants';
import { CoreError } from '../shared/errors';
import { syncAggKey } from '../shared/storage-keys';
import { localDateStr } from '../shared/time';
import type {
  BankState,
  DailyAgg,
  HandledScheduleOccurrence,
  LegacyEventRecord,
  PauseEconomy,
  ScheduleOccurrenceRef,
  SessionConfigV2,
  SessionDuration,
  SessionEndedEventV2,
  SessionEndReasonV2,
  SessionOutcomeV2,
  SessionStateV2,
} from '../shared/types';
import { isNonBlankString, isSafeTimestamp } from '../shared/v2-domain-intrinsics';
import { validateDetachedClosureProjection } from './cleanup-closure-v2-validation';
import type { ClosureProjection } from './runtime-v2-types';

/** The two reasons the spec maps to a completed outcome. Every other reason cancels. */
const COMPLETED_END_REASONS: ReadonlySet<SessionEndReasonV2> = new Set<SessionEndReasonV2>([
  'timer-completed',
  'manual-completed',
]);

export interface FocusDateSplitV2 {
  date: string;
  ms: number;
}

export interface ClosureOutcomeV2 {
  outcome: SessionOutcomeV2;
  completionIncrement: 0 | 1;
}

export interface ClosureProjectionInputV2 {
  session: SessionStateV2;
  endedAt: number;
  reason: SessionEndReasonV2;
  bank: BankState;
  pauseEconomy: PauseEconomy;
  accruedFocusMs: number;
  todayAgg: DailyAgg | null;
  /**
   * The stored daily aggregates this closure may add focus to, keyed by `syncAggKey`. A closure
   * that crosses a local midnight lands focus on a date the runtime already finished and wrote, and
   * `aggregateSets` is an absolute value, so seeding such a date empty would erase that whole day.
   * The caller reads those keys before preparing the closure.
   */
  priorAggregates: Record<string, DailyAgg>;
  runtimeDate: string;
  deviceId: string;
  currentHandledOccurrences: readonly HandledScheduleOccurrence[];
  openOccurrences: readonly ScheduleOccurrenceRef[];
}

export interface ClosureProjectionResultV2 {
  projection: ClosureProjection;
  todayAgg: DailyAgg;
  accruedFocusMs: number;
}

/** One entry per local day the interval covers, in order, summing to `toAt - fromAt`. */
export function splitFocusByLocalDateV2(fromAt: number, toAt: number): FocusDateSplitV2[] {
  assertSafeTimestamp(fromAt, 'focus split start');
  assertSafeTimestamp(toAt, 'focus split end');
  if (fromAt >= toAt) return [];

  const splits: FocusDateSplitV2[] = [];
  let cursor: number = fromAt;
  while (cursor < toAt) {
    const segmentEnd: number = Math.min(nextLocalMidnight(cursor), toAt);
    splits.push({ date: localDateStr(cursor), ms: segmentEnd - cursor });
    cursor = segmentEnd;
  }
  return splits;
}

export function closureOutcomeForReasonV2(reason: SessionEndReasonV2): ClosureOutcomeV2 {
  return COMPLETED_END_REASONS.has(reason)
    ? { outcome: 'completed', completionIncrement: 1 }
    : { outcome: 'canceled', completionIncrement: 0 };
}

/** A manual end completes an indefinite session and ends a timed one early. */
export function manualEndReasonV2(
  duration: SessionDuration,
): 'manual-completed' | 'manual-canceled' {
  return duration.kind === 'until-stopped' ? 'manual-completed' : 'manual-canceled';
}

/**
 * Natural timed completion handled its source token at start, so it adds nothing. Every other
 * closure of a scheduled or indefinite session suppresses the windows open at `endedAt`.
 */
export function closureHandledOccurrenceAdditionsV2(
  config: SessionConfigV2,
  reason: SessionEndReasonV2,
  openOccurrences: readonly ScheduleOccurrenceRef[],
  endedAt: number,
): HandledScheduleOccurrence[] {
  if (reason === 'timer-completed') return [];
  if (config.source !== 'schedule' && config.duration.kind !== 'until-stopped') return [];
  return openOccurrences.map(
    (occurrence: ScheduleOccurrenceRef): HandledScheduleOccurrence =>
      createHandledScheduleOccurrenceV2(occurrence, endedAt, 'closure-overlap'),
  );
}

export function buildClosureProjectionV2(
  input: ClosureProjectionInputV2,
): ClosureProjectionResultV2 {
  const session: SessionStateV2 = input.session;
  const endedAt: number = input.endedAt;
  assertClosureInput(input);

  const focusedMs: number = focusedMsAtV2(session, endedAt);
  const focusDeltaMs: number = Math.max(0, focusedMs - input.accruedFocusMs);
  const bankAfter: BankState = accrue(input.bank, focusDeltaMs, input.pauseEconomy);
  const outcome: ClosureOutcomeV2 = closureOutcomeForReasonV2(input.reason);
  const endedDate: string = localDateStr(endedAt);
  const endEvent: SessionEndedEventV2 = buildSessionEndedEventV2(input, outcome.outcome, focusedMs);

  const projection: ClosureProjection = {
    closureId: `${session.sessionId}:close`,
    sessionId: session.sessionId,
    endedAt,
    reason: input.reason,
    outcome: outcome.outcome,
    focusedMs,
    endEvent,
    events: [
      ...settlementEventsV2(session.sessionId, endedAt, bankAfter.balanceMs - input.bank.balanceMs),
      endEvent,
    ],
    handledOccurrences: mergeHandledScheduleOccurrencesV2(
      input.currentHandledOccurrences,
      closureHandledOccurrenceAdditionsV2(
        session.config,
        input.reason,
        input.openOccurrences,
        endedAt,
      ),
      endedAt,
    ),
    completionIncrement: outcome.completionIncrement,
    bankAfter,
    aggregateSets: buildClosureAggregatesV2(input, {
      splits: settlementSplitsV2(session, endedAt, focusDeltaMs),
      endedDate,
      completionIncrement: outcome.completionIncrement,
    }),
    aggregateRemoves: [],
  };
  if (!validateDetachedClosureProjection(projection)) {
    invalidClosure('the closure projection does not satisfy the stored closure contract');
  }

  const endedAggregate: DailyAgg | undefined =
    projection.aggregateSets[syncAggKey(input.deviceId, endedDate)];
  if (endedAggregate === undefined) invalidClosure('the closure end date carries no aggregate');
  return { projection, todayAgg: structuredClone(endedAggregate), accruedFocusMs: focusedMs };
}

/** The immutable end event, whose duration, source, and occurrence repeat the session config. */
function buildSessionEndedEventV2(
  input: ClosureProjectionInputV2,
  outcome: SessionOutcomeV2,
  focusedMs: number,
): SessionEndedEventV2 {
  const session: SessionStateV2 = input.session;
  return {
    version: 2,
    t: 'sessionEnded',
    eventId: `${session.sessionId}:end`,
    at: input.endedAt,
    sessionId: session.sessionId,
    outcome,
    reason: input.reason,
    focusedMs,
    duration: structuredClone(session.config.duration),
    source: session.config.source,
    scheduleOccurrence: structuredClone(session.config.scheduleOccurrence),
  };
}

/** A closure that banks nothing records nothing, so replay never sees a zero credit event. */
function settlementEventsV2(
  sessionId: string,
  endedAt: number,
  earnedMs: number,
): LegacyEventRecord[] {
  if (earnedMs <= 0) return [];
  return [{ t: 'budgetEarned', at: endedAt, ms: earnedMs, sessionId }];
}

/** The settled interval ends at the last focus instant and is exactly the unsettled delta long. */
function settlementSplitsV2(
  session: SessionStateV2,
  endedAt: number,
  focusDeltaMs: number,
): FocusDateSplitV2[] {
  const settleTo: number = settlementEndV2(session, endedAt);
  const settleFrom: number = settleTo - focusDeltaMs;
  assertSafeTimestamp(settleFrom, 'focus settlement start');
  return splitFocusByLocalDateV2(settleFrom, settleTo);
}

/** What the closure aggregates need beyond the raw input, computed once by the builder. */
interface ClosureAggregatePlanV2 {
  splits: readonly FocusDateSplitV2[];
  endedDate: string;
  completionIncrement: 0 | 1;
}

/**
 * Focus credit lands on every local date the settled interval covers. The end date always gets an
 * entry, because it carries the completion increment even when that increment is zero.
 */
function buildClosureAggregatesV2(
  input: ClosureProjectionInputV2,
  plan: ClosureAggregatePlanV2,
): Record<string, DailyAgg> {
  const aggregates: Map<string, DailyAgg> = new Map<string, DailyAgg>();
  for (const split of plan.splits) {
    const aggregate: DailyAgg = seedClosureAggregateV2(aggregates, input, split.date);
    aggregate.focusMs = checkedAdd(aggregate.focusMs, split.ms, 'aggregate focus');
  }
  const ended: DailyAgg = seedClosureAggregateV2(aggregates, input, plan.endedDate);
  ended.sessionsCompleted = checkedAdd(
    ended.sessionsCompleted,
    plan.completionIncrement,
    'completed sessions',
  );

  return Object.fromEntries(
    [...aggregates.entries()].map(([key, aggregate]: [string, DailyAgg]): [string, DailyAgg] => [
      key,
      capAttempts(aggregate, TOP_SITES_DAILY),
    ]),
  );
}

/** One seeded aggregate per touched date, built once and then added to in place. */
function seedClosureAggregateV2(
  aggregates: Map<string, DailyAgg>,
  input: ClosureProjectionInputV2,
  date: string,
): DailyAgg {
  const key: string = syncAggKey(input.deviceId, date);
  const known: DailyAgg | undefined = aggregates.get(key);
  if (known !== undefined) return known;
  const seeded: DailyAgg = closureAggregateSeedV2(input, key, date);
  aggregates.set(key, seeded);
  return seeded;
}

/**
 * The live runtime aggregate seeds its own date, a stored aggregate seeds any other date, and only
 * a date with nothing stored yet starts empty. A date earlier than the runtime date has already
 * been finished and written, so the caller must supply it: seeding it empty would replace that
 * day's attempts, sessions, and earlier focus with this closure's split alone.
 */
function closureAggregateSeedV2(
  input: ClosureProjectionInputV2,
  key: string,
  date: string,
): DailyAgg {
  if (date === input.runtimeDate && input.todayAgg !== null) {
    return structuredClone(input.todayAgg);
  }
  const prior: DailyAgg | undefined = input.priorAggregates[key];
  if (prior !== undefined) {
    if (prior.date !== date) invalidClosure(`the stored aggregate ${key} belongs to another date`);
    return structuredClone(prior);
  }
  if (date < input.runtimeDate) {
    invalidClosure(`settling focus on ${date} needs the stored aggregate ${key}`);
  }
  return emptyDaily(date);
}

/**
 * Focus credit ends at the last focus instant. A live focus phase settles through the closure end
 * bounded by its own end, and a break or pause settles through the instant that phase began.
 */
function settlementEndV2(session: SessionStateV2, endedAt: number): number {
  if (session.phase !== 'focus') return session.phaseStartedAt;
  return Math.min(endedAt, session.phaseEndsAt ?? endedAt);
}

function assertClosureInput(input: ClosureProjectionInputV2): void {
  assertSafeTimestamp(input.endedAt, 'closure end');
  assertSafeTimestamp(input.accruedFocusMs, 'accrued focus');
  if (!isNonBlankString(input.deviceId)) invalidClosure('a closure aggregate needs a device ID');
  if (input.endedAt < input.session.phaseStartedAt) {
    invalidClosure('closure end cannot precede the current phase start');
  }
  if (input.todayAgg !== null && input.todayAgg.date !== input.runtimeDate) {
    invalidClosure('the runtime aggregate must belong to the runtime date');
  }
}

/** The first instant of the next local day, which is where one date's focus share stops. */
function nextLocalMidnight(at: number): number {
  const local: Date = new Date(at);
  const year: number = local.getFullYear();
  if (year < 1000 || year > 9999) {
    invalidClosure('a focus split boundary must have a four-digit local year');
  }
  const midnight: number = new Date(year, local.getMonth(), local.getDate() + 1).getTime();
  if (!Number.isSafeInteger(midnight) || midnight <= at) {
    invalidClosure('local midnight must advance past the focus split cursor');
  }
  return midnight;
}

function checkedAdd(left: number, right: number, label: string): number {
  const total: number = left + right;
  if (!Number.isSafeInteger(total) || total < 0) {
    invalidClosure(`${label} must stay a non-negative safe integer`);
  }
  return total;
}

function assertSafeTimestamp(value: number, label: string): void {
  if (!isSafeTimestamp(value)) invalidClosure(`${label} must be a non-negative safe integer`);
}

function invalidClosure(message: string): never {
  throw new CoreError('invalid-rule', message);
}

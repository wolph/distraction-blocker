/**
 * Direct fixtures for the background v2 runtime contracts. Every helper builds a fresh graph per
 * call and never calls a production builder, so a test can mutate what it receives and a rejection
 * case can differ from the accepted one by exactly one field.
 *
 * Sections: identities, cleanup, closure. Later tasks append transition and runtime sections.
 */

import type { FrozenDocumentCommand } from '../../../src/background/enforcement-persistence-v2';
import type { RuntimeTabState } from '../../../src/background/runtime-leaf-types';
import type {
  CleanupEnforcementTarget,
  CleanupProgress,
  CleanupRetryState,
  CleanupSeed,
  CleanupTabClaim,
  ClosureProjection,
  PendingClosure,
  PostCleanupClosure,
} from '../../../src/background/runtime-v2-types';
import type {
  BankState,
  DailyAgg,
  HandledScheduleOccurrence,
  LegacyEventRecord,
  ScheduleOccurrenceRef,
  SessionEndedEventV2,
} from '../../../src/shared/types';

export type PreparedClosureV2 = Extract<PendingClosure, { stage: 'prepared' }>;
export type CleanupClosureV2 = Extract<PendingClosure, { stage: 'cleanup' }>;
export type BudgetEarnedEvent = Extract<LegacyEventRecord, { t: 'budgetEarned' }>;

export const NOW: number = 1_750_000_000_000;
export const CLOSED_AT: number = NOW + 30_000;
export const SESSION_ID: string = '10000000-0000-4000-8000-000000000001';
export const OTHER_SESSION_ID: string = '10000000-0000-4000-8000-000000000002';
export const CLEANUP_OPERATION_ID: string = '20000000-0000-4000-8000-000000000001';
export const OTHER_OPERATION_ID: string = '20000000-0000-4000-8000-000000000002';
export const EPOCH_ID: string = '30000000-0000-4000-8000-000000000001';
export const OTHER_EPOCH_ID: string = '30000000-0000-4000-8000-000000000002';
export const CLEAR_RUNTIME_REVISION: number = 9;
export const TARGET_URL: string = 'https://example.com/path';
export const SECOND_TARGET_URL: string = 'https://news.example.com/story';
export const LOCAL_DATE: string = '2026-09-02';
export const ENTRY_ID: string = 'weekday';
export const AGGREGATE_KEY: string = `agg:device-1:${LOCAL_DATE}`;
export const ARCHIVE_AGGREGATE_KEY: string = `archive:clock-rebase:device-1:${LOCAL_DATE}:1:rebase`;
export const HANDLED_OCCURRENCE_TTL_MS: number = 14 * 24 * 60 * 60 * 1000;

// Cleanup fixtures.

export function documentKey(tabId: number, documentId: string): string {
  return `${tabId}:${documentId}`;
}

export function cleanupRetryState(overrides: Partial<CleanupRetryState> = {}): CleanupRetryState {
  return {
    batch: 0,
    automaticAttempt: 1,
    nextAttemptAt: NOW + 60_000,
    lastError: null,
    ...overrides,
  };
}

export function runtimeTabState(overrides: Partial<RuntimeTabState> = {}): RuntimeTabState {
  return {
    muteUrl: 'https://example.com/muted',
    priorMuted: false,
    stoppedDocumentId: 'document-1',
    ...overrides,
  };
}

export function cleanupTabClaim(
  tabId: number = 11,
  state: Partial<RuntimeTabState> = {},
): CleanupTabClaim {
  return { tabId, state: runtimeTabState(state) };
}

export function cleanupSeed(overrides: Partial<CleanupSeed> = {}): CleanupSeed {
  return {
    alarmNames: ['closure-cleanup', 'phase'],
    tabClaims: [cleanupTabClaim(11), cleanupTabClaim(12)],
    ...overrides,
  };
}

export function cleanupTarget(
  overrides: Partial<CleanupEnforcementTarget> = {},
): CleanupEnforcementTarget {
  return { tabId: 11, documentId: 'document-1', expectedUrl: TARGET_URL, ...overrides };
}

export function cleanupTargetMap(): Record<string, CleanupEnforcementTarget> {
  return {
    [documentKey(11, 'document-1')]: cleanupTarget(),
    [documentKey(12, 'document-2')]: cleanupTarget({
      tabId: 12,
      documentId: 'document-2',
      expectedUrl: SECOND_TARGET_URL,
    }),
  };
}

export function clearCommand(
  overrides: Partial<FrozenDocumentCommand> = {},
): FrozenDocumentCommand {
  return {
    version: 1,
    command: 'apply-enforcement',
    operationId: CLEANUP_OPERATION_ID,
    enforcementEpoch: EPOCH_ID,
    sessionId: SESSION_ID,
    reservedSessionId: null,
    basePolicyRevision: 4,
    runtimeRevision: CLEAR_RUNTIME_REVISION,
    documentId: 'document-1',
    expectedUrl: TARGET_URL,
    presentation: 'clear',
    verdict: { blocked: false, reason: 'no-session', categoryId: null, matchedPattern: null },
    overlay: null,
    tabId: 11,
    ...overrides,
  };
}

export function clearCommandMap(
  overrides: Partial<FrozenDocumentCommand> = {},
): Record<string, FrozenDocumentCommand> {
  return {
    [documentKey(11, 'document-1')]: clearCommand(overrides),
    [documentKey(12, 'document-2')]: clearCommand({
      tabId: 12,
      documentId: 'document-2',
      expectedUrl: SECOND_TARGET_URL,
      ...overrides,
    }),
  };
}

export function cleanupProgress(overrides: Partial<CleanupProgress> = {}): CleanupProgress {
  const cleanupOperationId: string = overrides.cleanupOperationId ?? CLEANUP_OPERATION_ID;
  const clearRuntimeRevision: number = overrides.clearRuntimeRevision ?? CLEAR_RUNTIME_REVISION;
  return {
    cleanupOperationId,
    clearRuntimeRevision,
    targets: cleanupTargetMap(),
    clearCommands: clearCommandMap({
      operationId: cleanupOperationId,
      runtimeRevision: clearRuntimeRevision,
    }),
    tabClaims: [cleanupTabClaim(11), cleanupTabClaim(12)],
    resolvedTabIds: [],
    retry: cleanupRetryState(),
    ...overrides,
  };
}

// Closure fixtures.

export function sessionEndedEvent(
  overrides: Partial<SessionEndedEventV2> = {},
): SessionEndedEventV2 {
  return {
    version: 2,
    t: 'sessionEnded',
    eventId: `${SESSION_ID}:end`,
    at: CLOSED_AT,
    sessionId: SESSION_ID,
    outcome: 'completed',
    reason: 'manual-completed',
    focusedMs: 30_000,
    duration: { kind: 'until-stopped' },
    source: 'manual',
    scheduleOccurrence: null,
    ...overrides,
  };
}

/** The one canceled end that the v1 missing-occurrence migration cleanup may leave unoccurred. */
export function migrationInvalidActiveEndEvent(
  overrides: Partial<SessionEndedEventV2> = {},
): SessionEndedEventV2 {
  return sessionEndedEvent({
    outcome: 'canceled',
    reason: 'invalid-active-state',
    duration: { kind: 'timed', minutes: 25 },
    source: 'schedule',
    scheduleOccurrence: null,
    ...overrides,
  });
}

export function budgetEarnedEvent(overrides: Partial<BudgetEarnedEvent> = {}): BudgetEarnedEvent {
  return { t: 'budgetEarned', at: NOW + 10_000, ms: 5_000, sessionId: SESSION_ID, ...overrides };
}

export function scheduleOccurrence(
  overrides: Partial<ScheduleOccurrenceRef> = {},
): ScheduleOccurrenceRef {
  return {
    version: 1,
    token: `${ENTRY_ID}@${LOCAL_DATE}`,
    entryId: ENTRY_ID,
    localStartDate: LOCAL_DATE,
    ...overrides,
  };
}

export function handledOccurrence(
  overrides: Partial<HandledScheduleOccurrence> = {},
): HandledScheduleOccurrence {
  return {
    version: 1,
    token: `${ENTRY_ID}@${LOCAL_DATE}`,
    entryId: ENTRY_ID,
    localStartDate: LOCAL_DATE,
    handledAt: NOW,
    reason: 'closure-overlap',
    expiresAt: NOW + HANDLED_OCCURRENCE_TTL_MS,
    ...overrides,
  };
}

export function bankState(overrides: Partial<BankState> = {}): BankState {
  return { balanceMs: 120_000, ...overrides };
}

export function dailyAgg(overrides: Partial<DailyAgg> = {}): DailyAgg {
  return {
    date: LOCAL_DATE,
    focusMs: 30_000,
    sessionsStarted: 1,
    sessionsCompleted: 1,
    attempts: { 'example.com': 2 },
    attemptsOther: 0,
    pausesTaken: 0,
    pauseMsSpent: 0,
    pauseMsEarned: 5_000,
    unlocksTaken: 0,
    unlockMsSpent: 0,
    resisted: 1,
    ...overrides,
  };
}

/** Fields the end event owns are derived from it, so one override keeps the whole graph agreeing. */
export function closureProjection(overrides: Partial<ClosureProjection> = {}): ClosureProjection {
  const endEvent: SessionEndedEventV2 = overrides.endEvent ?? sessionEndedEvent();
  return {
    closureId: `${SESSION_ID}:close`,
    sessionId: SESSION_ID,
    endedAt: endEvent.at,
    reason: endEvent.reason,
    outcome: endEvent.outcome,
    focusedMs: endEvent.focusedMs,
    endEvent,
    events: [budgetEarnedEvent(), endEvent],
    handledOccurrences: [handledOccurrence()],
    completionIncrement: endEvent.outcome === 'completed' ? 1 : 0,
    bankAfter: bankState(),
    aggregateSets: { [AGGREGATE_KEY]: dailyAgg() },
    aggregateRemoves: [],
    ...overrides,
  };
}

export function preparedClosure(overrides: Partial<PreparedClosureV2> = {}): PreparedClosureV2 {
  return {
    version: 1,
    stage: 'prepared',
    projection: closureProjection(),
    cleanupSeed: cleanupSeed(),
    cleanupProgress: null,
    ...overrides,
  };
}

export function cleanupClosure(overrides: Partial<CleanupClosureV2> = {}): CleanupClosureV2 {
  return {
    version: 1,
    stage: 'cleanup',
    projection: closureProjection(),
    cleanupSeed: cleanupSeed(),
    cleanupProgress: cleanupProgress(),
    ...overrides,
  };
}

export function postCleanupClosure(
  overrides: Partial<PostCleanupClosure> = {},
): PostCleanupClosure {
  return { projection: closureProjection(), cleanupSeed: cleanupSeed(), ...overrides };
}

/** The exact invalid-active migration cleanup: a scheduled canceled close with no occurrence. */
export function migrationInvalidActiveClosure(): CleanupClosureV2 {
  const endEvent: SessionEndedEventV2 = migrationInvalidActiveEndEvent();
  return cleanupClosure({
    projection: closureProjection({
      endEvent,
      events: [budgetEarnedEvent(), endEvent],
      handledOccurrences: [],
      aggregateSets: { [AGGREGATE_KEY]: dailyAgg({ sessionsCompleted: 0 }) },
    }),
    cleanupProgress: cleanupProgress({ clearRuntimeRevision: 1 }),
  });
}

/**
 * Direct fixtures for the background v2 runtime contracts. Every helper builds a fresh graph per
 * call and never calls a production builder, so a test can mutate what it receives and a rejection
 * case can differ from the accepted one by exactly one field.
 *
 * Sections: identities, cleanup, closure, transition, runtime.
 */

import type {
  DocumentEnforcementAck,
  DocumentEpochResetAck,
  EnforcementCheckpoint,
  FrozenDocumentCommand,
} from '../../../src/background/enforcement-persistence-v2';
import type {
  DeferredBlockClaim,
  RuntimeTabState,
} from '../../../src/background/runtime-leaf-types';
import type {
  CandidateScheduleWindow,
  CleanupEnforcementTarget,
  CleanupProgress,
  CleanupRetryState,
  CleanupSeed,
  CleanupTabClaim,
  ClosureProjection,
  FrozenTransitionView,
  PendingClosure,
  PendingEnforcementTransition,
  PostCleanupClosure,
  PreparedTargetReservation,
  RuntimeCommitCheckpointV2,
  RuntimeDomainProjectionV2,
  RuntimeStateV2,
  SessionStartCandidate,
  TransitionStage,
} from '../../../src/background/runtime-v2-types';
import {
  HANDLED_SCHEDULE_OCCURRENCE_RETENTION_MS,
  MAX_HANDLED_SCHEDULE_OCCURRENCES,
} from '../../../src/shared/constants';
import type { ActiveOverlayCopy, DocumentOverlayView } from '../../../src/shared/enforcement-v2';
import type {
  BankState,
  CategoryId,
  DailyAgg,
  GateState,
  HandledScheduleOccurrence,
  LegacyEventRecord,
  ScheduleOccurrenceRef,
  SessionConfigV2,
  SessionEndedEventV2,
  SessionRuleSnapshot,
  SessionStartedEventV2,
  SessionStateV2,
  Verdict,
} from '../../../src/shared/types';

export type PreparedClosureV2 = Extract<PendingClosure, { stage: 'prepared' }>;
export type CleanupClosureV2 = Extract<PendingClosure, { stage: 'cleanup' }>;
export type BudgetEarnedEvent = Extract<LegacyEventRecord, { t: 'budgetEarned' }>;
export type StartingOverlay = Extract<DocumentOverlayView, { presentation: 'starting' }>;
export type ActiveOverlay = Extract<DocumentOverlayView, { presentation: 'active' }>;
export type TransitionKind = PendingEnforcementTransition['kind'];
export type TransitionCleanupFrom = NonNullable<PendingEnforcementTransition['cleanupFrom']>;
export type TransitionCleanupCause = NonNullable<PendingEnforcementTransition['cleanupCause']>;

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
    basePolicyRevision: BASE_POLICY_REVISION,
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
    expiresAt: NOW + HANDLED_SCHEDULE_OCCURRENCE_RETENTION_MS,
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

// Transition fixtures.

export const TRANSITION_ID: string = '40000000-0000-4000-8000-000000000001';
export const STARTING_OPERATION_ID: string = '50000000-0000-4000-8000-000000000001';
export const ACTIVE_OPERATION_ID: string = '50000000-0000-4000-8000-000000000002';
export const BASE_POLICY_REVISION: number = 4;
export const TARGET_GENERATION: number = 3;
/** Local 2026-09-02 09:30, so the captured window agrees with LOCAL_DATE in any test timezone. */
export const REQUESTED_AT: number = new Date(2026, 8, 2, 9, 30, 0, 0).getTime();
export const ACTIVATION_AT: number = REQUESTED_AT + 5_000;
export const WINDOW_STARTS_AT: number = new Date(2026, 8, 2, 9, 0, 0, 0).getTime();
export const WINDOW_ENDS_AT: number = new Date(2026, 8, 2, 17, 0, 0, 0).getTime();
export const START_STARTING_REVISION: number = 0;
export const START_ACTIVE_REVISION: number = 1;
export const RESUME_STARTING_REVISION: number = 7;
export const RESUME_ACTIVE_REVISION: number = 8;
export const PROVENANCE: string = 'Blocked by Social media: example.com';
const FOCUS_MS: number = 1_500_000;
const CLOSING_CLEANUP_CAUSES: readonly string[] = [
  'timer-completed',
  'manual-end',
  'transition-failed',
];
const COMMITTED_STAGES: readonly string[] = [
  'committed-pending-verification',
  'alarm-ready',
  'active-verified',
];

export function blockedVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    blocked: true,
    reason: 'category',
    categoryId: 'social',
    matchedPattern: 'example.com',
    ...overrides,
  };
}

export function allowedVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    blocked: false,
    reason: 'default',
    categoryId: null,
    matchedPattern: null,
    ...overrides,
  };
}

export function sessionCategories(): Record<CategoryId, boolean> {
  return {
    social: true,
    video: false,
    news: false,
    mail: false,
    shopping: false,
    gaming: false,
    forums: false,
  };
}

/** The exact snapshot `normalizeSessionRules` returns for itself, written out rather than built. */
export function canonicalRules(overrides: Partial<SessionRuleSnapshot> = {}): SessionRuleSnapshot {
  return {
    baselineRevision: 'baseline-1',
    baselineCategories: sessionCategories(),
    categories: sessionCategories(),
    exclusions: {},
    permanentBlacklist: [],
    permanentAllowlist: [],
    sessionBlacklist: [],
    sessionAllowlist: [],
    ...overrides,
  };
}

export function candidateScheduleWindow(
  overrides: Partial<CandidateScheduleWindow> = {},
): CandidateScheduleWindow {
  return { windowStartsAt: WINDOW_STARTS_AT, windowEndsAt: WINDOW_ENDS_AT, ...overrides };
}

export function manualCandidate(
  overrides: Partial<SessionStartCandidate> = {},
): SessionStartCandidate {
  return {
    mode: 'blacklist',
    strictness: 'friction',
    duration: { kind: 'manual-timed', minutes: 25 },
    cycling: null,
    intention: 'Finish the release notes',
    source: 'manual',
    scheduleOccurrence: null,
    scheduleWindow: null,
    rules: canonicalRules(),
    ...overrides,
  };
}

export function untilStoppedCandidate(
  overrides: Partial<SessionStartCandidate> = {},
): SessionStartCandidate {
  return manualCandidate({
    strictness: 'flexible',
    duration: { kind: 'until-stopped' },
    cycling: null,
    ...overrides,
  });
}

export function scheduleCandidate(
  overrides: Partial<SessionStartCandidate> = {},
): SessionStartCandidate {
  return manualCandidate({
    duration: { kind: 'schedule-window' },
    source: 'schedule',
    scheduleOccurrence: scheduleOccurrence(),
    scheduleWindow: candidateScheduleWindow(),
    ...overrides,
  });
}

export function startingOverlay(overrides: Partial<StartingOverlay> = {}): StartingOverlay {
  return {
    version: 1,
    presentation: 'starting',
    capturedAt: REQUESTED_AT,
    theme: 'dark',
    stoppedPage: false,
    copy: {
      title: 'Focus Lock is starting',
      detail: 'Applying your selected rules.',
      verdictProvenance: PROVENANCE,
      stoppedPage: null,
    },
    actions: { end: 'hidden' },
    ...overrides,
  };
}

export function activeCopy(overrides: Partial<ActiveOverlayCopy> = {}): ActiveOverlayCopy {
  return {
    status: { kind: 'timed', text: 'Focus Lock is active for 25:00 more.' },
    lockedUntil: 'Locked until 09:55',
    intention: 'Finish the release notes',
    attempts: '2 attempts blocked today',
    verdictProvenance: PROVENANCE,
    stoppedPage: null,
    bankUnit: 'pause banked',
    pauseAction: 'Pause blocking for 1 min',
    unlockAction: 'Unlock this site for 2 min',
    endAction: 'End session',
    bankWaitFallback: 'earn pause time by focusing',
    bankWaitPrefix: 'ready in',
    gateTitle: null,
    gateBack: 'Never mind, back to work',
    gatePhraseLabel: 'Type this to confirm:',
    gateConfirm: null,
    transportError: 'Focus Lock could not update this action. Try again.',
    ...overrides,
  };
}

export function activeOverlay(
  overrides: Partial<ActiveOverlay> = {},
  capturedAt: number = ACTIVATION_AT,
): ActiveOverlay {
  return {
    version: 1,
    presentation: 'active',
    theme: 'dark',
    sessionId: SESSION_ID,
    phase: 'focus',
    mode: 'blacklist',
    strictness: 'friction',
    duration: { kind: 'timed', minutes: 25 },
    timing: {
      capturedAt,
      phaseStartedAt: capturedAt,
      phaseEndsAt: capturedAt + FOCUS_MS,
      sessionEndsAt: capturedAt + FOCUS_MS,
    },
    economy: {
      bankMs: 60_000,
      bankAccrualPerMs: 1 / 6,
      bankCapMs: 300_000,
      pauseCostMs: 60_000,
      unlockCostMs: 120_000,
    },
    gate: null,
    activeUnlocks: [{ host: 'example.com', until: capturedAt + 30_000 }],
    attemptsToday: 2,
    stoppedPage: false,
    actions: { state: 'ready', end: 'request-end', pause: 'request-gate', unlock: 'request-gate' },
    copy: activeCopy(),
    ...overrides,
  };
}

/** Indefinite focus: no phase or session end, no timed status copy, and no immediate End action. */
export function untilStoppedActiveOverlay(
  overrides: Partial<ActiveOverlay> = {},
  capturedAt: number = ACTIVATION_AT,
): ActiveOverlay {
  return activeOverlay(
    {
      strictness: 'flexible',
      duration: { kind: 'until-stopped' },
      timing: {
        capturedAt,
        phaseStartedAt: capturedAt,
        phaseEndsAt: null,
        sessionEndsAt: null,
      },
      actions: { state: 'ready', end: 'hidden', pause: 'request-gate', unlock: 'request-gate' },
      copy: activeCopy({
        status: {
          kind: 'until-stopped',
          text: 'Focus Lock is active until you end it from the popup.',
        },
        lockedUntil: null,
      }),
      ...overrides,
    },
    capturedAt,
  );
}

/**
 * The cancel gate a committed Friction End persists. It opens at a command time after activation,
 * while the replacement active view keeps the frozen `capturedAt` anchor the transition captured.
 */
export function cancelGateState(overrides: Partial<GateState> = {}): GateState {
  return {
    kind: 'cancel',
    host: null,
    openedAt: ACTIVATION_AT + 3_000,
    readyAt: ACTIVATION_AT + 8_000,
    requiredPhrase: 'end my session',
    ...overrides,
  };
}

/** The replacement active view a committed Friction transition freezes when End opens its gate. */
export function gatedActiveOverlay(
  overrides: Partial<ActiveOverlay> = {},
  capturedAt: number = ACTIVATION_AT,
): ActiveOverlay {
  return activeOverlay(
    {
      gate: cancelGateState(),
      actions: { state: 'gate', end: 'hidden', pause: 'hidden', unlock: 'hidden' },
      copy: activeCopy({ gateTitle: 'End this session?', gateConfirm: 'End the session' }),
      ...overrides,
    },
    capturedAt,
  );
}

export function startingCommand(
  overrides: Partial<FrozenDocumentCommand> = {},
): FrozenDocumentCommand {
  return {
    version: 1,
    command: 'apply-enforcement',
    operationId: STARTING_OPERATION_ID,
    enforcementEpoch: EPOCH_ID,
    sessionId: null,
    reservedSessionId: SESSION_ID,
    basePolicyRevision: BASE_POLICY_REVISION,
    runtimeRevision: START_STARTING_REVISION,
    documentId: 'document-1',
    expectedUrl: TARGET_URL,
    presentation: 'starting',
    verdict: blockedVerdict(),
    overlay: startingOverlay(),
    tabId: 11,
    ...overrides,
  };
}

export function activeCommand(
  overrides: Partial<FrozenDocumentCommand> = {},
): FrozenDocumentCommand {
  return startingCommand({
    operationId: ACTIVE_OPERATION_ID,
    sessionId: SESSION_ID,
    reservedSessionId: null,
    runtimeRevision: START_ACTIVE_REVISION,
    presentation: 'active',
    overlay: activeOverlay(),
    ...overrides,
  });
}

/** One blocked document that carries the frozen overlay and one allowed document that does not. */
export function startingCommandMap(
  overrides: Partial<FrozenDocumentCommand> = {},
  capturedAt: number = REQUESTED_AT,
): Record<string, FrozenDocumentCommand> {
  return {
    [documentKey(11, 'document-1')]: startingCommand({
      overlay: startingOverlay({ capturedAt }),
      ...overrides,
    }),
    [documentKey(12, 'document-2')]: startingCommand({
      tabId: 12,
      documentId: 'document-2',
      expectedUrl: SECOND_TARGET_URL,
      verdict: allowedVerdict(),
      overlay: null,
      ...overrides,
    }),
  };
}

export function activeCommandMap(
  overrides: Partial<FrozenDocumentCommand> = {},
  capturedAt: number = ACTIVATION_AT,
  overlay: ActiveOverlay = activeOverlay({}, capturedAt),
): Record<string, FrozenDocumentCommand> {
  return {
    [documentKey(11, 'document-1')]: activeCommand({
      overlay,
      ...overrides,
    }),
    [documentKey(12, 'document-2')]: activeCommand({
      tabId: 12,
      documentId: 'document-2',
      expectedUrl: SECOND_TARGET_URL,
      verdict: allowedVerdict(),
      overlay: null,
      ...overrides,
    }),
  };
}

export function frozenStartingView(
  kind: TransitionKind = 'start',
  overrides: Partial<FrozenTransitionView> = {},
): FrozenTransitionView {
  const capturedAt: number = overrides.capturedAt ?? REQUESTED_AT;
  const operationId: string = overrides.operationId ?? STARTING_OPERATION_ID;
  const runtimeRevision: number = overrides.runtimeRevision ?? startingRevision(kind);
  return {
    capturedAt,
    operationId,
    enforcementEpoch: EPOCH_ID,
    basePolicyRevision: BASE_POLICY_REVISION,
    runtimeRevision,
    documents: startingCommandMap(
      { operationId, runtimeRevision, ...sessionIdentity(kind === 'resume') },
      capturedAt,
    ),
    ...overrides,
  };
}

export function frozenActiveView(
  kind: TransitionKind = 'start',
  overrides: Partial<FrozenTransitionView> = {},
): FrozenTransitionView {
  const capturedAt: number = overrides.capturedAt ?? ACTIVATION_AT;
  const operationId: string = overrides.operationId ?? ACTIVE_OPERATION_ID;
  const runtimeRevision: number = overrides.runtimeRevision ?? activeRevision(kind);
  return {
    capturedAt,
    operationId,
    enforcementEpoch: EPOCH_ID,
    basePolicyRevision: BASE_POLICY_REVISION,
    runtimeRevision,
    documents: activeCommandMap({ operationId, runtimeRevision }, capturedAt),
    ...overrides,
  };
}

export function preparedReservation(
  overrides: Partial<PreparedTargetReservation> = {},
): PreparedTargetReservation {
  return {
    tabId: 11,
    documentId: 'document-1',
    expectedUrl: TARGET_URL,
    commandKey: documentKey(11, 'document-1'),
    ...overrides,
  };
}

export function preparedReservationMap(): Record<string, PreparedTargetReservation> {
  return {
    [documentKey(11, 'document-1')]: preparedReservation(),
    [documentKey(12, 'document-2')]: preparedReservation({
      tabId: 12,
      documentId: 'document-2',
      expectedUrl: SECOND_TARGET_URL,
      commandKey: documentKey(12, 'document-2'),
    }),
  };
}

export function enforcementAck(
  overrides: Partial<DocumentEnforcementAck> = {},
): DocumentEnforcementAck {
  return {
    version: 1,
    operationId: STARTING_OPERATION_ID,
    enforcementEpoch: EPOCH_ID,
    sessionId: SESSION_ID,
    reservedSessionId: null,
    basePolicyRevision: BASE_POLICY_REVISION,
    runtimeRevision: START_ACTIVE_REVISION,
    tabId: 11,
    documentId: 'document-1',
    url: TARGET_URL,
    verdict: blockedVerdict(),
    handledAt: ACTIVATION_AT,
    ...overrides,
  };
}

export function transitionCheckpoint(
  overrides: Partial<EnforcementCheckpoint> = {},
): EnforcementCheckpoint {
  const operationId: string = overrides.operationId ?? STARTING_OPERATION_ID;
  return {
    version: 1,
    operationId,
    enforcementEpoch: EPOCH_ID,
    sessionId: SESSION_ID,
    basePolicyRevision: BASE_POLICY_REVISION,
    kind: 'activation',
    registrationAuditedAt: REQUESTED_AT + 1_000,
    completedAt: REQUESTED_AT + 2_000,
    targetGeneration: TARGET_GENERATION,
    documents: [enforcementAck({ operationId })],
    exclusions: [],
    ...overrides,
  };
}

/** A start reserves its identity before commit, so its starting acknowledgements are reserved. */
export function transitionStartingCheckpoint(kind: TransitionKind): EnforcementCheckpoint {
  const reserved: boolean = kind === 'start';
  return transitionCheckpoint({
    operationId: STARTING_OPERATION_ID,
    kind: reserved ? 'activation' : 'resume-strengthening',
    documents: [
      enforcementAck({
        operationId: STARTING_OPERATION_ID,
        runtimeRevision: startingRevision(kind),
        ...sessionIdentity(!reserved),
      }),
    ],
  });
}

export function transitionActiveCheckpoint(kind: TransitionKind): EnforcementCheckpoint {
  return transitionCheckpoint({
    operationId: ACTIVE_OPERATION_ID,
    kind: kind === 'start' ? 'activation' : 'resume-strengthening',
    registrationAuditedAt: ACTIVATION_AT + 1_000,
    completedAt: ACTIVATION_AT + 2_000,
    documents: [
      enforcementAck({ operationId: ACTIVE_OPERATION_ID, runtimeRevision: activeRevision(kind) }),
    ],
  });
}

export function pendingTransition(
  kind: TransitionKind,
  stage: Exclude<TransitionStage, 'cleanup'>,
  overrides: Partial<PendingEnforcementTransition> = {},
): PendingEnforcementTransition {
  return {
    version: 1,
    kind,
    stage,
    transitionId: TRANSITION_ID,
    startingOperationId: STARTING_OPERATION_ID,
    activeOperationId: ACTIVE_OPERATION_ID,
    enforcementEpoch: EPOCH_ID,
    basePolicyRevision: BASE_POLICY_REVISION,
    runtimeRevision: startingRevision(kind),
    sessionId: SESSION_ID,
    trigger: kind === 'start' ? 'manual' : 'pause-expired',
    requestedAt: REQUESTED_AT,
    candidate: kind === 'start' ? manualCandidate() : null,
    priorPhase: kind === 'start' ? null : 'paused',
    activationAt: null,
    verificationStartedAt: null,
    freshnessAttempts: 0,
    targetGeneration: TARGET_GENERATION,
    preparedTargetReservations: {},
    startingView: frozenStartingView(kind),
    activeView: null,
    startingCheckpoint: null,
    checkpoint: null,
    alarmNames: [],
    failure: null,
    cleanupProgress: null,
    cleanupFrom: null,
    cleanupCause: null,
    postCleanupClosure: null,
    ...transitionStagePatch(kind, stage),
    ...overrides,
  };
}

export function cleanupTransition(
  kind: TransitionKind,
  cleanupFrom: TransitionCleanupFrom,
  cleanupCause: TransitionCleanupCause,
  overrides: Partial<PendingEnforcementTransition> = {},
): PendingEnforcementTransition {
  const durable: boolean = kind === 'resume' || COMMITTED_STAGES.includes(cleanupFrom);
  return {
    ...pendingTransition(kind, cleanupFrom),
    stage: 'cleanup',
    runtimeRevision: CLEAR_RUNTIME_REVISION,
    preparedTargetReservations: {},
    failure: cleanupCause === 'transition-failed' ? 'tab-enforcement-failed' : null,
    cleanupProgress: cleanupProgress({
      clearCommands: clearCommandMap({
        operationId: CLEANUP_OPERATION_ID,
        runtimeRevision: CLEAR_RUNTIME_REVISION,
        ...sessionIdentity(durable),
      }),
    }),
    cleanupFrom,
    cleanupCause,
    postCleanupClosure: CLOSING_CLEANUP_CAUSES.includes(cleanupCause) ? postCleanupClosure() : null,
    ...overrides,
  };
}

function startingRevision(kind: TransitionKind): number {
  return kind === 'start' ? START_STARTING_REVISION : RESUME_STARTING_REVISION;
}

function activeRevision(kind: TransitionKind): number {
  return kind === 'start' ? START_ACTIVE_REVISION : RESUME_ACTIVE_REVISION;
}

/** A committed row names the durable session, a pre-commit start names only its reserved one. */
function sessionIdentity(durable: boolean): Partial<FrozenDocumentCommand> {
  return durable
    ? { sessionId: SESSION_ID, reservedSessionId: null }
    : { sessionId: null, reservedSessionId: SESSION_ID };
}

function transitionStagePatch(
  kind: TransitionKind,
  stage: Exclude<TransitionStage, 'cleanup'>,
): Partial<PendingEnforcementTransition> {
  switch (stage) {
    case 'prepared':
    case 'registration-audited':
      return { preparedTargetReservations: preparedReservationMap() };
    case 'starting-verified':
      return { startingCheckpoint: transitionStartingCheckpoint(kind) };
    case 'committed-pending-verification':
      return committedTransitionPatch(kind, 0);
    case 'alarm-ready':
      return committedTransitionPatch(kind, 1);
    case 'active-verified':
      return {
        ...committedTransitionPatch(kind, 2),
        checkpoint: transitionActiveCheckpoint(kind),
      };
  }
}

function committedTransitionPatch(
  kind: TransitionKind,
  freshnessAttempts: number,
): Partial<PendingEnforcementTransition> {
  return {
    runtimeRevision: activeRevision(kind),
    activationAt: ACTIVATION_AT,
    verificationStartedAt: ACTIVATION_AT,
    freshnessAttempts,
    activeView: frozenActiveView(kind),
    startingCheckpoint: transitionStartingCheckpoint(kind),
    alarmNames: ['phase'],
  };
}

// Runtime fixtures.

export const PUBLISHED_REVISION: number = START_ACTIVE_REVISION;
/** A resumed session started well before the transition that resumes it. */
export const RESUMED_STARTED_AT: number = ACTIVATION_AT - 600_000;
/** The logical end every runtime closure fixture projects, on the transition timeline. */
export const RUNTIME_CLOSED_AT: number = ACTIVATION_AT + 60_000;
export { MAX_HANDLED_SCHEDULE_OCCURRENCES };
export const ATTEMPT_DEBOUNCE_KEY: string = `11:${TARGET_URL}`;

export function sessionConfigV2(overrides: Partial<SessionConfigV2> = {}): SessionConfigV2 {
  return {
    mode: 'blacklist',
    strictness: 'friction',
    duration: { kind: 'timed', minutes: 25 },
    cycling: null,
    intention: 'Finish the release notes',
    source: 'manual',
    scheduleOccurrence: null,
    rules: canonicalRules(),
    ...overrides,
  };
}

/** The timed focus a committed start commits, so its start and phase both begin at activation. */
export function timedFocusSession(overrides: Partial<SessionStateV2> = {}): SessionStateV2 {
  return {
    version: 2,
    sessionId: SESSION_ID,
    config: sessionConfigV2(),
    startedAt: ACTIVATION_AT,
    sessionEndsAt: ACTIVATION_AT + FOCUS_MS,
    phase: 'focus',
    phaseStartedAt: ACTIVATION_AT,
    phaseEndsAt: ACTIVATION_AT + FOCUS_MS,
    cycleIndex: 0,
    pausedFrom: null,
    focusedMs: 0,
    ...overrides,
  };
}

/** Indefinite focus: no session or phase end, Flexible strictness, and no cycling. */
export function untilStoppedFocusSession(overrides: Partial<SessionStateV2> = {}): SessionStateV2 {
  return timedFocusSession({
    config: sessionConfigV2({ strictness: 'flexible', duration: { kind: 'until-stopped' } }),
    sessionEndsAt: null,
    phaseEndsAt: null,
    ...overrides,
  });
}

/** The durable pause a resume transition leaves in place until it commits. */
export function pausedSession(overrides: Partial<SessionStateV2> = {}): SessionStateV2 {
  return timedFocusSession({
    startedAt: RESUMED_STARTED_AT,
    sessionEndsAt: RESUMED_STARTED_AT + FOCUS_MS,
    phase: 'paused',
    phaseStartedAt: RESUMED_STARTED_AT + 60_000,
    phaseEndsAt: RESUMED_STARTED_AT + 120_000,
    pausedFrom: { phase: 'focus', phaseEndsAt: RESUMED_STARTED_AT + FOCUS_MS },
    focusedMs: 60_000,
    ...overrides,
  });
}

/** A break needs its cycling config, and carries no paused-from record. */
export function breakSession(overrides: Partial<SessionStateV2> = {}): SessionStateV2 {
  return pausedSession({
    config: sessionConfigV2({
      cycling: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 },
    }),
    phase: 'break',
    pausedFrom: null,
    ...overrides,
  });
}

/** The same durable session after a resume commit: focus restarted at the captured activation. */
export function resumedFocusSession(overrides: Partial<SessionStateV2> = {}): SessionStateV2 {
  return pausedSession({
    phase: 'focus',
    phaseStartedAt: ACTIVATION_AT,
    phaseEndsAt: RESUMED_STARTED_AT + FOCUS_MS,
    pausedFrom: null,
    ...overrides,
  });
}

export function sessionStartedEvent(
  overrides: Partial<SessionStartedEventV2> = {},
): SessionStartedEventV2 {
  return {
    version: 2,
    t: 'sessionStarted',
    eventId: `${SESSION_ID}:start`,
    at: ACTIVATION_AT,
    sessionId: SESSION_ID,
    source: 'manual',
    mode: 'blacklist',
    strictness: 'flexible',
    duration: { kind: 'until-stopped' },
    intention: 'Finish the release notes',
    scheduleOccurrence: null,
    ...overrides,
  };
}

export function epochResetAck(
  overrides: Partial<DocumentEpochResetAck> = {},
): DocumentEpochResetAck {
  return {
    version: 1,
    operationId: OTHER_OPERATION_ID,
    enforcementEpoch: EPOCH_ID,
    tabId: 11,
    documentId: 'document-1',
    url: TARGET_URL,
    handledAt: REQUESTED_AT,
    ...overrides,
  };
}

export function epochResetAckMap(
  overrides: Partial<DocumentEpochResetAck> = {},
): Record<string, DocumentEpochResetAck> {
  return { [documentKey(11, 'document-1')]: epochResetAck(overrides) };
}

export function deferredBlockClaim(
  overrides: Partial<DeferredBlockClaim> = {},
): DeferredBlockClaim {
  return {
    attemptAt: ACTIVATION_AT,
    documentId: 'document-1',
    kind: 'navigation',
    sessionId: SESSION_ID,
    stage: 'stopped',
    tabId: 11,
    url: TARGET_URL,
    ...overrides,
  };
}

/** The live engine key. No stored rule constrains it, so fixtures simply keep its shape. */
export function deferredClaimKey(claim: DeferredBlockClaim): string {
  return `${claim.sessionId}:${claim.tabId}:${claim.url}:${claim.kind}:${claim.documentId ?? ''}`;
}

export function deferredBlockClaimMap(
  overrides: Partial<DeferredBlockClaim> = {},
): Record<string, DeferredBlockClaim> {
  const claim: DeferredBlockClaim = deferredBlockClaim(overrides);
  return { [deferredClaimKey(claim)]: claim };
}

/** Distinct handled tokens, for the deterministic 256-record retention cap. */
export function handledOccurrenceLog(count: number): HandledScheduleOccurrence[] {
  return Array.from(
    { length: count },
    (_unused: unknown, index: number): HandledScheduleOccurrence =>
      handledOccurrence({ entryId: `entry-${index}`, token: `entry-${index}@${LOCAL_DATE}` }),
  );
}

/** A closure projection on the runtime timeline, so its logical end follows the session start. */
export function runtimeClosureProjection(
  overrides: Partial<ClosureProjection> = {},
): ClosureProjection {
  return closureProjection({
    endEvent: sessionEndedEvent({ at: RUNTIME_CLOSED_AT }),
    ...overrides,
  });
}

export function emptyRuntimeV2(overrides: Partial<RuntimeStateV2> = {}): RuntimeStateV2 {
  return {
    runtimeSchemaVersion: 2,
    session: null,
    gate: null,
    unlocks: [],
    tabStates: {},
    accruedFocusMs: 0,
    attemptDebounce: {},
    deferredBlockClaims: {},
    removedTabTombstones: {},
    scheduleUnavailableNoticeToken: null,
    handledScheduleOccurrences: [],
    enforcementEpoch: EPOCH_ID,
    epochResetAcks: {},
    basePolicyRevision: BASE_POLICY_REVISION,
    runtimeRevision: 0,
    documentCommands: {},
    enforcementCheckpoint: null,
    pendingEnforcementTransition: null,
    pendingClosure: null,
    date: LOCAL_DATE,
    todayAgg: null,
    lastPruneDate: null,
    commitCheckpoint: null,
    ...overrides,
  };
}

/** The published focus a finished start leaves: durable session, checkpoint, current commands. */
export function publishedFocusRuntime(overrides: Partial<RuntimeStateV2> = {}): RuntimeStateV2 {
  return emptyRuntimeV2({
    session: timedFocusSession(),
    gate: null,
    unlocks: [{ host: 'example.com', until: ACTIVATION_AT + 30_000 }],
    tabStates: { 11: runtimeTabState() },
    accruedFocusMs: 45_000,
    attemptDebounce: { [ATTEMPT_DEBOUNCE_KEY]: ACTIVATION_AT },
    deferredBlockClaims: deferredBlockClaimMap(),
    removedTabTombstones: { 13: true },
    scheduleUnavailableNoticeToken: `${ENTRY_ID}@${LOCAL_DATE}`,
    handledScheduleOccurrences: [handledOccurrence({ reason: 'started' })],
    epochResetAcks: epochResetAckMap(),
    runtimeRevision: PUBLISHED_REVISION,
    documentCommands: activeCommandMap({
      operationId: ACTIVE_OPERATION_ID,
      runtimeRevision: PUBLISHED_REVISION,
    }),
    enforcementCheckpoint: transitionActiveCheckpoint('start'),
    todayAgg: dailyAgg(),
    lastPruneDate: LOCAL_DATE,
    ...overrides,
  });
}

/** The clear batch a paused or break runtime keeps until cleanup or closure replaces it. */
export function retainedClearCommandMap(): Record<string, FrozenDocumentCommand> {
  return clearCommandMap({ operationId: OTHER_OPERATION_ID, runtimeRevision: PUBLISHED_REVISION });
}

/** Pause and break publish with no focus checkpoint and an explicitly cleared document set. */
export function pausedRuntime(overrides: Partial<RuntimeStateV2> = {}): RuntimeStateV2 {
  return publishedFocusRuntime({
    session: pausedSession(),
    enforcementCheckpoint: null,
    documentCommands: retainedClearCommandMap(),
    ...overrides,
  });
}

export function breakRuntime(overrides: Partial<RuntimeStateV2> = {}): RuntimeStateV2 {
  return pausedRuntime({ session: breakSession(), ...overrides });
}

/**
 * A migrated active session before standalone recovery: journal-free focus with no checkpoint and
 * no document commands yet. Its accrued watermark already leads the session's settled focus.
 */
export function migratedActiveFocusRuntime(
  overrides: Partial<RuntimeStateV2> = {},
): RuntimeStateV2 {
  return publishedFocusRuntime({
    session: timedFocusSession({ focusedMs: 30_000 }),
    accruedFocusMs: 45_000,
    enforcementCheckpoint: null,
    epochResetAcks: {},
    runtimeRevision: 0,
    documentCommands: {},
    ...overrides,
  });
}

/** A closing transition cleanup whose projected end follows the activation it cleans up. */
export function transitionPostCleanupClosure(
  overrides: Partial<PostCleanupClosure> = {},
): PostCleanupClosure {
  return postCleanupClosure({ projection: runtimeClosureProjection(), ...overrides });
}

/**
 * Runtime around one stored transition. The frozen views own the transition commands, so a
 * transition never rewrites the runtime map: a resume keeps the batch its paused or break runtime
 * published at the older revision, and only cleanup replaces it with the exact clear batch.
 */
export function transitionRuntime(
  transition: PendingEnforcementTransition,
  overrides: Partial<RuntimeStateV2> = {},
): RuntimeStateV2 {
  return emptyRuntimeV2({
    session: transitionSession(transition),
    accruedFocusMs: 45_000,
    handledScheduleOccurrences: [handledOccurrence({ reason: 'started' })],
    basePolicyRevision: transitionBaseRevision(transition),
    runtimeRevision: transition.runtimeRevision,
    documentCommands: transitionCommandMap(transition),
    pendingEnforcementTransition: transition,
    ...overrides,
  });
}

/** The durable session stays while a prepared closure waits for its commit checkpoint. */
export function preparedClosureRuntime(overrides: Partial<RuntimeStateV2> = {}): RuntimeStateV2 {
  return publishedFocusRuntime({
    session: untilStoppedFocusSession({ focusedMs: 30_000 }),
    documentCommands: activeCommandMap(
      { operationId: ACTIVE_OPERATION_ID, runtimeRevision: PUBLISHED_REVISION },
      ACTIVATION_AT,
      untilStoppedActiveOverlay(),
    ),
    pendingClosure: preparedClosure({ projection: runtimeClosureProjection() }),
    ...overrides,
  });
}

/** Logical closure has committed: no session, the clear batch, and the projected handled records. */
export function cleanupClosureRuntime(overrides: Partial<RuntimeStateV2> = {}): RuntimeStateV2 {
  return emptyRuntimeV2({
    handledScheduleOccurrences: [handledOccurrence()],
    runtimeRevision: CLEAR_RUNTIME_REVISION,
    documentCommands: clearCommandMap({
      operationId: CLEANUP_OPERATION_ID,
      runtimeRevision: CLEAR_RUNTIME_REVISION,
    }),
    pendingClosure: cleanupClosure({ projection: runtimeClosureProjection() }),
    ...overrides,
  });
}

/** The projection a stored commit checkpoint repeats for every runtime field it owns. */
export function runtimeDomainProjection(runtime: RuntimeStateV2): RuntimeDomainProjectionV2 {
  return {
    session: structuredClone(runtime.session),
    gate: structuredClone(runtime.gate),
    unlocks: structuredClone(runtime.unlocks),
    accruedFocusMs: runtime.accruedFocusMs,
    handledScheduleOccurrences: structuredClone(runtime.handledScheduleOccurrences),
    enforcementEpoch: runtime.enforcementEpoch,
    epochResetAcks: structuredClone(runtime.epochResetAcks),
    basePolicyRevision: runtime.basePolicyRevision,
    runtimeRevision: runtime.runtimeRevision,
    documentCommands: structuredClone(runtime.documentCommands),
    enforcementCheckpoint: structuredClone(runtime.enforcementCheckpoint),
    pendingEnforcementTransition: structuredClone(runtime.pendingEnforcementTransition),
    pendingClosure: structuredClone(runtime.pendingClosure),
  };
}

export function runtimeCommitCheckpoint(
  runtime: RuntimeStateV2,
  overrides: Partial<RuntimeCommitCheckpointV2> = {},
): RuntimeCommitCheckpointV2 {
  return {
    version: 2,
    checkpointId: `${SESSION_ID}:closure`,
    projection: runtimeDomainProjection(runtime),
    bank: bankState(),
    events: [
      budgetEarnedEvent(),
      sessionStartedEvent(),
      sessionEndedEvent({ at: RUNTIME_CLOSED_AT }),
    ],
    syncBank: true,
    aggregateSets: { [AGGREGATE_KEY]: dailyAgg() },
    aggregateRemoves: [AGGREGATE_KEY],
    ...overrides,
  };
}

/** A runtime whose stored checkpoint still owes its event, bank, and aggregate replay. */
export function commitCheckpointRuntime(
  runtime: RuntimeStateV2 = cleanupClosureRuntime(),
  overrides: Partial<RuntimeCommitCheckpointV2> = {},
): RuntimeStateV2 {
  return { ...runtime, commitCheckpoint: runtimeCommitCheckpoint(runtime, overrides) };
}

/**
 * A resume begins from a durable pause or break, so it inherits that runtime's retained clear batch
 * at its own older revision. A start begins from an idle runtime, which owns no commands.
 */
function transitionCommandMap(
  transition: PendingEnforcementTransition,
): Record<string, FrozenDocumentCommand> {
  if (transition.cleanupProgress !== null) return transition.cleanupProgress.clearCommands;
  return transition.kind === 'resume' ? retainedClearCommandMap() : {};
}

/** The durable session each stage of the machine leaves in runtime. */
function transitionSession(transition: PendingEnforcementTransition): SessionStateV2 | null {
  const retained: string = retainedStage(transition);
  if (transition.stage !== 'cleanup') {
    return COMMITTED_STAGES.includes(retained)
      ? committedTransitionSession(transition.kind)
      : preCommitTransitionSession(transition);
  }
  if (transition.postCleanupClosure !== null) {
    return COMMITTED_STAGES.includes(retained)
      ? committedTransitionSession(transition.kind)
      : preCommitTransitionSession(transition);
  }
  return transition.cleanupCause === 'start-abandon' ? null : priorPhaseSession(transition);
}

function committedTransitionSession(kind: TransitionKind): SessionStateV2 {
  return kind === 'start' ? timedFocusSession() : resumedFocusSession();
}

function preCommitTransitionSession(
  transition: PendingEnforcementTransition,
): SessionStateV2 | null {
  return transition.kind === 'start' ? null : priorPhaseSession(transition);
}

function priorPhaseSession(transition: PendingEnforcementTransition): SessionStateV2 {
  return transition.priorPhase === 'break' ? breakSession() : pausedSession();
}

/** A cleanup row keeps the fields of the stage it left, which `cleanupFrom` names. */
function retainedStage(transition: PendingEnforcementTransition): string {
  return transition.stage === 'cleanup' ? (transition.cleanupFrom ?? '') : transition.stage;
}

/**
 * A pre-commit start reserves the next base policy revision, so durable runtime still holds the
 * previous one until commit stores it, or until abandonment persists it with the clear batch.
 */
function transitionBaseRevision(transition: PendingEnforcementTransition): number {
  const reserving: boolean =
    transition.kind === 'start' &&
    transition.stage !== 'cleanup' &&
    !COMMITTED_STAGES.includes(transition.stage);
  return reserving ? BASE_POLICY_REVISION - 1 : BASE_POLICY_REVISION;
}

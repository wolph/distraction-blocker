import { MAX_FINAL_FRESHNESS_ATTEMPTS } from '../shared/constants';
import type { DocumentOverlayView } from '../shared/enforcement-v2';
import { canonicalSessionIdentity } from '../shared/enforcement-v2-validation';
import { snapshotExactData } from '../shared/exact-data';
import { isRelativeMinuteDuration } from '../shared/numeric-validation';
import { localDateStr } from '../shared/time';
import {
  everyDenseEntry,
  exactRecord,
  isNonBlankString,
  isNonNegativeInteger,
  isSafeTimestamp,
  isUuid,
  validateDetachedCanonicalSessionRuleSnapshot,
  validateDetachedCycleConfigV2,
  validateDetachedScheduleOccurrenceRef,
} from '../shared/v2-domain-intrinsics';
import { PHASE_ALARM } from './alarms-v2';
import {
  detachedIdentityMap,
  validateDetachedCleanupProgress,
  validateDetachedPostCleanupClosure,
} from './cleanup-closure-v2-validation';
import type { EnforcementCheckpoint, FrozenDocumentCommand } from './enforcement-persistence-v2';
import {
  validateDetachedEnforcementCheckpoint,
  validateDetachedFrozenDocumentCommand,
} from './enforcement-persistence-v2-validation';
import type {
  CandidateScheduleWindow,
  CleanupProgress,
  FrozenTransitionView,
  PendingEnforcementTransition,
  PreparedTargetReservation,
  SessionStartCandidate,
  StartDurationPlan,
} from './runtime-v2-types';

type UnknownRecord = Record<string, unknown>;

/** The transition-wide authority every view, checkpoint, and clear command repeats. */
interface TransitionHeader {
  kind: 'start' | 'resume';
  stage: string;
  sessionId: string;
  enforcementEpoch: string;
  basePolicyRevision: number;
  runtimeRevision: number;
  startingOperationId: string;
  activeOperationId: string;
}

/** What one stage of the machine says about every field the stage matrix makes conditional. */
interface StageExpectation {
  committed: boolean;
  minFreshnessAttempts: number;
  maxFreshnessAttempts: number;
  reservationsAllowed: boolean;
  startingCheckpoint: boolean;
  checkpoint: boolean;
}

/** The operation-time authority one frozen view and each of its commands must repeat. */
interface ViewExpectation {
  operationId: string;
  enforcementEpoch: string;
  basePolicyRevision: number;
  sessionId: string;
  durableSession: boolean;
  presentation: 'starting' | 'active';
}

interface TransitionViews {
  startingView: FrozenTransitionView;
  activeView: FrozenTransitionView | null;
}

/** The validated request: a start's whole candidate, or null for a resume, which carries none. */
interface TransitionRequest {
  start: SessionStartCandidate | null;
}

const TRANSITION_KEYS: readonly string[] = [
  'version',
  'kind',
  'stage',
  'transitionId',
  'startingOperationId',
  'activeOperationId',
  'enforcementEpoch',
  'basePolicyRevision',
  'runtimeRevision',
  'sessionId',
  'trigger',
  'requestedAt',
  'candidate',
  'priorPhase',
  'activationAt',
  'verificationStartedAt',
  'freshnessAttempts',
  'targetGeneration',
  'preparedTargetReservations',
  'startingView',
  'activeView',
  'startingCheckpoint',
  'checkpoint',
  'alarmNames',
  'failure',
  'cleanupProgress',
  'cleanupFrom',
  'cleanupCause',
  'postCleanupClosure',
];
const CANDIDATE_KEYS: readonly string[] = [
  'mode',
  'strictness',
  'duration',
  'cycling',
  'intention',
  'source',
  'scheduleOccurrence',
  'scheduleWindow',
  'rules',
];
const SCHEDULE_WINDOW_KEYS: readonly string[] = ['windowStartsAt', 'windowEndsAt'];
const VIEW_KEYS: readonly string[] = [
  'capturedAt',
  'operationId',
  'enforcementEpoch',
  'basePolicyRevision',
  'runtimeRevision',
  'documents',
];
const RESERVATION_KEYS: readonly string[] = ['tabId', 'documentId', 'expectedUrl', 'commandKey'];
const TRIGGERS: ReadonlySet<string> = new Set<string>([
  'manual',
  'schedule',
  'pause-expired',
  'break-expired',
]);
const FAILURE_REASONS: ReadonlySet<string> = new Set<string>([
  'website-access-lost',
  'content-registration-failed',
  'alarm-failed',
  'tab-enforcement-failed',
]);
/** The causes that must close a durable session, so exactly these carry a post-cleanup closure. */
const CLOSING_CLEANUP_CAUSES: ReadonlySet<string> = new Set<string>([
  'timer-completed',
  'manual-end',
  'transition-failed',
]);
const PRE_COMMIT: StageExpectation = {
  committed: false,
  minFreshnessAttempts: 0,
  maxFreshnessAttempts: 0,
  reservationsAllowed: false,
  startingCheckpoint: false,
  checkpoint: false,
};
/** The stage matrix. A cleanup row is measured against the stage named by `cleanupFrom`. */
const STAGE_EXPECTATIONS: ReadonlyMap<string, StageExpectation> = new Map<string, StageExpectation>(
  [
    ['prepared', { ...PRE_COMMIT, reservationsAllowed: true }],
    ['registration-audited', { ...PRE_COMMIT, reservationsAllowed: true }],
    ['starting-verified', { ...PRE_COMMIT, startingCheckpoint: true }],
    [
      'committed-pending-verification',
      { ...PRE_COMMIT, committed: true, startingCheckpoint: true },
    ],
    [
      'alarm-ready',
      {
        ...PRE_COMMIT,
        committed: true,
        maxFreshnessAttempts: MAX_FINAL_FRESHNESS_ATTEMPTS,
        startingCheckpoint: true,
      },
    ],
    [
      'active-verified',
      {
        committed: true,
        minFreshnessAttempts: 1,
        maxFreshnessAttempts: MAX_FINAL_FRESHNESS_ATTEMPTS,
        reservationsAllowed: false,
        startingCheckpoint: true,
        checkpoint: true,
      },
    ],
  ],
);

export function parsePendingEnforcementTransition(
  value: unknown,
): PendingEnforcementTransition | null {
  const snapshot: unknown = snapshotExactData(value)?.value;
  return validateDetachedPendingEnforcementTransition(snapshot) ? snapshot : null;
}

/**
 * Accepts only already-detached exact plain data from snapshotExactData. This validates one stored
 * transition against itself. Relating it to the durable session, epoch, revision, document
 * commands, and closure belongs to the runtime API.
 */
export function validateDetachedPendingEnforcementTransition(
  value: unknown,
): value is PendingEnforcementTransition {
  const candidate: UnknownRecord | null = exactRecord(value, TRANSITION_KEYS);
  if (candidate === null) return false;
  const header: TransitionHeader | null = transitionHeader(candidate);
  if (header === null) return false;
  const request: TransitionRequest | null = transitionRequest(candidate, header);
  const retained: string | null = retainedStageName(candidate, header.stage);
  const expectation: StageExpectation | undefined =
    retained === null ? undefined : STAGE_EXPECTATIONS.get(retained);
  if (request === null || expectation === undefined) return false;
  const views: TransitionViews | null = transitionViews(candidate, header, expectation);
  if (views === null) return false;
  return (
    validateTransitionVerification(candidate, expectation) &&
    activationWithinWindow(request.start, candidate.activationAt) &&
    validateTransitionReservations(candidate, header, expectation, views.startingView) &&
    validateTransitionCheckpoints(candidate, header, expectation) &&
    validateTransitionAlarmNames(candidate.alarmNames, expectation, request.start) &&
    validateTransitionCleanup(candidate, header, expectation) &&
    validateTransitionRevision(header, expectation, views)
  );
}

/** Returns the transition's own authority, or null when an identity or counter is out of domain. */
function transitionHeader(candidate: UnknownRecord): TransitionHeader | null {
  const kind: unknown = candidate.kind;
  const stage: unknown = candidate.stage;
  const sessionId: unknown = candidate.sessionId;
  const enforcementEpoch: unknown = candidate.enforcementEpoch;
  const basePolicyRevision: unknown = candidate.basePolicyRevision;
  const runtimeRevision: unknown = candidate.runtimeRevision;
  const startingOperationId: unknown = candidate.startingOperationId;
  const activeOperationId: unknown = candidate.activeOperationId;
  if (
    candidate.version !== 1 ||
    (kind !== 'start' && kind !== 'resume') ||
    typeof stage !== 'string' ||
    !isUuid(candidate.transitionId) ||
    !isUuid(startingOperationId) ||
    !isUuid(activeOperationId) ||
    startingOperationId === activeOperationId ||
    !isUuid(enforcementEpoch) ||
    !isUuid(sessionId) ||
    !isNonNegativeInteger(basePolicyRevision) ||
    !isNonNegativeInteger(runtimeRevision) ||
    !isNonNegativeInteger(candidate.targetGeneration)
  ) {
    return null;
  }
  return {
    kind,
    stage,
    sessionId,
    enforcementEpoch,
    basePolicyRevision,
    runtimeRevision,
    startingOperationId,
    activeOperationId,
  };
}

/**
 * Returns the stage whose retained fields this row must satisfy. A cleanup row keeps the fields of
 * the stage it left, so `cleanupFrom` names it. Every other stage names itself.
 */
function retainedStageName(candidate: UnknownRecord, stage: string): string | null {
  const cleanupFrom: unknown = candidate.cleanupFrom;
  if (stage !== 'cleanup') return cleanupFrom === null ? stage : null;
  return typeof cleanupFrom === 'string' ? cleanupFrom : null;
}

/**
 * Returns the validated request once, so later rules read the candidate rather than revalidate it.
 * A start carries its whole candidate and no prior phase, and its trigger names its source, which
 * leaves `manual` and `schedule` as the only start triggers. A resume carries no candidate and
 * keeps the durable phase its trigger expires.
 */
function transitionRequest(
  candidate: UnknownRecord,
  header: TransitionHeader,
): TransitionRequest | null {
  const trigger: unknown = candidate.trigger;
  if (
    typeof trigger !== 'string' ||
    !TRIGGERS.has(trigger) ||
    !isSafeTimestamp(candidate.requestedAt)
  ) {
    return null;
  }
  if (header.kind === 'resume') {
    return resumeRequestAgrees(candidate, trigger) ? { start: null } : null;
  }
  const start: unknown = candidate.candidate;
  if (
    candidate.priorPhase !== null ||
    !validateDetachedSessionStartCandidate(start) ||
    start.source !== trigger
  ) {
    return null;
  }
  return { start };
}

function resumeRequestAgrees(candidate: UnknownRecord, trigger: string): boolean {
  if (candidate.candidate !== null || trigger === 'schedule') return false;
  return candidate.priorPhase === (trigger === 'break-expired' ? 'break' : 'paused');
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
function validateDetachedSessionStartCandidate(value: unknown): value is SessionStartCandidate {
  const candidate: UnknownRecord | null = exactRecord(value, CANDIDATE_KEYS);
  const duration: unknown = candidate?.duration;
  if (
    candidate === null ||
    !validateDetachedStartDurationPlan(duration) ||
    (candidate.mode !== 'blacklist' && candidate.mode !== 'whitelist') ||
    (candidate.strictness !== 'flexible' &&
      candidate.strictness !== 'friction' &&
      candidate.strictness !== 'hard') ||
    (candidate.cycling !== null && !validateDetachedCycleConfigV2(candidate.cycling)) ||
    typeof candidate.intention !== 'string' ||
    (candidate.source !== 'manual' && candidate.source !== 'schedule') ||
    !validateDetachedCanonicalSessionRuleSnapshot(candidate.rules)
  ) {
    return false;
  }
  if (duration.kind === 'until-stopped') {
    if (candidate.strictness !== 'flexible' || candidate.cycling !== null) return false;
  }
  return candidate.source === 'manual'
    ? candidate.scheduleOccurrence === null &&
        candidate.scheduleWindow === null &&
        duration.kind !== 'schedule-window'
    : scheduledCandidateAgrees(candidate, duration);
}

/** A scheduled candidate freezes its bounds, and its occurrence date names its start bound. */
function scheduledCandidateAgrees(candidate: UnknownRecord, duration: StartDurationPlan): boolean {
  const occurrence: unknown = candidate.scheduleOccurrence;
  const window: unknown = candidate.scheduleWindow;
  if (
    duration.kind === 'manual-timed' ||
    !validateDetachedScheduleOccurrenceRef(occurrence) ||
    !validateDetachedCandidateScheduleWindow(window)
  ) {
    return false;
  }
  return localDateStr(window.windowStartsAt) === occurrence.localStartDate;
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
function validateDetachedStartDurationPlan(value: unknown): value is StartDurationPlan {
  const timed: UnknownRecord | null = exactRecord(value, ['kind', 'minutes']);
  if (timed !== null) {
    return timed.kind === 'manual-timed' && isRelativeMinuteDuration(timed.minutes);
  }
  const plan: UnknownRecord | null = exactRecord(value, ['kind']);
  return plan !== null && (plan.kind === 'schedule-window' || plan.kind === 'until-stopped');
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
function validateDetachedCandidateScheduleWindow(value: unknown): value is CandidateScheduleWindow {
  const window: UnknownRecord | null = exactRecord(value, SCHEDULE_WINDOW_KEYS);
  const windowStartsAt: unknown = window?.windowStartsAt;
  const windowEndsAt: unknown = window?.windowEndsAt;
  return (
    window !== null &&
    isSafeTimestamp(windowStartsAt) &&
    isSafeTimestamp(windowEndsAt) &&
    windowStartsAt < windowEndsAt
  );
}

/**
 * A window-timed session runs between its captured bounds, so its activation sits inside the
 * half-open window the pre-commit recheck applied: `windowStartsAt <= activationAt < windowEndsAt`.
 * The bound itself would derive a zero-length session, which is not a duration this domain has.
 */
function activationWithinWindow(
  start: SessionStartCandidate | null,
  activationAt: unknown,
): boolean {
  if (
    start === null ||
    start.duration.kind !== 'schedule-window' ||
    start.scheduleWindow === null ||
    activationAt === null
  ) {
    return true;
  }
  return (
    typeof activationAt === 'number' &&
    start.scheduleWindow.windowStartsAt <= activationAt &&
    activationAt < start.scheduleWindow.windowEndsAt
  );
}

/** Returns both frozen views once each agrees with its operation, or null when either does not. */
function transitionViews(
  candidate: UnknownRecord,
  header: TransitionHeader,
  expectation: StageExpectation,
): TransitionViews | null {
  const startingView: unknown = candidate.startingView;
  const activeView: unknown = candidate.activeView;
  if (!validateDetachedFrozenTransitionView(startingView, viewExpectation(header, false))) {
    return null;
  }
  if (!expectation.committed) {
    return activeView === null ? { startingView, activeView: null } : null;
  }
  if (
    !validateDetachedFrozenTransitionView(activeView, viewExpectation(header, true)) ||
    activeView.capturedAt !== candidate.activationAt
  ) {
    return null;
  }
  return { startingView, activeView };
}

function viewExpectation(header: TransitionHeader, active: boolean): ViewExpectation {
  return {
    operationId: active ? header.activeOperationId : header.startingOperationId,
    enforcementEpoch: header.enforcementEpoch,
    basePolicyRevision: header.basePolicyRevision,
    sessionId: header.sessionId,
    durableSession: active || header.kind === 'resume',
    presentation: active ? 'active' : 'starting',
  };
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
function validateDetachedFrozenTransitionView(
  value: unknown,
  expectation: ViewExpectation,
): value is FrozenTransitionView {
  const view: UnknownRecord | null = exactRecord(value, VIEW_KEYS);
  const capturedAt: unknown = view?.capturedAt;
  const runtimeRevision: unknown = view?.runtimeRevision;
  if (
    view === null ||
    !isSafeTimestamp(capturedAt) ||
    !isNonNegativeInteger(runtimeRevision) ||
    view.operationId !== expectation.operationId ||
    view.enforcementEpoch !== expectation.enforcementEpoch ||
    view.basePolicyRevision !== expectation.basePolicyRevision
  ) {
    return false;
  }
  const documents: Record<string, FrozenDocumentCommand> | null = detachedIdentityMap(
    view.documents,
    validateDetachedFrozenDocumentCommand,
  );
  if (documents === null) return false;
  return Object.values(documents).every((command: FrozenDocumentCommand): boolean =>
    commandRepeatsView(command, capturedAt, runtimeRevision, expectation),
  );
}

/**
 * One frozen command repeats its view's operation tuple and presentation, names the transition
 * session in the form its phase allows, and carries no regenerated capture time.
 */
function commandRepeatsView(
  command: FrozenDocumentCommand,
  capturedAt: number,
  runtimeRevision: number,
  expectation: ViewExpectation,
): boolean {
  const durable: boolean = command.sessionId !== null;
  return (
    command.operationId === expectation.operationId &&
    command.enforcementEpoch === expectation.enforcementEpoch &&
    command.basePolicyRevision === expectation.basePolicyRevision &&
    command.runtimeRevision === runtimeRevision &&
    command.presentation === expectation.presentation &&
    durable === expectation.durableSession &&
    canonicalSessionIdentity(command.sessionId, command.reservedSessionId) ===
      expectation.sessionId &&
    overlayRepeatsCapture(command.overlay, capturedAt)
  );
}

function overlayRepeatsCapture(overlay: DocumentOverlayView | null, capturedAt: number): boolean {
  if (overlay === null) return true;
  const overlayCapturedAt: number =
    overlay.presentation === 'starting' ? overlay.capturedAt : overlay.timing.capturedAt;
  return overlayCapturedAt === capturedAt;
}

/** Activation is captured once at commit and the verification budget starts from that instant. */
function validateTransitionVerification(
  candidate: UnknownRecord,
  expectation: StageExpectation,
): boolean {
  const activationAt: unknown = candidate.activationAt;
  const freshnessAttempts: unknown = candidate.freshnessAttempts;
  if (
    !isNonNegativeInteger(freshnessAttempts) ||
    freshnessAttempts < expectation.minFreshnessAttempts ||
    freshnessAttempts > expectation.maxFreshnessAttempts
  ) {
    return false;
  }
  if (!expectation.committed) {
    return activationAt === null && candidate.verificationStartedAt === null;
  }
  return isSafeTimestamp(activationAt) && candidate.verificationStartedAt === activationAt;
}

/** Listeners queue reservations only until the audit is durable, and each names its command. */
function validateTransitionReservations(
  candidate: UnknownRecord,
  header: TransitionHeader,
  expectation: StageExpectation,
  startingView: FrozenTransitionView,
): boolean {
  const reservations: Record<string, PreparedTargetReservation> | null = detachedIdentityMap(
    candidate.preparedTargetReservations,
    validateDetachedPreparedTargetReservation,
  );
  if (reservations === null) return false;
  const entries: Array<[string, PreparedTargetReservation]> = Object.entries(reservations);
  if (entries.length === 0) return true;
  if (!expectation.reservationsAllowed || header.stage === 'cleanup') return false;
  return entries.every(([key, reservation]: [string, PreparedTargetReservation]): boolean =>
    reservationRepeatsCommand(reservation, key, startingView),
  );
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
function validateDetachedPreparedTargetReservation(
  value: unknown,
): value is PreparedTargetReservation {
  const reservation: UnknownRecord | null = exactRecord(value, RESERVATION_KEYS);
  return (
    reservation !== null &&
    isNonNegativeInteger(reservation.tabId) &&
    isNonBlankString(reservation.documentId) &&
    isNonBlankString(reservation.expectedUrl) &&
    isNonBlankString(reservation.commandKey)
  );
}

function reservationRepeatsCommand(
  reservation: PreparedTargetReservation,
  key: string,
  startingView: FrozenTransitionView,
): boolean {
  if (reservation.commandKey !== key) return false;
  const command: FrozenDocumentCommand | undefined = startingView.documents[key];
  return (
    command !== undefined &&
    command.tabId === reservation.tabId &&
    command.documentId === reservation.documentId &&
    command.expectedUrl === reservation.expectedUrl
  );
}

function validateTransitionCheckpoints(
  candidate: UnknownRecord,
  header: TransitionHeader,
  expectation: StageExpectation,
): boolean {
  return (
    checkpointAgrees(
      candidate.startingCheckpoint,
      expectation.startingCheckpoint,
      header.startingOperationId,
      header,
    ) &&
    checkpointAgrees(candidate.checkpoint, expectation.checkpoint, header.activeOperationId, header)
  );
}

/**
 * A stored checkpoint repeats the transition's operation authority and the kind its transition
 * kind derives. Neither checkpoint carries a runtime revision, so none is compared here.
 */
function checkpointAgrees(
  value: unknown,
  required: boolean,
  operationId: string,
  header: TransitionHeader,
): boolean {
  if (!required) return value === null;
  if (!validateDetachedEnforcementCheckpoint(value)) return false;
  const checkpoint: EnforcementCheckpoint = value;
  return (
    checkpoint.operationId === operationId &&
    checkpoint.enforcementEpoch === header.enforcementEpoch &&
    checkpoint.sessionId === header.sessionId &&
    checkpoint.basePolicyRevision === header.basePolicyRevision &&
    checkpoint.kind === (header.kind === 'start' ? 'activation' : 'resume-strengthening')
  );
}

/**
 * A transition owns the single `phase` alarm it creates at commit, named by the one constant
 * `alarms-v2` owns. Indefinite focus owns none, and a resume cannot see its durable duration from
 * the journal, so either inventory is legal there.
 */
function validateTransitionAlarmNames(
  value: unknown,
  expectation: StageExpectation,
  start: SessionStartCandidate | null,
): boolean {
  if (!everyDenseEntry(value, isNonBlankString)) return false;
  if (!expectation.committed) return value.length === 0;
  if (value.length > 1) return false;
  if (value.some((name: string): boolean => name !== PHASE_ALARM)) return false;
  if (start === null) return true;
  return value.length === (start.duration.kind === 'until-stopped' ? 0 : 1);
}

/** Cleanup owns its cause, source stage, failure, progress, and optional closure as one row. */
function validateTransitionCleanup(
  candidate: UnknownRecord,
  header: TransitionHeader,
  expectation: StageExpectation,
): boolean {
  const cause: unknown = candidate.cleanupCause;
  if (header.stage !== 'cleanup') {
    return (
      cause === null &&
      candidate.cleanupProgress === null &&
      candidate.postCleanupClosure === null &&
      candidate.failure === null
    );
  }
  if (typeof cause !== 'string' || !cleanupCauseAgrees(cause, header.kind, expectation.committed)) {
    return false;
  }
  const progress: unknown = candidate.cleanupProgress;
  if (
    !cleanupFailureAgrees(candidate.failure, cause) ||
    !validateDetachedCleanupProgress(progress) ||
    progress.clearRuntimeRevision !== header.runtimeRevision ||
    !allocatesNewCleanupOperation(progress, header) ||
    !clearsTransitionSession(progress, header, expectation.committed)
  ) {
    return false;
  }
  return postCleanupClosureAgrees(candidate.postCleanupClosure, cause, header.sessionId);
}

/** Cleanup allocates a new operation ID, so it never reuses either verification operation. */
function allocatesNewCleanupOperation(
  progress: CleanupProgress,
  header: TransitionHeader,
): boolean {
  return (
    progress.cleanupOperationId !== header.startingOperationId &&
    progress.cleanupOperationId !== header.activeOperationId
  );
}

/**
 * Abandonment and restoration undo a pre-commit attempt of their own kind. Manual end and
 * transition failure only follow a commit. Timer completion closes a durable session, which a
 * pre-commit start does not have.
 */
function cleanupCauseAgrees(cause: string, kind: string, committedSource: boolean): boolean {
  switch (cause) {
    case 'start-abandon':
      return kind === 'start' && !committedSource;
    case 'resume-restore':
      return kind === 'resume' && !committedSource;
    case 'timer-completed':
      return committedSource || kind === 'resume';
    case 'manual-end':
    case 'transition-failed':
      return committedSource;
    default:
      return false;
  }
}

/**
 * A transition failure always names its cause, and only an abandoned start may also name one. A
 * pre-commit resume enforcement failure therefore stores `resume-restore` with a null `failure`,
 * per design lines 961 and 962, and the runtime records why in the closure reason instead.
 */
function cleanupFailureAgrees(failure: unknown, cause: string): boolean {
  if (failure === null) return cause !== 'transition-failed';
  if (typeof failure !== 'string' || !FAILURE_REASONS.has(failure)) return false;
  return cause === 'transition-failed' || cause === 'start-abandon';
}

function postCleanupClosureAgrees(value: unknown, cause: string, sessionId: string): boolean {
  if (!CLOSING_CLEANUP_CAUSES.has(cause)) return value === null;
  return validateDetachedPostCleanupClosure(value) && value.projection.sessionId === sessionId;
}

/** Every clear command carries the transition epoch and its session in the form the source had. */
function clearsTransitionSession(
  progress: CleanupProgress,
  header: TransitionHeader,
  committedSource: boolean,
): boolean {
  const durable: boolean = committedSource || header.kind === 'resume';
  return Object.values(progress.clearCommands).every(
    (command: FrozenDocumentCommand): boolean =>
      command.enforcementEpoch === header.enforcementEpoch &&
      (command.sessionId !== null) === durable &&
      canonicalSessionIdentity(command.sessionId, command.reservedSessionId) === header.sessionId,
  );
}

/**
 * A start begins at revision zero and a resume reserves the next durable revision. Each replaced
 * view advances the current revision, and commit advances it once more. In cleanup the clear
 * revision is current, so the retained historical views are evidence rather than comparands.
 */
function validateTransitionRevision(
  header: TransitionHeader,
  expectation: StageExpectation,
  views: TransitionViews,
): boolean {
  const starting: number = views.startingView.runtimeRevision;
  if (header.kind === 'resume' && starting < 1) return false;
  if (header.kind === 'start' && header.stage === 'prepared' && starting !== 0) return false;
  if (views.activeView !== null && views.activeView.runtimeRevision <= starting) return false;
  if (header.stage === 'cleanup') return true;
  if (!expectation.committed) return header.runtimeRevision === starting;
  return views.activeView !== null && header.runtimeRevision === views.activeView.runtimeRevision;
}

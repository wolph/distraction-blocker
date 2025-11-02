/**
 * The start and resume transition runner. It owns one durable state machine: every stage is a
 * persisted row, every step reads the durable row rather than a cached one, and every browser
 * effect happens after the write that authorizes it.
 *
 * Three rules shape the whole file. A frozen view is built once and reissued byte for byte, so a
 * pass never regenerates a command for an unchanged epoch and tuple. A new document seen mid-sweep
 * advances the runtime revision and persists a complete replacement view before its first send.
 * And every failure leaves through `enterTransitionCleanupV2`, which is the only writer that moves
 * a transition out of its stage without publishing.
 */

import type { CompiledMatcher } from '../core/matcher';
import {
  capturedScheduleWindowContainsV2,
  createHandledScheduleOccurrenceV2,
  mergeHandledScheduleOccurrencesV2,
} from '../core/schedule-v2';
import { commitResumeV2, startSessionV2 } from '../core/session-v2';
import { emptyDaily } from '../core/stats';
import { CoreError } from '../shared/errors';
import { syncAggKey } from '../shared/storage-keys';
import { localDateStr } from '../shared/time';
import type {
  DailyAgg,
  HandledScheduleOccurrence,
  SessionConfigV2,
  SessionEventRecordV2,
  SessionStartedEventV2,
  SessionStateV2,
  Verdict,
} from '../shared/types';
import { ensurePhaseAlarmV2, PHASE_ALARM } from './alarms-v2';
import { documentCommandKeyV2 } from './cleanup-progress-v2';
import type {
  DocumentEnforcementAck,
  DocumentEpochResetAck,
  EnforcementCheckpoint,
  EnforcementTargetExclusion,
  FrozenDocumentCommand,
  FrozenEpochResetCommand,
} from './enforcement-persistence-v2';
import {
  classifyEnforcementTargetV2,
  type EnforcementPassResultV2,
  type EnforcementTargetPortsV2,
  enumerateEnforcementTargetsV2,
  type FreshnessAttemptResultV2,
  freshnessBudgetPermitsV2,
  runEnforcementPassV2,
  runFreshnessAttemptV2,
  type SweepDriverV2,
  type TargetClassificationV2,
} from './enforcement-targets-v2';
import {
  buildActiveOverlayView,
  buildFrozenDocumentCommandV2,
  buildFrozenEpochResetCommandV2,
  buildStartingOverlayView,
} from './overlay-view-v2';
import { projectRuntimeDomainV2 } from './runtime-checkpoint-v2';
import type { RuntimePortsV2 } from './runtime-ports-v2';
import type {
  FrozenTransitionView,
  PendingEnforcementTransition,
  RuntimeStateV2,
  SessionStartCandidate,
  StartDurationPlan,
  TransitionStage,
} from './runtime-v2-types';
import { parseRuntimeStateV2 } from './runtime-v2-validation';
import { enterTransitionCleanupV2 } from './transition-cleanup-v2';
import { validateDetachedPendingEnforcementTransition } from './transition-v2-validation';

export interface PreparedTransitionV2 {
  runtime: RuntimeStateV2;
  matcher: CompiledMatcher;
}

export type TransitionDriveResultV2 =
  | { kind: 'published'; runtime: RuntimeStateV2 }
  | { kind: 'cleanup'; runtime: RuntimeStateV2 };

type EnforceableTargetV2 = Extract<TargetClassificationV2, { kind: 'enforceable' }>;
/** Which frozen view a step reads and which operation its commands carry. */
type SweepPhaseV2 = 'starting' | 'active';

const PRE_COMMIT_STAGES: ReadonlySet<string> = new Set<string>([
  'prepared',
  'registration-audited',
  'starting-verified',
]);
const MINUTE_MS: number = 60_000;

/**
 * Validates the request, compiles its matcher, reserves every identity, and freezes the starting
 * view, then persists all of it as one `prepared` row. A rejected candidate leaves no journal and
 * no browser effect, which is what makes a failed start invisible.
 */
export async function prepareStartTransitionV2(
  ports: RuntimePortsV2,
  candidate: SessionStartCandidate,
  trigger: 'manual' | 'schedule',
): Promise<PreparedTransitionV2> {
  const runtime: RuntimeStateV2 = idleRuntimeFor(ports, 'start');
  const matcher: CompiledMatcher = ports.compileMatcher(candidate.rules, candidate.mode);
  const now: number = ports.now();
  const sessionId: string = ports.newId();
  const transitionId: string = ports.newId();
  const startingOperationId: string = ports.newId();
  const activeOperationId: string = ports.newId();
  const basePolicyRevision: number = runtime.basePolicyRevision + 1;
  const startingView: FrozenTransitionView = await freezeStartingView(ports, matcher, {
    runtime,
    capturedAt: now,
    operationId: startingOperationId,
    enforcementEpoch: runtime.enforcementEpoch,
    basePolicyRevision,
    runtimeRevision: 0,
    sessionId,
    durable: false,
  });
  const transition: PendingEnforcementTransition = {
    version: 1,
    kind: 'start',
    stage: 'prepared',
    transitionId,
    startingOperationId,
    activeOperationId,
    enforcementEpoch: runtime.enforcementEpoch,
    basePolicyRevision,
    runtimeRevision: 0,
    sessionId,
    trigger,
    requestedAt: now,
    candidate: structuredClone(candidate),
    priorPhase: null,
    activationAt: null,
    verificationStartedAt: null,
    freshnessAttempts: 0,
    targetGeneration: ports.targets.readTargetGeneration(),
    preparedTargetReservations: {},
    startingView,
    activeView: null,
    startingCheckpoint: null,
    checkpoint: null,
    alarmNames: [],
    failure: null,
    cleanupProgress: null,
    cleanupFrom: null,
    cleanupCause: null,
    postCleanupClosure: null,
  };
  const next: RuntimeStateV2 = await writeStage(ports, runtime, transition, {
    runtimeRevision: 0,
    documentCommands: startingView.documents,
  });
  return { runtime: next, matcher };
}

/**
 * Prepares a resume over the durable pause or break the trigger expires. The epoch and base policy
 * revision are already durable, so only the runtime revision advances, and the session's captured
 * rules are the policy this transition reissues.
 */
export async function prepareResumeTransitionV2(
  ports: RuntimePortsV2,
  trigger: 'manual' | 'pause-expired' | 'break-expired',
): Promise<PreparedTransitionV2> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const session: SessionStateV2 | null = runtime.session;
  if (session === null || runtime.pendingEnforcementTransition !== null) {
    throw new CoreError('invalid-rule', 'a resume needs a durable session and no journal');
  }
  if (runtime.pendingClosure !== null) {
    throw new CoreError('invalid-rule', 'a resume cannot run while a closure exists');
  }
  const priorPhase: 'paused' | 'break' = trigger === 'break-expired' ? 'break' : 'paused';
  if (session.phase !== priorPhase) {
    throw new CoreError('invalid-rule', `a ${trigger} resume needs a durable ${priorPhase}`);
  }
  const matcher: CompiledMatcher = ports.compileMatcher(session.config.rules, session.config.mode);
  const now: number = ports.now();
  const transitionId: string = ports.newId();
  const startingOperationId: string = ports.newId();
  const activeOperationId: string = ports.newId();
  const runtimeRevision: number = runtime.runtimeRevision + 1;
  const startingView: FrozenTransitionView = await freezeStartingView(ports, matcher, {
    runtime,
    capturedAt: now,
    operationId: startingOperationId,
    enforcementEpoch: runtime.enforcementEpoch,
    basePolicyRevision: runtime.basePolicyRevision,
    runtimeRevision,
    sessionId: session.sessionId,
    durable: true,
  });
  const transition: PendingEnforcementTransition = {
    version: 1,
    kind: 'resume',
    stage: 'prepared',
    transitionId,
    startingOperationId,
    activeOperationId,
    enforcementEpoch: runtime.enforcementEpoch,
    basePolicyRevision: runtime.basePolicyRevision,
    runtimeRevision,
    sessionId: session.sessionId,
    trigger,
    requestedAt: now,
    candidate: null,
    priorPhase,
    activationAt: null,
    verificationStartedAt: null,
    freshnessAttempts: 0,
    targetGeneration: ports.targets.readTargetGeneration(),
    preparedTargetReservations: {},
    startingView,
    activeView: null,
    startingCheckpoint: null,
    checkpoint: null,
    alarmNames: [],
    failure: null,
    cleanupProgress: null,
    cleanupFrom: null,
    cleanupCause: null,
    postCleanupClosure: null,
  };
  const next: RuntimeStateV2 = await writeStage(ports, runtime, transition, {
    runtimeRevision,
    documentCommands: startingView.documents,
  });
  return { runtime: next, matcher };
}

/**
 * Drives the durable transition from whatever stage it is at to publication or cleanup. Every
 * iteration rereads the durable row, so a restarted worker resumes exactly where the last write
 * left it, with the original operation IDs, views, and verification start.
 */
export async function driveTransitionV2(
  ports: RuntimePortsV2,
  matcher: CompiledMatcher,
): Promise<TransitionDriveResultV2> {
  for (;;) {
    const runtime: RuntimeStateV2 = ports.runtime();
    const transition: PendingEnforcementTransition | null = runtime.pendingEnforcementTransition;
    if (transition === null) return { kind: 'published', runtime };
    if (transition.stage === 'cleanup') return { kind: 'cleanup', runtime };
    const stepped: 'continue' | 'cleanup' = await stepTransition(
      ports,
      matcher,
      runtime,
      transition,
    );
    if (stepped === 'cleanup') return { kind: 'cleanup', runtime: ports.runtime() };
  }
}

/** Runs exactly one stage. Returns `cleanup` once a failure has written the cleanup row. */
async function stepTransition(
  ports: RuntimePortsV2,
  matcher: CompiledMatcher,
  runtime: RuntimeStateV2,
  transition: PendingEnforcementTransition,
): Promise<'continue' | 'cleanup'> {
  switch (transition.stage) {
    case 'prepared':
      return auditStage(ports, runtime, transition);
    case 'registration-audited':
      return startingSweepStage(ports, matcher, transition);
    case 'starting-verified':
      return commitStage(ports, matcher, runtime, transition);
    case 'committed-pending-verification':
      return alarmStage(ports, runtime, transition);
    default:
      return freshnessStage(ports, matcher, runtime, transition);
  }
}

/**
 * Audits optional website access and the exact content registration, then persists the audit
 * result. Nothing has been sent yet, so a failed audit releases its reservations with empty
 * browser-effect targets rather than closing a session it never created.
 */
async function auditStage(
  ports: RuntimePortsV2,
  runtime: RuntimeStateV2,
  transition: PendingEnforcementTransition,
): Promise<'continue' | 'cleanup'> {
  const audit: 'ready' | 'website-access-lost' | 'content-registration-failed' =
    await ports.auditEnforcement();
  if (audit !== 'ready') {
    await enterTransitionCleanupV2(ports, {
      cause: transition.kind === 'start' ? 'start-abandon' : 'resume-restore',
      failure: transition.kind === 'start' ? audit : null,
      endedAt: ports.now(),
    });
    return 'cleanup';
  }
  await writeStage(ports, runtime, { ...transition, stage: 'registration-audited' }, {});
  return 'continue';
}

/**
 * Drains queued targets through the three-pass provisional sweep with presentation `starting`, and
 * persists its checkpoint. Every target resets to the current epoch before its first enforcement
 * command, and each acknowledgement is durable before that command is sent.
 */
async function startingSweepStage(
  ports: RuntimePortsV2,
  matcher: CompiledMatcher,
  transition: PendingEnforcementTransition,
): Promise<'continue' | 'cleanup'> {
  const pass: EnforcementPassResultV2 = await runEnforcementPassV2(
    ports.targets,
    sweepDriver(ports, matcher, 'starting'),
  );
  if (pass.kind === 'unreachable') return failStarting(ports, transition);
  const current: PendingEnforcementTransition = durableTransition(ports);
  await writeStage(
    ports,
    ports.runtime(),
    {
      ...current,
      stage: 'starting-verified',
      preparedTargetReservations: {},
      startingCheckpoint: checkpointFor(current, 'starting', pass.documents, pass.exclusions, {
        auditedAt: ports.now(),
        generation: pass.generation,
      }),
    },
    {},
  );
  return 'continue';
}

/**
 * Captures `activationAt`, builds the immutable session from it, and commits the session, its start
 * or phase event, its aggregate, the frozen active view, and the committed transition in one
 * checkpoint. A scheduled start is rechecked only against its own captured window.
 */
async function commitStage(
  ports: RuntimePortsV2,
  matcher: CompiledMatcher,
  runtime: RuntimeStateV2,
  transition: PendingEnforcementTransition,
): Promise<'continue' | 'cleanup'> {
  const activationAt: number = ports.now();
  const start: SessionStartCandidate | null = transition.candidate;
  if (start !== null && start.scheduleWindow !== null) {
    if (!capturedScheduleWindowContainsV2(start.scheduleWindow, activationAt)) {
      await enterTransitionCleanupV2(ports, {
        cause: 'start-abandon',
        failure: null,
        endedAt: activationAt,
      });
      return 'cleanup';
    }
  }
  if (start === null) {
    const durable: SessionStateV2 = requireSession(runtime);
    if (durable.sessionEndsAt !== null && durable.sessionEndsAt <= activationAt) {
      await enterTransitionCleanupV2(ports, {
        cause: 'timer-completed',
        failure: null,
        endedAt: durable.sessionEndsAt,
      });
      return 'cleanup';
    }
  }
  const session: SessionStateV2 =
    start === null
      ? resumedSession(runtime, activationAt)
      : startSessionV2(configFor(start, activationAt), activationAt, transition.sessionId);
  const runtimeRevision: number = transition.startingView.runtimeRevision + 1;
  const activeView: FrozenTransitionView = await freezeActiveView(ports, matcher, {
    runtime,
    session,
    capturedAt: activationAt,
    operationId: transition.activeOperationId,
    enforcementEpoch: transition.enforcementEpoch,
    basePolicyRevision: transition.basePolicyRevision,
    runtimeRevision,
  });
  const committed: PendingEnforcementTransition = {
    ...transition,
    stage: 'committed-pending-verification',
    runtimeRevision,
    preparedTargetReservations: {},
    activationAt,
    verificationStartedAt: activationAt,
    freshnessAttempts: 0,
    activeView,
    alarmNames: session.phaseEndsAt === null ? [] : [PHASE_ALARM],
  };
  await commitTransition(ports, runtime, committed, session, activationAt);
  return 'continue';
}

/** Creates and reads back the phase alarm the committed session owns, then records that fact. */
async function alarmStage(
  ports: RuntimePortsV2,
  runtime: RuntimeStateV2,
  transition: PendingEnforcementTransition,
): Promise<'continue' | 'cleanup'> {
  const settled: 'ready' | 'alarm-failed' = await ensurePhaseAlarmV2(ports.alarms, runtime.session);
  if (settled === 'alarm-failed') {
    await enterTransitionCleanupV2(ports, {
      cause: 'transition-failed',
      failure: 'alarm-failed',
      endedAt: ports.now(),
    });
    return 'cleanup';
  }
  await writeStage(ports, runtime, { ...transition, stage: 'alarm-ready' }, {});
  return 'continue';
}

/**
 * The final verification. The fixed end is rechecked first, then one freshness attempt runs under
 * the persisted active view. A verified attempt writes `active-verified` and rereads the
 * generation; an unchanged reread publishes, and a changed one retries while the budget permits.
 */
async function freshnessStage(
  ports: RuntimePortsV2,
  matcher: CompiledMatcher,
  runtime: RuntimeStateV2,
  transition: PendingEnforcementTransition,
): Promise<'continue' | 'cleanup'> {
  const session: SessionStateV2 | null = runtime.session;
  if (session === null) {
    throw new CoreError('invalid-rule', 'a committed transition lost its durable session');
  }
  if (session.sessionEndsAt !== null && session.sessionEndsAt <= ports.now()) {
    await enterTransitionCleanupV2(ports, {
      cause: 'timer-completed',
      failure: null,
      endedAt: session.sessionEndsAt,
    });
    return 'cleanup';
  }
  if (
    transition.stage === 'active-verified' &&
    ports.targets.readTargetGeneration() === transition.targetGeneration
  ) {
    await publishTransition(ports, runtime, transition);
    return 'continue';
  }
  const verificationStartedAt: number | null = transition.verificationStartedAt;
  if (verificationStartedAt === null) {
    throw new CoreError('invalid-rule', 'a committed transition lost its verification start');
  }
  const attempts: number = transition.freshnessAttempts + 1;
  if (
    !freshnessBudgetPermitsV2(
      { verificationStartedAt, freshnessAttempts: attempts - 1 },
      ports.now(),
    )
  ) {
    return failVerification(ports);
  }
  await writeStage(ports, runtime, { ...transition, freshnessAttempts: attempts }, {});
  const attempt: FreshnessAttemptResultV2 = await runFreshnessAttemptV2(
    ports.targets,
    sweepDriver(ports, matcher, 'active'),
    { verificationStartedAt, freshnessAttempts: attempts - 1 },
  );
  if (attempt.kind === 'verified') {
    const current: PendingEnforcementTransition = durableTransition(ports);
    await writeStage(
      ports,
      ports.runtime(),
      {
        ...current,
        stage: 'active-verified',
        targetGeneration: attempt.generation,
        checkpoint: checkpointFor(current, 'active', attempt.documents, attempt.exclusions, {
          auditedAt: attempt.completedAt,
          generation: attempt.generation,
        }),
      },
      {},
    );
    return 'continue';
  }
  if (attempt.kind === 'unreachable') return failVerification(ports);
  const budget: boolean = freshnessBudgetPermitsV2(
    { verificationStartedAt, freshnessAttempts: attempts },
    ports.now(),
  );
  return budget ? 'continue' : failVerification(ports);
}

/** One final checkpoint sets the publishable enforcement checkpoint and clears the transition. */
async function publishTransition(
  ports: RuntimePortsV2,
  runtime: RuntimeStateV2,
  transition: PendingEnforcementTransition,
): Promise<void> {
  const checkpoint: EnforcementCheckpoint | null = transition.checkpoint;
  if (checkpoint === null) {
    throw new CoreError('invalid-rule', 'publication needs the candidate enforcement checkpoint');
  }
  const published: RuntimeStateV2 = {
    ...structuredClone(runtime),
    basePolicyRevision: transition.basePolicyRevision,
    enforcementCheckpoint: structuredClone(checkpoint),
    pendingEnforcementTransition: null,
  };
  await ports.commit({
    checkpointId: `${transition.sessionId}:publish`,
    projection: projectRuntimeDomainV2(requireValid(published)),
    bank: ports.bank(),
    events: [],
    syncBank: false,
    aggregateSets: {},
    aggregateRemoves: [],
  });
}

/** The commit that turns a verified start or resume into a durable session. */
async function commitTransition(
  ports: RuntimePortsV2,
  runtime: RuntimeStateV2,
  transition: PendingEnforcementTransition,
  session: SessionStateV2,
  activationAt: number,
): Promise<void> {
  const handled: HandledScheduleOccurrence[] = startedOccurrences(transition, activationAt);
  const next: RuntimeStateV2 = {
    ...structuredClone(runtime),
    session: structuredClone(session),
    gate: null,
    basePolicyRevision: transition.basePolicyRevision,
    runtimeRevision: transition.runtimeRevision,
    documentCommands: structuredClone(transition.activeView?.documents ?? {}),
    enforcementCheckpoint: null,
    handledScheduleOccurrences: mergeHandledScheduleOccurrencesV2(
      runtime.handledScheduleOccurrences,
      handled,
      activationAt,
    ),
    pendingEnforcementTransition: structuredClone(transition),
  };
  await ports.commit({
    checkpointId: `${transition.sessionId}:${transition.kind}`,
    projection: projectRuntimeDomainV2(requireValid(next)),
    bank: ports.bank(),
    events: commitEvents(transition, session, activationAt),
    syncBank: false,
    aggregateSets: await startedAggregate(ports, runtime, activationAt),
    aggregateRemoves: [],
  });
}

/** A start announces itself. A resume records the phase change from its saved non-blocking phase. */
function commitEvents(
  transition: PendingEnforcementTransition,
  session: SessionStateV2,
  activationAt: number,
): SessionEventRecordV2[] {
  if (transition.kind === 'resume') {
    return [
      {
        t: 'phase',
        at: activationAt,
        from: transition.priorPhase === 'break' ? 'break' : 'paused',
        to: 'focus',
        sessionId: session.sessionId,
      },
    ];
  }
  const started: SessionStartedEventV2 = {
    version: 2,
    t: 'sessionStarted',
    eventId: `${session.sessionId}:start`,
    at: activationAt,
    sessionId: session.sessionId,
    source: session.config.source,
    mode: session.config.mode,
    strictness: session.config.strictness,
    duration: structuredClone(session.config.duration),
    intention: session.config.intention,
    scheduleOccurrence: structuredClone(session.config.scheduleOccurrence),
  };
  return [started];
}

/** One started-session increment on the local date the activation belongs to. */
async function startedAggregate(
  ports: RuntimePortsV2,
  runtime: RuntimeStateV2,
  activationAt: number,
): Promise<Record<string, DailyAgg>> {
  const date: string = localDateStr(activationAt);
  const key: string = syncAggKey(ports.deviceId(), date);
  const stored: DailyAgg | undefined =
    runtime.todayAgg?.date === date ? runtime.todayAgg : (await ports.loadAggregates([key]))[key];
  const base: DailyAgg = structuredClone(stored ?? emptyDaily(date));
  return { [key]: { ...base, sessionsStarted: base.sessionsStarted + 1 } };
}

/** A scheduled start handles its own source occurrence at the moment it commits. */
function startedOccurrences(
  transition: PendingEnforcementTransition,
  activationAt: number,
): HandledScheduleOccurrence[] {
  const occurrence = transition.candidate?.scheduleOccurrence ?? null;
  if (occurrence === null) return [];
  return [createHandledScheduleOccurrenceV2(occurrence, activationAt, 'started')];
}

/** The resumed session, or null once the arrived fixed end has entered timer completion. */
function resumedSession(runtime: RuntimeStateV2, activationAt: number): SessionStateV2 {
  return commitResumeV2(requireSession(runtime), activationAt);
}

/** The session config a start plan implies. A window plan becomes the timed remainder it has. */
function configFor(candidate: SessionStartCandidate, activationAt: number): SessionConfigV2 {
  return {
    mode: candidate.mode,
    strictness: candidate.strictness,
    duration: durationFor(candidate.duration, candidate, activationAt),
    cycling: structuredClone(candidate.cycling),
    intention: candidate.intention,
    source: candidate.source,
    scheduleOccurrence: structuredClone(candidate.scheduleOccurrence),
    rules: structuredClone(candidate.rules),
  };
}

function durationFor(
  plan: StartDurationPlan,
  candidate: SessionStartCandidate,
  activationAt: number,
): SessionConfigV2['duration'] {
  if (plan.kind === 'until-stopped') return { kind: 'until-stopped' };
  if (plan.kind === 'manual-timed') return { kind: 'timed', minutes: plan.minutes };
  const window = candidate.scheduleWindow;
  if (window === null) {
    throw new CoreError('invalid-rule', 'a window plan needs its captured bounds');
  }
  return { kind: 'timed', minutes: (window.windowEndsAt - activationAt) / MINUTE_MS };
}

/** A pre-commit enforcement failure abandons a start and restores a resume, per spec 961. */
async function failStarting(
  ports: RuntimePortsV2,
  transition: PendingEnforcementTransition,
): Promise<'cleanup'> {
  await enterTransitionCleanupV2(ports, {
    cause: transition.kind === 'start' ? 'start-abandon' : 'resume-restore',
    failure: transition.kind === 'start' ? 'tab-enforcement-failed' : null,
    endedAt: ports.now(),
  });
  return 'cleanup';
}

/** Verification cannot succeed, so the committed session closes with the enforcement reason. */
async function failVerification(ports: RuntimePortsV2): Promise<'cleanup'> {
  await enterTransitionCleanupV2(ports, {
    cause: 'transition-failed',
    failure: 'tab-enforcement-failed',
    endedAt: ports.now(),
  });
  return 'cleanup';
}

/**
 * Handles one navigation seen while a transition is running. Every stage advances the target
 * generation and persists whatever the target needs before anything is sent, and `prepared` only
 * queues, because nothing may be sent before the audit is durable.
 */
export async function handleTransitionNavigationV2(
  ports: RuntimePortsV2,
  matcher: CompiledMatcher,
  target: { tabId: number; documentId: string; url: string },
): Promise<void> {
  if (typeof target.documentId !== 'string' || target.documentId.trim() === '') {
    throw new CoreError('invalid-rule', 'a navigation target needs a document ID');
  }
  const classified: TargetClassificationV2 = classifyEnforcementTargetV2(
    target.tabId,
    target.url,
    target.documentId,
  );
  if (classified.kind !== 'enforceable') return;
  const transition: PendingEnforcementTransition = durableTransition(ports);
  if (transition.stage === 'cleanup') return;
  ports.targets.readTargetGeneration();
  if (transition.stage === 'prepared') {
    await queuePreparedTarget(ports, matcher, classified);
    return;
  }
  const phase: SweepPhaseV2 = PRE_COMMIT_STAGES.has(transition.stage) ? 'starting' : 'active';
  const driver: SweepDriverV2 = sweepDriver(ports, matcher, phase);
  const command: FrozenDocumentCommand = await driver.commandFor(classified);
  if (!driver.hasEpochAck(classified.tabId, classified.documentId)) {
    const reset: FrozenEpochResetCommand = await driver.resetFor(classified);
    const { sendEpochResetCommand } = await import('./content-transport-v2');
    const outcome = await sendEpochResetCommand(driver.transport, reset);
    if (outcome.kind !== 'reset') return;
    await driver.recordEpochAck(outcome.ack);
  }
  const { sendDocumentEnforcementCommand } = await import('./content-transport-v2');
  await sendDocumentEnforcementCommand(driver.transport, command);
}

/**
 * Queues one target found while the audit is still pending. The reservation and the frozen command
 * it names land in the same write, at the starting view's own runtime revision, because a prepared
 * transition has sent nothing and therefore owes no replacement view.
 */
async function queuePreparedTarget(
  ports: RuntimePortsV2,
  matcher: CompiledMatcher,
  target: EnforceableTargetV2,
): Promise<void> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const transition: PendingEnforcementTransition = durableTransition(ports);
  const view: FrozenTransitionView = transition.startingView;
  const key: string = documentCommandKeyV2(target.tabId, target.documentId);
  const command: FrozenDocumentCommand =
    view.documents[key] ??
    startingCommand(
      ports,
      matcher,
      {
        runtime,
        capturedAt: view.capturedAt,
        operationId: view.operationId,
        enforcementEpoch: view.enforcementEpoch,
        basePolicyRevision: view.basePolicyRevision,
        runtimeRevision: view.runtimeRevision,
        sessionId: transition.sessionId,
        durable: transition.kind === 'resume',
      },
      target,
    );
  const documents: Record<string, FrozenDocumentCommand> = {
    ...structuredClone(view.documents),
    [key]: structuredClone(command),
  };
  await writeStage(
    ports,
    runtime,
    {
      ...transition,
      targetGeneration: ports.targets.readTargetGeneration(),
      startingView: { ...structuredClone(view), documents },
      preparedTargetReservations: {
        ...structuredClone(transition.preparedTargetReservations),
        [key]: {
          tabId: target.tabId,
          documentId: target.documentId,
          expectedUrl: target.url,
          commandKey: key,
        },
      },
    },
    { documentCommands: documents },
  );
}

/** Recompiles the policy the durable transition captured, from its candidate or its session. */
export function transitionMatcherV2(ports: RuntimePortsV2): CompiledMatcher {
  const runtime: RuntimeStateV2 = ports.runtime();
  const transition: PendingEnforcementTransition | null = runtime.pendingEnforcementTransition;
  if (transition === null) {
    throw new CoreError('invalid-rule', 'no durable transition names a policy to compile');
  }
  const candidate: SessionStartCandidate | null = transition.candidate;
  if (candidate !== null) return ports.compileMatcher(candidate.rules, candidate.mode);
  const session: SessionStateV2 | null = runtime.session;
  if (session === null) {
    throw new CoreError('invalid-rule', 'a resume transition needs its durable session rules');
  }
  return ports.compileMatcher(session.config.rules, session.config.mode);
}

interface ViewIdentityV2 {
  runtime: RuntimeStateV2;
  capturedAt: number;
  operationId: string;
  enforcementEpoch: string;
  basePolicyRevision: number;
  runtimeRevision: number;
  sessionId: string;
  durable: boolean;
}

/** Freezes one starting command per current enforceable target, under one capture time. */
async function freezeStartingView(
  ports: RuntimePortsV2,
  matcher: CompiledMatcher,
  identity: ViewIdentityV2,
): Promise<FrozenTransitionView> {
  const documents: Record<string, FrozenDocumentCommand> = {};
  for (const target of await enforceableTargets(ports.targets)) {
    const key: string = documentCommandKeyV2(target.tabId, target.documentId);
    documents[key] = startingCommand(ports, matcher, identity, target);
  }
  return {
    capturedAt: identity.capturedAt,
    operationId: identity.operationId,
    enforcementEpoch: identity.enforcementEpoch,
    basePolicyRevision: identity.basePolicyRevision,
    runtimeRevision: identity.runtimeRevision,
    documents,
  };
}

function startingCommand(
  ports: RuntimePortsV2,
  matcher: CompiledMatcher,
  identity: ViewIdentityV2,
  target: EnforceableTargetV2,
): FrozenDocumentCommand {
  const verdict: Verdict = ports.verdictFor(matcher, target.url, identity.runtime.unlocks);
  const stoppedPage: boolean =
    identity.runtime.tabStates[target.tabId]?.stoppedDocumentId === target.documentId;
  return buildFrozenDocumentCommandV2({
    tabId: target.tabId,
    documentId: target.documentId,
    expectedUrl: target.url,
    operationId: identity.operationId,
    enforcementEpoch: identity.enforcementEpoch,
    sessionId: identity.durable ? identity.sessionId : null,
    reservedSessionId: identity.durable ? null : identity.sessionId,
    basePolicyRevision: identity.basePolicyRevision,
    runtimeRevision: identity.runtimeRevision,
    verdict,
    presentation: 'starting',
    overlay: verdict.blocked
      ? buildStartingOverlayView({
          capturedAt: identity.capturedAt,
          theme: ports.theme(),
          stoppedPage,
          verdict,
        })
      : null,
  });
}

interface ActiveViewIdentityV2 {
  runtime: RuntimeStateV2;
  session: SessionStateV2;
  capturedAt: number;
  operationId: string;
  enforcementEpoch: string;
  basePolicyRevision: number;
  runtimeRevision: number;
}

/** Freezes the active view the committed session publishes, under `capturedAt: activationAt`. */
async function freezeActiveView(
  ports: RuntimePortsV2,
  matcher: CompiledMatcher,
  identity: ActiveViewIdentityV2,
): Promise<FrozenTransitionView> {
  const documents: Record<string, FrozenDocumentCommand> = {};
  for (const target of await enforceableTargets(ports.targets)) {
    const key: string = documentCommandKeyV2(target.tabId, target.documentId);
    documents[key] = activeCommand(ports, matcher, identity, target);
  }
  return {
    capturedAt: identity.capturedAt,
    operationId: identity.operationId,
    enforcementEpoch: identity.enforcementEpoch,
    basePolicyRevision: identity.basePolicyRevision,
    runtimeRevision: identity.runtimeRevision,
    documents,
  };
}

function activeCommand(
  ports: RuntimePortsV2,
  matcher: CompiledMatcher,
  identity: ActiveViewIdentityV2,
  target: EnforceableTargetV2,
): FrozenDocumentCommand {
  const verdict: Verdict = ports.verdictFor(matcher, target.url, identity.runtime.unlocks);
  const stoppedPage: boolean =
    identity.runtime.tabStates[target.tabId]?.stoppedDocumentId === target.documentId;
  const economy = ports.economy();
  return buildFrozenDocumentCommandV2({
    tabId: target.tabId,
    documentId: target.documentId,
    expectedUrl: target.url,
    operationId: identity.operationId,
    enforcementEpoch: identity.enforcementEpoch,
    sessionId: identity.session.sessionId,
    reservedSessionId: null,
    basePolicyRevision: identity.basePolicyRevision,
    runtimeRevision: identity.runtimeRevision,
    verdict,
    presentation: 'active',
    overlay: verdict.blocked
      ? buildActiveOverlayView({
          capturedAt: identity.capturedAt,
          theme: ports.theme(),
          session: identity.session,
          economy: {
            bankMs: Math.min(ports.bank().balanceMs, economy.capMs),
            bankAccrualPerMs: economy.earnRatio,
            bankCapMs: economy.capMs,
            pauseCostMs: economy.pauseMs,
            unlockCostMs: economy.unlockMs,
          },
          gate: identity.runtime.gate,
          activeUnlocks: identity.runtime.unlocks.filter(
            (unlock): boolean => unlock.until > identity.capturedAt,
          ),
          attemptsToday: ports.attemptsToday(),
          stoppedPage,
          verdict,
        })
      : null,
  });
}

/**
 * The sweep driver the target module calls. Its whole job is to answer with the persisted frozen
 * command, and to persist a complete replacement view under a higher runtime revision the first
 * time it is asked about a document the current view does not carry.
 */
function sweepDriver(
  ports: RuntimePortsV2,
  matcher: CompiledMatcher,
  phase: SweepPhaseV2,
): SweepDriverV2 {
  const commandFor = async (target: EnforceableTargetV2): Promise<FrozenDocumentCommand> => {
    const key: string = documentCommandKeyV2(target.tabId, target.documentId);
    const stored: FrozenDocumentCommand | undefined = currentView(ports, phase).documents[key];
    if (stored !== undefined) return structuredClone(stored);
    return addDocumentToView(ports, matcher, phase, target);
  };
  return {
    commandFor,
    resetFor: async (target: EnforceableTargetV2): Promise<FrozenEpochResetCommand> => {
      const transition: PendingEnforcementTransition = durableTransition(ports);
      return buildFrozenEpochResetCommandV2({
        tabId: target.tabId,
        documentId: target.documentId,
        expectedUrl: target.url,
        operationId:
          phase === 'starting' ? transition.startingOperationId : transition.activeOperationId,
        enforcementEpoch: transition.enforcementEpoch,
      });
    },
    hasEpochAck: (tabId: number, documentId: string): boolean => {
      const runtime: RuntimeStateV2 = ports.runtime();
      const ack: DocumentEpochResetAck | undefined =
        runtime.epochResetAcks[documentCommandKeyV2(tabId, documentId)];
      return ack !== undefined && ack.enforcementEpoch === runtime.enforcementEpoch;
    },
    recordEpochAck: async (ack: DocumentEpochResetAck): Promise<void> => {
      const runtime: RuntimeStateV2 = ports.runtime();
      await ports.writeRuntime(
        requireValid({
          ...structuredClone(runtime),
          epochResetAcks: {
            ...structuredClone(runtime.epochResetAcks),
            [documentCommandKeyV2(ack.tabId, ack.documentId)]: structuredClone(ack),
          },
        }),
      );
    },
    onStale: commandFor,
    transport: ports.transport,
  };
}

/** The view the current phase reissues. */
function currentView(ports: RuntimePortsV2, phase: SweepPhaseV2): FrozenTransitionView {
  const transition: PendingEnforcementTransition = durableTransition(ports);
  if (phase === 'starting') return transition.startingView;
  const active: FrozenTransitionView | null = transition.activeView;
  if (active === null) {
    throw new CoreError('invalid-rule', 'an active sweep needs its frozen active view');
  }
  return active;
}

/**
 * A document the frozen view does not carry advances the runtime revision and persists a complete
 * replacement view, together with the runtime command map, before its command is returned for
 * sending. That is what keeps "frozen before send" true for a target that arrived mid-sweep.
 */
async function addDocumentToView(
  ports: RuntimePortsV2,
  matcher: CompiledMatcher,
  phase: SweepPhaseV2,
  target: EnforceableTargetV2,
): Promise<FrozenDocumentCommand> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const transition: PendingEnforcementTransition = durableTransition(ports);
  const view: FrozenTransitionView = currentView(ports, phase);
  const runtimeRevision: number = runtime.runtimeRevision + 1;
  const key: string = documentCommandKeyV2(target.tabId, target.documentId);
  const documents: Record<string, FrozenDocumentCommand> = {};
  for (const [existingKey, command] of Object.entries(view.documents)) {
    documents[existingKey] = { ...structuredClone(command), runtimeRevision };
  }
  documents[key] =
    phase === 'starting'
      ? startingCommand(
          ports,
          matcher,
          {
            runtime,
            capturedAt: view.capturedAt,
            operationId: view.operationId,
            enforcementEpoch: view.enforcementEpoch,
            basePolicyRevision: view.basePolicyRevision,
            runtimeRevision,
            sessionId: transition.sessionId,
            durable: transition.kind === 'resume',
          },
          target,
        )
      : activeCommand(
          ports,
          matcher,
          {
            runtime,
            session: requireSession(runtime),
            capturedAt: view.capturedAt,
            operationId: view.operationId,
            enforcementEpoch: view.enforcementEpoch,
            basePolicyRevision: view.basePolicyRevision,
            runtimeRevision,
          },
          target,
        );
  const replacement: FrozenTransitionView = { ...view, runtimeRevision, documents };
  const next: PendingEnforcementTransition =
    phase === 'starting'
      ? { ...transition, runtimeRevision, startingView: replacement }
      : { ...transition, runtimeRevision, activeView: replacement };
  await writeStage(ports, runtime, next, { runtimeRevision, documentCommands: documents });
  const added: FrozenDocumentCommand | undefined = documents[key];
  if (added === undefined)
    throw new CoreError('invalid-rule', 'the replacement view lost its new document');
  return structuredClone(added);
}

/** The checkpoint one verified sweep produces. */
function checkpointFor(
  transition: PendingEnforcementTransition,
  phase: SweepPhaseV2,
  documents: readonly DocumentEnforcementAck[],
  exclusions: readonly EnforcementTargetExclusion[],
  timing: { auditedAt: number; generation: number },
): EnforcementCheckpoint {
  return {
    version: 1,
    operationId:
      phase === 'starting' ? transition.startingOperationId : transition.activeOperationId,
    enforcementEpoch: transition.enforcementEpoch,
    sessionId: transition.sessionId,
    basePolicyRevision: transition.basePolicyRevision,
    kind: transition.kind === 'start' ? 'activation' : 'resume-strengthening',
    registrationAuditedAt: timing.auditedAt,
    completedAt: timing.auditedAt,
    targetGeneration: timing.generation,
    documents: structuredClone([...documents]),
    exclusions: structuredClone([...exclusions]),
  };
}

interface StageWriteV2 {
  runtimeRevision?: number;
  documentCommands?: Record<string, FrozenDocumentCommand>;
}

/** Persists one stage row. Every write goes through the storage boundary before it is stored. */
async function writeStage(
  ports: RuntimePortsV2,
  runtime: RuntimeStateV2,
  transition: PendingEnforcementTransition,
  fields: StageWriteV2,
): Promise<RuntimeStateV2> {
  const next: RuntimeStateV2 = requireValid({
    ...structuredClone(runtime),
    ...(fields.runtimeRevision === undefined ? {} : { runtimeRevision: fields.runtimeRevision }),
    ...(fields.documentCommands === undefined
      ? {}
      : { documentCommands: structuredClone(fields.documentCommands) }),
    pendingEnforcementTransition: structuredClone(transition),
  });
  await ports.writeRuntime(next);
  return next;
}

/** The idle runtime a start needs: no session, no transition, and no closure. */
function idleRuntimeFor(ports: RuntimePortsV2, kind: 'start'): RuntimeStateV2 {
  const runtime: RuntimeStateV2 = ports.runtime();
  if (
    runtime.session !== null ||
    runtime.pendingEnforcementTransition !== null ||
    runtime.pendingClosure !== null
  ) {
    throw new CoreError('invalid-rule', `a ${kind} needs an idle runtime`);
  }
  return runtime;
}

function durableTransition(ports: RuntimePortsV2): PendingEnforcementTransition {
  const transition: PendingEnforcementTransition | null =
    ports.runtime().pendingEnforcementTransition;
  if (transition === null) {
    throw new CoreError('invalid-rule', 'this step needs a durable transition');
  }
  return transition;
}

function requireSession(runtime: RuntimeStateV2): SessionStateV2 {
  const session: SessionStateV2 | null = runtime.session;
  if (session === null) throw new CoreError('invalid-rule', 'an active view needs its session');
  return session;
}

async function enforceableTargets(ports: EnforcementTargetPortsV2): Promise<EnforceableTargetV2[]> {
  const classified: TargetClassificationV2[] = await enumerateEnforcementTargetsV2(ports);
  return classified.filter(
    (target: TargetClassificationV2): target is EnforceableTargetV2 =>
      target.kind === 'enforceable',
  );
}

/** No runner ever hands `writeRuntime` or `commit` a value the storage boundary would reject. */
function requireValid(runtime: RuntimeStateV2): RuntimeStateV2 {
  const parsed: RuntimeStateV2 | null = parseRuntimeStateV2(runtime);
  if (parsed === null) {
    throw new CoreError('invalid-rule', 'the transition runner built an invalid runtime');
  }
  return parsed;
}

/** Every stage row is validated as a transition before it becomes part of a runtime write. */
export function assertValidTransitionV2(transition: PendingEnforcementTransition): void {
  if (!validateDetachedPendingEnforcementTransition(structuredClone(transition))) {
    throw new CoreError('invalid-rule', 'the transition runner built an invalid transition');
  }
}

/** The stages this runner recognizes, for the controller that routes a durable row back to it. */
export const DRIVEABLE_TRANSITION_STAGES: ReadonlySet<TransitionStage> = new Set<TransitionStage>([
  'prepared',
  'registration-audited',
  'starting-verified',
  'committed-pending-verification',
  'alarm-ready',
  'active-verified',
]);

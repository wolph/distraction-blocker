/**
 * Transition cleanup. This file owns the one durable entry write that moves a transition from the
 * stage it failed at into `cleanup`, together with the closure a cause that ends a durable session
 * must capture before any browser effect runs.
 *
 * Task 3 adds attempts, automatic retry, manual retry, and the post-cleanup resolution handoff on
 * top of this entry without rewriting it: everything below produces the durable row those steps
 * then advance.
 *
 * The entry is one write, and it is the last moment the durable session still exists for a closing
 * cause, which is why the closure projection is captured here rather than after the effects.
 *
 * The entry takes `{ cause, failure, endedAt }` and derives the end reason. An earlier brief drafted
 * it as `{ cause, failure, closure: { endedAt, reason } | null }`; that shape is superseded by
 * controller ruling and should not be restored.
 */

import { CoreError } from '../shared/errors';
import type { RetryCleanupResultCodeV2 } from '../shared/messages';
import { syncAggKey } from '../shared/storage-keys';
import type { DailyAgg, SessionEndReasonV2, SessionStateV2 } from '../shared/types';
import {
  type AlarmNameV2,
  clearAlarmWithReadBackV2,
  createAlarmWithReadBackV2,
  ensurePhaseAlarmV2,
  parseAlarmNameV2,
  TRANSITION_CLEANUP_ALARM,
} from './alarms-v2';
import {
  addCleanupTargetV2,
  buildCleanupProgressV2,
  buildCleanupSeedV2,
  documentCommandKeyV2,
  mergeCleanupTabClaimV2,
  recordCleanupAttemptFailureV2,
  replaceCleanupBatchV2,
  resolveCleanupTabV2,
} from './cleanup-progress-v2';
import { buildClosureProjectionV2, splitFocusByLocalDateV2 } from './closure-projection-v2';
import {
  type DocumentCommandOutcomeV2,
  type EpochResetOutcomeV2,
  sendDocumentEnforcementCommand,
  sendEpochResetCommand,
} from './content-transport-v2';
import type { DocumentEpochResetAck, FrozenDocumentCommand } from './enforcement-persistence-v2';
import { classifyEnforcementTargetV2, type TargetClassificationV2 } from './enforcement-targets-v2';
import { buildFrozenEpochResetCommandV2 } from './overlay-view-v2';
import { projectRuntimeDomainV2 } from './runtime-checkpoint-v2';
import type { RuntimePortsV2 } from './runtime-ports-v2';
import type {
  CleanupEnforcementTarget,
  CleanupProgress,
  CleanupRetryState,
  CleanupSeed,
  CleanupTabClaim,
  ClosureProjection,
  PendingEnforcementTransition,
  PostCleanupClosure,
  RuntimeStateV2,
  TransitionFailureReason,
} from './runtime-v2-types';
import { parseRuntimeStateV2 } from './runtime-v2-validation';

export type TransitionCleanupCauseV2 = NonNullable<PendingEnforcementTransition['cleanupCause']>;
export type TransitionCleanupSourceV2 = NonNullable<PendingEnforcementTransition['cleanupFrom']>;

/** The logical end a closing cause captures. The reason is what tells the user why it ended. */
export interface PostCleanupClosureCaptureV2 {
  endedAt: number;
  reason: SessionEndReasonV2;
}

/** The browser effects one cleanup attempt performs. Everything else here is pure state. */
export interface CleanupEffectPortsV2 {
  restoreTabClaims(claims: readonly CleanupTabClaim[]): Promise<number[]>;
  reloadStoppedDocuments(claims: readonly CleanupTabClaim[]): Promise<void>;
  requestBlankBadge(): void;
}

export interface TransitionCleanupEntryV2 {
  cause: TransitionCleanupCauseV2;
  failure: TransitionFailureReason | null;
  /** The logical end. Read only for the causes that close a durable session. */
  endedAt: number;
}

/**
 * The entry's own retry batch, and a manual retry begins the next one. Transition cleanup numbers
 * its batches from one per the task brief, while `freshCleanupRetryStateV2` and the migration
 * closure number theirs from zero. Nothing reads the number except the batch-advance guard, which
 * only compares it with the batch before it, so the two conventions coexist safely.
 */
const FIRST_CLEANUP_BATCH: number = 1;
/** Exactly the causes that must close a durable session, so exactly these capture a closure. */
const CLOSING_CAUSES: ReadonlySet<TransitionCleanupCauseV2> = new Set<TransitionCleanupCauseV2>([
  'timer-completed',
  'manual-end',
  'transition-failed',
]);
/** The end reason each closing cause records, which is what tells the user why it ended. */
const CLOSURE_REASONS: Readonly<Record<string, SessionEndReasonV2>> = {
  'timer-completed': 'timer-completed',
  'manual-end': 'manual-completed',
};

/**
 * Moves the durable transition into `cleanup` in one write. The row it produces carries the exact
 * clear batch runtime `documentCommands` must equal, the session the cause implies, and, for a
 * closing cause, the immutable closure captured while the session is still durable.
 */
export async function enterTransitionCleanupV2(
  ports: RuntimePortsV2,
  entry: TransitionCleanupEntryV2,
): Promise<RuntimeStateV2> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const transition: PendingEnforcementTransition | null = runtime.pendingEnforcementTransition;
  if (transition === null) {
    throw new CoreError('invalid-rule', 'transition cleanup needs a durable transition');
  }
  if (transition.stage === 'cleanup') {
    throw new CoreError('invalid-rule', 'this transition is already in cleanup');
  }
  const clearRuntimeRevision: number = runtime.runtimeRevision + 1;
  const seed: CleanupSeed = buildCleanupSeedV2(transition.alarmNames, runtime.tabStates);
  const progress: CleanupProgress = buildCleanupProgressV2({
    cleanupOperationId: ports.newId(),
    clearRuntimeRevision,
    targets: clearTargetsOf(transition, entry),
    identity: {
      enforcementEpoch: runtime.enforcementEpoch,
      basePolicyRevision: transition.basePolicyRevision,
      ...clearedIdentity(transition),
    },
    seed,
    at: ports.now(),
    batch: FIRST_CLEANUP_BATCH,
  });
  const closure: PostCleanupClosure | null = await captureClosure(ports, runtime, entry, seed);
  const next: RuntimeStateV2 = cleanupRuntime(runtime, transition, entry, {
    clearRuntimeRevision,
    progress,
    closure,
  });
  await ports.writeRuntime(next);
  return next;
}

interface CleanupRowV2 {
  clearRuntimeRevision: number;
  progress: CleanupProgress;
  closure: PostCleanupClosure | null;
}

/**
 * The runtime the entry persists. Its command map is exactly the clear batch, its revision is the
 * clear revision, its base policy revision is the one the transition reserved and this write now
 * makes durable, and the session is the one the cause leaves behind.
 */
function cleanupRuntime(
  runtime: RuntimeStateV2,
  transition: PendingEnforcementTransition,
  entry: TransitionCleanupEntryV2,
  row: CleanupRowV2,
): RuntimeStateV2 {
  const next: RuntimeStateV2 = {
    ...structuredClone(runtime),
    session: retainedSession(runtime, entry.cause),
    basePolicyRevision: transition.basePolicyRevision,
    runtimeRevision: row.clearRuntimeRevision,
    documentCommands: structuredClone(row.progress.clearCommands),
    enforcementCheckpoint: null,
    pendingEnforcementTransition: {
      ...structuredClone(transition),
      stage: 'cleanup',
      runtimeRevision: row.clearRuntimeRevision,
      preparedTargetReservations: {},
      failure: entry.failure,
      cleanupProgress: structuredClone(row.progress),
      cleanupFrom: transition.stage as TransitionCleanupSourceV2,
      cleanupCause: entry.cause,
      postCleanupClosure: structuredClone(row.closure),
    },
  };
  const parsed: RuntimeStateV2 | null = parseRuntimeStateV2(next);
  if (parsed === null) {
    throw new CoreError('invalid-rule', 'transition cleanup entry failed runtime validation');
  }
  return parsed;
}

/**
 * Abandoning a start removes the session it never committed. Every other cause keeps the durable
 * session: a restored resume keeps its saved pause or break, and a closing cause keeps the session
 * frozen at the projected end until the one-checkpoint handoff clears it.
 */
function retainedSession(
  runtime: RuntimeStateV2,
  cause: TransitionCleanupCauseV2,
): SessionStateV2 | null {
  return cause === 'start-abandon' ? null : structuredClone(runtime.session);
}

/** The two audit answers, which fail before registration is audited and so before any send. */
const AUDIT_FAILURES: ReadonlySet<string> = new Set<string>([
  'website-access-lost',
  'content-registration-failed',
]);

/**
 * The clear batch covers exactly the documents the transition's newest frozen view addressed, with
 * one exception: an audit failure happens before registration is audited, so no document has been
 * sent anything (spec 766) and there is nothing to clear. That entry releases its reservations with
 * an empty batch instead of clearing targets that never heard from this transition.
 */
function clearTargetsOf(
  transition: PendingEnforcementTransition,
  entry: TransitionCleanupEntryV2,
): CleanupEnforcementTarget[] {
  if (entry.failure !== null && AUDIT_FAILURES.has(entry.failure)) return [];
  return frozenTargetsOf(transition);
}

function frozenTargetsOf(transition: PendingEnforcementTransition): CleanupEnforcementTarget[] {
  const view: Record<string, FrozenDocumentCommand> =
    transition.activeView?.documents ?? transition.startingView.documents;
  return Object.values(view).map(
    (command: FrozenDocumentCommand): CleanupEnforcementTarget => ({
      tabId: command.tabId,
      documentId: command.documentId,
      expectedUrl: command.expectedUrl,
    }),
  );
}

/**
 * A clear command names the session in the form the source stage had. A committed transition and
 * every resume own a durable session ID; a pre-commit start only ever reserved one.
 */
function clearedIdentity(transition: PendingEnforcementTransition): {
  sessionId: string | null;
  reservedSessionId: string | null;
} {
  const durable: boolean = transition.activeView !== null || transition.kind === 'resume';
  return durable
    ? { sessionId: transition.sessionId, reservedSessionId: null }
    : { sessionId: null, reservedSessionId: transition.sessionId };
}

/**
 * Captures the immutable closure a closing cause owes, while the session is still durable. Focus
 * that crosses a local midnight lands on a day the runtime already wrote, and an aggregate set is
 * an absolute value, so every date the settlement touches is read back before it is added to.
 */
async function captureClosure(
  ports: RuntimePortsV2,
  runtime: RuntimeStateV2,
  entry: TransitionCleanupEntryV2,
  seed: CleanupSeed,
): Promise<PostCleanupClosure | null> {
  if (!CLOSING_CAUSES.has(entry.cause)) return null;
  const session: SessionStateV2 | null = runtime.session;
  if (session === null) {
    throw new CoreError('invalid-rule', `${entry.cause} cleanup needs the session it closes`);
  }
  const projection: ClosureProjection = buildClosureProjectionV2({
    session,
    endedAt: entry.endedAt,
    reason: closureReason(entry, session),
    bank: ports.bank(),
    pauseEconomy: ports.economy(),
    accruedFocusMs: runtime.accruedFocusMs,
    todayAgg: runtime.todayAgg,
    priorAggregates: await settledAggregates(ports, session, entry.endedAt),
    runtimeDate: runtime.date,
    deviceId: ports.deviceId(),
    currentHandledOccurrences: runtime.handledScheduleOccurrences,
    openOccurrences: ports.openOccurrencesAt(entry.endedAt),
  }).projection;
  return { projection: structuredClone(projection), cleanupSeed: structuredClone(seed) };
}

/**
 * A transition failure ends the session with the enforcement reason that caused it. Timer
 * completion and a manual end carry their own reasons, and a manual end of a timed session is an
 * early cancel rather than a completion.
 */
function closureReason(
  entry: TransitionCleanupEntryV2,
  session: SessionStateV2,
): SessionEndReasonV2 {
  if (entry.cause === 'transition-failed') {
    if (entry.failure === null) {
      throw new CoreError('invalid-rule', 'a transition-failed cleanup names its failure');
    }
    return entry.failure;
  }
  if (entry.cause === 'manual-end' && session.config.duration.kind !== 'until-stopped') {
    return 'manual-canceled';
  }
  const reason: SessionEndReasonV2 | undefined = CLOSURE_REASONS[entry.cause];
  if (reason === undefined) {
    throw new CoreError('invalid-rule', `${entry.cause} does not close a session`);
  }
  return reason;
}

/** Reads back every stored day the settled focus lands on, so no finished day is overwritten. */
async function settledAggregates(
  ports: RuntimePortsV2,
  session: SessionStateV2,
  endedAt: number,
): Promise<Record<string, DailyAgg>> {
  const from: number = session.phase === 'focus' ? session.phaseStartedAt : endedAt;
  const keys: string[] = splitFocusByLocalDateV2(from, endedAt).map((split): string =>
    syncAggKey(ports.deviceId(), split.date),
  );
  return keys.length === 0 ? {} : ports.loadAggregates(keys);
}

/** Re-exported so the runner and Task 3 agree on the one document key spelling. */
export { documentCommandKeyV2 };

/**
 * One cleanup attempt. It clears the alarms the transition owns, blanks the badge, reissues the
 * exact frozen clear commands, restores the tab claims it captured, and then either resolves the
 * transition or records the failure and schedules the next attempt.
 *
 * Nothing here regenerates a command. Every send is the value the entry froze, which is what makes
 * an automatic retry and a restart indistinguishable to a document.
 */
export async function runTransitionCleanupAttemptV2(
  ports: RuntimePortsV2,
  effects: CleanupEffectPortsV2,
): Promise<RuntimeStateV2> {
  const transition: PendingEnforcementTransition = cleanupTransitionOf(ports);
  const progress: CleanupProgress = requireProgress(transition);
  let failure: string | null;
  try {
    failure = await performCleanupEffects(ports, effects, transition, progress);
  } catch (error: unknown) {
    // A cleanup error raised while acting on the browser, a contradictory tab claim included, is
    // this attempt's failure and is recorded as one. It never escapes as an overwrite or a throw.
    failure = error instanceof Error ? error.message : String(error);
  }
  if (failure !== null) return recordAttemptFailure(ports, failure);
  return resolveCleanup(ports);
}

/**
 * Runs the browser side of one attempt and returns the first fatal detail, or null when the
 * attempt is clean. A closed or changed target is not a failure: it disappears from the next
 * reread, and a missing acknowledgement is never treated as success.
 */
async function performCleanupEffects(
  ports: RuntimePortsV2,
  effects: CleanupEffectPortsV2,
  transition: PendingEnforcementTransition,
  progress: CleanupProgress,
): Promise<string | null> {
  for (const name of transition.alarmNames) {
    const alarm: AlarmNameV2 | null = parseAlarmNameV2(name);
    if (alarm === null) return `cleanup cannot clear the unknown alarm ${name}`;
    if (!(await clearAlarmWithReadBackV2(ports.alarms, alarm))) {
      return `cleanup could not clear the ${alarm} alarm`;
    }
  }
  effects.requestBlankBadge();
  const cleared: string | null = await reissueClearCommands(ports, progress);
  if (cleared !== null) return cleared;
  const resolved: number[] = await effects.restoreTabClaims(progress.tabClaims);
  await effects.reloadStoppedDocuments(progress.tabClaims);
  await recordResolvedTabs(ports, resolved);
  return null;
}

/** Resets any target that has not acknowledged this epoch, then sends its frozen clear command. */
async function reissueClearCommands(
  ports: RuntimePortsV2,
  progress: CleanupProgress,
): Promise<string | null> {
  for (const [key, command] of Object.entries(progress.clearCommands)) {
    // Reread per target: the acknowledgement this loop persists for one document is durable
    // before the next document is considered.
    const runtime: RuntimeStateV2 = ports.runtime();
    const ack: DocumentEpochResetAck | undefined = runtime.epochResetAcks[key];
    if (ack === undefined || ack.enforcementEpoch !== runtime.enforcementEpoch) {
      const reset: EpochResetOutcomeV2 = await sendEpochResetCommand(
        ports.transport,
        buildFrozenEpochResetCommandV2({
          tabId: command.tabId,
          documentId: command.documentId,
          expectedUrl: command.expectedUrl,
          operationId: progress.cleanupOperationId,
          enforcementEpoch: command.enforcementEpoch,
        }),
      );
      if (reset.kind === 'closed') continue;
      if (reset.kind !== 'reset') return `cleanup reset for ${key} answered ${reset.kind}`;
      await recordCleanupEpochAck(ports, reset.ack);
    }
    const outcome: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
      ports.transport,
      command,
    );
    if (outcome.kind === 'applied' || outcome.kind === 'closed' || outcome.kind === 'changed') {
      continue;
    }
    // Nothing may outrank the clear revision, so a stale answer during cleanup is fatal too.
    return `cleanup clear for ${key} answered ${outcome.kind}`;
  }
  return null;
}

/** Resolves the transition the clean attempt earned, by the cause that entered cleanup. */
async function resolveCleanup(ports: RuntimePortsV2): Promise<RuntimeStateV2> {
  const transition: PendingEnforcementTransition = cleanupTransitionOf(ports);
  const closure: PostCleanupClosure | null = transition.postCleanupClosure;
  if (closure !== null) return handOffClosure(ports, transition, closure);
  if (transition.cleanupCause === 'resume-restore') return restoreResume(ports);
  return clearTransition(ports, `${transition.sessionId}:abandon`);
}

/**
 * Restores the pause or break a pre-commit resume left. The saved phase alarm is recreated and read
 * back before the commit, so the restored session is never durable without the boundary it needs.
 * An arrived fixed end upgrades to timer completion instead of restoring.
 */
async function restoreResume(ports: RuntimePortsV2): Promise<RuntimeStateV2> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const session: SessionStateV2 | null = runtime.session;
  if (session === null) {
    throw new CoreError('invalid-rule', 'a resume restore lost the session it restores');
  }
  const now: number = ports.now();
  if (session.sessionEndsAt !== null && session.sessionEndsAt <= now) {
    return upgradeToTimerCompletion(ports, session.sessionEndsAt);
  }
  if ((await ensurePhaseAlarmV2(ports.alarms, session)) === 'alarm-failed') {
    return recordAttemptFailure(ports, 'cleanup could not restore the saved phase alarm');
  }
  return clearTransition(ports, `${session.sessionId}:restore`);
}

/**
 * A resume whose fixed end arrived during cleanup has nothing to restore, so it captures timer
 * completion at the exact end and hands that closure off through the same one-checkpoint path.
 *
 * The reread after the closure capture is structural rather than tested. `captureClosure` awaits
 * only `ports.loadAggregates`, and `settledAggregates` skips that read whenever the settlement
 * covers no dates; this function is reached from `restoreResume` alone, where the session is always
 * paused or break, so the settlement window is always empty and no await occurs. The reread costs
 * nothing and keeps the branch correct if a future caller reaches it with a focus session, but
 * there is no interleaving a test can drive through it today.
 */
async function upgradeToTimerCompletion(
  ports: RuntimePortsV2,
  endedAt: number,
): Promise<RuntimeStateV2> {
  const seed: CleanupSeed = buildCleanupSeedV2(
    cleanupTransitionOf(ports).alarmNames,
    ports.runtime().tabStates,
  );
  const closure: PostCleanupClosure | null = await captureClosure(
    ports,
    ports.runtime(),
    { cause: 'timer-completed', failure: null, endedAt },
    seed,
  );
  if (closure === null) {
    throw new CoreError('invalid-rule', 'timer completion did not capture its closure');
  }
  // Capturing the closure reads stored aggregates, so the row this upgrade writes is reread after
  // that await. A navigation handled meanwhile has already advanced the durable batch.
  const current: RuntimeStateV2 = ports.runtime();
  const upgraded: PendingEnforcementTransition = {
    ...structuredClone(cleanupTransitionOf(ports)),
    cleanupCause: 'timer-completed',
    postCleanupClosure: structuredClone(closure),
  };
  await ports.writeRuntime(
    validated({ ...structuredClone(current), pendingEnforcementTransition: upgraded }),
  );
  return handOffClosure(ports, upgraded, closure);
}

/**
 * The one checkpoint that crosses journals. It allocates the closure's own cleanup batch above the
 * transition's clear revision, carries the verified claims and resolved tabs forward, replaces the
 * runtime command map, flushes the projected events, bank, and aggregates, installs the closure at
 * `cleanup`, and clears the transition. The projection itself is copied byte for byte.
 */
async function handOffClosure(
  ports: RuntimePortsV2,
  transition: PendingEnforcementTransition,
  closure: PostCleanupClosure,
): Promise<RuntimeStateV2> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const transitionProgress: CleanupProgress = requireProgress(transition);
  const clearRuntimeRevision: number = transitionProgress.clearRuntimeRevision + 1;
  const projection: ClosureProjection = closure.projection;
  let progress: CleanupProgress = buildCleanupProgressV2({
    cleanupOperationId: ports.newId(),
    clearRuntimeRevision,
    targets: Object.values(transitionProgress.targets).map(
      (target: CleanupEnforcementTarget): CleanupEnforcementTarget => structuredClone(target),
    ),
    identity: {
      enforcementEpoch: runtime.enforcementEpoch,
      basePolicyRevision: runtime.basePolicyRevision,
      sessionId: projection.sessionId,
      reservedSessionId: null,
    },
    seed: closure.cleanupSeed,
    at: ports.now(),
    batch: FIRST_CLEANUP_BATCH,
  });
  for (const claim of transitionProgress.tabClaims) {
    progress = mergeCleanupTabClaimV2(progress, claim);
  }
  for (const tabId of transitionProgress.resolvedTabIds) {
    progress = resolveCleanupTabV2(progress, tabId);
  }
  const next: RuntimeStateV2 = validated({
    ...structuredClone(runtime),
    session: null,
    gate: null,
    unlocks: [],
    runtimeRevision: clearRuntimeRevision,
    documentCommands: structuredClone(progress.clearCommands),
    enforcementCheckpoint: null,
    handledScheduleOccurrences: structuredClone(projection.handledOccurrences),
    pendingEnforcementTransition: null,
    pendingClosure: {
      version: 1,
      stage: 'cleanup',
      projection: structuredClone(projection),
      cleanupSeed: structuredClone(closure.cleanupSeed),
      cleanupProgress: structuredClone(progress),
    },
  });
  return ports.commit({
    checkpointId: projection.closureId,
    projection: projectRuntimeDomainV2(next),
    bank: structuredClone(projection.bankAfter),
    events: structuredClone(projection.events),
    syncBank: true,
    aggregateSets: structuredClone(projection.aggregateSets),
    aggregateRemoves: [...projection.aggregateRemoves],
  });
}

/** Clears a resolved transition that owes no closure, retaining the durable clear tuple. */
async function clearTransition(
  ports: RuntimePortsV2,
  checkpointId: string,
): Promise<RuntimeStateV2> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const next: RuntimeStateV2 = validated({
    ...structuredClone(runtime),
    pendingEnforcementTransition: null,
  });
  return ports.commit({
    checkpointId,
    projection: projectRuntimeDomainV2(next),
    bank: ports.bank(),
    events: [],
    syncBank: false,
    aggregateSets: {},
    aggregateRemoves: [],
  });
}

/**
 * Records one failed attempt and schedules the next. The twelfth failure leaves `nextAttemptAt`
 * null and creates no alarm, which is what lifecycle reads as `transition-cleanup-failed`.
 */
async function recordAttemptFailure(
  ports: RuntimePortsV2,
  detail: string,
): Promise<RuntimeStateV2> {
  let next: RuntimeStateV2 = await writeAttemptFailure(ports, detail);
  for (;;) {
    const scheduled: number | null = retryStateOf(next).nextAttemptAt;
    if (scheduled === null) return next;
    if (await createAlarmWithReadBackV2(ports.alarms, TRANSITION_CLEANUP_ALARM, scheduled)) {
      return next;
    }
    // An alarm the browser refused is not a scheduled attempt. Recording it as one more failure is
    // what keeps the schedule moving toward the manual retry instead of stranding this journal
    // with a live `nextAttemptAt` that nothing will ever fire.
    next = await writeAttemptFailure(ports, 'cleanup could not schedule its retry alarm');
  }
}

/** Advances the retry state by one failure and persists it. */
async function writeAttemptFailure(ports: RuntimePortsV2, detail: string): Promise<RuntimeStateV2> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const transition: PendingEnforcementTransition = cleanupTransitionOf(ports);
  const progress: CleanupProgress = requireProgress(transition);
  const retry: CleanupRetryState = recordCleanupAttemptFailureV2(
    progress.retry,
    ports.now(),
    detail,
  );
  const next: RuntimeStateV2 = validated({
    ...structuredClone(runtime),
    pendingEnforcementTransition: {
      ...structuredClone(transition),
      cleanupProgress: { ...structuredClone(progress), retry },
    },
  });
  await ports.writeRuntime(next);
  return next;
}

function retryStateOf(runtime: RuntimeStateV2): CleanupRetryState {
  const retry: CleanupRetryState | undefined =
    runtime.pendingEnforcementTransition?.cleanupProgress?.retry;
  if (retry === undefined) {
    throw new CoreError('invalid-rule', 'a cleanup attempt needs its durable retry state');
  }
  return retry;
}

/** Records the tabs whose captured effects were verified clean, so a retry leaves them alone. */
async function recordResolvedTabs(
  ports: RuntimePortsV2,
  resolved: readonly number[],
): Promise<void> {
  if (resolved.length === 0) return;
  const runtime: RuntimeStateV2 = ports.runtime();
  const transition: PendingEnforcementTransition = cleanupTransitionOf(ports);
  let progress: CleanupProgress = requireProgress(transition);
  for (const tabId of resolved) progress = resolveCleanupTabV2(progress, tabId);
  await ports.writeRuntime(
    validated({
      ...structuredClone(runtime),
      pendingEnforcementTransition: {
        ...structuredClone(transition),
        cleanupProgress: structuredClone(progress),
      },
    }),
  );
}

/** One acknowledgement becomes durable before the enforcement command it authorizes is sent. */
async function recordCleanupEpochAck(
  ports: RuntimePortsV2,
  ack: DocumentEpochResetAck,
): Promise<void> {
  const runtime: RuntimeStateV2 = ports.runtime();
  await ports.writeRuntime(
    validated({
      ...structuredClone(runtime),
      epochResetAcks: {
        ...structuredClone(runtime.epochResetAcks),
        [documentCommandKeyV2(ack.tabId, ack.documentId)]: structuredClone(ack),
      },
    }),
  );
}

/**
 * The manual retry the popup offers once a batch is exhausted. One durable write allocates a new
 * operation, advances the clear revision, replaces every frozen command and the runtime map, and
 * begins the next batch. Targets, claims, resolved IDs, and the closure projection do not move.
 */
export async function retryTransitionCleanupV2(
  ports: RuntimePortsV2,
): Promise<{ runtime: RuntimeStateV2; code: RetryCleanupResultCodeV2 }> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const transition: PendingEnforcementTransition | null = runtime.pendingEnforcementTransition;
  const progress: CleanupProgress | null = transition?.cleanupProgress ?? null;
  if (
    transition === null ||
    transition.stage !== 'cleanup' ||
    progress === null ||
    progress.retry.nextAttemptAt !== null
  ) {
    return { runtime, code: 'retry-not-available' };
  }
  const at: number = ports.now();
  const replaced: CleanupProgress = replaceCleanupBatchV2(progress, {
    cleanupOperationId: ports.newId(),
    clearRuntimeRevision: progress.clearRuntimeRevision + 1,
    at,
  });
  const next: RuntimeStateV2 = validated({
    ...structuredClone(runtime),
    runtimeRevision: replaced.clearRuntimeRevision,
    documentCommands: structuredClone(replaced.clearCommands),
    pendingEnforcementTransition: {
      ...structuredClone(transition),
      runtimeRevision: replaced.clearRuntimeRevision,
      cleanupProgress: structuredClone(replaced),
    },
  });
  // Through the checkpoint rather than a plain write: `assertCleanupBatchAdvance` is written for
  // exactly this replacement, and it only runs inside a commit. Nothing is flushed.
  const committed: RuntimeStateV2 = await ports.commit({
    checkpointId: `${transition.transitionId}:cleanup-retry-${replaced.retry.batch}`,
    projection: projectRuntimeDomainV2(next),
    bank: ports.bank(),
    events: [],
    syncBank: false,
    aggregateSets: {},
    aggregateRemoves: [],
  });
  return { runtime: committed, code: 'ok' };
}

/**
 * Adds a target discovered while cleanup is running. The target and its frozen clear command are
 * durable before the first send, under the batch's existing operation and clear revision, so a
 * newly found document never outranks the commands already in flight.
 */
export async function handleCleanupNavigationV2(
  ports: RuntimePortsV2,
  target: { tabId: number; documentId: string; url: string },
): Promise<void> {
  if (typeof target.documentId !== 'string' || target.documentId.trim() === '') {
    throw new CoreError('invalid-rule', 'a cleanup target needs a document ID');
  }
  const classified: TargetClassificationV2 = classifyEnforcementTargetV2(
    target.tabId,
    target.url,
    target.documentId,
  );
  if (classified.kind !== 'enforceable') return;
  const runtime: RuntimeStateV2 = ports.runtime();
  const transition: PendingEnforcementTransition = cleanupTransitionOf(ports);
  const progress: CleanupProgress = requireProgress(transition);
  const key: string = documentCommandKeyV2(classified.tabId, classified.documentId);
  const known: FrozenDocumentCommand | undefined = progress.clearCommands[key];
  const next: CleanupProgress =
    known === undefined
      ? addCleanupTargetV2(
          progress,
          {
            tabId: classified.tabId,
            documentId: classified.documentId,
            expectedUrl: classified.url,
          },
          {
            enforcementEpoch: runtime.enforcementEpoch,
            basePolicyRevision: runtime.basePolicyRevision,
            ...clearedIdentity(transition),
          },
        )
      : progress;
  if (known === undefined) {
    await ports.writeRuntime(
      validated({
        ...structuredClone(runtime),
        documentCommands: structuredClone(next.clearCommands),
        pendingEnforcementTransition: {
          ...structuredClone(transition),
          cleanupProgress: structuredClone(next),
        },
      }),
    );
  }
  const command: FrozenDocumentCommand | undefined = next.clearCommands[key];
  if (command === undefined) {
    throw new CoreError('invalid-rule', 'the cleanup batch lost its new clear command');
  }
  // The next attempt owns the verdict for this target: the command is durable, so an unreachable
  // document is simply re-sent from the frozen batch rather than judged here.
  await sendDocumentEnforcementCommand(ports.transport, command);
}

/** The durable transition this file acts on: one that is already in cleanup with its progress. */
function cleanupTransitionOf(ports: RuntimePortsV2): PendingEnforcementTransition {
  const transition: PendingEnforcementTransition | null =
    ports.runtime().pendingEnforcementTransition;
  if (transition === null || transition.stage !== 'cleanup') {
    throw new CoreError('invalid-rule', 'this step needs a transition already in cleanup');
  }
  return transition;
}

function requireProgress(transition: PendingEnforcementTransition): CleanupProgress {
  const progress: CleanupProgress | null = transition.cleanupProgress;
  if (progress === null) {
    throw new CoreError('invalid-rule', 'a cleanup transition needs its durable progress');
  }
  return progress;
}

function validated(runtime: RuntimeStateV2): RuntimeStateV2 {
  const parsed: RuntimeStateV2 | null = parseRuntimeStateV2(runtime);
  if (parsed === null) {
    throw new CoreError('invalid-rule', 'transition cleanup built an invalid runtime');
  }
  return parsed;
}

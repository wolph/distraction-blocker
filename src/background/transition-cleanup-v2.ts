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
 */

import { CoreError } from '../shared/errors';
import { syncAggKey } from '../shared/storage-keys';
import type { DailyAgg, SessionEndReasonV2, SessionStateV2 } from '../shared/types';
import {
  buildCleanupProgressV2,
  buildCleanupSeedV2,
  documentCommandKeyV2,
} from './cleanup-progress-v2';
import { buildClosureProjectionV2, splitFocusByLocalDateV2 } from './closure-projection-v2';
import type { FrozenDocumentCommand } from './enforcement-persistence-v2';
import type { RuntimePortsV2 } from './runtime-ports-v2';
import type {
  CleanupEnforcementTarget,
  CleanupProgress,
  CleanupSeed,
  ClosureProjection,
  PendingEnforcementTransition,
  PostCleanupClosure,
  RuntimeStateV2,
  TransitionFailureReason,
} from './runtime-v2-types';
import { parseRuntimeStateV2 } from './runtime-v2-validation';

export type TransitionCleanupCauseV2 = NonNullable<PendingEnforcementTransition['cleanupCause']>;
export type TransitionCleanupSourceV2 = NonNullable<PendingEnforcementTransition['cleanupFrom']>;

export interface TransitionCleanupEntryV2 {
  cause: TransitionCleanupCauseV2;
  failure: TransitionFailureReason | null;
  /** The logical end. Read only for the causes that close a durable session. */
  endedAt: number;
}

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
    targets: clearTargetsOf(transition),
    identity: {
      enforcementEpoch: runtime.enforcementEpoch,
      basePolicyRevision: transition.basePolicyRevision,
      ...clearedIdentity(transition),
    },
    seed,
    at: ports.now(),
    batch: 0,
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

/** The clear batch covers exactly the documents the transition's newest frozen view addressed. */
function clearTargetsOf(transition: PendingEnforcementTransition): CleanupEnforcementTarget[] {
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

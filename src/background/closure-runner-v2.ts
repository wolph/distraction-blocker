/**
 * The closure journal. This file owns the two durable writes that end a session and the cleanup
 * attempts that follow them: `prepared` freezes the logical end while the session is still durable,
 * and one checkpoint commits that end and installs the browser cleanup the closure still owes.
 *
 * The split from `transition-cleanup-v2.ts` is by journal, not by behavior. A transition that must
 * close a session captures its closure and hands it off inside its own cleanup; a session that ends
 * with no transition in flight comes through here. Both produce the same `cleanup` closure row, so
 * the attempt, retry, and removal rules below are the only ones the runtime ever applies to it.
 */

import { focusedMsAtV2 } from '../core/session-v2';
import { CoreError } from '../shared/errors';
import { exactDataEqual } from '../shared/exact-data';
import type { RetryCleanupResultCodeV2 } from '../shared/messages';
import { syncAggKey } from '../shared/storage-keys';
import { localDateStr } from '../shared/time';
import type { DailyAgg, SessionEndReasonV2, SessionStateV2 } from '../shared/types';
import {
  type AlarmNameV2,
  CLOSURE_CLEANUP_ALARM,
  clearAlarmWithReadBackV2,
  createAlarmWithReadBackV2,
  PHASE_ALARM,
  parseAlarmNameV2,
  planPhaseAlarmV2,
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
import {
  enumerateEnforcementTargetsV2,
  type TargetClassificationV2,
} from './enforcement-targets-v2';
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
  PendingClosure,
  RuntimeStateV2,
} from './runtime-v2-types';
import { parseRuntimeStateV2 } from './runtime-v2-validation';
import type { CleanupEffectPortsV2 } from './transition-cleanup-v2';

/** The closure's own first retry batch. A manual retry begins the next one. */
const FIRST_CLEANUP_BATCH: number = 1;

/** The logical end a caller asks this runner to make durable. */
export interface ClosureRequestV2 {
  endedAt: number;
  reason: SessionEndReasonV2;
}

type CleanupClosureV2 = Extract<PendingClosure, { stage: 'cleanup' }>;

/**
 * Freezes the logical end. The session, its checkpoint, and its commands all stay durable in this
 * write, so a crash here leaves the session running with a closure that the next boot commits.
 *
 * Every local date the settled focus lands on is read back first. An aggregate set is an absolute
 * value and focus that crosses a local midnight lands on a day the runtime already finished, so the
 * frozen projection has to carry those stored counters before it can add this session's focus.
 */
export async function prepareClosureV2(
  ports: RuntimePortsV2,
  input: ClosureRequestV2,
): Promise<RuntimeStateV2> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const session: SessionStateV2 | null = runtime.session;
  if (session === null) throw invalidClosure('a closure needs the session it closes');
  if (runtime.pendingClosure !== null) {
    throw invalidClosure('this runtime already carries a closure');
  }
  if (runtime.pendingEnforcementTransition !== null) {
    throw invalidClosure('a transition closes its own session through its cleanup handoff');
  }
  const seed: CleanupSeed = buildCleanupSeedV2(closureAlarmNames(session), runtime.tabStates);
  const priorAggregates: Record<string, DailyAgg> = await settledAggregates(
    ports,
    runtime,
    session,
    input.endedAt,
  );
  const projection: ClosureProjection = buildClosureProjectionV2({
    session,
    endedAt: input.endedAt,
    reason: input.reason,
    bank: ports.bank(),
    pauseEconomy: ports.economy(),
    accruedFocusMs: runtime.accruedFocusMs,
    todayAgg: runtime.todayAgg,
    priorAggregates,
    runtimeDate: runtime.date,
    deviceId: ports.deviceId(),
    currentHandledOccurrences: runtime.handledScheduleOccurrences,
    openOccurrences: ports.openOccurrencesAt(input.endedAt),
  }).projection;
  const next: RuntimeStateV2 = validated({
    ...structuredClone(runtime),
    pendingClosure: {
      version: 1,
      stage: 'prepared',
      projection: structuredClone(projection),
      cleanupSeed: structuredClone(seed),
      cleanupProgress: null,
    },
  });
  await ports.writeRuntime(next);
  return next;
}

/**
 * The logical commit. One checkpoint removes the session, publishes the projected events, bank, and
 * aggregates, and installs the closure at `cleanup` with the clear batch the runtime command map
 * must equal. The projection is copied byte for byte, so a restart commits exactly what the
 * prepared write froze rather than recomputing an end from a clock that has moved.
 */
export async function commitClosureV2(ports: RuntimePortsV2): Promise<RuntimeStateV2> {
  const closure: PendingClosure = preparedClosureOf(ports);
  const projection: ClosureProjection = closure.projection;
  const clearRuntimeRevision: number = ports.runtime().runtimeRevision + 1;
  const progress: CleanupProgress = buildCleanupProgressV2({
    cleanupOperationId: ports.newId(),
    clearRuntimeRevision,
    targets: await currentClearTargets(ports),
    identity: {
      enforcementEpoch: ports.runtime().enforcementEpoch,
      basePolicyRevision: ports.runtime().basePolicyRevision,
      sessionId: projection.sessionId,
      reservedSessionId: null,
    },
    seed: closure.cleanupSeed,
    at: ports.now(),
    batch: FIRST_CLEANUP_BATCH,
  });
  const rebased: RuntimeStateV2 = await rebaseClosureDay(ports, projection);
  const next: RuntimeStateV2 = validated({
    ...structuredClone(rebased),
    session: null,
    gate: null,
    unlocks: [],
    accruedFocusMs: 0,
    handledScheduleOccurrences: structuredClone(projection.handledOccurrences),
    runtimeRevision: clearRuntimeRevision,
    documentCommands: structuredClone(progress.clearCommands),
    enforcementCheckpoint: null,
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

/**
 * One cleanup attempt. It clears the alarms the closure captured, blanks the badge, reissues the
 * exact frozen clear commands, restores the captured claims, and removes the journal only after
 * every claim and reachable target is resolved. Anything else records the failure and schedules the
 * next attempt, which is what lifecycle reads as `closure-cleanup-failed` once the batch is spent.
 */
export async function runClosureCleanupAttemptV2(
  ports: RuntimePortsV2,
  effects: CleanupEffectPortsV2,
): Promise<RuntimeStateV2> {
  const merged: string | null = await mergeDiscoveredClaims(ports);
  if (merged !== null) return recordAttemptFailure(ports, merged);
  const failure: string | null = await performClosureEffects(
    ports,
    effects,
    cleanupClosureOf(ports),
  );
  if (failure !== null) return recordAttemptFailure(ports, failure);
  const discovered: string | null = await clearDiscoveredDocuments(ports);
  if (discovered !== null) return recordAttemptFailure(ports, discovered);
  return removeClosureJournal(ports);
}

/**
 * Spec: before each cleanup write, a newly discovered owned claim is merged idempotently by tab ID
 * into the progress claims only. Saved ownership wins, a saved null may be filled once, and
 * contradictory ownership is a cleanup error rather than an overwrite, so it fails this attempt
 * instead of rewriting what the closure captured.
 */
async function mergeDiscoveredClaims(ports: RuntimePortsV2): Promise<string | null> {
  const closure: CleanupClosureV2 = cleanupClosureOf(ports);
  const runtime: RuntimeStateV2 = ports.runtime();
  let progress: CleanupProgress = closure.cleanupProgress;
  try {
    for (const [key, state] of Object.entries(runtime.tabStates)) {
      progress = mergeCleanupTabClaimV2(progress, { tabId: Number(key), state });
    }
  } catch (error: unknown) {
    return error instanceof CoreError
      ? `closure cleanup found a contradictory claim: ${error.message}`
      : 'closure cleanup could not merge a discovered claim';
  }
  if (exactDataEqual(progress.tabClaims, closure.cleanupProgress.tabClaims)) return null;
  await ports.writeRuntime(
    validated({
      ...structuredClone(runtime),
      pendingClosure: { ...structuredClone(closure), cleanupProgress: structuredClone(progress) },
    }),
  );
  return null;
}

/**
 * Spec: a newly discovered cleanup document is persisted under the existing clear revision in the
 * target, progress command, and runtime command maps before its first send, and a document whose
 * identity changed gets a new keyed target. Enumerating after the frozen batch ran is what finds
 * both, because a moved document answers `changed` and then reappears here under its new key.
 */
async function clearDiscoveredDocuments(ports: RuntimePortsV2): Promise<string | null> {
  const classified: TargetClassificationV2[] = await enumerateEnforcementTargetsV2(ports.targets);
  for (const target of classified) {
    if (target.kind !== 'enforceable') continue;
    const closure: CleanupClosureV2 = cleanupClosureOf(ports);
    const progress: CleanupProgress = closure.cleanupProgress;
    const key: string = documentCommandKeyV2(target.tabId, target.documentId);
    if (Object.hasOwn(progress.clearCommands, key)) continue;
    const runtime: RuntimeStateV2 = ports.runtime();
    const added: CleanupProgress = addCleanupTargetV2(
      progress,
      { tabId: target.tabId, documentId: target.documentId, expectedUrl: target.url },
      {
        enforcementEpoch: runtime.enforcementEpoch,
        basePolicyRevision: runtime.basePolicyRevision,
        sessionId: closure.projection.sessionId,
        reservedSessionId: null,
      },
    );
    await ports.writeRuntime(
      validated({
        ...structuredClone(runtime),
        documentCommands: structuredClone(added.clearCommands),
        pendingClosure: { ...structuredClone(closure), cleanupProgress: structuredClone(added) },
      }),
    );
    const command: FrozenDocumentCommand | undefined = added.clearCommands[key];
    if (command === undefined) return `closure cleanup lost the clear command for ${key}`;
    const outcome: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
      ports.transport,
      command,
    );
    if (outcome.kind !== 'applied' && outcome.kind !== 'closed' && outcome.kind !== 'changed') {
      return `closure clear for ${key} answered ${outcome.kind}`;
    }
  }
  return null;
}

/**
 * The manual retry the popup offers once a batch is exhausted. One durable write allocates a new
 * operation, advances the clear revision, and replaces every frozen command and the runtime map.
 * The projection, the seed, the claims, and the resolved tabs do not move.
 */
export async function retryClosureCleanupV2(
  ports: RuntimePortsV2,
): Promise<{ runtime: RuntimeStateV2; code: RetryCleanupResultCodeV2 }> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const closure: PendingClosure | null = runtime.pendingClosure;
  if (
    closure === null ||
    closure.stage !== 'cleanup' ||
    closure.cleanupProgress.retry.nextAttemptAt !== null
  ) {
    return { runtime, code: 'retry-not-available' };
  }
  const replaced: CleanupProgress = replaceCleanupBatchV2(closure.cleanupProgress, {
    cleanupOperationId: ports.newId(),
    clearRuntimeRevision: closure.cleanupProgress.clearRuntimeRevision + 1,
    at: ports.now(),
  });
  const next: RuntimeStateV2 = validated({
    ...structuredClone(runtime),
    runtimeRevision: replaced.clearRuntimeRevision,
    documentCommands: structuredClone(replaced.clearCommands),
    pendingClosure: { ...structuredClone(closure), cleanupProgress: structuredClone(replaced) },
  });
  // Through the checkpoint rather than a plain write: `assertCleanupBatchAdvance` is written for
  // exactly this replacement, and it only runs inside a commit. Nothing is flushed.
  const committed: RuntimeStateV2 = await ports.commit({
    checkpointId: `${closure.projection.closureId}:cleanup-retry-${replaced.retry.batch}`,
    projection: projectRuntimeDomainV2(next),
    bank: ports.bank(),
    events: [],
    syncBank: false,
    aggregateSets: {},
    aggregateRemoves: [],
  });
  return { runtime: committed, code: 'ok' };
}

/** The whole close: freeze the end, commit it, and run the first cleanup attempt. */
export async function closeSessionV2(
  ports: RuntimePortsV2,
  effects: CleanupEffectPortsV2,
  input: ClosureRequestV2,
): Promise<RuntimeStateV2> {
  await prepareClosureV2(ports, input);
  await commitClosureV2(ports);
  return runClosureCleanupAttemptV2(ports, effects);
}

/** A session with a durable phase boundary owns the one `phase` alarm the closure must clear. */
function closureAlarmNames(session: SessionStateV2): string[] {
  return planPhaseAlarmV2(session) === null ? [] : [PHASE_ALARM];
}

/**
 * Reads back every stored day the settled focus lands on, plus the day the closure ends on. The
 * interval is the one `buildClosureProjectionV2` will split: it ends at the last focus instant and
 * is exactly the unsettled focus delta long.
 */
async function settledAggregates(
  ports: RuntimePortsV2,
  runtime: RuntimeStateV2,
  session: SessionStateV2,
  endedAt: number,
): Promise<Record<string, DailyAgg>> {
  const settleTo: number =
    session.phase === 'focus'
      ? Math.min(endedAt, session.phaseEndsAt ?? endedAt)
      : session.phaseStartedAt;
  const deltaMs: number = Math.max(0, focusedMsAtV2(session, endedAt) - runtime.accruedFocusMs);
  const dates: Set<string> = new Set<string>(
    splitFocusByLocalDateV2(settleTo - deltaMs, settleTo).map(
      (split: { date: string }): string => split.date,
    ),
  );
  dates.add(localDateStr(endedAt));
  return ports.loadAggregates(
    [...dates].map((date: string): string => syncAggKey(ports.deviceId(), date)),
  );
}

/** The documents the clear batch addresses: every enforceable target the browser has right now. */
async function currentClearTargets(ports: RuntimePortsV2): Promise<CleanupEnforcementTarget[]> {
  const classified: TargetClassificationV2[] = await enumerateEnforcementTargetsV2(ports.targets);
  const targets: CleanupEnforcementTarget[] = [];
  for (const target of classified) {
    if (target.kind !== 'enforceable') continue;
    targets.push({
      tabId: target.tabId,
      documentId: target.documentId,
      expectedUrl: target.url,
    });
  }
  return targets;
}

/**
 * Moves the runtime day to the day the closure ended on and adopts that day's projected aggregate.
 * The checkpoint projection owns thirteen domain fields and `date` and `todayAgg` are not among
 * them, so this is a separate write. It changes no domain field, it is exactly what a local date
 * rollover would have written, and repeating it is a no-op, so a crash between it and the commit
 * leaves a runtime the next boot commits identically.
 */
async function rebaseClosureDay(
  ports: RuntimePortsV2,
  projection: ClosureProjection,
): Promise<RuntimeStateV2> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const endedDate: string = localDateStr(projection.endedAt);
  const aggregate: DailyAgg | undefined =
    projection.aggregateSets[syncAggKey(ports.deviceId(), endedDate)];
  if (aggregate === undefined) {
    throw invalidClosure('the closure projection carries no aggregate for the day it ended on');
  }
  if (runtime.date === endedDate && exactDataEqual(runtime.todayAgg, aggregate)) {
    return structuredClone(runtime);
  }
  const next: RuntimeStateV2 = validated({
    ...structuredClone(runtime),
    date: endedDate,
    todayAgg: structuredClone(aggregate),
  });
  await ports.writeRuntime(next);
  return next;
}

/**
 * Runs the browser side of one attempt and returns the first fatal detail, or null when the attempt
 * is clean. A closed or changed document is not a failure: it disappears from the next reread, and
 * a missing acknowledgement is never treated as success.
 */
async function performClosureEffects(
  ports: RuntimePortsV2,
  effects: CleanupEffectPortsV2,
  closure: CleanupClosureV2,
): Promise<string | null> {
  for (const name of closure.cleanupSeed.alarmNames) {
    const alarm: AlarmNameV2 | null = parseAlarmNameV2(name);
    if (alarm === null) return `closure cleanup cannot clear the unknown alarm ${name}`;
    if (!(await clearAlarmWithReadBackV2(ports.alarms, alarm))) {
      return `closure cleanup could not clear the ${alarm} alarm`;
    }
  }
  effects.requestBlankBadge();
  const cleared: string | null = await reissueClearCommands(ports, closure.cleanupProgress);
  if (cleared !== null) return cleared;
  const resolved: number[] = await effects.restoreTabClaims(closure.cleanupProgress.tabClaims);
  await effects.reloadStoppedDocuments(closure.cleanupProgress.tabClaims);
  await recordResolvedTabs(ports, resolved);
  return null;
}

/** Resets any target that has not acknowledged this epoch, then sends its frozen clear command. */
async function reissueClearCommands(
  ports: RuntimePortsV2,
  progress: CleanupProgress,
): Promise<string | null> {
  for (const [key, command] of Object.entries(progress.clearCommands)) {
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
      if (reset.kind !== 'reset') return `closure reset for ${key} answered ${reset.kind}`;
      await recordClosureEpochAck(ports, reset.ack);
    }
    const outcome: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
      ports.transport,
      command,
    );
    if (outcome.kind === 'applied' || outcome.kind === 'closed' || outcome.kind === 'changed') {
      continue;
    }
    // Nothing may outrank the clear revision, so a stale answer during cleanup is fatal too.
    return `closure clear for ${key} answered ${outcome.kind}`;
  }
  return null;
}

/**
 * Removes the journal, and only after every captured claim is resolved. An unresolved claim is a
 * failed attempt rather than a completion, and a removal that does not persist leaves the journal
 * exactly where it was with the next attempt scheduled.
 */
async function removeClosureJournal(ports: RuntimePortsV2): Promise<RuntimeStateV2> {
  const closure: CleanupClosureV2 = cleanupClosureOf(ports);
  const progress: CleanupProgress = closure.cleanupProgress;
  const unresolved: CleanupTabClaim[] = progress.tabClaims.filter(
    (claim: CleanupTabClaim): boolean => !progress.resolvedTabIds.includes(claim.tabId),
  );
  if (unresolved.length > 0) {
    return recordAttemptFailure(
      ports,
      `closure cleanup left ${unresolved.length} claims unresolved`,
    );
  }
  const next: RuntimeStateV2 = validated({
    ...structuredClone(ports.runtime()),
    pendingClosure: null,
  });
  try {
    await ports.writeRuntime(next);
  } catch (error: unknown) {
    ports.reportError(error);
    return recordAttemptFailure(ports, 'closure cleanup could not remove its journal');
  }
  return next;
}

/**
 * Records one failed attempt and schedules the next. The twelfth failure leaves `nextAttemptAt`
 * null and creates no alarm, which is the exhausted state a manual retry answers.
 */
async function recordAttemptFailure(
  ports: RuntimePortsV2,
  detail: string,
): Promise<RuntimeStateV2> {
  let next: RuntimeStateV2 = await writeAttemptFailure(ports, detail);
  for (;;) {
    const scheduled: number | null = closureRetryStateOf(next).nextAttemptAt;
    if (scheduled === null) return next;
    if (await createAlarmWithReadBackV2(ports.alarms, CLOSURE_CLEANUP_ALARM, scheduled)) {
      return next;
    }
    // An alarm the browser refused is not a scheduled attempt. Recording it as one more failure is
    // what keeps the schedule moving toward the manual retry instead of stranding this journal
    // with a live `nextAttemptAt` that nothing will ever fire.
    next = await writeAttemptFailure(ports, 'closure cleanup could not schedule its retry alarm');
  }
}

/** One durable failed attempt, with no alarm of its own. The caller owns the scheduling loop. */
async function writeAttemptFailure(ports: RuntimePortsV2, detail: string): Promise<RuntimeStateV2> {
  const closure: CleanupClosureV2 = cleanupClosureOf(ports);
  const retry: CleanupRetryState = recordCleanupAttemptFailureV2(
    closure.cleanupProgress.retry,
    ports.now(),
    detail,
  );
  const next: RuntimeStateV2 = validated({
    ...structuredClone(ports.runtime()),
    pendingClosure: {
      ...structuredClone(closure),
      cleanupProgress: { ...structuredClone(closure.cleanupProgress), retry },
    },
  });
  await ports.writeRuntime(next);
  return next;
}

function closureRetryStateOf(runtime: RuntimeStateV2): CleanupRetryState {
  const closure: PendingClosure | null = runtime.pendingClosure;
  if (closure === null || closure.stage !== 'cleanup') {
    throw invalidClosure('a closure cleanup attempt needs its durable retry state');
  }
  return closure.cleanupProgress.retry;
}

/** Records the tabs whose captured effects were verified clean, so a retry leaves them alone. */
async function recordResolvedTabs(
  ports: RuntimePortsV2,
  resolved: readonly number[],
): Promise<void> {
  if (resolved.length === 0) return;
  const closure: CleanupClosureV2 = cleanupClosureOf(ports);
  let progress: CleanupProgress = closure.cleanupProgress;
  for (const tabId of resolved) progress = resolveCleanupTabV2(progress, tabId);
  await ports.writeRuntime(
    validated({
      ...structuredClone(ports.runtime()),
      pendingClosure: { ...structuredClone(closure), cleanupProgress: structuredClone(progress) },
    }),
  );
}

/** One acknowledgement becomes durable before the clear command it authorizes is sent. */
async function recordClosureEpochAck(
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

function preparedClosureOf(ports: RuntimePortsV2): PendingClosure {
  const closure: PendingClosure | null = ports.runtime().pendingClosure;
  if (closure === null || closure.stage !== 'prepared') {
    throw invalidClosure('this step needs a durable prepared closure');
  }
  return closure;
}

function cleanupClosureOf(ports: RuntimePortsV2): CleanupClosureV2 {
  const closure: PendingClosure | null = ports.runtime().pendingClosure;
  if (closure === null || closure.stage !== 'cleanup') {
    throw invalidClosure('this step needs a closure already in cleanup');
  }
  return closure;
}

function validated(runtime: RuntimeStateV2): RuntimeStateV2 {
  const parsed: RuntimeStateV2 | null = parseRuntimeStateV2(runtime);
  if (parsed === null) throw invalidClosure('the closure runner built an invalid runtime');
  return parsed;
}

function invalidClosure(message: string): never {
  throw new CoreError('invalid-rule', message);
}

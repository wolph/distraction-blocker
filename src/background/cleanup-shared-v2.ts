/**
 * What both cleanup journals do the same way. A transition cleanup and a closure cleanup differ in
 * which durable row owns the batch and in what resolving it means, and in nothing else: the epoch
 * handshake before a clear, the acknowledgement write, the aggregate read a closure capture owes,
 * the failure-and-rearm loop, and the navigation entry are one rule each.
 *
 * This is a leaf. It imports neither runner, so both runners and recovery can call it, and the
 * journal is a parameter rather than a module boundary.
 */

import { focusedMsAtV2 } from '../core/session-v2';
import { CoreError } from '../shared/errors';
import { syncAggKey } from '../shared/storage-keys';
import { localDateStr } from '../shared/time';
import type { DailyAgg, SessionStateV2 } from '../shared/types';
import {
  type AlarmNameV2,
  CLOSURE_CLEANUP_ALARM,
  createAlarmWithReadBackV2,
  TRANSITION_CLEANUP_ALARM,
} from './alarms-v2';
import {
  addCleanupTargetV2,
  documentCommandKeyV2,
  recordCleanupAttemptFailureV2,
} from './cleanup-progress-v2';
import { splitFocusByLocalDateV2 } from './closure-projection-v2';
import {
  type DocumentCommandOutcomeV2,
  type EpochResetOutcomeV2,
  sendDocumentEnforcementCommand,
  sendEpochResetCommand,
} from './content-transport-v2';
import type { DocumentEpochResetAck, FrozenDocumentCommand } from './enforcement-persistence-v2';
import { classifyEnforcementTargetV2, type TargetClassificationV2 } from './enforcement-targets-v2';
import { buildFrozenEpochResetCommandV2 } from './overlay-view-v2';
import type { RuntimePortsV2 } from './runtime-ports-v2';
import type {
  CleanupProgress,
  PendingClosure,
  PendingEnforcementTransition,
  RuntimeStateV2,
} from './runtime-v2-types';
import { parseRuntimeStateV2 } from './runtime-v2-validation';

/** Which durable row owns the current clear batch. */
export type CleanupJournalV2 = 'closure' | 'transition';

/** The clear commands of one batch name the session in the form its source stage had. */
export interface CleanupClearIdentityV2 {
  sessionId: string | null;
  reservedSessionId: string | null;
}

/** The journal that owns a durable clear batch right now, or null when neither does. */
export function cleanupJournalOfV2(runtime: RuntimeStateV2): CleanupJournalV2 | null {
  const transition: PendingEnforcementTransition | null = runtime.pendingEnforcementTransition;
  if (transition !== null && transition.stage === 'cleanup') return 'transition';
  const closure: PendingClosure | null = runtime.pendingClosure;
  return closure !== null && closure.stage === 'cleanup' ? 'closure' : null;
}

/** The cleanup progress of one journal, which the caller has already proven is the current batch. */
export function journalProgressV2(
  runtime: RuntimeStateV2,
  journal: CleanupJournalV2,
): CleanupProgress {
  const progress: CleanupProgress | null =
    journal === 'closure'
      ? ((runtime.pendingClosure?.cleanupProgress ?? null) as CleanupProgress | null)
      : (runtime.pendingEnforcementTransition?.cleanupProgress ?? null);
  if (progress === null) {
    throw invalidCleanup(`the ${journal} journal lost its cleanup progress`);
  }
  return progress;
}

/** The same runtime with one journal's progress replaced. Every other field is carried. */
export function withJournalProgressV2(
  runtime: RuntimeStateV2,
  journal: CleanupJournalV2,
  progress: CleanupProgress,
): RuntimeStateV2 {
  if (journal === 'closure') {
    const closure: PendingClosure | null = runtime.pendingClosure;
    if (closure === null || closure.stage !== 'cleanup') {
      throw invalidCleanup('a closure cleanup write needs its cleanup closure');
    }
    return {
      ...structuredClone(runtime),
      pendingClosure: { ...structuredClone(closure), cleanupProgress: structuredClone(progress) },
    };
  }
  const transition: PendingEnforcementTransition | null = runtime.pendingEnforcementTransition;
  if (transition === null || transition.stage !== 'cleanup') {
    throw invalidCleanup('a transition cleanup write needs its cleanup transition');
  }
  return {
    ...structuredClone(runtime),
    pendingEnforcementTransition: {
      ...structuredClone(transition),
      cleanupProgress: structuredClone(progress),
    },
  };
}

/** The alarm that wakes one journal's waiting batch. */
export function cleanupAlarmOfV2(journal: CleanupJournalV2): AlarmNameV2 {
  return journal === 'closure' ? CLOSURE_CLEANUP_ALARM : TRANSITION_CLEANUP_ALARM;
}

/**
 * Records one failed attempt and schedules the next. An alarm the browser refused is not a
 * scheduled attempt: recording it as one more failure is what keeps the schedule moving toward the
 * manual retry instead of stranding a journal with a live `nextAttemptAt` nothing will ever fire.
 * The twelfth failure leaves `nextAttemptAt` null and creates no alarm.
 */
export async function recordCleanupFailureAndRearmV2(
  ports: RuntimePortsV2,
  journal: CleanupJournalV2,
  detail: string,
  label: string,
): Promise<RuntimeStateV2> {
  await writeCleanupFailureV2(ports, journal, detail);
  return rearmCleanupAlarmV2(ports, journal, label);
}

/**
 * Brings the journal's retry alarm in line with its durable `nextAttemptAt`, which is what a boot
 * owes a batch that is waiting. A refused read-back is recorded as one more failed attempt, so the
 * loop ends either with an alarm the browser confirmed or with an exhausted batch.
 */
export async function rearmCleanupAlarmV2(
  ports: RuntimePortsV2,
  journal: CleanupJournalV2,
  label: string,
): Promise<RuntimeStateV2> {
  const name: AlarmNameV2 = cleanupAlarmOfV2(journal);
  let runtime: RuntimeStateV2 = ports.runtime();
  for (;;) {
    const scheduled: number | null = journalProgressV2(runtime, journal).retry.nextAttemptAt;
    if (scheduled === null) return runtime;
    if (await createAlarmWithReadBackV2(ports.alarms, name, scheduled)) return runtime;
    runtime = await writeCleanupFailureV2(
      ports,
      journal,
      `${label} could not schedule its retry alarm`,
    );
  }
}

/** One durable failed attempt on the journal that owns the batch. The caller owns the loop. */
export async function writeCleanupFailureV2(
  ports: RuntimePortsV2,
  journal: CleanupJournalV2,
  detail: string,
): Promise<RuntimeStateV2> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const progress: CleanupProgress = journalProgressV2(runtime, journal);
  const next: CleanupProgress = {
    ...structuredClone(progress),
    retry: recordCleanupAttemptFailureV2(progress.retry, ports.now(), detail),
  };
  await ports.writeRuntime(
    validatedCleanupRuntimeV2(withJournalProgressV2(runtime, journal, next)),
  );
  return ports.runtime();
}

/**
 * Spec step 6 for one document: reset it when it has not acknowledged the current epoch, and only
 * then send its exact frozen clear. Every reachable document owes that handshake, the ones a batch
 * froze and the ones an attempt or a navigation discovers alike, so every send comes through here.
 */
export async function resetAndClearDocumentV2(
  ports: RuntimePortsV2,
  progress: CleanupProgress,
  key: string,
  command: FrozenDocumentCommand,
  label: string,
): Promise<string | null> {
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
    // A closed document owes nothing further this attempt, and its claim decides its resolution.
    if (reset.kind === 'closed') return null;
    if (reset.kind !== 'reset') return `${label} reset for ${key} answered ${reset.kind}`;
    await recordEpochAckV2(ports, reset.ack);
  }
  const outcome: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
    ports.transport,
    command,
  );
  if (outcome.kind === 'applied' || outcome.kind === 'closed' || outcome.kind === 'changed') {
    return null;
  }
  // Nothing may outrank the clear revision, so a stale answer during cleanup is fatal too.
  return `${label} clear for ${key} answered ${outcome.kind}`;
}

/** One acknowledgement becomes durable before the clear command it authorizes is sent. */
export async function recordEpochAckV2(
  ports: RuntimePortsV2,
  ack: DocumentEpochResetAck,
): Promise<void> {
  const runtime: RuntimeStateV2 = ports.runtime();
  await ports.writeRuntime(
    validatedCleanupRuntimeV2({
      ...structuredClone(runtime),
      epochResetAcks: {
        ...structuredClone(runtime.epochResetAcks),
        [documentCommandKeyV2(ack.tabId, ack.documentId)]: structuredClone(ack),
      },
    }),
  );
}

/**
 * Reads back every stored day a closure capture will settle focus on, plus the day it ends on. The
 * interval is the one `buildClosureProjectionV2` splits: it ends at the last focus instant and is
 * exactly the unsettled focus delta long. An aggregate set is an absolute value, so a day that is
 * already finished has to be read before this closure can add to it.
 */
export async function settledAggregatesV2(
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

/**
 * A document that navigated while a cleanup batch is durable. It belongs to whichever journal owns
 * that batch, so this dispatches on the durable row rather than on the caller: the controller
 * routes every cleanup navigation here and neither journal is a special case.
 *
 * The target and its frozen clear command are durable before the first send, under the batch's
 * existing operation and clear revision, so a newly found document never outranks the commands
 * already in flight.
 */
export async function handleCleanupNavigationV2(
  ports: RuntimePortsV2,
  target: { tabId: number; documentId: string; url: string },
): Promise<void> {
  if (typeof target.documentId !== 'string' || target.documentId.trim() === '') {
    throw invalidCleanup('a cleanup target needs a document ID');
  }
  const classified: TargetClassificationV2 = classifyEnforcementTargetV2(
    target.tabId,
    target.url,
    target.documentId,
  );
  if (classified.kind !== 'enforceable') return;
  // A runtime with no cleanup batch owns no clear command for this document, so there is nothing
  // to add and nothing to send. That includes a prepared closure, whose session is still running.
  const journal: CleanupJournalV2 | null = cleanupJournalOfV2(ports.runtime());
  if (journal === null) return;
  const key: string = documentCommandKeyV2(classified.tabId, classified.documentId);
  const command: FrozenDocumentCommand = await durableClearCommandV2(ports, journal, key, {
    tabId: classified.tabId,
    documentId: classified.documentId,
    expectedUrl: classified.url,
  });
  await resetAndClearDocumentV2(
    ports,
    journalProgressV2(ports.runtime(), journal),
    key,
    command,
    journal,
  );
}

/** Returns the batch's command for this document, adding and persisting it when it is new. */
async function durableClearCommandV2(
  ports: RuntimePortsV2,
  journal: CleanupJournalV2,
  key: string,
  target: { tabId: number; documentId: string; expectedUrl: string },
): Promise<FrozenDocumentCommand> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const progress: CleanupProgress = journalProgressV2(runtime, journal);
  const known: FrozenDocumentCommand | undefined = progress.clearCommands[key];
  if (known !== undefined) return known;
  const added: CleanupProgress = addCleanupTargetV2(progress, target, {
    enforcementEpoch: runtime.enforcementEpoch,
    basePolicyRevision: runtime.basePolicyRevision,
    ...cleanupClearIdentityV2(runtime, journal),
  });
  const next: RuntimeStateV2 = withJournalProgressV2(runtime, journal, added);
  await ports.writeRuntime(
    validatedCleanupRuntimeV2({
      ...next,
      documentCommands: structuredClone(added.clearCommands),
    }),
  );
  const command: FrozenDocumentCommand | undefined = added.clearCommands[key];
  if (command === undefined) throw invalidCleanup('the cleanup batch lost its new clear command');
  return command;
}

/**
 * The session identity a batch's clear commands carry. A closure closed a durable session, and a
 * transition names the durable one it committed or the reserved one a pre-commit start held.
 */
export function cleanupClearIdentityV2(
  runtime: RuntimeStateV2,
  journal: CleanupJournalV2,
): CleanupClearIdentityV2 {
  if (journal === 'closure') {
    const closure: PendingClosure | null = runtime.pendingClosure;
    if (closure === null) throw invalidCleanup('a closure clear needs its closure');
    return { sessionId: closure.projection.sessionId, reservedSessionId: null };
  }
  const transition: PendingEnforcementTransition | null = runtime.pendingEnforcementTransition;
  if (transition === null) throw invalidCleanup('a transition clear needs its transition');
  const durable: boolean = transition.activeView !== null || transition.kind === 'resume';
  return durable
    ? { sessionId: transition.sessionId, reservedSessionId: null }
    : { sessionId: null, reservedSessionId: transition.sessionId };
}

export function validatedCleanupRuntimeV2(runtime: RuntimeStateV2): RuntimeStateV2 {
  const parsed: RuntimeStateV2 | null = parseRuntimeStateV2(runtime);
  if (parsed === null) throw invalidCleanup('a cleanup step built an invalid runtime');
  return parsed;
}

function invalidCleanup(message: string): CoreError {
  return new CoreError('invalid-rule', message);
}

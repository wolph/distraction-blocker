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
import { exactDataEqual } from '../shared/exact-data';
import { syncAggKey } from '../shared/storage-keys';
import { localDateStr } from '../shared/time';
import type { DailyAgg, SessionStateV2 } from '../shared/types';
import {
  type AlarmNameV2,
  CLOSURE_CLEANUP_ALARM,
  createAlarmWithReadBackV2,
  TRANSITION_CLEANUP_ALARM,
} from './alarms-v2';
import type { ClearCommandIdentityV2 } from './cleanup-progress-v2';
import {
  addCleanupTargetV2,
  documentCommandKeyV2,
  mergeCleanupTabClaimV2,
  recordCleanupAttemptFailureV2,
  remapMovedCleanupTargetV2,
  replaceCleanupBatchV2,
} from './cleanup-progress-v2';
import { splitFocusByLocalDateV2 } from './closure-projection-v2';
import {
  type DocumentCommandOutcomeV2,
  type EpochResetOutcomeV2,
  sendDocumentEnforcementCommand,
  sendEpochResetCommand,
} from './content-transport-v2';
import type { DocumentEpochResetAck, FrozenDocumentCommand } from './enforcement-persistence-v2';
import {
  classifyEnforcementTargetV2,
  enumerateEnforcementTargetsV2,
  type TargetClassificationV2,
} from './enforcement-targets-v2';
import { buildFrozenEpochResetCommandV2 } from './overlay-view-v2';
import { projectRuntimeDomainV2 } from './runtime-checkpoint-v2';
import type { RuntimePortsV2 } from './runtime-ports-v2';
import type {
  CleanupProgress,
  CleanupTabClaim,
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
 * How one send treats a page that answers with no receiver at all.
 *
 * Membership in this batch is the evidence the transport answer does not carry. A document the
 * batch froze, or one on a tab this cleanup holds a claim for, was overlaid by this session (spec
 * 758, spec 1954), so a missing receiver there is a clear that did not land and the journal stays
 * open. A document discovered on a tab with no claim was never sent anything by this journal and
 * has no overlay to clear, so an unreachable one is deferred rather than fatal, which is how spec
 * 1345 treats the same case in browser reset.
 */
export interface CleanupSendPolicyV2 {
  tolerateNoReceiver: boolean;
}

const OVERLAID_SEND_POLICY: CleanupSendPolicyV2 = { tolerateNoReceiver: false };
const UNCLAIMED_SEND_POLICY: CleanupSendPolicyV2 = { tolerateNoReceiver: true };

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
  policy: CleanupSendPolicyV2 = OVERLAID_SEND_POLICY,
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
    if (reset.kind === 'no-receiver' && policy.tolerateNoReceiver) return null;
    if (reset.kind !== 'reset') return `${label} reset for ${key} answered ${reset.kind}`;
    await recordEpochAckV2(ports, reset.ack);
  }
  const outcome: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
    ports.transport,
    command,
  );
  if (outcome.kind === 'changed') {
    return reclearMovedDocumentV2(ports, key, command, outcome.observedUrl, label, policy);
  }
  if (outcome.kind === 'applied' || outcome.kind === 'closed') return null;
  if (outcome.kind === 'no-receiver' && policy.tolerateNoReceiver) return null;
  // Nothing may outrank the clear revision, so a stale answer during cleanup is fatal too.
  return `${label} clear for ${key} answered ${outcome.kind}`;
}

/**
 * A `changed` answer carries the URL the document is on, which is the exact evidence that this
 * key's recorded target moved within its own document and kept its key. The batch replaces that one
 * command with one built from the observed URL, in the single durable write `durableClearCommandV2`
 * makes, which retires the old command rather than leaving two for one key, and sends the
 * replacement once. A page that moves again inside the same attempt is left to the next attempt,
 * which rereads it, rather than chased in a loop.
 */
async function reclearMovedDocumentV2(
  ports: RuntimePortsV2,
  key: string,
  command: FrozenDocumentCommand,
  observedUrl: string,
  label: string,
  policy: CleanupSendPolicyV2,
): Promise<string | null> {
  const journal: CleanupJournalV2 | null = cleanupJournalOfV2(ports.runtime());
  if (journal === null || observedUrl === command.expectedUrl) return null;
  const moved: FrozenDocumentCommand = await durableClearCommandV2(ports, journal, key, {
    tabId: command.tabId,
    documentId: command.documentId,
    expectedUrl: observedUrl,
  });
  const outcome: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
    ports.transport,
    moved,
  );
  if (outcome.kind === 'applied' || outcome.kind === 'closed' || outcome.kind === 'changed') {
    return null;
  }
  if (outcome.kind === 'no-receiver' && policy.tolerateNoReceiver) return null;
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
 * Spec 1148: before each cleanup write, any newly discovered owned claim is merged idempotently by
 * tab ID into the batch's claims only. Saved ownership wins, a saved null may be filled once, and
 * contradictory ownership is a cleanup error rather than an overwrite, so it fails the attempt
 * instead of rewriting what the journal captured.
 */
export async function mergeDiscoveredClaimsV2(
  ports: RuntimePortsV2,
  journal: CleanupJournalV2,
  label: string,
): Promise<string | null> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const saved: CleanupProgress = journalProgressV2(runtime, journal);
  let progress: CleanupProgress = saved;
  try {
    for (const [key, state] of Object.entries(runtime.tabStates)) {
      progress = mergeCleanupTabClaimV2(progress, { tabId: Number(key), state });
    }
  } catch (error: unknown) {
    return error instanceof CoreError
      ? `${label} found a contradictory claim: ${error.message}`
      : `${label} could not merge a discovered claim`;
  }
  if (exactDataEqual(progress.tabClaims, saved.tabClaims)) return null;
  await ports.writeRuntime(
    validatedCleanupRuntimeV2(withJournalProgressV2(runtime, journal, progress)),
  );
  return null;
}

/**
 * Spec 1150: a newly discovered cleanup document is persisted under the existing clear revision in
 * the target, progress command, and runtime command maps before its first send, and a document
 * whose identity changed gets a new keyed target. Enumerating after the frozen batch ran is what
 * finds both, because a moved document answers `changed` and then reappears here under its new key.
 */
export async function clearDiscoveredDocumentsV2(
  ports: RuntimePortsV2,
  journal: CleanupJournalV2,
  label: string,
): Promise<string | null> {
  // Spec 766: a cleanup that entered before its registration audit sent nothing, so discovery must
  // not invent a first send for a document this cleanup never touched. The exemption is that stage,
  // not an empty batch: a post-audit batch that froze no commands still enumerates, and a closure
  // has no pre-audit stage to exempt.
  if (enteredBeforeAuditV2(ports.runtime(), journal)) return null;
  const classified: TargetClassificationV2[] = await enumerateEnforcementTargetsV2(ports.targets);
  for (const target of classified) {
    if (target.kind !== 'enforceable') continue;
    const key: string = documentCommandKeyV2(target.tabId, target.documentId);
    // A key the batch already owns is skipped only while it still names the URL the page is on. A
    // same-document move keeps the key and leaves the recorded URL behind it, so the batch would
    // otherwise send a command the page answers `changed` to and clear nothing.
    const recorded: FrozenDocumentCommand | undefined = journalProgressV2(ports.runtime(), journal)
      .clearCommands[key];
    if (recorded !== undefined && recorded.expectedUrl === target.url) continue;
    const command: FrozenDocumentCommand = await durableClearCommandV2(ports, journal, key, {
      tabId: target.tabId,
      documentId: target.documentId,
      expectedUrl: target.url,
    });
    const current: CleanupProgress = journalProgressV2(ports.runtime(), journal);
    const failure: string | null = await resetAndClearDocumentV2(
      ports,
      current,
      key,
      command,
      label,
      claimedTabV2(current, target.tabId) ? OVERLAID_SEND_POLICY : UNCLAIMED_SEND_POLICY,
    );
    if (failure !== null) return failure;
  }
  return null;
}

/** Whether this cleanup holds a claim for the tab, which is what proves it overlaid the page. */
function claimedTabV2(progress: CleanupProgress, tabId: number): boolean {
  return progress.tabClaims.some((claim: CleanupTabClaim): boolean => claim.tabId === tabId);
}

/** The two `auditEnforcement` answers, which are the failures that precede any send. */
const PRE_AUDIT_FAILURES: ReadonlySet<string> = new Set<string>([
  'website-access-lost',
  'content-registration-failed',
]);

/**
 * Whether this cleanup entered before the registration audit, which spec 766 exempts from every
 * clear. The stage the cleanup came from is the authority: `prepared` is the one stage before the
 * audit, and it covers an abandon that carries no failure at all as well as the two audit answers.
 * Those failures are still read, because a journal that reaches cleanup without recording its
 * source stage would otherwise lose the exemption its failure already proves.
 */
function enteredBeforeAuditV2(runtime: RuntimeStateV2, journal: CleanupJournalV2): boolean {
  if (journal === 'closure') return false;
  const transition: PendingEnforcementTransition | null = runtime.pendingEnforcementTransition;
  if (transition === null) return false;
  if (transition.cleanupFrom === 'prepared') return true;
  const failure: string | null = transition.failure;
  return failure !== null && PRE_AUDIT_FAILURES.has(failure);
}

/**
 * The manual retry both journals run, which is one step: a new operation ID and clear revision
 * replace the batch identity, every frozen command is restamped with them, and the row is persisted.
 *
 * It commits rather than writing, because `assertCleanupBatchAdvance` is written for exactly this
 * replacement and only runs inside a commit. Nothing is flushed: no events, no aggregates, and the
 * bank unchanged.
 */
export async function replaceCleanupBatchAndCommitV2(
  ports: RuntimePortsV2,
  journal: CleanupJournalV2,
  checkpointOwnerId: string,
): Promise<RuntimeStateV2> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const progress: CleanupProgress = journalProgressV2(runtime, journal);
  const replaced: CleanupProgress = replaceCleanupBatchV2(progress, {
    cleanupOperationId: ports.newId(),
    clearRuntimeRevision: progress.clearRuntimeRevision + 1,
    at: ports.now(),
  });
  const next: RuntimeStateV2 = validatedCleanupRuntimeV2(
    restampedCleanupRowV2(withJournalProgressV2(runtime, journal, replaced), journal, replaced),
  );
  return ports.commit({
    checkpointId: `${checkpointOwnerId}:cleanup-retry-${replaced.retry.batch}`,
    projection: projectRuntimeDomainV2(next),
    bank: ports.bank(),
    events: [],
    syncBank: false,
    aggregateSets: {},
    aggregateRemoves: [],
  });
}

/**
 * The runtime a replacement batch persists. The clear revision is the runtime revision, the command
 * map is the restamped batch, and a transition carries that revision on its own row as well.
 */
function restampedCleanupRowV2(
  runtime: RuntimeStateV2,
  journal: CleanupJournalV2,
  replaced: CleanupProgress,
): RuntimeStateV2 {
  const next: RuntimeStateV2 = {
    ...runtime,
    runtimeRevision: replaced.clearRuntimeRevision,
    documentCommands: structuredClone(replaced.clearCommands),
  };
  if (journal === 'closure') return next;
  const transition: PendingEnforcementTransition | null = next.pendingEnforcementTransition;
  if (transition === null) {
    throw invalidCleanup('a transition cleanup retry needs its cleanup transition');
  }
  return {
    ...next,
    pendingEnforcementTransition: {
      ...transition,
      runtimeRevision: replaced.clearRuntimeRevision,
    },
  };
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

/**
 * Returns the batch's command for this document, adding and persisting it when it is new and
 * rebuilding it in place when the page has moved within the same document, which keeps the key.
 */
async function durableClearCommandV2(
  ports: RuntimePortsV2,
  journal: CleanupJournalV2,
  key: string,
  target: { tabId: number; documentId: string; expectedUrl: string },
): Promise<FrozenDocumentCommand> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const progress: CleanupProgress = journalProgressV2(runtime, journal);
  const known: FrozenDocumentCommand | undefined = progress.clearCommands[key];
  if (known !== undefined && known.expectedUrl === target.expectedUrl) return known;
  const identity: Omit<ClearCommandIdentityV2, 'operationId' | 'runtimeRevision'> = {
    enforcementEpoch: runtime.enforcementEpoch,
    basePolicyRevision: runtime.basePolicyRevision,
    ...cleanupClearIdentityV2(runtime, journal),
  };
  const added: CleanupProgress =
    known === undefined
      ? addCleanupTargetV2(progress, target, identity)
      : remapMovedCleanupTargetV2(progress, target, identity);
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

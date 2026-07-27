/**
 * Bootstrap recovery: resolve every journal and stage before anything is published.
 *
 * The order is the spec's own. A durable closure is processed before the session is even inspected,
 * a pending transition is resolved by its stage, and only then does a surviving session settle,
 * audit, arm its alarm, and verify its documents. Nothing here publishes: it leaves a runtime whose
 * lifecycle projection is allowed to report what it reports, and the caller publishes from that.
 *
 * Recovery composes the runners rather than repeating them. What it owns alone is standalone
 * recovery, the branch a previously published or migrated focus session takes when no transition
 * exists: a new operation ID, one captured view time, frozen commands persisted before any send,
 * and a checkpoint of kind `recovery`. A recovery checkpoint never satisfies a pending transition,
 * which keeps the transition's own stage identity authoritative while this runs.
 */

import type { CompiledMatcher } from '../core/matcher';
import { advanceSessionV2, type SessionAdvanceResultV2 } from '../core/session-v2';
import { CoreError } from '../shared/errors';
import { exactDataEqual } from '../shared/exact-data';
import type { SessionEndReasonV2, SessionStateV2, Verdict } from '../shared/types';
import { ensurePhaseAlarmV2 } from './alarms-v2';
import {
  blockedDocumentCommandsV2,
  buildFrozenClearCommandV2,
  documentCommandKeyV2,
} from './cleanup-progress-v2';
import { rearmCleanupAlarmV2 } from './cleanup-shared-v2';
import { closeSessionV2, commitClosureV2, runClosureCleanupAttemptV2 } from './closure-runner-v2';
import type {
  DocumentEpochResetAck,
  EnforcementCheckpoint,
  EpochResetAckRecord,
  FrozenDocumentCommand,
  FrozenEpochResetCommand,
} from './enforcement-persistence-v2';
import {
  enumerateEnforcementTargetsV2,
  type FreshnessAttemptResultV2,
  freshnessBudgetPermitsV2,
  runEnforcementPassV2,
  runFreshnessAttemptV2,
  type SweepDriverV2,
  type TargetClassificationV2,
} from './enforcement-targets-v2';
import { withEpochResetAckV2 } from './epoch-reset-acks-v2';
import {
  buildActiveOverlayView,
  buildFrozenDocumentCommandV2,
  buildFrozenEpochResetCommandV2,
} from './overlay-view-v2';
import { carryCommitCheckpointProjectionV2 } from './runtime-checkpoint-v2';
import type { RuntimePortsV2 } from './runtime-ports-v2';
import type {
  CleanupProgress,
  PendingClosure,
  PendingEnforcementTransition,
  RuntimeStateV2,
} from './runtime-v2-types';
import { parseRuntimeStateV2 } from './runtime-v2-validation';
import {
  type CleanupEffectPortsV2,
  enterTransitionCleanupV2,
  runTransitionCleanupAttemptV2,
} from './transition-cleanup-v2';
import {
  driveTransitionV2,
  type PreparedTransitionV2,
  prepareResumeTransitionV2,
  type TransitionDriveResultV2,
  transitionMatcherV2,
} from './transition-runner-v2';

export type RecoveryResultV2 =
  | { kind: 'idle'; runtime: RuntimeStateV2 }
  | { kind: 'published'; runtime: RuntimeStateV2 }
  | { kind: 'transition'; runtime: RuntimeStateV2 }
  | { kind: 'closure'; runtime: RuntimeStateV2 };

/** The one target shape a sweep acts on, named the same way the transition runner names it. */
type EnforceableTargetV2 = Extract<TargetClassificationV2, { kind: 'enforceable' }>;

/** Which journal a cleanup batch belongs to, which is what names its retry alarm. */

/** The identity one standalone recovery reserves once and every command it freezes repeats. */
interface RecoveryIdentityV2 {
  operationId: string;
  capturedAt: number;
}

/** The stages a transition has not committed a session from, which recovery abandons. */
const PRE_COMMIT_STAGES: ReadonlySet<string> = new Set<string>([
  'prepared',
  'registration-audited',
  'starting-verified',
]);

/**
 * Resolves this profile's one runtime authority. The caller runs it after commit checkpoint replay
 * and before lifecycle projection, browser effects, or any bank writer, and serializes it against
 * every other runtime command.
 */
export async function recoverRuntimeV2(
  ports: RuntimePortsV2,
  effects: CleanupEffectPortsV2,
): Promise<RecoveryResultV2> {
  const runtime: RuntimeStateV2 = ports.runtime();
  if (runtime.pendingClosure !== null && runtime.pendingEnforcementTransition !== null) {
    throw new CoreError('invalid-rule', 'a runtime carries at most one journal at a time');
  }
  if (runtime.pendingClosure !== null) {
    return resultFor(await recoverClosureJournal(ports, effects, runtime.pendingClosure));
  }
  const transition: PendingEnforcementTransition | null = runtime.pendingEnforcementTransition;
  if (transition !== null) {
    return resultFor(await recoverTransitionJournal(ports, effects, transition));
  }
  return recoverDurableSession(ports, effects);
}

/**
 * Step 8. A prepared closure has already frozen its logical end, so recovery commits it and runs
 * the first cleanup attempt. A cleanup closure continues its own batch: its clear revision must
 * still be the runtime's top revision, and it either reissues the frozen commands or waits for the
 * retry alarm it re-arms here. The historical views a transition left behind are never consulted.
 */
async function recoverClosureJournal(
  ports: RuntimePortsV2,
  effects: CleanupEffectPortsV2,
  closure: PendingClosure,
): Promise<RuntimeStateV2> {
  if (closure.stage === 'prepared') {
    await commitClosureV2(ports);
    return runClosureCleanupAttemptV2(ports, effects);
  }
  const progress: CleanupProgress = closure.cleanupProgress;
  assertClearBatchIsCurrent(ports.runtime(), progress);
  if (!attemptIsDue(progress, ports.now()))
    return rearmCleanupAlarmV2(ports, 'closure', 'recovery');
  return runClosureCleanupAttemptV2(ports, effects);
}

/**
 * Step 9. A pre-commit transition is abandoned or restored rather than continued, because its
 * starting sweep cannot be resumed from a cold worker. A committed transition continues with its
 * own operation, epoch, base revision, views, verification start, and remaining attempts. A cleanup
 * transition continues its batch exactly like a cleanup closure.
 */
async function recoverTransitionJournal(
  ports: RuntimePortsV2,
  effects: CleanupEffectPortsV2,
  transition: PendingEnforcementTransition,
): Promise<RuntimeStateV2> {
  if (transition.stage === 'cleanup') {
    const progress: CleanupProgress = requireProgress(transition);
    assertClearBatchIsCurrent(ports.runtime(), progress);
    if (!attemptIsDue(progress, ports.now()))
      return rearmCleanupAlarmV2(ports, 'transition', 'recovery');
    return runTransitionCleanupAttemptV2(ports, effects);
  }
  if (PRE_COMMIT_STAGES.has(transition.stage)) {
    // A pre-commit resume records no failure. The closure reason carries the why when one follows.
    await enterTransitionCleanupV2(ports, {
      cause: transition.kind === 'start' ? 'start-abandon' : 'resume-restore',
      failure: null,
      endedAt: ports.now(),
    });
    return runTransitionCleanupAttemptV2(ports, effects);
  }
  const driven: TransitionDriveResultV2 = await driveTransitionV2(
    ports,
    transitionMatcherV2(ports),
  );
  if (driven.kind !== 'cleanup') return driven.runtime;
  return runTransitionCleanupAttemptV2(ports, effects);
}

/**
 * Steps 10 through 17 for a runtime with no journal. The fixed end is checked before anything is
 * settled, so a session that already ended is closed at its own `sessionEndsAt` rather than being
 * advanced past it first.
 */
async function recoverDurableSession(
  ports: RuntimePortsV2,
  effects: CleanupEffectPortsV2,
): Promise<RecoveryResultV2> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const session: SessionStateV2 | null = runtime.session;
  if (session === null) return { kind: 'idle', runtime };
  const recoveryAt: number = ports.now();
  if (session.sessionEndsAt !== null && session.sessionEndsAt <= recoveryAt) {
    return closeForReason(ports, effects, 'timer-completed', session.sessionEndsAt);
  }
  const settled: SessionStateV2 | RecoveryResultV2 = await settleDurablePhase(
    ports,
    effects,
    session,
    recoveryAt,
  );
  if (!isSessionState(settled)) return settled;
  return verifyRecoveredSession(ports, effects, settled);
}

/**
 * Step 11. The last durable phase is settled through the recovery instant. An expired pause or
 * break is not settled at all: it needs a resume transition, which owns its own commit.
 */
async function settleDurablePhase(
  ports: RuntimePortsV2,
  effects: CleanupEffectPortsV2,
  session: SessionStateV2,
  recoveryAt: number,
): Promise<SessionStateV2 | RecoveryResultV2> {
  const advanced: SessionAdvanceResultV2 = advanceSessionV2(session, recoveryAt);
  if (advanced.kind === 'timer-completed') {
    return closeForReason(ports, effects, 'timer-completed', advanced.endedAt);
  }
  if (advanced.kind === 'resume-required') {
    // A worker that slept through a focus boundary and the break after it advances two phases at
    // once. The phase it passed through has to be durable before anything resumes from it: the
    // resume reads the phase it restores, and the focus checkpoint left behind attests a phase that
    // is over, which the parser refuses on a non-blocking row.
    await writeSettledSession(ports, advanced.state, session);
    const prepared: PreparedTransitionV2 = await prepareResumeTransitionV2(ports, advanced.trigger);
    const driven: TransitionDriveResultV2 = await driveTransitionV2(ports, prepared.matcher);
    if (driven.kind !== 'cleanup') return resultFor(driven.runtime);
    return resultFor(await runTransitionCleanupAttemptV2(ports, effects));
  }
  await writeSettledSession(ports, advanced.state, session);
  return advanced.state;
}

/**
 * Steps 12 through 17. Every failure here closes the durable session with the reason that names it,
 * which is what makes a worker that cannot verify report an ended session instead of a live one.
 */
async function verifyRecoveredSession(
  ports: RuntimePortsV2,
  effects: CleanupEffectPortsV2,
  session: SessionStateV2,
): Promise<RecoveryResultV2> {
  const audit: 'ready' | SessionEndReasonV2 = await ports.auditEnforcement();
  if (audit !== 'ready') return closeForReason(ports, effects, audit, ports.now());
  const matcher: CompiledMatcher | null = compiledMatcher(ports, session);
  if (matcher === null) {
    return closeForReason(ports, effects, 'invalid-active-state', ports.now());
  }
  if ((await ensurePhaseAlarmV2(ports.alarms, session)) !== 'ready') {
    return closeForReason(ports, effects, 'alarm-failed', ports.now());
  }
  if (session.phase !== 'focus') {
    await clearNonBlockingPhase(ports, session);
    return { kind: 'published', runtime: ports.runtime() };
  }
  return runStandaloneRecovery(ports, effects, matcher, session);
}

/**
 * Step 14, the standalone branch. One new operation ID, one captured view time, one advanced
 * runtime revision, and the complete frozen command set persisted before a single send. A migrated
 * active session that never had a command takes this branch to create its first ones.
 */
async function runStandaloneRecovery(
  ports: RuntimePortsV2,
  effects: CleanupEffectPortsV2,
  matcher: CompiledMatcher,
  session: SessionStateV2,
): Promise<RecoveryResultV2> {
  const identity: RecoveryIdentityV2 = { operationId: ports.newId(), capturedAt: ports.now() };
  await freezeRecoveryCommands(ports, matcher, session, identity);
  const driver: SweepDriverV2 = recoveryDriver(ports, matcher, session, identity);
  for (let attempts: number = 0; ; attempts++) {
    const budget: { verificationStartedAt: number; freshnessAttempts: number } = {
      verificationStartedAt: identity.capturedAt,
      freshnessAttempts: attempts,
    };
    if (!freshnessBudgetPermitsV2(budget, ports.now())) break;
    const attempt: FreshnessAttemptResultV2 = await runFreshnessAttemptV2(
      ports.targets,
      driver,
      budget,
    );
    if (attempt.kind === 'unreachable') break;
    if (attempt.kind === 'verified') {
      await writeRecoveryCheckpoint(ports, session, identity, attempt);
      return { kind: 'published', runtime: ports.runtime() };
    }
  }
  return closeForReason(ports, effects, 'tab-enforcement-failed', ports.now());
}

/**
 * Step 16. A pause or a break is not blocking, so it gets clear commands and no checkpoint at all.
 * One pass is enough: a document this cannot reach is not blocked by anything either, so an
 * unreachable target is not a reason to end a session that is already not enforcing.
 */
async function clearNonBlockingPhase(
  ports: RuntimePortsV2,
  session: SessionStateV2,
): Promise<void> {
  const identity: RecoveryIdentityV2 = { operationId: ports.newId(), capturedAt: ports.now() };
  await freezeRecoveryCommands(ports, null, session, identity);
  await runEnforcementPassV2(ports.targets, recoveryDriver(ports, null, session, identity));
}

/**
 * Freezes the blocked commands for the current targets and persists them, with the revision every
 * command of this recovery carries, before any send. Every command in the runtime carries one
 * runtime revision, so the whole map is rebuilt at the next one. An allowed page's clear is
 * computed at that revision when the sweep reaches it and never stored: the page keeps the clear,
 * a later pull at the same tuple is answered the same clear, and the runtime holds no address for
 * a page the session is not blocking.
 */
async function freezeRecoveryCommands(
  ports: RuntimePortsV2,
  matcher: CompiledMatcher | null,
  session: SessionStateV2,
  identity: RecoveryIdentityV2,
): Promise<void> {
  const targets: TargetClassificationV2[] = await enumerateEnforcementTargetsV2(ports.targets);
  const runtime: RuntimeStateV2 = ports.runtime();
  const runtimeRevision: number = runtime.runtimeRevision + 1;
  const documents: Record<string, FrozenDocumentCommand> = {};
  for (const target of targets) {
    if (target.kind !== 'enforceable') continue;
    documents[documentCommandKeyV2(target.tabId, target.documentId)] = recoveryCommand(
      ports,
      runtime,
      matcher,
      session,
      { ...identity, runtimeRevision },
      target,
    );
  }
  await writeRuntime(ports, {
    ...runtime,
    runtimeRevision,
    documentCommands: blockedDocumentCommandsV2(documents),
  });
}

/**
 * Adds one document that appeared after the freeze. The revision advances for the whole map, and
 * the write lands before the command is returned to the sweep, so nothing is ever sent unpersisted.
 */
async function addRecoveryDocument(
  ports: RuntimePortsV2,
  matcher: CompiledMatcher | null,
  session: SessionStateV2,
  identity: RecoveryIdentityV2,
  target: EnforceableTargetV2,
): Promise<FrozenDocumentCommand> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const runtimeRevision: number = runtime.runtimeRevision + 1;
  const key: string = documentCommandKeyV2(target.tabId, target.documentId);
  const documents: Record<string, FrozenDocumentCommand> = {};
  for (const [existing, command] of Object.entries(runtime.documentCommands)) {
    documents[existing] = { ...structuredClone(command), runtimeRevision };
  }
  documents[key] = recoveryCommand(
    ports,
    runtime,
    matcher,
    session,
    { ...identity, runtimeRevision },
    target,
  );
  await writeRuntime(ports, { ...runtime, runtimeRevision, documentCommands: documents });
  return structuredClone(documents[key] as FrozenDocumentCommand);
}

/**
 * One frozen command. A focus session enforces a blocked verdict, and every other page, the
 * allowed ones under focus included, gets the canonical clear at this recovery's tuple.
 */
function recoveryCommand(
  ports: RuntimePortsV2,
  runtime: RuntimeStateV2,
  matcher: CompiledMatcher | null,
  session: SessionStateV2,
  identity: RecoveryIdentityV2 & { runtimeRevision: number },
  target: EnforceableTargetV2,
): FrozenDocumentCommand {
  const base = {
    tabId: target.tabId,
    documentId: target.documentId,
    expectedUrl: target.url,
    operationId: identity.operationId,
    enforcementEpoch: runtime.enforcementEpoch,
    sessionId: session.sessionId,
    reservedSessionId: null,
    basePolicyRevision: runtime.basePolicyRevision,
    runtimeRevision: identity.runtimeRevision,
  };
  const verdict: Verdict | null =
    matcher === null ? null : ports.verdictFor(matcher, target.url, runtime.unlocks);
  if (verdict === null || !verdict.blocked) {
    return buildFrozenClearCommandV2(
      { tabId: target.tabId, documentId: target.documentId, expectedUrl: target.url },
      {
        operationId: base.operationId,
        enforcementEpoch: base.enforcementEpoch,
        sessionId: base.sessionId,
        reservedSessionId: base.reservedSessionId,
        basePolicyRevision: base.basePolicyRevision,
        runtimeRevision: base.runtimeRevision,
      },
    );
  }
  const economy: ReturnType<RuntimePortsV2['economy']> = ports.economy();
  return buildFrozenDocumentCommandV2({
    ...base,
    verdict,
    presentation: 'active',
    overlay: verdict.blocked
      ? buildActiveOverlayView({
          targetUrl: target.url,
          capturedAt: identity.capturedAt,
          theme: ports.theme(),
          session,
          economy: {
            bankMs: Math.min(ports.bank().balanceMs, economy.capMs),
            bankAccrualPerMs: economy.earnRatio,
            bankCapMs: economy.capMs,
            pauseCostMs: economy.pauseMs,
            unlockCostMs: economy.unlockMs,
          },
          gate: runtime.gate,
          activeUnlocks: runtime.unlocks.filter(
            (unlock: { until: number }): boolean => unlock.until > identity.capturedAt,
          ),
          attemptsToday: ports.attemptsToday(),
          stoppedPage: runtime.tabStates[target.tabId]?.stoppedDocumentId === target.documentId,
          verdict,
        })
      : null,
  });
}

/** The sweep driver for a recovery operation, reading and extending the runtime's own command map. */
function recoveryDriver(
  ports: RuntimePortsV2,
  matcher: CompiledMatcher | null,
  session: SessionStateV2,
  identity: RecoveryIdentityV2,
): SweepDriverV2 {
  const commandFor = async (target: EnforceableTargetV2): Promise<FrozenDocumentCommand> => {
    const key: string = documentCommandKeyV2(target.tabId, target.documentId);
    const runtime: RuntimeStateV2 = ports.runtime();
    const stored: FrozenDocumentCommand | undefined = runtime.documentCommands[key];
    if (stored !== undefined && stored.operationId === identity.operationId) {
      return structuredClone(stored);
    }
    const blocked: boolean =
      matcher !== null && ports.verdictFor(matcher, target.url, runtime.unlocks).blocked;
    if (blocked) return addRecoveryDocument(ports, matcher, session, identity, target);
    // A page this recovery does not block gets the clear at the revision the freeze made durable.
    // Nothing is written: the page keeps the clear, and the controller answers the same clear to
    // a pull at this tuple, so the send is safe without a stored copy.
    return recoveryCommand(
      ports,
      runtime,
      matcher,
      session,
      { ...identity, runtimeRevision: runtime.runtimeRevision },
      target,
    );
  };
  return {
    commandFor,
    onStale: commandFor,
    resetFor: async (target: EnforceableTargetV2): Promise<FrozenEpochResetCommand> =>
      buildFrozenEpochResetCommandV2({
        tabId: target.tabId,
        documentId: target.documentId,
        expectedUrl: target.url,
        operationId: identity.operationId,
        enforcementEpoch: ports.runtime().enforcementEpoch,
      }),
    hasEpochAck: (tabId: number, documentId: string): boolean => {
      const runtime: RuntimeStateV2 = ports.runtime();
      const ack: EpochResetAckRecord | undefined =
        runtime.epochResetAcks[documentCommandKeyV2(tabId, documentId)];
      return ack !== undefined && ack.enforcementEpoch === runtime.enforcementEpoch;
    },
    recordEpochAck: async (ack: DocumentEpochResetAck): Promise<void> => {
      const runtime: RuntimeStateV2 = ports.runtime();
      await writeRuntime(ports, {
        ...runtime,
        epochResetAcks: withEpochResetAckV2(runtime.epochResetAcks, ack),
      });
    },
    transport: ports.transport,
  };
}

/**
 * Step 17 for the standalone branch. The recovery checkpoint replaces the published one. It is
 * never written while a transition exists, so it can never satisfy one.
 */
async function writeRecoveryCheckpoint(
  ports: RuntimePortsV2,
  session: SessionStateV2,
  identity: RecoveryIdentityV2,
  attempt: Extract<FreshnessAttemptResultV2, { kind: 'verified' }>,
): Promise<void> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const checkpoint: EnforcementCheckpoint = {
    version: 1,
    operationId: identity.operationId,
    enforcementEpoch: runtime.enforcementEpoch,
    sessionId: session.sessionId,
    basePolicyRevision: runtime.basePolicyRevision,
    kind: 'recovery',
    registrationAuditedAt: identity.capturedAt,
    completedAt: attempt.completedAt,
    targetGeneration: attempt.generation,
    documents: structuredClone([...attempt.documents]),
    exclusions: structuredClone([...attempt.exclusions]),
  };
  await writeRuntime(ports, { ...runtime, enforcementCheckpoint: checkpoint });
}

/**
 * The settled session lands in place, and only the phase it settled into moves with it. A session
 * that did not move at all is not rewritten, so a boot that settles nothing writes nothing.
 */
async function writeSettledSession(
  ports: RuntimePortsV2,
  settled: SessionStateV2,
  previous: SessionStateV2,
): Promise<void> {
  if (exactDataEqual(settled, previous)) return;
  const runtime: RuntimeStateV2 = ports.runtime();
  await writeRuntime(ports, {
    ...runtime,
    session: structuredClone(settled),
    // A boundary that turned focus into a pause or a break takes the focus checkpoint with it,
    // because a non-blocking phase carries none.
    enforcementCheckpoint: settled.phase === 'focus' ? runtime.enforcementCheckpoint : null,
  });
}

/** Compiles the persisted rules. Rules that cannot compile are broken durable state, not a verdict. */
function compiledMatcher(ports: RuntimePortsV2, session: SessionStateV2): CompiledMatcher | null {
  try {
    return ports.compileMatcher(session.config.rules, session.config.mode);
  } catch (error: unknown) {
    ports.reportError(error);
    return null;
  }
}

async function closeForReason(
  ports: RuntimePortsV2,
  effects: CleanupEffectPortsV2,
  reason: SessionEndReasonV2,
  endedAt: number,
): Promise<RecoveryResultV2> {
  return resultFor(await closeSessionV2(ports, effects, { endedAt, reason }));
}

/** A batch whose retry time has arrived runs now. An exhausted batch never runs again by itself. */
function attemptIsDue(progress: CleanupProgress, now: number): boolean {
  const nextAttemptAt: number | null = progress.retry.nextAttemptAt;
  return nextAttemptAt !== null && nextAttemptAt <= now;
}

/**
 * A cleanup batch owns the runtime's command map, so its clear revision is the top revision. A
 * runtime that has moved past it is broken durable state rather than something to reissue over.
 */
function assertClearBatchIsCurrent(runtime: RuntimeStateV2, progress: CleanupProgress): void {
  if (runtime.runtimeRevision !== progress.clearRuntimeRevision) {
    throw new CoreError(
      'invalid-rule',
      'a cleanup batch must still be the current runtime revision to reissue its clear commands',
    );
  }
}

function requireProgress(transition: PendingEnforcementTransition): CleanupProgress {
  const progress: CleanupProgress | null = transition.cleanupProgress;
  if (progress === null) {
    throw new CoreError('invalid-rule', 'a cleanup transition needs its cleanup progress');
  }
  return progress;
}

/** What the caller may publish from, read from the runtime the recovery left durable. */
function resultFor(runtime: RuntimeStateV2): RecoveryResultV2 {
  if (runtime.pendingEnforcementTransition !== null) return { kind: 'transition', runtime };
  if (runtime.pendingClosure !== null) return { kind: 'closure', runtime };
  if (runtime.session !== null) return { kind: 'published', runtime };
  return { kind: 'idle', runtime };
}

/**
 * `RecoveryResultV2` is a tagged union, so ask its tag. The structural test this replaces was
 * correct only because the result happens to carry no `version` and the session happens to carry
 * no `kind`: either type is one field away from routing a recovery result back into the session
 * path, and neither field is declared anywhere that would make the coupling visible.
 */
function isSessionState(value: SessionStateV2 | RecoveryResultV2): value is SessionStateV2 {
  const kind: unknown = (value as { kind?: unknown }).kind;
  return typeof kind !== 'string' || !RECOVERY_RESULT_KINDS.has(kind);
}

const RECOVERY_RESULT_KINDS: ReadonlySet<string> = new Set<RecoveryResultV2['kind']>([
  'published',
  'closure',
  'transition',
  'idle',
]);

async function writeRuntime(ports: RuntimePortsV2, next: RuntimeStateV2): Promise<void> {
  const parsed: RuntimeStateV2 | null = parseRuntimeStateV2(
    carryCommitCheckpointProjectionV2(next),
  );
  if (parsed === null) {
    throw new CoreError('invalid-rule', 'recovery would persist an invalid runtime');
  }
  await ports.writeRuntime(parsed);
}

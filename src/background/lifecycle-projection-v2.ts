/**
 * The public read model. One pure function turns a parsed `RuntimeStateV2` into the lifecycle and
 * snapshot the popup, Options, Stats, and badge consume. Nothing here reads storage, a clock, or a
 * browser API, and nothing here mutates the runtime it was handed.
 *
 * The rule the whole file serves: only an `active` lifecycle may expose a phase, a config, or a
 * clock. A durable session hidden behind a transition or closure journal, or one that has no
 * matching enforcement checkpoint yet, is real but not publishable, and its snapshot says nothing
 * about it.
 */

import { focusedMsAtV2 } from '../core/session-v2';
import { CoreError } from '../shared/errors';
import type {
  BankState,
  DailyAgg,
  EndAuthorityV2,
  GateState,
  SessionLifecycleV2,
  SessionSnapshotV2,
  SessionStateV2,
  SettingsV2,
  SiteUnlock,
  Strictness,
} from '../shared/types';
import type { EnforcementCheckpoint } from './enforcement-persistence-v2';
import type {
  PendingClosure,
  PendingEnforcementTransition,
  RuntimeStateV2,
} from './runtime-v2-types';

export interface SnapshotInputV2 {
  runtime: RuntimeStateV2;
  settings: SettingsV2;
  bank: BankState;
  at: number;
  nextSchedule: { entryId: string; startsAt: number } | null;
}

/**
 * The public types pin these strings as literals, so they are written out here rather than read
 * from `session-copy.ts`, whose constants are typed `string`. A test asserts `END_ACTION_LABEL`
 * still equals the shared `END_SESSION_LABEL`.
 */
const END_ACTION_LABEL: 'End session' = 'End session';
const GATE_TITLE: 'End this session' = 'End this session';
const GATE_BACK: 'Never mind, back to work' = 'Never mind, back to work';
const GATE_PHRASE_LABEL: 'Type this to confirm:' = 'Type this to confirm:';
const GATE_CONFIRM: 'End the session' = 'End the session';
const HIDDEN_AUTHORITY: { kind: 'hidden' } = { kind: 'hidden' };
/** The stages whose durable session is committed, so its strictness already governs End. */
const COMMITTED_TRANSITION_STAGES: ReadonlySet<string> = new Set<string>([
  'committed-pending-verification',
  'alarm-ready',
  'active-verified',
]);

/**
 * End authority for one durable strictness. Hard renders no End, Flexible ends immediately, and
 * Friction renders the cancel deliberation gate: closed until one is persisted, then the exact
 * persisted gate. Every indefinite session is Flexible, so it always reaches the immediate branch.
 */
export function endAuthorityV2(
  strictness: Strictness,
  gate: GateState | null,
  intention: string,
): EndAuthorityV2 {
  if (strictness === 'hard') return { kind: 'hidden' };
  if (strictness === 'flexible') return { kind: 'immediate', actionLabel: END_ACTION_LABEL };
  const cancelGate: (GateState & { kind: 'cancel' }) | null = openCancelGate(gate);
  if (cancelGate === null) {
    return {
      kind: 'friction-gate',
      gate: null,
      copy: { actionLabel: END_ACTION_LABEL },
      actions: { open: 'open-end-gate' },
    };
  }
  return {
    kind: 'friction-gate',
    gate: cancelGate,
    copy: {
      title: GATE_TITLE,
      back: GATE_BACK,
      phraseLabel: GATE_PHRASE_LABEL,
      confirm: GATE_CONFIRM,
      intentionReminder: intentionReminder(intention),
    },
    actions: { abandon: 'abandon-gate', confirm: 'confirm-gate' },
  };
}

/**
 * A session is publishable when nothing durable is still in flight over it. Focus additionally
 * needs the enforcement checkpoint that proves its documents were verified under the current epoch
 * and base policy revision. Pause and break publish a non-blocking phase and hold no focus
 * checkpoint at all.
 */
export function isPublishableSessionV2(runtime: RuntimeStateV2): boolean {
  const session: SessionStateV2 | null = runtime.session;
  if (
    session === null ||
    runtime.pendingEnforcementTransition !== null ||
    runtime.pendingClosure !== null
  ) {
    return false;
  }
  if (session.phase !== 'focus') return runtime.enforcementCheckpoint === null;
  return checkpointPublishes(runtime.enforcementCheckpoint, runtime, session);
}

/**
 * Projects the one public lifecycle a durable runtime supports. A transition and a closure never
 * coexist in a runtime the boundary parser accepted, so a runtime carrying both is a reader defect
 * rather than a state this projection has an answer for.
 */
export function projectLifecycleV2(runtime: RuntimeStateV2): SessionLifecycleV2 {
  const transition: PendingEnforcementTransition | null = runtime.pendingEnforcementTransition;
  const closure: PendingClosure | null = runtime.pendingClosure;
  if (transition !== null && closure !== null) {
    throw new CoreError(
      'invalid-rule',
      'runtime carries a transition and a closure at the same time',
    );
  }
  if (transition !== null) return transitionLifecycle(runtime, transition);
  if (closure !== null) return closureLifecycle(closure);
  if (runtime.session === null) return { kind: 'idle', endAuthority: HIDDEN_AUTHORITY };
  if (isPublishableSessionV2(runtime)) {
    return { kind: 'active', endAuthority: sessionAuthority(runtime, runtime.session) };
  }
  return unpublishedSessionLifecycle(runtime);
}

/**
 * Builds the public snapshot at one observation instant. Active focus settles through `at`; every
 * other lifecycle reports the idle shape, because the worker never projects clocks or config from a
 * session the public lifecycle is not reporting as active.
 */
export function buildSessionSnapshotV2(input: SnapshotInputV2): SessionSnapshotV2 {
  const { runtime, settings, bank, at, nextSchedule }: SnapshotInputV2 = input;
  const lifecycle: SessionLifecycleV2 = projectLifecycleV2(runtime);
  const session: SessionStateV2 | null = lifecycle.kind === 'active' ? runtime.session : null;
  return {
    at,
    theme: settings.theme,
    lifecycle,
    ...sessionFields(session, at),
    ...bankFields(session, settings, bank),
    activeUnlocks: session === null ? [] : liveUnlocks(runtime.unlocks, at),
    gate: session === null ? null : structuredClone(runtime.gate),
    attemptsToday: attemptsToday(runtime.todayAgg),
    scheduleActive: session !== null && session.config.source === 'schedule',
    nextSchedule: structuredClone(nextSchedule),
  };
}

/** The active session fields, or the idle shape every other lifecycle reports. */
function sessionFields(
  session: SessionStateV2 | null,
  at: number,
): Pick<
  SessionSnapshotV2,
  | 'phase'
  | 'config'
  | 'startedAt'
  | 'phaseStartedAt'
  | 'phaseEndsAt'
  | 'sessionEndsAt'
  | 'sessionFocusedMs'
  | 'cycleIndex'
> {
  if (session === null) {
    return {
      phase: 'idle',
      config: null,
      startedAt: null,
      phaseStartedAt: null,
      phaseEndsAt: null,
      sessionEndsAt: null,
      sessionFocusedMs: 0,
      cycleIndex: 0,
    };
  }
  return {
    phase: session.phase,
    config: structuredClone(session.config),
    startedAt: session.startedAt,
    phaseStartedAt: session.phaseStartedAt,
    phaseEndsAt: session.phaseEndsAt,
    sessionEndsAt: session.sessionEndsAt,
    sessionFocusedMs: focusedMsAtV2(session, at),
    cycleIndex: session.cycleIndex,
  };
}

/**
 * The pause economy the popup renders. Only a focus phase accrues, and the balance is reported
 * within the current cap, which the settings writer already keeps true of the durable bank.
 */
function bankFields(
  session: SessionStateV2 | null,
  settings: SettingsV2,
  bank: BankState,
): Pick<
  SessionSnapshotV2,
  'bankMs' | 'bankAccrualPerMs' | 'bankCapMs' | 'pauseCostMs' | 'unlockCostMs'
> {
  const focusing: boolean = session !== null && session.phase === 'focus';
  return {
    bankMs: Math.min(bank.balanceMs, settings.pause.capMs),
    bankAccrualPerMs: focusing ? settings.pause.earnRatio : 0,
    bankCapMs: settings.pause.capMs,
    pauseCostMs: settings.pause.pauseMs,
    unlockCostMs: settings.pause.unlockMs,
  };
}

/**
 * A pre-commit transition hides End entirely and names its starting operation. A committed one
 * still hides clocks and config, but derives End authority from the session its commit created.
 */
function transitionLifecycle(
  runtime: RuntimeStateV2,
  transition: PendingEnforcementTransition,
): SessionLifecycleV2 {
  if (transition.stage === 'cleanup') return transitionCleanupLifecycle(transition);
  const committed: boolean = COMMITTED_TRANSITION_STAGES.has(transition.stage);
  return {
    kind: 'starting',
    operationId: committed ? transition.activeOperationId : transition.startingOperationId,
    transition: transition.kind,
    endAuthority: committed ? committedAuthority(runtime) : HIDDEN_AUTHORITY,
  };
}

/** Cleanup keeps reporting itself while a retry is scheduled, and reports error once none is. */
function transitionCleanupLifecycle(transition: PendingEnforcementTransition): SessionLifecycleV2 {
  if (transition.cleanupProgress?.retry.nextAttemptAt == null) {
    return {
      kind: 'error',
      code: 'transition-cleanup-failed',
      retryAvailable: true,
      endAuthority: HIDDEN_AUTHORITY,
    };
  }
  return {
    kind: 'cleanup',
    journal: 'transition',
    id: transition.transitionId,
    endAuthority: HIDDEN_AUTHORITY,
  };
}

/**
 * A durable closure always wins over the older session, so a prepared closure already reports the
 * closure copy. The public identifier is the journal's own `closureId`.
 */
function closureLifecycle(closure: PendingClosure): SessionLifecycleV2 {
  if (closure.stage === 'cleanup' && closure.cleanupProgress.retry.nextAttemptAt === null) {
    return {
      kind: 'error',
      code: 'closure-cleanup-failed',
      retryAvailable: true,
      endAuthority: HIDDEN_AUTHORITY,
    };
  }
  return {
    kind: 'cleanup',
    journal: 'closure',
    id: closure.projection.closureId,
    endAuthority: HIDDEN_AUTHORITY,
  };
}

/**
 * A session with no journal that is still not publishable is a migrated active state waiting for
 * standalone recovery, or a focus session whose checkpoint does not match. Either way the public
 * lifecycle withholds active state, and the only stable identifier it can name is the epoch that
 * recovery will verify against.
 */
function unpublishedSessionLifecycle(runtime: RuntimeStateV2): SessionLifecycleV2 {
  return {
    kind: 'starting',
    operationId: runtime.enforcementEpoch,
    transition: 'start',
    endAuthority: HIDDEN_AUTHORITY,
  };
}

/** A committed transition without its durable session cannot derive End, so it hides it. */
function committedAuthority(runtime: RuntimeStateV2): EndAuthorityV2 {
  const session: SessionStateV2 | null = runtime.session;
  return session === null ? HIDDEN_AUTHORITY : sessionAuthority(runtime, session);
}

function sessionAuthority(runtime: RuntimeStateV2, session: SessionStateV2): EndAuthorityV2 {
  return endAuthorityV2(session.config.strictness, runtime.gate, session.config.intention);
}

/** The published checkpoint names this session under the current epoch and base policy revision. */
function checkpointPublishes(
  checkpoint: EnforcementCheckpoint | null,
  runtime: RuntimeStateV2,
  session: SessionStateV2,
): boolean {
  return (
    checkpoint !== null &&
    checkpoint.sessionId === session.sessionId &&
    checkpoint.enforcementEpoch === runtime.enforcementEpoch &&
    checkpoint.basePolicyRevision === runtime.basePolicyRevision
  );
}

/** Only a persisted cancel gate opens the Friction End gate. Any other gate leaves it closed. */
function openCancelGate(gate: GateState | null): (GateState & { kind: 'cancel' }) | null {
  if (gate === null || gate.kind !== 'cancel') return null;
  return { ...structuredClone(gate), kind: 'cancel' };
}

function intentionReminder(intention: string): string | null {
  const goal: string = intention.trim();
  return goal === '' ? null : goal;
}

/** An unlock that has already expired at the observation instant is no longer active. */
function liveUnlocks(unlocks: readonly SiteUnlock[], at: number): SiteUnlock[] {
  return unlocks
    .filter((unlock: SiteUnlock): boolean => unlock.until > at)
    .map((unlock: SiteUnlock): SiteUnlock => structuredClone(unlock));
}

function attemptsToday(agg: DailyAgg | null): number {
  if (agg === null) return 0;
  const hosts: number = Object.values(agg.attempts).reduce(
    (total: number, count: number): number => total + count,
    0,
  );
  return hosts + agg.attemptsOther;
}

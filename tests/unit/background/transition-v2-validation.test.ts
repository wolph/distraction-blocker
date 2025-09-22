import { describe, expect, it } from 'vitest';
import { MAX_AUTOMATIC_CLEANUP_ATTEMPT } from '../../../src/background/cleanup-closure-v2-validation';
import type { FrozenDocumentCommand } from '../../../src/background/enforcement-persistence-v2';
import type {
  FrozenTransitionView,
  PendingEnforcementTransition,
  TransitionStage,
} from '../../../src/background/runtime-v2-types';
import {
  parsePendingEnforcementTransition,
  validateDetachedPendingEnforcementTransition,
} from '../../../src/background/transition-v2-validation';
import type { SessionEndedEventV2 } from '../../../src/shared/types';
import {
  ACTIVATION_AT,
  ACTIVE_OPERATION_ID,
  activeCommandMap,
  activeOverlay,
  allowedVerdict,
  BASE_POLICY_REVISION,
  budgetEarnedEvent,
  CLEANUP_OPERATION_ID,
  CLEAR_RUNTIME_REVISION,
  candidateScheduleWindow,
  canonicalRules,
  cleanupProgress,
  cleanupRetryState,
  cleanupTransition,
  clearCommand,
  clearCommandMap,
  closureProjection,
  documentKey,
  frozenActiveView,
  frozenStartingView,
  LOCAL_DATE,
  manualCandidate,
  OTHER_EPOCH_ID,
  OTHER_OPERATION_ID,
  OTHER_SESSION_ID,
  pendingTransition,
  postCleanupClosure,
  preparedReservation,
  preparedReservationMap,
  REQUESTED_AT,
  RESUME_STARTING_REVISION,
  SECOND_TARGET_URL,
  SESSION_ID,
  START_ACTIVE_REVISION,
  STARTING_OPERATION_ID,
  scheduleCandidate,
  scheduleOccurrence,
  sessionEndedEvent,
  startingCommand,
  startingCommandMap,
  startingOverlay,
  transitionActiveCheckpoint,
  transitionCheckpoint,
  transitionStartingCheckpoint,
  untilStoppedActiveOverlay,
  untilStoppedCandidate,
} from './runtime-v2-fixtures';

type UnknownRecord = Record<string, unknown>;
type JournalStage = Exclude<TransitionStage, 'cleanup'>;

const PRE_COMMIT_STAGES: readonly JournalStage[] = [
  'prepared',
  'registration-audited',
  'starting-verified',
];
const COMMITTED_STAGES: readonly JournalStage[] = [
  'committed-pending-verification',
  'alarm-ready',
  'active-verified',
];

function withKey(value: object, key: string, replacement: unknown): UnknownRecord {
  return { ...value, [key]: replacement };
}

function withoutKey(value: object, key: string): UnknownRecord {
  const clone: UnknownRecord = { ...value };
  Reflect.deleteProperty(clone, key);
  return clone;
}

function expectRejected(values: readonly unknown[]): void {
  for (const value of values) {
    expect((): PendingEnforcementTransition | null =>
      parsePendingEnforcementTransition(value),
    ).not.toThrow();
    expect(parsePendingEnforcementTransition(value)).toBeNull();
  }
}

function expectAccepted(values: readonly PendingEnforcementTransition[]): void {
  for (const value of values) {
    expect(parsePendingEnforcementTransition(value)).toEqual(value);
    expect(validateDetachedPendingEnforcementTransition(structuredClone(value))).toBe(true);
  }
}

function cyclicRecord(): UnknownRecord {
  const cycle: UnknownRecord = {};
  cycle.self = cycle;
  return cycle;
}

function sparseArray(entry: unknown): unknown[] {
  const sparse: unknown[] = [entry];
  sparse.length = 3;
  return sparse;
}

/** A pre-commit start view whose frozen commands follow the field the case moves. */
function startView(overrides: Partial<FrozenTransitionView>): FrozenTransitionView {
  return frozenStartingView('start', overrides);
}

/** The committed indefinite start: no phase alarm and an until-stopped active view. */
function indefiniteStart(
  stage: JournalStage,
  overrides: Partial<PendingEnforcementTransition> = {},
): PendingEnforcementTransition {
  return pendingTransition('start', stage, {
    candidate: untilStoppedCandidate(),
    alarmNames: [],
    activeView: frozenActiveView('start', {
      documents: activeCommandMap({}, ACTIVATION_AT, untilStoppedActiveOverlay()),
    }),
    ...overrides,
  });
}

describe('background transition stage fixtures', (): void => {
  it('accepts every start stage', (): void => {
    expectAccepted([
      pendingTransition('start', 'prepared'),
      pendingTransition('start', 'registration-audited'),
      pendingTransition('start', 'starting-verified'),
      pendingTransition('start', 'committed-pending-verification'),
      pendingTransition('start', 'alarm-ready'),
      pendingTransition('start', 'active-verified'),
    ]);
  });

  it('accepts every resume stage', (): void => {
    expectAccepted([
      pendingTransition('resume', 'prepared'),
      pendingTransition('resume', 'registration-audited'),
      pendingTransition('resume', 'starting-verified'),
      pendingTransition('resume', 'committed-pending-verification'),
      pendingTransition('resume', 'alarm-ready'),
      pendingTransition('resume', 'active-verified'),
    ]);
  });

  it('accepts scheduled, indefinite, and break-resume variants', (): void => {
    expectAccepted([
      pendingTransition('start', 'prepared', {
        trigger: 'schedule',
        candidate: scheduleCandidate(),
      }),
      pendingTransition('start', 'starting-verified', {
        trigger: 'schedule',
        candidate: scheduleCandidate({
          duration: { kind: 'until-stopped' },
          strictness: 'flexible',
        }),
      }),
      indefiniteStart('alarm-ready'),
      pendingTransition('resume', 'alarm-ready', { trigger: 'break-expired', priorPhase: 'break' }),
      pendingTransition('resume', 'prepared', { trigger: 'manual' }),
    ]);
  });

  it('accepts every cleanup cause with its legal source stage', (): void => {
    expectAccepted([
      cleanupTransition('start', 'prepared', 'start-abandon'),
      cleanupTransition('start', 'registration-audited', 'start-abandon', {
        failure: 'content-registration-failed',
      }),
      cleanupTransition('start', 'starting-verified', 'start-abandon'),
      cleanupTransition('resume', 'prepared', 'resume-restore'),
      cleanupTransition('resume', 'starting-verified', 'timer-completed'),
      cleanupTransition('start', 'committed-pending-verification', 'manual-end'),
      cleanupTransition('start', 'alarm-ready', 'timer-completed'),
      cleanupTransition('start', 'active-verified', 'transition-failed'),
      cleanupTransition('resume', 'active-verified', 'manual-end'),
    ]);
  });

  it('accepts an exhausted cleanup batch that stopped scheduling retries', (): void => {
    expectAccepted([
      cleanupTransition('start', 'prepared', 'start-abandon', {
        cleanupProgress: cleanupProgress({
          clearCommands: clearCommandMap({
            operationId: CLEANUP_OPERATION_ID,
            runtimeRevision: CLEAR_RUNTIME_REVISION,
            sessionId: null,
            reservedSessionId: SESSION_ID,
          }),
          retry: cleanupRetryState({
            automaticAttempt: MAX_AUTOMATIC_CLEANUP_ATTEMPT,
            nextAttemptAt: null,
          }),
        }),
      }),
    ]);
  });
});

describe('background transition identity and request', (): void => {
  it('requires version one, a known kind, and a known stage', (): void => {
    expectRejected([
      withKey(pendingTransition('start', 'prepared'), 'version', 2),
      withKey(pendingTransition('start', 'prepared'), 'kind', 'restart'),
      withKey(pendingTransition('start', 'prepared'), 'stage', 'verified'),
      withKey(pendingTransition('start', 'prepared'), 'stage', null),
      withKey(pendingTransition('start', 'prepared'), 'extra', true),
      withoutKey(pendingTransition('start', 'prepared'), 'stage'),
    ]);
  });

  it('requires every stored identity to be a UUID', (): void => {
    expectRejected([
      pendingTransition('start', 'prepared', { transitionId: 'transition-1' }),
      pendingTransition('start', 'prepared', {
        startingOperationId: 'starting',
        startingView: startView({ operationId: 'starting' }),
      }),
      pendingTransition('start', 'prepared', { activeOperationId: '' }),
      pendingTransition('start', 'prepared', { enforcementEpoch: 'epoch' }),
      pendingTransition('start', 'prepared', { sessionId: 'session' }),
      withKey(pendingTransition('start', 'prepared'), 'transitionId', null),
    ]);
  });

  it('reserves two distinct verification operations', (): void => {
    expectRejected([
      pendingTransition('start', 'prepared', {
        startingOperationId: ACTIVE_OPERATION_ID,
        startingView: startView({ operationId: ACTIVE_OPERATION_ID }),
      }),
      pendingTransition('start', 'active-verified', {
        activeOperationId: STARTING_OPERATION_ID,
        activeView: frozenActiveView('start', { operationId: STARTING_OPERATION_ID }),
        checkpoint: transitionCheckpoint({ operationId: STARTING_OPERATION_ID }),
      }),
    ]);
  });

  it('requires non-negative safe revisions, a generation, and a request time', (): void => {
    expectRejected([
      pendingTransition('start', 'prepared', { basePolicyRevision: -1 }),
      pendingTransition('start', 'prepared', { basePolicyRevision: 1.5 }),
      pendingTransition('start', 'prepared', { runtimeRevision: -1 }),
      pendingTransition('start', 'prepared', { targetGeneration: -1 }),
      pendingTransition('start', 'prepared', { targetGeneration: Number.NaN }),
      pendingTransition('start', 'prepared', { requestedAt: -1 }),
      withKey(pendingTransition('start', 'prepared'), 'requestedAt', `${REQUESTED_AT}`),
    ]);
  });

  it('pairs a start with its candidate and a resume with its prior phase', (): void => {
    expectRejected([
      pendingTransition('start', 'prepared', { candidate: null }),
      pendingTransition('start', 'prepared', { priorPhase: 'paused' }),
      pendingTransition('resume', 'prepared', { candidate: manualCandidate() }),
      pendingTransition('resume', 'prepared', { priorPhase: null }),
      withKey(pendingTransition('resume', 'prepared'), 'priorPhase', 'focus'),
    ]);
  });

  it('maps each trigger to its legal kind, source, and prior phase', (): void => {
    expectRejected([
      pendingTransition('start', 'prepared', { trigger: 'pause-expired' }),
      pendingTransition('start', 'prepared', { trigger: 'break-expired' }),
      pendingTransition('start', 'prepared', { trigger: 'schedule' }),
      pendingTransition('start', 'prepared', { trigger: 'manual', candidate: scheduleCandidate() }),
      pendingTransition('resume', 'prepared', { trigger: 'schedule' }),
      pendingTransition('resume', 'prepared', { trigger: 'break-expired' }),
      pendingTransition('resume', 'prepared', { trigger: 'manual', priorPhase: 'break' }),
      pendingTransition('resume', 'prepared', { trigger: 'pause-expired', priorPhase: 'break' }),
      withKey(pendingTransition('start', 'prepared'), 'trigger', 'boot'),
    ]);
  });
});

describe('background transition candidate', (): void => {
  it('requires the exact candidate key set and leaf domains', (): void => {
    const transition: PendingEnforcementTransition = pendingTransition('start', 'prepared');

    expectRejected([
      withKey(transition, 'candidate', withKey(manualCandidate(), 'extra', true)),
      withKey(transition, 'candidate', withoutKey(manualCandidate(), 'scheduleWindow')),
      withKey(transition, 'candidate', withKey(manualCandidate(), 'mode', 'both')),
      withKey(transition, 'candidate', withKey(manualCandidate(), 'strictness', 'strict')),
      withKey(transition, 'candidate', withKey(manualCandidate(), 'intention', 12)),
      withKey(transition, 'candidate', withKey(manualCandidate(), 'source', 'boot')),
      withKey(transition, 'candidate', withKey(manualCandidate(), 'cycling', { focusMin: 25 })),
      pendingTransition('start', 'prepared', {
        candidate: manualCandidate({ rules: canonicalRules({ baselineRevision: '' }) }),
      }),
    ]);
  });

  it('accepts each duration plan and rejects unknown or malformed plans', (): void => {
    const transition: PendingEnforcementTransition = pendingTransition('start', 'prepared');

    expectAccepted([
      pendingTransition('start', 'prepared', {
        candidate: manualCandidate({ duration: { kind: 'manual-timed', minutes: 0.5 } }),
      }),
      pendingTransition('start', 'prepared', { candidate: untilStoppedCandidate() }),
    ]);
    expectRejected([
      withKey(
        transition,
        'candidate',
        withKey(manualCandidate(), 'duration', {
          kind: 'timed',
          minutes: 25,
        }),
      ),
      withKey(
        transition,
        'candidate',
        withKey(manualCandidate(), 'duration', {
          kind: 'until-stopped',
          minutes: 25,
        }),
      ),
      pendingTransition('start', 'prepared', {
        candidate: manualCandidate({ duration: { kind: 'manual-timed', minutes: 0 } }),
      }),
      pendingTransition('start', 'prepared', {
        candidate: manualCandidate({ duration: { kind: 'manual-timed', minutes: -25 } }),
      }),
      pendingTransition('start', 'prepared', {
        candidate: manualCandidate({ duration: { kind: 'manual-timed', minutes: Number.NaN } }),
      }),
      pendingTransition('start', 'prepared', {
        candidate: manualCandidate({ duration: { kind: 'schedule-window' } }),
      }),
    ]);
  });

  it('keeps a manual candidate free of schedule identity and bounds', (): void => {
    expectRejected([
      pendingTransition('start', 'prepared', {
        candidate: manualCandidate({ scheduleOccurrence: scheduleOccurrence() }),
      }),
      pendingTransition('start', 'prepared', {
        candidate: manualCandidate({ scheduleWindow: candidateScheduleWindow() }),
      }),
    ]);
  });

  it('requires a scheduled candidate to carry an occurrence, bounds, and a window duration', (): void => {
    expectRejected([
      pendingTransition('start', 'prepared', {
        trigger: 'schedule',
        candidate: scheduleCandidate({ scheduleOccurrence: null }),
      }),
      pendingTransition('start', 'prepared', {
        trigger: 'schedule',
        candidate: scheduleCandidate({ scheduleWindow: null }),
      }),
      pendingTransition('start', 'prepared', {
        trigger: 'schedule',
        candidate: scheduleCandidate({ duration: { kind: 'manual-timed', minutes: 25 } }),
      }),
      pendingTransition('start', 'prepared', {
        trigger: 'schedule',
        candidate: scheduleCandidate({
          scheduleOccurrence: scheduleOccurrence({ token: `other@${LOCAL_DATE}` }),
        }),
      }),
    ]);
  });

  it('requires increasing safe window bounds', (): void => {
    const window: ReturnType<typeof candidateScheduleWindow> = candidateScheduleWindow();
    const scheduled: PendingEnforcementTransition = pendingTransition('start', 'prepared', {
      trigger: 'schedule',
      candidate: scheduleCandidate(),
    });

    expectRejected([
      pendingTransition('start', 'prepared', {
        trigger: 'schedule',
        candidate: scheduleCandidate({
          scheduleWindow: candidateScheduleWindow({ windowEndsAt: window.windowStartsAt }),
        }),
      }),
      pendingTransition('start', 'prepared', {
        trigger: 'schedule',
        candidate: scheduleCandidate({
          scheduleWindow: candidateScheduleWindow({ windowStartsAt: -1 }),
        }),
      }),
      withKey(
        scheduled,
        'candidate',
        withKey(scheduleCandidate(), 'scheduleWindow', withKey(window, 'extra', true)),
      ),
    ]);
  });

  it('requires the occurrence local date to agree with the captured start bound', (): void => {
    const dayBefore: number = new Date(2026, 8, 1, 9, 0, 0, 0).getTime();

    expectRejected([
      pendingTransition('start', 'prepared', {
        trigger: 'schedule',
        candidate: scheduleCandidate({
          scheduleWindow: candidateScheduleWindow({ windowStartsAt: dayBefore }),
        }),
      }),
    ]);
  });

  it('keeps an until-stopped candidate flexible and uncycled', (): void => {
    expectRejected([
      pendingTransition('start', 'prepared', {
        candidate: untilStoppedCandidate({ strictness: 'friction' }),
      }),
      pendingTransition('start', 'prepared', {
        candidate: untilStoppedCandidate({ strictness: 'hard' }),
      }),
      pendingTransition('start', 'prepared', {
        candidate: untilStoppedCandidate({
          cycling: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 },
        }),
      }),
    ]);
  });

  it('accepts cycling on a timed candidate', (): void => {
    expectAccepted([
      pendingTransition('start', 'prepared', {
        candidate: manualCandidate({
          cycling: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 },
        }),
      }),
    ]);
  });

  it('requires a window-timed activation to stay inside its captured bounds', (): void => {
    const window: ReturnType<typeof candidateScheduleWindow> = candidateScheduleWindow();

    expectRejected([
      pendingTransition('start', 'alarm-ready', {
        trigger: 'schedule',
        candidate: scheduleCandidate({
          scheduleWindow: candidateScheduleWindow({ windowEndsAt: ACTIVATION_AT - 1 }),
        }),
      }),
      pendingTransition('start', 'alarm-ready', {
        trigger: 'schedule',
        candidate: scheduleCandidate({
          scheduleWindow: candidateScheduleWindow({
            windowStartsAt: ACTIVATION_AT + 1,
            windowEndsAt: ACTIVATION_AT + 2,
          }),
        }),
      }),
    ]);
    expectAccepted([
      pendingTransition('start', 'alarm-ready', {
        trigger: 'schedule',
        candidate: scheduleCandidate({
          scheduleWindow: candidateScheduleWindow({ windowEndsAt: ACTIVATION_AT + 1 }),
        }),
      }),
      pendingTransition('start', 'alarm-ready', {
        trigger: 'schedule',
        candidate: scheduleCandidate({
          scheduleWindow: candidateScheduleWindow({ windowEndsAt: ACTIVATION_AT }),
        }),
      }),
      pendingTransition('start', 'alarm-ready', {
        trigger: 'schedule',
        candidate: scheduleCandidate({
          scheduleWindow: candidateScheduleWindow({ windowStartsAt: ACTIVATION_AT }),
        }),
      }),
      indefiniteStart('alarm-ready', {
        trigger: 'schedule',
        candidate: scheduleCandidate({
          duration: { kind: 'until-stopped' },
          strictness: 'flexible',
          scheduleWindow: candidateScheduleWindow({ windowEndsAt: window.windowStartsAt + 1 }),
        }),
      }),
    ]);
  });
});

describe('background transition activation and verification', (): void => {
  it('keeps activation, verification, and attempts empty before commit', (): void => {
    for (const stage of PRE_COMMIT_STAGES) {
      expectRejected([
        pendingTransition('start', stage, { activationAt: ACTIVATION_AT }),
        pendingTransition('start', stage, { verificationStartedAt: ACTIVATION_AT }),
        pendingTransition('start', stage, { freshnessAttempts: 1 }),
      ]);
    }
  });

  it('captures one activation that the verification start repeats after commit', (): void => {
    expectRejected([
      pendingTransition('start', 'alarm-ready', { activationAt: null }),
      pendingTransition('start', 'alarm-ready', { verificationStartedAt: null }),
      pendingTransition('start', 'alarm-ready', { verificationStartedAt: ACTIVATION_AT + 1 }),
      pendingTransition('start', 'alarm-ready', {
        activationAt: -1,
        verificationStartedAt: -1,
        activeView: frozenActiveView('start', { capturedAt: -1 }),
      }),
    ]);
  });

  it('bounds freshness attempts by stage', (): void => {
    expectAccepted([
      pendingTransition('start', 'committed-pending-verification', { freshnessAttempts: 0 }),
      pendingTransition('start', 'alarm-ready', { freshnessAttempts: 0 }),
      pendingTransition('start', 'alarm-ready', { freshnessAttempts: 3 }),
      pendingTransition('start', 'active-verified', { freshnessAttempts: 1 }),
      pendingTransition('start', 'active-verified', { freshnessAttempts: 3 }),
    ]);
    expectRejected([
      pendingTransition('start', 'committed-pending-verification', { freshnessAttempts: 1 }),
      pendingTransition('start', 'alarm-ready', { freshnessAttempts: 4 }),
      pendingTransition('start', 'alarm-ready', { freshnessAttempts: -1 }),
      pendingTransition('start', 'alarm-ready', { freshnessAttempts: 1.5 }),
      pendingTransition('start', 'active-verified', { freshnessAttempts: 0 }),
      pendingTransition('start', 'active-verified', { freshnessAttempts: 4 }),
    ]);
  });
});

describe('background transition frozen views', (): void => {
  it('requires the exact view key set and leaf domains', (): void => {
    const transition: PendingEnforcementTransition = pendingTransition('start', 'prepared');

    expectRejected([
      withKey(transition, 'startingView', withKey(frozenStartingView('start'), 'extra', true)),
      withKey(transition, 'startingView', withoutKey(frozenStartingView('start'), 'documents')),
      withKey(
        transition,
        'startingView',
        withKey(frozenStartingView('start'), 'runtimeRevision', 1.5),
      ),
      withKey(transition, 'startingView', null),
      pendingTransition('start', 'prepared', { startingView: startView({ capturedAt: -1 }) }),
    ]);
  });

  it('ties each view to its own operation, epoch, and base revision', (): void => {
    const transition: PendingEnforcementTransition = pendingTransition('start', 'prepared');

    expectRejected([
      pendingTransition('start', 'prepared', {
        startingView: frozenStartingView('start', { operationId: OTHER_OPERATION_ID }),
      }),
      withKey(
        transition,
        'startingView',
        withKey(frozenStartingView('start'), 'enforcementEpoch', OTHER_EPOCH_ID),
      ),
      withKey(
        transition,
        'startingView',
        withKey(frozenStartingView('start'), 'basePolicyRevision', BASE_POLICY_REVISION + 1),
      ),
      pendingTransition('start', 'alarm-ready', {
        activeView: frozenActiveView('start', { operationId: STARTING_OPERATION_ID }),
      }),
    ]);
  });

  it('requires every frozen command to repeat its view tuple and key identity', (): void => {
    expectRejected([
      pendingTransition('start', 'prepared', {
        startingView: startView({
          documents: startingCommandMap({ operationId: OTHER_OPERATION_ID }),
        }),
      }),
      pendingTransition('start', 'prepared', {
        startingView: startView({
          documents: startingCommandMap({ enforcementEpoch: OTHER_EPOCH_ID }),
        }),
      }),
      pendingTransition('start', 'prepared', {
        startingView: startView({
          documents: startingCommandMap({ basePolicyRevision: BASE_POLICY_REVISION + 1 }),
        }),
      }),
      pendingTransition('start', 'prepared', {
        startingView: startView({
          documents: startingCommandMap({ runtimeRevision: START_ACTIVE_REVISION }),
        }),
      }),
      pendingTransition('start', 'prepared', {
        startingView: startView({
          documents: { [documentKey(11, 'document-2')]: startingCommand() },
        }),
      }),
      withKey(
        pendingTransition('start', 'prepared'),
        'startingView',
        withKey(frozenStartingView('start'), 'documents', {
          [documentKey(11, 'document-1')]: withKey(startingCommand(), 'extra', true),
        }),
      ),
    ]);
  });

  it('keeps each view on its own presentation', (): void => {
    expectRejected([
      pendingTransition('start', 'prepared', {
        startingView: startView({
          documents: startingCommandMap({
            presentation: 'clear',
            verdict: clearCommand().verdict,
            overlay: null,
          }),
        }),
      }),
      pendingTransition('start', 'alarm-ready', {
        activeView: frozenActiveView('start', {
          documents: activeCommandMap({
            presentation: 'starting',
            overlay: startingOverlay({ capturedAt: ACTIVATION_AT }),
          }),
        }),
      }),
    ]);
  });

  it('reserves the session identity before commit and names it afterwards', (): void => {
    expectRejected([
      pendingTransition('start', 'prepared', {
        startingView: startView({
          documents: startingCommandMap({ sessionId: SESSION_ID, reservedSessionId: null }),
        }),
      }),
      pendingTransition('start', 'prepared', {
        startingView: startView({
          documents: startingCommandMap({ sessionId: null, reservedSessionId: OTHER_SESSION_ID }),
        }),
      }),
      pendingTransition('resume', 'prepared', {
        startingView: frozenStartingView('resume', {
          documents: startingCommandMap({
            runtimeRevision: RESUME_STARTING_REVISION,
            sessionId: null,
            reservedSessionId: SESSION_ID,
          }),
        }),
      }),
      pendingTransition('start', 'alarm-ready', {
        activeView: frozenActiveView('start', {
          documents: activeCommandMap({
            sessionId: null,
            reservedSessionId: SESSION_ID,
            verdict: allowedVerdict(),
            overlay: null,
          }),
        }),
      }),
    ]);
  });

  it('freezes one captured time that every overlay in the view repeats', (): void => {
    expectRejected([
      pendingTransition('start', 'prepared', {
        startingView: startView({ documents: startingCommandMap({}, REQUESTED_AT + 1_000) }),
      }),
      pendingTransition('start', 'alarm-ready', {
        activeView: frozenActiveView('start', {
          documents: activeCommandMap({}, ACTIVATION_AT, activeOverlay({}, ACTIVATION_AT + 1_000)),
        }),
      }),
    ]);
  });

  it('freezes the active view at the captured activation', (): void => {
    expectRejected([
      pendingTransition('start', 'alarm-ready', {
        activeView: frozenActiveView('start', { capturedAt: ACTIVATION_AT + 1_000 }),
      }),
    ]);
  });

  it('holds the active view exactly from commit onward', (): void => {
    for (const stage of PRE_COMMIT_STAGES) {
      expectRejected([
        pendingTransition('start', stage, { activeView: frozenActiveView('start') }),
      ]);
    }
    for (const stage of COMMITTED_STAGES) {
      expectRejected([pendingTransition('start', stage, { activeView: null })]);
    }
  });
});

describe('background transition checkpoints', (): void => {
  it('holds the starting checkpoint from starting-verified onward', (): void => {
    expectRejected([
      pendingTransition('start', 'prepared', {
        startingCheckpoint: transitionStartingCheckpoint('start'),
      }),
      pendingTransition('start', 'registration-audited', {
        startingCheckpoint: transitionStartingCheckpoint('start'),
      }),
      pendingTransition('start', 'starting-verified', { startingCheckpoint: null }),
      pendingTransition('start', 'alarm-ready', { startingCheckpoint: null }),
    ]);
  });

  it('holds the publishable checkpoint only at active-verified', (): void => {
    expectRejected([
      pendingTransition('start', 'alarm-ready', {
        checkpoint: transitionActiveCheckpoint('start'),
      }),
      pendingTransition('start', 'starting-verified', {
        checkpoint: transitionActiveCheckpoint('start'),
      }),
      pendingTransition('start', 'active-verified', { checkpoint: null }),
    ]);
  });

  it('matches each checkpoint to its operation, epoch, session, and base revision', (): void => {
    expectRejected([
      pendingTransition('start', 'starting-verified', {
        startingCheckpoint: transitionCheckpoint({ operationId: ACTIVE_OPERATION_ID }),
      }),
      pendingTransition('start', 'starting-verified', {
        startingCheckpoint: transitionCheckpoint({ enforcementEpoch: OTHER_EPOCH_ID }),
      }),
      pendingTransition('start', 'starting-verified', {
        startingCheckpoint: transitionCheckpoint({ sessionId: OTHER_SESSION_ID }),
      }),
      pendingTransition('start', 'starting-verified', {
        startingCheckpoint: transitionCheckpoint({ basePolicyRevision: BASE_POLICY_REVISION + 1 }),
      }),
      pendingTransition('start', 'active-verified', {
        checkpoint: transitionCheckpoint({ operationId: STARTING_OPERATION_ID }),
      }),
    ]);
  });

  it('derives the checkpoint kind from the transition kind', (): void => {
    expectRejected([
      pendingTransition('start', 'starting-verified', {
        startingCheckpoint: transitionStartingCheckpoint('resume'),
      }),
      pendingTransition('resume', 'starting-verified', {
        startingCheckpoint: transitionStartingCheckpoint('start'),
      }),
      pendingTransition('start', 'starting-verified', {
        startingCheckpoint: transitionCheckpoint({ kind: 'recovery' }),
      }),
      pendingTransition('start', 'active-verified', {
        checkpoint: transitionCheckpoint({ operationId: ACTIVE_OPERATION_ID, kind: 'recovery' }),
      }),
    ]);
  });
});

describe('background transition reservations', (): void => {
  it('keys each reservation by its own identity and frozen command', (): void => {
    expectRejected([
      pendingTransition('start', 'prepared', {
        preparedTargetReservations: { [documentKey(11, 'document-2')]: preparedReservation() },
      }),
      pendingTransition('start', 'prepared', {
        preparedTargetReservations: {
          [documentKey(11, 'document-1')]: preparedReservation({
            commandKey: documentKey(12, 'document-2'),
          }),
        },
      }),
      pendingTransition('start', 'prepared', {
        preparedTargetReservations: {
          [documentKey(11, 'document-1')]: preparedReservation({ expectedUrl: SECOND_TARGET_URL }),
        },
      }),
      pendingTransition('start', 'prepared', {
        preparedTargetReservations: {
          [documentKey(13, 'document-3')]: preparedReservation({
            tabId: 13,
            documentId: 'document-3',
            commandKey: documentKey(13, 'document-3'),
          }),
        },
      }),
      withKey(pendingTransition('start', 'prepared'), 'preparedTargetReservations', {
        [documentKey(11, 'document-1')]: withKey(preparedReservation(), 'extra', true),
      }),
      withKey(pendingTransition('start', 'prepared'), 'preparedTargetReservations', []),
      withKey(pendingTransition('start', 'prepared'), 'preparedTargetReservations', null),
    ]);
  });

  it('queues reservations only while the audit is pending', (): void => {
    expectAccepted([
      pendingTransition('start', 'prepared', { preparedTargetReservations: {} }),
      pendingTransition('start', 'registration-audited', {
        preparedTargetReservations: preparedReservationMap(),
      }),
    ]);
    expectRejected([
      pendingTransition('start', 'starting-verified', {
        preparedTargetReservations: preparedReservationMap(),
      }),
      pendingTransition('start', 'committed-pending-verification', {
        preparedTargetReservations: preparedReservationMap(),
      }),
      pendingTransition('start', 'active-verified', {
        preparedTargetReservations: preparedReservationMap(),
      }),
      cleanupTransition('start', 'prepared', 'start-abandon', {
        preparedTargetReservations: preparedReservationMap(),
      }),
    ]);
  });
});

describe('background transition revisions', (): void => {
  it('matches the pre-commit revision to the latest starting view', (): void => {
    expectAccepted([
      pendingTransition('start', 'registration-audited', {
        runtimeRevision: 5,
        startingView: startView({ runtimeRevision: 5 }),
      }),
    ]);
    expectRejected([
      pendingTransition('start', 'prepared', { runtimeRevision: 1 }),
      pendingTransition('start', 'starting-verified', {
        runtimeRevision: 2,
        startingView: startView({ runtimeRevision: 3 }),
      }),
    ]);
  });

  it('matches the committed revision to the active view above the starting view', (): void => {
    expectRejected([
      pendingTransition('start', 'alarm-ready', { runtimeRevision: START_ACTIVE_REVISION + 1 }),
      pendingTransition('start', 'alarm-ready', {
        runtimeRevision: 0,
        activeView: frozenActiveView('start', { runtimeRevision: 0 }),
      }),
      pendingTransition('start', 'alarm-ready', {
        runtimeRevision: 5,
        activeView: frozenActiveView('start', { runtimeRevision: 5 }),
        startingView: startView({ runtimeRevision: 5 }),
      }),
    ]);
  });

  it('begins a start at revision zero and reserves the next revision for a resume', (): void => {
    expectRejected([
      pendingTransition('start', 'prepared', {
        runtimeRevision: 2,
        startingView: startView({ runtimeRevision: 2 }),
      }),
      pendingTransition('resume', 'prepared', {
        runtimeRevision: 0,
        startingView: frozenStartingView('resume', {
          runtimeRevision: 0,
          documents: startingCommandMap({
            runtimeRevision: 0,
            sessionId: SESSION_ID,
            reservedSessionId: null,
          }),
        }),
      }),
    ]);
  });

  it('matches a cleanup revision to its clear revision', (): void => {
    expectRejected([
      cleanupTransition('start', 'prepared', 'start-abandon', {
        runtimeRevision: CLEAR_RUNTIME_REVISION + 1,
      }),
      cleanupTransition('start', 'prepared', 'start-abandon', { runtimeRevision: 0 }),
    ]);
  });
});

describe('background transition alarm inventory', (): void => {
  it('plans no alarm before commit', (): void => {
    for (const stage of PRE_COMMIT_STAGES) {
      expectRejected([pendingTransition('start', stage, { alarmNames: ['phase'] })]);
    }
  });

  it('owns the single phase alarm for a committed timed session', (): void => {
    expectRejected([
      pendingTransition('start', 'committed-pending-verification', { alarmNames: [] }),
      pendingTransition('start', 'alarm-ready', { alarmNames: ['phase', 'phase'] }),
      pendingTransition('start', 'alarm-ready', { alarmNames: ['tick'] }),
      pendingTransition('start', 'alarm-ready', { alarmNames: ['transition-cleanup'] }),
      pendingTransition('start', 'alarm-ready', { alarmNames: ['phase', 'transition-cleanup'] }),
      withKey(pendingTransition('start', 'alarm-ready'), 'alarmNames', 'phase'),
      withKey(pendingTransition('start', 'alarm-ready'), 'alarmNames', sparseArray('phase')),
    ]);
  });

  it('owns no phase alarm for a committed indefinite start', (): void => {
    expectRejected([indefiniteStart('alarm-ready', { alarmNames: ['phase'] })]);
  });

  it('accepts either phase ownership for a resume that cannot see its durable duration', (): void => {
    expectAccepted([
      pendingTransition('resume', 'alarm-ready', { alarmNames: [] }),
      pendingTransition('resume', 'alarm-ready', { alarmNames: ['phase'] }),
    ]);
    expectRejected([
      pendingTransition('resume', 'alarm-ready', { alarmNames: ['phase', 'phase'] }),
      pendingTransition('resume', 'alarm-ready', { alarmNames: ['transition-cleanup'] }),
    ]);
  });

  it('keeps the retained inventory in cleanup', (): void => {
    expectRejected([
      cleanupTransition('start', 'prepared', 'start-abandon', { alarmNames: ['phase'] }),
      cleanupTransition('start', 'alarm-ready', 'manual-end', { alarmNames: [] }),
    ]);
  });
});

describe('background transition cleanup', (): void => {
  it('keeps every cleanup field null outside cleanup', (): void => {
    expectRejected([
      pendingTransition('start', 'prepared', { cleanupCause: 'start-abandon' }),
      pendingTransition('start', 'prepared', { cleanupFrom: 'prepared' }),
      pendingTransition('start', 'prepared', { cleanupProgress: cleanupProgress() }),
      pendingTransition('start', 'prepared', { postCleanupClosure: postCleanupClosure() }),
      pendingTransition('start', 'prepared', { failure: 'alarm-failed' }),
      pendingTransition('start', 'active-verified', { failure: 'tab-enforcement-failed' }),
    ]);
  });

  it('requires a complete cleanup row', (): void => {
    expectRejected([
      cleanupTransition('start', 'prepared', 'start-abandon', { cleanupFrom: null }),
      cleanupTransition('start', 'prepared', 'start-abandon', { cleanupCause: null }),
      cleanupTransition('start', 'prepared', 'start-abandon', { cleanupProgress: null }),
      withKey(cleanupTransition('start', 'prepared', 'start-abandon'), 'cleanupFrom', 'cleanup'),
      withKey(cleanupTransition('start', 'prepared', 'start-abandon'), 'cleanupCause', 'abandon'),
    ]);
  });

  it('pairs each cause with its legal kind and source stage', (): void => {
    expectRejected([
      cleanupTransition('resume', 'prepared', 'start-abandon'),
      cleanupTransition('start', 'prepared', 'resume-restore'),
      cleanupTransition('start', 'alarm-ready', 'start-abandon'),
      cleanupTransition('resume', 'active-verified', 'resume-restore'),
      cleanupTransition('start', 'prepared', 'manual-end'),
      cleanupTransition('start', 'starting-verified', 'transition-failed'),
      cleanupTransition('start', 'prepared', 'timer-completed'),
    ]);
  });

  it('records a failure only for a transition failure or an abandoned start', (): void => {
    expectRejected([
      cleanupTransition('start', 'active-verified', 'transition-failed', { failure: null }),
      cleanupTransition('start', 'alarm-ready', 'manual-end', { failure: 'alarm-failed' }),
      cleanupTransition('resume', 'prepared', 'resume-restore', {
        failure: 'content-registration-failed',
      }),
      cleanupTransition('start', 'alarm-ready', 'timer-completed', {
        failure: 'tab-enforcement-failed',
      }),
      withKey(cleanupTransition('start', 'prepared', 'start-abandon'), 'failure', 'lost'),
    ]);
  });

  it('closes a durable session exactly for the three closing causes', (): void => {
    expectRejected([
      cleanupTransition('start', 'alarm-ready', 'manual-end', { postCleanupClosure: null }),
      cleanupTransition('start', 'active-verified', 'transition-failed', {
        postCleanupClosure: null,
      }),
      cleanupTransition('resume', 'starting-verified', 'timer-completed', {
        postCleanupClosure: null,
      }),
      cleanupTransition('start', 'prepared', 'start-abandon', {
        postCleanupClosure: postCleanupClosure(),
      }),
      cleanupTransition('resume', 'prepared', 'resume-restore', {
        postCleanupClosure: postCleanupClosure(),
      }),
    ]);
  });

  it('closes the transition session and no other', (): void => {
    const otherEnd: SessionEndedEventV2 = sessionEndedEvent({
      sessionId: OTHER_SESSION_ID,
      eventId: `${OTHER_SESSION_ID}:end`,
    });

    expectRejected([
      cleanupTransition('start', 'alarm-ready', 'manual-end', {
        postCleanupClosure: postCleanupClosure({
          projection: closureProjection({
            closureId: `${OTHER_SESSION_ID}:close`,
            sessionId: OTHER_SESSION_ID,
            endEvent: otherEnd,
            events: [budgetEarnedEvent({ sessionId: OTHER_SESSION_ID }), otherEnd],
          }),
        }),
      }),
    ]);
  });

  it('clears the transition epoch and session identity', (): void => {
    expectRejected([
      cleanupTransition('start', 'alarm-ready', 'manual-end', {
        cleanupProgress: cleanupProgress({
          clearCommands: clearCommandMap({
            operationId: CLEANUP_OPERATION_ID,
            runtimeRevision: CLEAR_RUNTIME_REVISION,
            enforcementEpoch: OTHER_EPOCH_ID,
          }),
        }),
      }),
      cleanupTransition('start', 'alarm-ready', 'manual-end', {
        cleanupProgress: cleanupProgress({
          clearCommands: clearCommandMap({
            operationId: CLEANUP_OPERATION_ID,
            runtimeRevision: CLEAR_RUNTIME_REVISION,
            sessionId: OTHER_SESSION_ID,
          }),
        }),
      }),
      cleanupTransition('start', 'alarm-ready', 'manual-end', {
        cleanupProgress: cleanupProgress({
          clearCommands: clearCommandMap({
            operationId: CLEANUP_OPERATION_ID,
            runtimeRevision: CLEAR_RUNTIME_REVISION,
            sessionId: null,
            reservedSessionId: SESSION_ID,
          }),
        }),
      }),
      cleanupTransition('start', 'prepared', 'start-abandon', {
        cleanupProgress: cleanupProgress(),
      }),
    ]);
  });

  it('keeps historical views as evidence without comparing them to the clear revision', (): void => {
    expectAccepted([
      cleanupTransition('start', 'starting-verified', 'start-abandon', {
        startingView: startView({ runtimeRevision: CLEAR_RUNTIME_REVISION + 5 }),
      }),
      cleanupTransition('start', 'active-verified', 'timer-completed', {
        activeView: frozenActiveView('start', { runtimeRevision: CLEAR_RUNTIME_REVISION + 5 }),
      }),
    ]);
    expectRejected([
      cleanupTransition('start', 'active-verified', 'timer-completed', {
        startingView: startView({ runtimeRevision: START_ACTIVE_REVISION }),
      }),
    ]);
  });

  it('keeps the retained stage fields of its source stage', (): void => {
    expectRejected([
      cleanupTransition('start', 'prepared', 'start-abandon', { activationAt: ACTIVATION_AT }),
      cleanupTransition('start', 'starting-verified', 'start-abandon', {
        startingCheckpoint: null,
      }),
      cleanupTransition('start', 'alarm-ready', 'manual-end', { activationAt: null }),
      cleanupTransition('start', 'alarm-ready', 'manual-end', { activeView: null }),
      cleanupTransition('start', 'alarm-ready', 'manual-end', { freshnessAttempts: 4 }),
      cleanupTransition('start', 'active-verified', 'timer-completed', { checkpoint: null }),
      cleanupTransition('start', 'alarm-ready', 'manual-end', {
        checkpoint: transitionActiveCheckpoint('start'),
      }),
    ]);
  });
});

describe('background transition hostile input and detachment', (): void => {
  it('rejects hostile roots and nested journals', (): void => {
    expectRejected([
      new Proxy(pendingTransition('start', 'prepared'), {}),
      withKey(pendingTransition('start', 'prepared'), 'startingView', cyclicRecord()),
      withKey(
        pendingTransition('start', 'prepared'),
        'startingView',
        new Proxy(frozenStartingView('start'), {}),
      ),
      withKey(pendingTransition('start', 'prepared'), 'candidate', {
        ...manualCandidate(),
        [Symbol('extra')]: true,
      }),
      withKey(
        pendingTransition('start', 'alarm-ready'),
        'activeView',
        withKey(
          frozenActiveView('start'),
          'documents',
          new Proxy(frozenActiveView('start').documents, {}),
        ),
      ),
      cyclicRecord(),
      [pendingTransition('start', 'prepared')],
      null,
      undefined,
      'transition',
    ]);
  });

  it('rejects accessor properties without reading them', (): void => {
    let reads: number = 0;
    const accessorView: UnknownRecord = { ...frozenStartingView('start') };
    Object.defineProperty(accessorView, 'runtimeRevision', {
      configurable: true,
      enumerable: true,
      get: (): number => {
        reads += 1;
        return 0;
      },
    });

    expectRejected([withKey(pendingTransition('start', 'prepared'), 'startingView', accessorView)]);
    expect(reads).toBe(0);
  });

  it('rejects sparse and over-deep structures', (): void => {
    let deep: UnknownRecord = {};
    for (let level: number = 0; level < 200; level++) deep = { nested: deep };
    const checkpoint: ReturnType<typeof transitionStartingCheckpoint> =
      transitionStartingCheckpoint('start');

    expectRejected([
      withKey(pendingTransition('start', 'prepared'), 'alarmNames', sparseArray('phase')),
      withKey(pendingTransition('start', 'prepared'), 'candidate', deep),
      withKey(
        pendingTransition('start', 'starting-verified'),
        'startingCheckpoint',
        withKey(checkpoint, 'documents', sparseArray(checkpoint.documents[0])),
      ),
    ]);
  });

  it('detaches the parsed transition in both directions and keeps legal aliases', (): void => {
    const overlay: ReturnType<typeof startingOverlay> = startingOverlay();
    const source: PendingEnforcementTransition = pendingTransition('start', 'prepared', {
      startingView: startView({
        documents: {
          [documentKey(11, 'document-1')]: startingCommand({ overlay }),
          [documentKey(12, 'document-2')]: startingCommand({
            tabId: 12,
            documentId: 'document-2',
            expectedUrl: SECOND_TARGET_URL,
            overlay,
          }),
        },
      }),
    });
    const parsed: PendingEnforcementTransition = parsePendingEnforcementTransition(
      source,
    ) as PendingEnforcementTransition;
    const first: FrozenDocumentCommand = parsed.startingView.documents[
      documentKey(11, 'document-1')
    ] as FrozenDocumentCommand;
    const second: FrozenDocumentCommand = parsed.startingView.documents[
      documentKey(12, 'document-2')
    ] as FrozenDocumentCommand;

    expect(parsed).toEqual(source);
    expect(parsed.startingView).not.toBe(source.startingView);
    expect(first.overlay).toBe(second.overlay);
    source.startingView.capturedAt = REQUESTED_AT + 1;
    expect(parsed.startingView.capturedAt).toBe(REQUESTED_AT);
    parsed.alarmNames.push('phase');
    expect(source.alarmNames).toHaveLength(0);
  });

  it('accepts a transition with no targets and one with no blocked document', (): void => {
    expectAccepted([
      pendingTransition('start', 'prepared', {
        preparedTargetReservations: {},
        startingView: startView({ documents: {} }),
      }),
      pendingTransition('start', 'prepared', {
        startingView: startView({
          documents: startingCommandMap({ verdict: allowedVerdict(), overlay: null }),
        }),
      }),
    ]);
  });
});

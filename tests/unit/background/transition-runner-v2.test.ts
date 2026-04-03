import { describe, expect, it } from 'vitest';
import { PHASE_ALARM } from '../../../src/background/alarms-v2';
import type { FrozenDocumentCommand } from '../../../src/background/enforcement-persistence-v2';
import type { RuntimeCommitInputV2 } from '../../../src/background/runtime-checkpoint-v2';
import type {
  FrozenTransitionView,
  PendingEnforcementTransition,
  RuntimeStateV2,
  SessionStartCandidate,
} from '../../../src/background/runtime-v2-types';
import {
  driveTransitionV2,
  handleTransitionNavigationV2,
  type PreparedTransitionV2,
  prepareResumeTransitionV2,
  prepareStartTransitionV2,
  type TransitionDriveResultV2,
  transitionMatcherV2,
} from '../../../src/background/transition-runner-v2';
import { validateDetachedPendingEnforcementTransition } from '../../../src/background/transition-v2-validation';
import type { CompiledMatcher } from '../../../src/core/matcher';
import { MAX_FINAL_FRESHNESS_ATTEMPTS } from '../../../src/shared/constants';
import type {
  DocumentContentCommand,
  DocumentEnforcementCommand,
} from '../../../src/shared/enforcement-v2';
import { CoreError } from '../../../src/shared/errors';
import {
  appliedResponseFor,
  createRuntimePortsFakeV2,
  epochResetResponseFor,
  type FakeSendV2,
  type FakeTabRowV2,
  noReceiverResponder,
  type RuntimePortsFakeV2,
  silentResponder,
} from './runtime-ports-fake';
import {
  ACTIVE_OPERATION_ID,
  BASE_POLICY_REVISION,
  breakSession,
  CLEANUP_OPERATION_ID,
  candidateScheduleWindow,
  documentKey,
  EPOCH_ID,
  emptyRuntimeV2,
  manualCandidate,
  OTHER_OPERATION_ID,
  pausedSession,
  REQUESTED_AT,
  SESSION_ID,
  STARTING_OPERATION_ID,
  scheduleCandidate,
  scheduleOccurrence,
  sessionConfigV2,
  TRANSITION_ID,
  untilStoppedCandidate,
} from './runtime-v2-fixtures';

/** The four IDs preparation reserves, in the order the runner allocates them. */
const IDS: readonly string[] = [
  SESSION_ID,
  TRANSITION_ID,
  STARTING_OPERATION_ID,
  ACTIVE_OPERATION_ID,
];
const TAB_URL: string = 'https://facebook.com/feed';
const OTHER_URL: string = 'https://news.example.com/story';
const DOC_ONE: string = 'document-11';
const DOC_TWO: string = 'document-12';

function seedRuntime(overrides: Partial<RuntimeStateV2> = {}): RuntimeStateV2 {
  return emptyRuntimeV2({ runtimeRevision: 0, ...overrides });
}

function fakeFor(
  runtime: RuntimeStateV2,
  options: Parameters<typeof createRuntimePortsFakeV2>[1] = {},
): RuntimePortsFakeV2 {
  return createRuntimePortsFakeV2(runtime, {
    now: REQUESTED_AT,
    ids: [...IDS, CLEANUP_OPERATION_ID, OTHER_OPERATION_ID],
    tabs: [
      { tabId: 11, url: TAB_URL, documentId: DOC_ONE },
      { tabId: 12, url: OTHER_URL, documentId: DOC_TWO },
    ],
    ...options,
  });
}

/** The stage progression with the repeats that per-acknowledgement writes legitimately add. */
function distinctStages(fake: RuntimePortsFakeV2): Array<string | null> {
  return fake
    .stages()
    .filter(
      (stage: string | null, index: number, all: Array<string | null>): boolean =>
        index === 0 || all[index - 1] !== stage,
    );
}

/** The durable transition after the last write, which every stage assertion reads. */
function storedTransition(fake: RuntimePortsFakeV2): PendingEnforcementTransition {
  const transition: PendingEnforcementTransition | null =
    fake.current().pendingEnforcementTransition;
  expect(transition).not.toBeNull();
  if (transition === null) throw new Error('expected a durable transition');
  expect(validateDetachedPendingEnforcementTransition(structuredClone(transition))).toBe(true);
  return transition;
}

describe('prepareStartTransitionV2', (): void => {
  it('validates the candidate and compiles the matcher before any write', async (): Promise<void> => {
    const invalid: readonly SessionStartCandidate[] = [
      untilStoppedCandidate({ strictness: 'friction' }),
      manualCandidate({ scheduleOccurrence: scheduleOccurrence() }),
      scheduleCandidate({ scheduleWindow: null }),
    ];

    for (const candidate of invalid) {
      const fake: RuntimePortsFakeV2 = fakeFor(seedRuntime());
      await expect(prepareStartTransitionV2(fake, candidate, 'manual')).rejects.toThrow(CoreError);
      expect(fake.writes).toHaveLength(0);
      expect(fake.sends).toHaveLength(0);
      expect(fake.auditCalls).toBe(0);
    }
  });

  it('reserves four identities and freezes the starting view in one write', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(seedRuntime());
    const prepared: PreparedTransitionV2 = await prepareStartTransitionV2(
      fake,
      manualCandidate(),
      'manual',
    );
    const transition: PendingEnforcementTransition = storedTransition(fake);

    expect(fake.writes).toHaveLength(1);
    expect(transition.stage).toBe('prepared');
    expect(transition.kind).toBe('start');
    expect(transition.sessionId).toBe(SESSION_ID);
    expect(transition.transitionId).toBe(TRANSITION_ID);
    expect(transition.startingOperationId).toBe(STARTING_OPERATION_ID);
    expect(transition.activeOperationId).toBe(ACTIVE_OPERATION_ID);
    expect(transition.enforcementEpoch).toBe(EPOCH_ID);
    expect(transition.basePolicyRevision).toBe(BASE_POLICY_REVISION + 1);
    expect(transition.runtimeRevision).toBe(0);
    expect(transition.trigger).toBe('manual');
    expect(transition.requestedAt).toBe(REQUESTED_AT);
    expect(transition.priorPhase).toBeNull();
    expect(transition.activationAt).toBeNull();
    expect(transition.verificationStartedAt).toBeNull();
    expect(transition.freshnessAttempts).toBe(0);
    expect(transition.activeView).toBeNull();
    expect(transition.startingCheckpoint).toBeNull();
    expect(transition.checkpoint).toBeNull();
    expect(transition.alarmNames).toEqual([]);
    expect(transition.cleanupProgress).toBeNull();
    expect(transition.cleanupFrom).toBeNull();
    expect(transition.cleanupCause).toBeNull();
    expect(transition.postCleanupClosure).toBeNull();
    expect(transition.startingView.capturedAt).toBe(REQUESTED_AT);
    expect(transition.startingView.runtimeRevision).toBe(0);
    expect(Object.keys(transition.startingView.documents).sort()).toEqual([
      documentKey(11, DOC_ONE),
      documentKey(12, DOC_TWO),
    ]);
    expect(fake.current().documentCommands).toEqual(transition.startingView.documents);
    expect(fake.current().runtimeRevision).toBe(0);
    expect(prepared.runtime).toEqual(fake.current());
    expect(fake.sends).toHaveLength(0);
    expect(fake.auditCalls).toBe(0);
    expect(fake.alarmCalls).toHaveLength(0);
  });

  it('freezes a starting overlay for a blocked target and none for an allowed one', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(seedRuntime());
    await prepareStartTransitionV2(fake, manualCandidate(), 'manual');
    const documents: Record<string, FrozenDocumentCommand> =
      storedTransition(fake).startingView.documents;
    const blocked: FrozenDocumentCommand | undefined = documents[documentKey(11, DOC_ONE)];
    const allowed: FrozenDocumentCommand | undefined = documents[documentKey(12, DOC_TWO)];

    expect(blocked?.presentation).toBe('starting');
    expect(blocked?.verdict.blocked).toBe(true);
    expect(blocked?.overlay).not.toBeNull();
    expect(blocked?.reservedSessionId).toBe(SESSION_ID);
    expect(blocked?.sessionId).toBeNull();
    expect(allowed?.verdict.blocked).toBe(false);
    expect(allowed?.overlay).toBeNull();
  });

  it('refuses to prepare over a session or a journal', async (): Promise<void> => {
    const withSession: RuntimePortsFakeV2 = fakeFor(
      seedRuntime({
        session: pausedSession(),
        basePolicyRevision: BASE_POLICY_REVISION,
      }),
    );

    await expect(
      prepareStartTransitionV2(withSession, manualCandidate(), 'manual'),
    ).rejects.toThrow(CoreError);
    expect(withSession.writes).toHaveLength(0);
  });
});

describe('prepareResumeTransitionV2', (): void => {
  it('keeps the epoch and base revision and reserves the next runtime revision', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(
      seedRuntime({ session: pausedSession(), runtimeRevision: 7 }),
    );
    await prepareResumeTransitionV2(fake, 'pause-expired');
    const transition: PendingEnforcementTransition = storedTransition(fake);

    expect(transition.kind).toBe('resume');
    expect(transition.stage).toBe('prepared');
    expect(transition.candidate).toBeNull();
    expect(transition.priorPhase).toBe('paused');
    expect(transition.sessionId).toBe(SESSION_ID);
    expect(transition.enforcementEpoch).toBe(EPOCH_ID);
    expect(transition.basePolicyRevision).toBe(BASE_POLICY_REVISION);
    expect(transition.runtimeRevision).toBe(8);
    expect(transition.startingView.runtimeRevision).toBe(8);
    expect(fake.current().runtimeRevision).toBe(8);
  });

  it('resumes a break only from a break-expired trigger', async (): Promise<void> => {
    const onBreak: RuntimePortsFakeV2 = fakeFor(
      seedRuntime({ session: breakSession(), runtimeRevision: 7 }),
    );
    await prepareResumeTransitionV2(onBreak, 'break-expired');
    expect(storedTransition(onBreak).priorPhase).toBe('break');

    const mismatched: RuntimePortsFakeV2 = fakeFor(
      seedRuntime({ session: pausedSession(), runtimeRevision: 7 }),
    );
    await expect(prepareResumeTransitionV2(mismatched, 'break-expired')).rejects.toThrow(CoreError);
    expect(mismatched.writes).toHaveLength(0);
  });

  it('refuses to resume without a durable non-blocking session', async (): Promise<void> => {
    const idle: RuntimePortsFakeV2 = fakeFor(seedRuntime());
    await expect(prepareResumeTransitionV2(idle, 'pause-expired')).rejects.toThrow(CoreError);
    expect(idle.writes).toHaveLength(0);
  });
});

describe('driveTransitionV2 start sequence', (): void => {
  async function preparedStart(
    candidate: SessionStartCandidate = manualCandidate(),
    trigger: 'manual' | 'schedule' = 'manual',
    options: Parameters<typeof createRuntimePortsFakeV2>[1] = {},
  ): Promise<{ fake: RuntimePortsFakeV2; prepared: PreparedTransitionV2 }> {
    const fake: RuntimePortsFakeV2 = fakeFor(seedRuntime(), options);
    const prepared: PreparedTransitionV2 = await prepareStartTransitionV2(fake, candidate, trigger);
    return { fake, prepared };
  }

  it('walks every stage to publication and returns the published runtime', async (): Promise<void> => {
    const { fake, prepared } = await preparedStart();
    const result: TransitionDriveResultV2 = await driveTransitionV2(fake, prepared.matcher);

    expect(result.kind).toBe('published');
    expect(distinctStages(fake)).toEqual([
      'prepared',
      'registration-audited',
      'starting-verified',
      'committed-pending-verification',
      'alarm-ready',
      'active-verified',
      null,
    ]);
    expect(fake.auditCalls).toBe(1);
    const published: RuntimeStateV2 = fake.current();
    expect(published.pendingEnforcementTransition).toBeNull();
    expect(published.session?.sessionId).toBe(SESSION_ID);
    expect(published.enforcementCheckpoint?.operationId).toBe(ACTIVE_OPERATION_ID);
    expect(published.enforcementCheckpoint?.kind).toBe('activation');
    expect(published.enforcementCheckpoint?.sessionId).toBe(SESSION_ID);
    expect(published.basePolicyRevision).toBe(BASE_POLICY_REVISION + 1);
  });

  it('commits the session, start event, aggregate, and frozen active view together', async (): Promise<void> => {
    const { fake, prepared } = await preparedStart();
    await driveTransitionV2(fake, prepared.matcher);
    const commit: RuntimeCommitInputV2 | undefined = fake.commits[0];

    expect(commit).toBeDefined();
    expect(commit?.projection.session?.sessionId).toBe(SESSION_ID);
    expect(commit?.projection.enforcementCheckpoint).toBeNull();
    expect(commit?.events.some((event): boolean => event.t === 'sessionStarted')).toBe(true);
    expect(Object.keys(commit?.aggregateSets ?? {})).toHaveLength(1);
    const transition: PendingEnforcementTransition | null | undefined =
      commit?.projection.pendingEnforcementTransition;
    expect(transition?.stage).toBe('committed-pending-verification');
    expect(transition?.activationAt).not.toBeNull();
    expect(transition?.verificationStartedAt).toBe(transition?.activationAt);
    expect(transition?.freshnessAttempts).toBe(0);
    expect(transition?.alarmNames).toEqual([PHASE_ALARM]);
    expect(transition?.activeView?.capturedAt).toBe(transition?.activationAt);
  });

  it('plans no phase alarm for an indefinite start', async (): Promise<void> => {
    const { fake, prepared } = await preparedStart(untilStoppedCandidate());
    await driveTransitionV2(fake, prepared.matcher);

    expect(fake.commits[0]?.projection.pendingEnforcementTransition?.alarmNames).toEqual([]);
    expect(fake.current().session?.sessionEndsAt).toBeNull();
    expect(fake.current().session?.phaseEndsAt).toBeNull();
  });

  it('sends no active command before the session commit', async (): Promise<void> => {
    const { fake, prepared } = await preparedStart();
    await driveTransitionV2(fake, prepared.matcher);
    const firstActive: number = fake.sends.findIndex(
      (send): boolean =>
        send.message.command === 'apply-enforcement' && send.message.presentation === 'active',
    );
    const startingSends: number = fake.sends.filter(
      (send): boolean =>
        send.message.command === 'apply-enforcement' && send.message.presentation === 'starting',
    ).length;

    expect(startingSends).toBeGreaterThan(0);
    expect(firstActive).toBeGreaterThan(0);
  });

  it('resets an unacknowledged target before its first enforcement command', async (): Promise<void> => {
    const { fake, prepared } = await preparedStart();
    await driveTransitionV2(fake, prepared.matcher);
    const firstReset: number = fake.sends.findIndex(
      (send): boolean => send.message.command === 'reset-enforcement-epoch',
    );
    const firstEnforcement: number = fake.sends.findIndex(
      (send): boolean => send.message.command === 'apply-enforcement',
    );

    expect(firstReset).toBe(0);
    expect(firstReset).toBeLessThan(firstEnforcement);
    expect(Object.keys(fake.current().epochResetAcks).length).toBeGreaterThan(0);
  });

  it('enters reservation-release cleanup when the audit fails', async (): Promise<void> => {
    for (const audit of ['website-access-lost', 'content-registration-failed'] as const) {
      const { fake, prepared } = await preparedStart(manualCandidate(), 'manual', { audit });
      const result: TransitionDriveResultV2 = await driveTransitionV2(fake, prepared.matcher);
      const transition: PendingEnforcementTransition = storedTransition(fake);

      expect(result.kind).toBe('cleanup');
      expect(transition.stage).toBe('cleanup');
      expect(transition.cleanupCause).toBe('start-abandon');
      expect(transition.cleanupFrom).toBe('prepared');
      expect(transition.failure).toBe(audit);
      expect(fake.current().session).toBeNull();
      expect(fake.sends).toHaveLength(0);
    }
  });

  it('abandons a scheduled start whose captured window has closed', async (): Promise<void> => {
    const closed: SessionStartCandidate = scheduleCandidate({
      scheduleWindow: candidateScheduleWindow({
        windowStartsAt: REQUESTED_AT - 120_000,
        windowEndsAt: REQUESTED_AT - 60_000,
      }),
    });
    const { fake, prepared } = await preparedStart(closed, 'schedule');
    const result: TransitionDriveResultV2 = await driveTransitionV2(fake, prepared.matcher);

    expect(result.kind).toBe('cleanup');
    expect(storedTransition(fake).cleanupCause).toBe('start-abandon');
    expect(fake.current().session).toBeNull();
    expect(fake.commits).toHaveLength(0);
    expect(fake.current().handledScheduleOccurrences).toEqual([]);
  });

  it('abandons a start whose starting sweep cannot reach a target', async (): Promise<void> => {
    const { fake, prepared } = await preparedStart();
    fake.respondForDocument(11, DOC_ONE, noReceiverResponder());
    const result: TransitionDriveResultV2 = await driveTransitionV2(fake, prepared.matcher);

    expect(result.kind).toBe('cleanup');
    expect(storedTransition(fake).cleanupCause).toBe('start-abandon');
    expect(storedTransition(fake).failure).toBe('tab-enforcement-failed');
  });

  it('treats a starting mismatch as an enforcement failure rather than ignoring it', async (): Promise<void> => {
    const { fake, prepared } = await preparedStart();
    fake.respondForDocument(11, DOC_ONE, silentResponder());
    const result: TransitionDriveResultV2 = await driveTransitionV2(fake, prepared.matcher);

    expect(result.kind).toBe('cleanup');
    expect(storedTransition(fake).failure).toBe('tab-enforcement-failed');
  });

  it('closes the session when the phase alarm cannot be read back', async (): Promise<void> => {
    const { fake, prepared } = await preparedStart(manualCandidate(), 'manual', {
      alarmReadBack: 'missing',
    });
    const result: TransitionDriveResultV2 = await driveTransitionV2(fake, prepared.matcher);
    const transition: PendingEnforcementTransition = storedTransition(fake);

    expect(result.kind).toBe('cleanup');
    expect(transition.cleanupCause).toBe('transition-failed');
    expect(transition.failure).toBe('alarm-failed');
    expect(transition.cleanupFrom).toBe('committed-pending-verification');
    expect(transition.postCleanupClosure?.projection.reason).toBe('alarm-failed');
  });

  it('captures timer completion when the fixed end arrives after the alarm read-back', async (): Promise<void> => {
    // The clock moves while the phase alarm is created, so the fixed end has passed by the time
    // the runner rechecks it, which is the ordering the start sequence's step 9 describes.
    const fake: RuntimePortsFakeV2 = fakeFor(seedRuntime(), {
      onAlarmCreate: (): void => fake.advance(180_000),
    });
    const prepared: PreparedTransitionV2 = await prepareStartTransitionV2(
      fake,
      manualCandidate({ duration: { kind: 'manual-timed', minutes: 1 } }),
      'manual',
    );
    const result: TransitionDriveResultV2 = await driveTransitionV2(fake, prepared.matcher);
    const transition: PendingEnforcementTransition = storedTransition(fake);

    expect(result.kind).toBe('cleanup');
    expect(transition.cleanupCause).toBe('timer-completed');
    expect(transition.postCleanupClosure?.projection.reason).toBe('timer-completed');
  });

  it('increments the freshness attempt before each attempt and retries a generation change', async (): Promise<void> => {
    const { fake, prepared } = await preparedStart();
    let changes: number = 0;
    fake.respondForOperation(ACTIVE_OPERATION_ID, (message): unknown => {
      if (changes < 1) {
        changes += 1;
        fake.bumpGeneration();
      }
      return appliedResponseFor(message, fake.now());
    });
    const result: TransitionDriveResultV2 = await driveTransitionV2(fake, prepared.matcher);
    const attempts: number[] = fake.writes
      .map(
        (runtime): number | null => runtime.pendingEnforcementTransition?.freshnessAttempts ?? null,
      )
      .filter((value): value is number => value !== null);

    expect(result.kind).toBe('published');
    expect(Math.max(...attempts)).toBeGreaterThanOrEqual(2);
  });

  it('publishes when the generation settles before the budget runs out', async (): Promise<void> => {
    // The other half of the budget rule: a run that stops moving under the limit publishes and
    // spends no more passes than it needed. The exhaustion case below counts the limit itself.
    const { fake, prepared } = await preparedStart();
    let bumps: number = 0;
    fake.respondForOperation(ACTIVE_OPERATION_ID, (message): unknown => {
      if (bumps < 2) {
        bumps += 1;
        fake.bumpGeneration();
      }
      return appliedResponseFor(message, fake.now());
    });

    const result: TransitionDriveResultV2 = await driveTransitionV2(fake, prepared.matcher);
    const attempts: number[] = fake.writes
      .map(
        (runtime): number | null => runtime.pendingEnforcementTransition?.freshnessAttempts ?? null,
      )
      .filter((value): value is number => value !== null);

    expect(result.kind).toBe('published');
    expect(Math.max(...attempts)).toBeLessThan(MAX_FINAL_FRESHNESS_ATTEMPTS);
  });

  it('closes the session when the freshness budget is exhausted', async (): Promise<void> => {
    const { fake, prepared } = await preparedStart();
    fake.respondForOperation(ACTIVE_OPERATION_ID, (message): unknown => {
      fake.bumpGeneration();
      return appliedResponseFor(message, fake.now());
    });
    const result: TransitionDriveResultV2 = await driveTransitionV2(fake, prepared.matcher);
    const attempts: number[] = fake.writes
      .map(
        (runtime): number | null => runtime.pendingEnforcementTransition?.freshnessAttempts ?? null,
      )
      .filter((value): value is number => value !== null);
    const passes: number[] = [...new Set<number>(attempts)].filter(
      (value: number): boolean => value > 0,
    );
    const transition: PendingEnforcementTransition = storedTransition(fake);

    // Counted rather than derived, so nobody has to reason it out again. Each pass writes its own
    // incremented number before it runs, so the numbers written are the passes: 1, 2, 3, and the
    // fourth is refused. Fewer than three would mean the budget spends an attempt it never used.
    expect(passes).toEqual([1, 2, 3]);
    expect(passes).toHaveLength(MAX_FINAL_FRESHNESS_ATTEMPTS);
    expect(result.kind).toBe('cleanup');
    expect(transition.cleanupCause).toBe('transition-failed');
    expect(transition.failure).toBe('tab-enforcement-failed');
    expect(transition.postCleanupClosure?.projection.reason).toBe('tab-enforcement-failed');
  });
});

describe('driveTransitionV2 resume sequence', (): void => {
  async function preparedResume(
    session = pausedSession(),
    trigger: 'manual' | 'pause-expired' | 'break-expired' = 'pause-expired',
  ): Promise<{ fake: RuntimePortsFakeV2; prepared: PreparedTransitionV2 }> {
    const fake: RuntimePortsFakeV2 = fakeFor(seedRuntime({ session, runtimeRevision: 7 }));
    const prepared: PreparedTransitionV2 = await prepareResumeTransitionV2(fake, trigger);
    return { fake, prepared };
  }

  it('commits the resumed focus phase and publishes', async (): Promise<void> => {
    const { fake, prepared } = await preparedResume();
    const result: TransitionDriveResultV2 = await driveTransitionV2(fake, prepared.matcher);
    const commit: RuntimeCommitInputV2 | undefined = fake.commits[0];

    expect(result.kind).toBe('published');
    expect(distinctStages(fake)).toEqual([
      'prepared',
      'registration-audited',
      'starting-verified',
      'committed-pending-verification',
      'alarm-ready',
      'active-verified',
      null,
    ]);
    expect(commit?.projection.session?.phase).toBe('focus');
    expect(commit?.events.some((event): boolean => event.t === 'phase')).toBe(true);
    expect(fake.current().session?.sessionId).toBe(SESSION_ID);
    expect(fake.current().enforcementCheckpoint?.kind).toBe('resume-strengthening');
  });

  it('keeps the fixed session end and creates the phase alarm', async (): Promise<void> => {
    const { fake, prepared } = await preparedResume();
    const before: number | null = fake.current().session?.sessionEndsAt ?? null;
    await driveTransitionV2(fake, prepared.matcher);

    expect(fake.current().session?.sessionEndsAt).toBe(before);
    expect(fake.alarmCalls.some((call): boolean => call.name === PHASE_ALARM)).toBe(true);
  });

  it('completes a resume whose fixed end has already arrived instead of committing', async (): Promise<void> => {
    const { fake, prepared } = await preparedResume();
    const endsAt: number = fake.current().session?.sessionEndsAt ?? 0;
    fake.setNow(endsAt + 1_000);
    const result: TransitionDriveResultV2 = await driveTransitionV2(fake, prepared.matcher);
    const transition: PendingEnforcementTransition = storedTransition(fake);

    expect(result.kind).toBe('cleanup');
    expect(transition.cleanupCause).toBe('timer-completed');
    expect(transition.postCleanupClosure?.projection.endedAt).toBe(endsAt);
    expect(fake.commits).toHaveLength(0);
  });

  it('restores a pre-commit resume with a null failure when enforcement fails', async (): Promise<void> => {
    const { fake, prepared } = await preparedResume();
    fake.respondForDocument(11, DOC_ONE, noReceiverResponder());
    const result: TransitionDriveResultV2 = await driveTransitionV2(fake, prepared.matcher);
    const transition: PendingEnforcementTransition = storedTransition(fake);

    expect(result.kind).toBe('cleanup');
    expect(transition.cleanupCause).toBe('resume-restore');
    expect(transition.failure).toBeNull();
    expect(fake.current().session?.phase).toBe('paused');
  });

  it('plans no phase alarm for an indefinite resume', async (): Promise<void> => {
    const indefinite = pausedSession({
      config: sessionConfigV2({
        strictness: 'flexible',
        duration: { kind: 'until-stopped' },
      }),
      sessionEndsAt: null,
      pausedFrom: { phase: 'focus', phaseEndsAt: null },
    });
    const { fake, prepared } = await preparedResume(indefinite);
    await driveTransitionV2(fake, prepared.matcher);

    expect(fake.commits[0]?.projection.pendingEnforcementTransition?.alarmNames).toEqual([]);
    expect(fake.current().session?.sessionEndsAt).toBeNull();
  });
});

describe('handleTransitionNavigationV2', (): void => {
  it('queues a reservation at prepared without sending anything', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(seedRuntime());
    const prepared: PreparedTransitionV2 = await prepareStartTransitionV2(
      fake,
      manualCandidate(),
      'manual',
    );
    // The tabs adapter advances the generation on the navigation itself, and the runner records
    // that value into the transition it persists.
    const before: number = fake.targets.readTargetGeneration();
    fake.bumpGeneration();
    await handleTransitionNavigationV2(fake, prepared.matcher, {
      tabId: 13,
      documentId: 'document-13',
      url: 'https://late.example.com/',
    });
    const transition: PendingEnforcementTransition = storedTransition(fake);
    const key: string = documentKey(13, 'document-13');

    expect(transition.targetGeneration).toBe(before + 1);
    expect(transition.preparedTargetReservations[key]?.commandKey).toBe(key);
    expect(transition.startingView.documents[key]).toBeDefined();
    expect(fake.sends).toHaveLength(0);
  });

  it('ignores a target outside the enforceable set and rejects a blank document', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(seedRuntime());
    const prepared: PreparedTransitionV2 = await prepareStartTransitionV2(
      fake,
      manualCandidate(),
      'manual',
    );
    const writes: number = fake.writes.length;

    await handleTransitionNavigationV2(fake, prepared.matcher, {
      tabId: 14,
      documentId: 'document-14',
      url: 'chrome://settings',
    });
    expect(fake.writes).toHaveLength(writes);
    await expect(
      handleTransitionNavigationV2(fake, prepared.matcher, {
        tabId: 15,
        documentId: '  ',
        url: 'https://blank.example.com/',
      }),
    ).rejects.toThrow(CoreError);
    expect(fake.writes).toHaveLength(writes);
  });
});

describe('transitionMatcherV2', (): void => {
  it('recompiles from the durable candidate and from a durable session', async (): Promise<void> => {
    const start: RuntimePortsFakeV2 = fakeFor(seedRuntime());
    await prepareStartTransitionV2(start, manualCandidate(), 'manual');
    expect(transitionMatcherV2(start)).toBeDefined();

    const resume: RuntimePortsFakeV2 = fakeFor(
      seedRuntime({ session: pausedSession(), runtimeRevision: 7 }),
    );
    await prepareResumeTransitionV2(resume, 'pause-expired');
    expect(transitionMatcherV2(resume)).toBeDefined();
  });

  it('throws when no durable transition explains what to compile', (): void => {
    const fake: RuntimePortsFakeV2 = fakeFor(seedRuntime());
    expect((): unknown => transitionMatcherV2(fake)).toThrow(CoreError);
  });
});

describe('driveTransitionV2 restart recovery', (): void => {
  it('continues a committed transition from its durable stage with the original identities', async (): Promise<void> => {
    const first: RuntimePortsFakeV2 = fakeFor(seedRuntime());
    const prepared: PreparedTransitionV2 = await prepareStartTransitionV2(
      first,
      manualCandidate(),
      'manual',
    );
    first.setAlarmReadBack('missing');
    await driveTransitionV2(first, prepared.matcher).catch((): void => undefined);
    const committed: RuntimeStateV2 | undefined = first.writes.find(
      (runtime): boolean =>
        runtime.pendingEnforcementTransition?.stage === 'committed-pending-verification',
    );
    expect(committed).toBeDefined();
    if (committed === undefined) throw new Error('expected a committed write');

    const restarted: RuntimePortsFakeV2 = fakeFor(committed, { ids: [CLEANUP_OPERATION_ID] });
    const before: PendingEnforcementTransition =
      committed.pendingEnforcementTransition as PendingEnforcementTransition;
    const result: TransitionDriveResultV2 = await driveTransitionV2(
      restarted,
      transitionMatcherV2(restarted),
    );
    const after: RuntimeStateV2 = restarted.current();

    expect(result.kind).toBe('published');
    expect(after.enforcementCheckpoint?.operationId).toBe(before.activeOperationId);
    expect(after.enforcementCheckpoint?.enforcementEpoch).toBe(before.enforcementEpoch);
    expect(after.basePolicyRevision).toBe(before.basePolicyRevision);
    expect(after.session?.startedAt).toBe(before.activationAt);
    const replayed: DocumentEnforcementCommand | undefined = restarted.sends
      .map((send): DocumentContentCommand => send.message)
      .filter(
        (message): message is DocumentEnforcementCommand => message.command === 'apply-enforcement',
      )
      .find((message): boolean => message.presentation === 'active');
    expect(replayed?.runtimeRevision).toBe(before.activeView?.runtimeRevision);
  });
});

describe('driveTransitionV2 concurrent navigation', (): void => {
  const LATE_URL: string = 'https://instagram.com/explore';
  const LATE_DOC: string = 'document-13';
  const LATE_KEY: string = documentKey(13, LATE_DOC);
  const GROWN: readonly FakeTabRowV2[] = [
    { tabId: 11, url: TAB_URL, documentId: DOC_ONE },
    { tabId: 12, url: OTHER_URL, documentId: DOC_TWO },
    { tabId: 13, url: LATE_URL, documentId: LATE_DOC },
  ];

  /**
   * Lands one navigation write while the named stage is awaiting a port, which is the interleaving
   * each stage's reread exists to survive.
   */
  function navigateDuring(
    stage: string,
    ports: () => RuntimePortsFakeV2,
    matcher: () => CompiledMatcher,
  ): () => Promise<void> {
    let done: boolean = false;
    return async (): Promise<void> => {
      if (done || ports().current().pendingEnforcementTransition?.stage !== stage) return;
      done = true;
      ports().setTabs(GROWN);
      ports().bumpGeneration();
      await handleTransitionNavigationV2(ports(), matcher(), {
        tabId: 13,
        documentId: LATE_DOC,
        url: LATE_URL,
      });
    };
  }

  /**
   * The third column is whether the starting view must also carry the late document, which depends
   * on whether that view was still being written when the navigation landed. It is measured
   * rather than assumed: a navigation arriving at `committed-pending-verification` reaches only
   * the active view, because the starting view was frozen before it existed. Asserting both views
   * everywhere would be false, and asserting either view anywhere is the weakness these cases had.
   */
  it.each([
    ['prepared', 'onAudit', true],
    ['starting-verified', 'onQueryTabs', true],
    ['starting-verified', 'onLoadAggregates', true],
    ['committed-pending-verification', 'onAlarmCreate', false],
  ])(
    'enforces a navigation that landed while %s was awaiting %s',
    async (stage: string, hook: string, startingViewCarries: boolean): Promise<void> => {
      let ports: RuntimePortsFakeV2 | null = null;
      let compiled: CompiledMatcher | null = null;
      const navigate: () => Promise<void> = navigateDuring(
        stage,
        (): RuntimePortsFakeV2 => ports as RuntimePortsFakeV2,
        (): CompiledMatcher => compiled as CompiledMatcher,
      );
      ports = fakeFor(seedRuntime(), {
        ids: [...IDS, CLEANUP_OPERATION_ID, OTHER_OPERATION_ID],
        [hook]: navigate,
      });
      const prepared: PreparedTransitionV2 = await prepareStartTransitionV2(
        ports,
        manualCandidate(),
        'manual',
      );
      compiled = prepared.matcher;
      const result: TransitionDriveResultV2 = await driveTransitionV2(ports, prepared.matcher);
      const revisions: number[] = ports.writes.map(
        (runtime: RuntimeStateV2): number => runtime.runtimeRevision,
      );

      expect(result.kind).toBe('published');

      // The requirement. A navigation that lands mid-transition has to end up enforced, and
      // neither half of that was asserted before: the loop below skips the publishing write,
      // which is the only one that shows the document reaching publication, and nothing looked at
      // what was sent. The published runtime is the authority a restarted worker reads back.
      expect(Object.keys(result.runtime.documentCommands)).toContain(LATE_KEY);
      expect(result.runtime.pendingEnforcementTransition).toBeNull();

      const lateCommands: string[] = ports.sends
        .filter((send: FakeSendV2): boolean => send.tabId === 13 && send.documentId === LATE_DOC)
        .map((send: FakeSendV2): string => send.message.command);
      expect(lateCommands).toContain('reset-enforcement-epoch');
      expect(lateCommands).toContain('apply-enforcement');

      // Once a frozen view carries the document, no later write of that same view may drop it.
      // Checking the two views separately is what catches a stage writing one of them from a
      // stale snapshot while the other happens to carry the document anyway.
      let seenStarting: boolean = false;
      let seenActive: boolean = false;
      for (const runtime of ports.writes) {
        const journal: PendingEnforcementTransition | null = runtime.pendingEnforcementTransition;
        if (journal === null) continue;
        const inStarting: boolean = journal.startingView.documents[LATE_KEY] !== undefined;
        const inActive: boolean = journal.activeView?.documents[LATE_KEY] !== undefined;
        if (seenStarting) expect(inStarting).toBe(true);
        if (seenActive && journal.activeView !== null) expect(inActive).toBe(true);
        seenStarting = seenStarting || inStarting;
        seenActive = seenActive || inActive;
      }
      // The active view is what publication is built from, so it carries the document in every
      // case. The starting view carries it only while it is still being written, which is why the
      // expectation is a parameter rather than a constant.
      expect(seenActive).toBe(true);
      expect(seenStarting).toBe(startingViewCarries);
      for (let index: number = 1; index < revisions.length; index++) {
        expect(revisions[index] ?? 0).toBeGreaterThanOrEqual(revisions[index - 1] ?? 0);
      }
    },
  );

  it('advances the revision and persists a replacement view for a document found mid-sweep', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(seedRuntime());
    const prepared: PreparedTransitionV2 = await prepareStartTransitionV2(
      fake,
      manualCandidate(),
      'manual',
    );
    const before: PendingEnforcementTransition = storedTransition(fake);
    const baseRevision: number = before.startingView.runtimeRevision;
    const existing: readonly string[] = Object.keys(before.startingView.documents);
    // The first enumeration of the audited sweep sees a third tab, so its document is new to the
    // frozen view and must be persisted under a higher revision before anything is sent to it.
    const grown: readonly FakeTabRowV2[] = [
      { tabId: 11, url: TAB_URL, documentId: DOC_ONE },
      { tabId: 12, url: OTHER_URL, documentId: DOC_TWO },
      { tabId: 13, url: LATE_URL, documentId: LATE_DOC },
    ];
    fake.scriptTabSets([grown]);
    fake.setTabs(grown);
    let writesWhenSent: number | null = null;
    fake.respondForDocument(13, LATE_DOC, (message): unknown => {
      // The epoch handshake precedes the frozen command, so only the enforcement send is timed.
      if (message.command !== 'apply-enforcement')
        return epochResetResponseFor(message, fake.now());
      if (writesWhenSent === null) writesWhenSent = fake.writes.length;
      return appliedResponseFor(message, fake.now());
    });
    const result: TransitionDriveResultV2 = await driveTransitionV2(fake, prepared.matcher);
    const key: string = documentKey(13, LATE_DOC);
    const replacement: RuntimeStateV2 | undefined = fake.writes.find(
      (runtime: RuntimeStateV2): boolean =>
        runtime.pendingEnforcementTransition?.startingView.documents[key] !== undefined,
    );
    const view: FrozenTransitionView | undefined =
      replacement?.pendingEnforcementTransition?.startingView;

    expect(result.kind).toBe('published');
    expect(view?.runtimeRevision).toBe(baseRevision + 1);
    for (const existingKey of existing) {
      expect(view?.documents[existingKey]?.runtimeRevision).toBe(baseRevision + 1);
    }
    expect(replacement?.documentCommands).toEqual(view?.documents);
    expect(replacement?.runtimeRevision).toBe(baseRevision + 1);
    // The replacement view must be durable before the new document hears anything, so the write
    // count observed at send time has to be past the write that added it.
    const writeIndex: number = fake.writes.indexOf(replacement as RuntimeStateV2);
    expect(writeIndex).toBeGreaterThanOrEqual(0);
    expect(writesWhenSent).not.toBeNull();
    expect(writesWhenSent ?? 0).toBeGreaterThan(writeIndex);
  });
});

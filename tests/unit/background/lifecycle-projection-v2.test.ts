import { describe, expect, it } from 'vitest';
import {
  buildSessionSnapshotV2,
  endAuthorityV2,
  isPublishableSessionV2,
  projectLifecycleV2,
  type SnapshotInputV2,
} from '../../../src/background/lifecycle-projection-v2';
import type { RuntimeStateV2 } from '../../../src/background/runtime-v2-types';
import { cancelPhrase, DEFAULT_SETTINGS } from '../../../src/shared/constants';
import { CoreError } from '../../../src/shared/errors';
import {
  intentionReminderFor,
  isSessionLifecycleV2,
  isSessionSnapshotV2,
} from '../../../src/shared/runtime-validation';
import { END_SESSION_LABEL, UNLOCK_LABEL } from '../../../src/shared/session-copy';
import type {
  BankState,
  EndAuthorityV2,
  GateState,
  SessionConfigV2,
  SessionDuration,
  SessionLifecycleV2,
  SessionSnapshotV2,
  SessionStateV2,
  SettingsV2,
  Strictness,
} from '../../../src/shared/types';
import {
  ACTIVATION_AT,
  ACTIVE_OPERATION_ID,
  breakRuntime,
  breakSession,
  CLEAR_RUNTIME_REVISION,
  cancelGateState,
  cleanupClosure,
  cleanupClosureRuntime,
  cleanupProgress,
  cleanupRetryState,
  cleanupTransition,
  emptyRuntimeV2,
  migratedActiveFocusRuntime,
  OTHER_SESSION_ID,
  pausedRuntime,
  pausedSession,
  pendingTransition,
  preparedClosure,
  preparedClosureRuntime,
  publishedFocusRuntime,
  runtimeClosureProjection,
  SESSION_ID,
  STARTING_OPERATION_ID,
  scheduleOccurrence,
  sessionConfigV2,
  TRANSITION_ID,
  timedFocusSession,
  transitionActiveCheckpoint,
  transitionRuntime,
  untilStoppedFocusSession,
} from './runtime-v2-fixtures';

type JournalStage = 'prepared' | 'registration-audited' | 'starting-verified';
type CommittedStage = 'committed-pending-verification' | 'alarm-ready' | 'active-verified';

const PRE_COMMIT_STAGES: readonly JournalStage[] = [
  'prepared',
  'registration-audited',
  'starting-verified',
];
const COMMITTED_STAGES: readonly CommittedStage[] = [
  'committed-pending-verification',
  'alarm-ready',
  'active-verified',
];
/** Inside the timed focus fixture's window, so an active snapshot has both clocks ahead of it. */
const AT: number = ACTIVATION_AT + 60_000;
/** Inside the paused fixture's own window, which closes well before the focus one opens. */
const PAUSED_AT: number = ACTIVATION_AT - 500_000;
const SETTINGS: SettingsV2 = { ...DEFAULT_SETTINGS, schedule: [] };
const BANK: BankState = { balanceMs: 120_000 };
const INTENTION: string = 'Finish the release notes';
const TIMED: SessionDuration = { kind: 'timed', minutes: 25 };
const INDEFINITE: SessionDuration = { kind: 'until-stopped' };

function snapshotInput(
  runtime: RuntimeStateV2,
  overrides: Partial<SnapshotInputV2> = {},
): SnapshotInputV2 {
  return { runtime, settings: SETTINGS, bank: BANK, at: AT, nextSchedule: null, ...overrides };
}

function snapshotOf(
  runtime: RuntimeStateV2,
  overrides: Partial<SnapshotInputV2> = {},
): SessionSnapshotV2 {
  const snapshot: SessionSnapshotV2 = buildSessionSnapshotV2(snapshotInput(runtime, overrides));
  expect(isSessionSnapshotV2(snapshot)).toBe(true);
  return snapshot;
}

function lifecycleOf(runtime: RuntimeStateV2): SessionLifecycleV2 {
  const lifecycle: SessionLifecycleV2 = projectLifecycleV2(runtime);
  expect(isSessionLifecycleV2(lifecycle)).toBe(true);
  return lifecycle;
}

/** A published focus runtime whose durable session carries the given strictness. */
function publishedWith(
  strictness: Strictness,
  overrides: Partial<RuntimeStateV2> = {},
): RuntimeStateV2 {
  return publishedFocusRuntime({
    session: timedFocusSession({ config: sessionConfigV2({ strictness, intention: INTENTION }) }),
    ...overrides,
  });
}

/** A transition cleanup whose twelfth automatic attempt has passed, so no retry is scheduled. */
function exhaustedTransitionCleanupRuntime(): RuntimeStateV2 {
  return transitionRuntime(
    cleanupTransition('start', 'prepared', 'start-abandon', {
      cleanupProgress: cleanupProgress({
        clearRuntimeRevision: CLEAR_RUNTIME_REVISION,
        retry: cleanupRetryState({ automaticAttempt: 12, nextAttemptAt: null }),
        clearCommands: cleanupProgress().clearCommands,
      }),
    }),
  );
}

/** A committed transition over the durable focus session its commit created. */
function committedRuntime(
  stage: CommittedStage,
  strictness: Strictness,
  overrides: Partial<RuntimeStateV2> = {},
  kind: 'start' | 'resume' = 'start',
): RuntimeStateV2 {
  return transitionRuntime(pendingTransition(kind, stage), {
    session: timedFocusSession({ config: sessionConfigV2({ strictness, intention: INTENTION }) }),
    ...overrides,
  });
}

describe('endAuthorityV2', (): void => {
  it('hides End for Hard and offers it immediately for Flexible', (): void => {
    expect(endAuthorityV2('hard', TIMED, null, INTENTION)).toEqual({ kind: 'hidden' });
    expect(endAuthorityV2('hard', TIMED, cancelGateState(), INTENTION)).toEqual({ kind: 'hidden' });
    expect(endAuthorityV2('flexible', TIMED, null, INTENTION)).toEqual({
      kind: 'immediate',
      actionLabel: END_SESSION_LABEL,
    });
  });

  it('closes the Friction gate until a cancel gate is persisted', (): void => {
    const closed: EndAuthorityV2 = {
      kind: 'friction-gate',
      gate: null,
      copy: { actionLabel: 'End session' },
      actions: { open: 'open-end-gate' },
    };

    expect(endAuthorityV2('friction', TIMED, null, INTENTION)).toEqual(closed);
    expect(
      endAuthorityV2(
        'friction',
        TIMED,
        {
          kind: 'pause',
          host: null,
          openedAt: AT,
          readyAt: AT,
          requiredPhrase: null,
          forceEndAvailable: false,
        },
        INTENTION,
      ),
    ).toEqual(closed);
  });

  it('opens the Friction gate on the exact persisted cancel gate', (): void => {
    const gate: GateState = cancelGateState({ requiredPhrase: cancelPhrase(INTENTION) });

    expect(endAuthorityV2('friction', TIMED, gate, INTENTION)).toEqual({
      kind: 'friction-gate',
      gate,
      copy: {
        title: 'End this session',
        back: 'Keep focusing',
        phraseLabel: 'Type this to confirm:',
        confirm: 'End the session',
        intentionReminder: INTENTION,
      },
      actions: { abandon: 'abandon-gate', confirm: 'confirm-gate' },
    });
  });

  it('labels the End of a Friction until-stopped session Unlock, closed and open', (): void => {
    const gate: GateState = cancelGateState({ requiredPhrase: cancelPhrase(INTENTION) });

    expect(endAuthorityV2('friction', INDEFINITE, null, INTENTION)).toEqual({
      kind: 'friction-gate',
      gate: null,
      copy: { actionLabel: UNLOCK_LABEL },
      actions: { open: 'open-end-gate' },
    });
    expect(endAuthorityV2('friction', INDEFINITE, gate, INTENTION)).toEqual({
      kind: 'friction-gate',
      gate,
      copy: {
        title: 'End this session',
        back: 'Keep focusing',
        phraseLabel: 'Type this to confirm:',
        confirm: UNLOCK_LABEL,
        intentionReminder: INTENTION,
      },
      actions: { abandon: 'abandon-gate', confirm: 'confirm-gate' },
    });
  });

  it('keeps End session for a Flexible until-stopped session and hides it for Hard', (): void => {
    expect(endAuthorityV2('flexible', INDEFINITE, null, INTENTION)).toEqual({
      kind: 'immediate',
      actionLabel: END_SESSION_LABEL,
    });
    expect(endAuthorityV2('hard', INDEFINITE, null, INTENTION)).toEqual({ kind: 'hidden' });
  });

  it('publishes a Friction indefinite snapshot the public validator accepts', (): void => {
    const runtime: RuntimeStateV2 = publishedFocusRuntime({
      session: untilStoppedFocusSession({
        config: sessionConfigV2({
          strictness: 'friction',
          duration: { kind: 'until-stopped' },
          intention: INTENTION,
        }),
      }),
    });
    const snapshot: SessionSnapshotV2 = buildSessionSnapshotV2(snapshotInput(runtime));

    expect(snapshot.lifecycle).toEqual({
      kind: 'active',
      endAuthority: {
        kind: 'friction-gate',
        gate: null,
        copy: { actionLabel: UNLOCK_LABEL },
        actions: { open: 'open-end-gate' },
      },
    });
    expect(isSessionSnapshotV2(snapshot)).toBe(true);
  });

  it('projects the reminder the snapshot guard cross-checks it against', (): void => {
    const gate: GateState = cancelGateState();

    for (const intention of [`  ${INTENTION}  `, '   ', '', '\n\t']) {
      const authority: EndAuthorityV2 = endAuthorityV2('friction', TIMED, gate, intention);

      expect(
        authority.kind === 'friction-gate' && authority.gate !== null && authority.copy,
      ).toMatchObject({ intentionReminder: intentionReminderFor(intention) });
    }
  });

  it('reports a blank intention as no reminder', (): void => {
    const gate: GateState = cancelGateState();
    const blank: EndAuthorityV2 = endAuthorityV2('friction', TIMED, gate, '   ');
    const padded: EndAuthorityV2 = endAuthorityV2('friction', TIMED, gate, `  ${INTENTION}  `);

    expect(
      blank.kind === 'friction-gate' && blank.gate !== null && blank.copy.intentionReminder,
    ).toBe(null);
    expect(
      padded.kind === 'friction-gate' && padded.gate !== null && padded.copy.intentionReminder,
    ).toBe(INTENTION);
  });
});

describe('projectLifecycleV2 lifecycle table', (): void => {
  it('reports idle with no session and no journal', (): void => {
    expect(lifecycleOf(emptyRuntimeV2())).toEqual({
      kind: 'idle',
      endAuthority: { kind: 'hidden' },
    });
  });

  it('never lets a consumer mutate the hidden authority every row shares', (): void => {
    const first: SessionLifecycleV2 = lifecycleOf(emptyRuntimeV2());

    expect((): void => {
      Object.assign(first.endAuthority, { kind: 'immediate' });
    }).toThrow(TypeError);
    expect(lifecycleOf(emptyRuntimeV2()).endAuthority).toEqual({ kind: 'hidden' });
  });

  it('hides End for every pre-commit transition stage', (): void => {
    for (const stage of PRE_COMMIT_STAGES) {
      for (const kind of ['start', 'resume'] as const) {
        expect(lifecycleOf(transitionRuntime(pendingTransition(kind, stage)))).toEqual({
          kind: 'starting',
          operationId: STARTING_OPERATION_ID,
          transition: kind,
          endAuthority: { kind: 'hidden' },
        });
      }
    }
  });

  it('derives committed transition authority from the durable strictness', (): void => {
    for (const stage of COMMITTED_STAGES) {
      expect(lifecycleOf(committedRuntime(stage, 'flexible'))).toEqual({
        kind: 'starting',
        operationId: ACTIVE_OPERATION_ID,
        transition: 'start',
        endAuthority: { kind: 'immediate', actionLabel: 'End session' },
      });
      expect(lifecycleOf(committedRuntime(stage, 'flexible', {}, 'resume'))).toEqual({
        kind: 'starting',
        operationId: ACTIVE_OPERATION_ID,
        transition: 'resume',
        endAuthority: { kind: 'immediate', actionLabel: 'End session' },
      });
      expect(lifecycleOf(committedRuntime(stage, 'hard')).endAuthority).toEqual({ kind: 'hidden' });
      expect(lifecycleOf(committedRuntime(stage, 'friction')).endAuthority).toEqual({
        kind: 'friction-gate',
        gate: null,
        copy: { actionLabel: 'End session' },
        actions: { open: 'open-end-gate' },
      });
    }
  });

  it('carries the persisted cancel gate of a committed Friction transition', (): void => {
    const gate: GateState = cancelGateState({ requiredPhrase: cancelPhrase(INTENTION) });
    const lifecycle: SessionLifecycleV2 = lifecycleOf(
      committedRuntime('alarm-ready', 'friction', { gate }),
    );

    expect(lifecycle.kind === 'starting' && lifecycle.endAuthority.kind).toBe('friction-gate');
    expect(
      lifecycle.kind === 'starting' &&
        lifecycle.endAuthority.kind === 'friction-gate' &&
        lifecycle.endAuthority.gate,
    ).toEqual(gate);
  });

  it('reports transition cleanup while a retry is scheduled and error once it is not', (): void => {
    const scheduled: RuntimeStateV2 = transitionRuntime(
      cleanupTransition('start', 'prepared', 'start-abandon'),
    );
    const exhausted: RuntimeStateV2 = exhaustedTransitionCleanupRuntime();

    expect(lifecycleOf(scheduled)).toEqual({
      kind: 'cleanup',
      journal: 'transition',
      id: TRANSITION_ID,
      endAuthority: { kind: 'hidden' },
    });
    expect(lifecycleOf(exhausted)).toEqual({
      kind: 'error',
      code: 'transition-cleanup-failed',
      retryAvailable: true,
      endAuthority: { kind: 'hidden' },
    });
  });

  it('reports a publishable focus session as active with its strictness authority', (): void => {
    expect(lifecycleOf(publishedWith('flexible'))).toEqual({
      kind: 'active',
      endAuthority: { kind: 'immediate', actionLabel: 'End session' },
    });
    expect(lifecycleOf(publishedWith('hard')).endAuthority).toEqual({ kind: 'hidden' });
    expect(lifecycleOf(publishedWith('friction')).endAuthority).toEqual({
      kind: 'friction-gate',
      gate: null,
      copy: { actionLabel: 'End session' },
      actions: { open: 'open-end-gate' },
    });
  });

  it('reports a publishable pause or break as active', (): void => {
    expect(lifecycleOf(pausedRuntime()).kind).toBe('active');
    expect(lifecycleOf(breakRuntime()).kind).toBe('active');
  });

  it('withholds active state from a migrated focus session with no checkpoint', (): void => {
    const migrated: RuntimeStateV2 = migratedActiveFocusRuntime();

    expect(lifecycleOf(migrated)).toEqual({
      kind: 'starting',
      operationId: migrated.enforcementEpoch,
      transition: 'start',
      endAuthority: { kind: 'hidden' },
    });
    expect(isPublishableSessionV2(migrated)).toBe(false);
  });

  it('calls a pause past its boundary a resume rather than a start', (): void => {
    // A pause whose end has passed is exactly the session waiting for a resume transition. Nothing
    // renders this label today, but it is part of the published snapshot, and calling that pass a
    // start was the one thing it could not be.
    const paused: RuntimeStateV2 = pausedRuntime();
    const afterPause: number = (paused.session?.phaseEndsAt ?? 0) + 1_000;

    const lifecycle: SessionLifecycleV2 = projectLifecycleV2(paused, afterPause);

    expect(isPublishableSessionV2(paused, afterPause)).toBe(false);
    expect(lifecycle).toEqual({
      kind: 'starting',
      operationId: paused.enforcementEpoch,
      transition: 'resume',
      endAuthority: { kind: 'hidden' },
    });
  });

  it('reports closure cleanup while a retry is scheduled and error once it is not', (): void => {
    const scheduled: RuntimeStateV2 = cleanupClosureRuntime();
    const exhausted: RuntimeStateV2 = cleanupClosureRuntime({
      pendingClosure: cleanupClosure({
        projection: runtimeClosureProjection(),
        cleanupProgress: cleanupProgress({
          retry: cleanupRetryState({ automaticAttempt: 12, nextAttemptAt: null }),
        }),
      }),
    });

    expect(lifecycleOf(scheduled)).toEqual({
      kind: 'cleanup',
      journal: 'closure',
      id: `${SESSION_ID}:close`,
      endAuthority: { kind: 'hidden' },
    });
    expect(lifecycleOf(exhausted)).toEqual({
      kind: 'error',
      code: 'closure-cleanup-failed',
      retryAvailable: true,
      endAuthority: { kind: 'hidden' },
    });
  });

  it('reports a prepared closure as closure cleanup, which already won over its session', (): void => {
    expect(lifecycleOf(preparedClosureRuntime())).toEqual({
      kind: 'cleanup',
      journal: 'closure',
      id: `${SESSION_ID}:close`,
      endAuthority: { kind: 'hidden' },
    });
  });

  it('never reports active for a checkpoint that names another session', (): void => {
    const mismatched: RuntimeStateV2 = publishedFocusRuntime({
      enforcementCheckpoint: transitionActiveCheckpoint('start'),
      session: timedFocusSession({ sessionId: OTHER_SESSION_ID }),
    });

    expect(isPublishableSessionV2(mismatched)).toBe(false);
    expect(lifecycleOf(mismatched).kind).not.toBe('active');
    expect(
      isPublishableSessionV2(
        publishedFocusRuntime({
          basePolicyRevision: 9,
          enforcementCheckpoint: transitionActiveCheckpoint('start'),
        }),
      ),
    ).toBe(false);
  });

  it('throws on a runtime that carries both journals', (): void => {
    const impossible: RuntimeStateV2 = {
      ...emptyRuntimeV2(),
      pendingEnforcementTransition: pendingTransition('start', 'prepared'),
      pendingClosure: preparedClosure({ projection: runtimeClosureProjection() }),
    };

    expect((): SessionLifecycleV2 => projectLifecycleV2(impossible)).toThrow(CoreError);
  });
});

describe('isPublishableSessionV2', (): void => {
  it('publishes only a matching focus checkpoint or a journal-free pause or break', (): void => {
    expect(isPublishableSessionV2(publishedFocusRuntime())).toBe(true);
    expect(isPublishableSessionV2(pausedRuntime())).toBe(true);
    expect(isPublishableSessionV2(breakRuntime())).toBe(true);
    expect(isPublishableSessionV2(emptyRuntimeV2())).toBe(false);
    expect(isPublishableSessionV2(migratedActiveFocusRuntime())).toBe(false);
    expect(
      isPublishableSessionV2(transitionRuntime(pendingTransition('start', 'alarm-ready'))),
    ).toBe(false);
    expect(isPublishableSessionV2(preparedClosureRuntime())).toBe(false);
  });
});

describe('buildSessionSnapshotV2', (): void => {
  it('settles focus through the observation time and exposes the active session', (): void => {
    const runtime: RuntimeStateV2 = publishedWith('flexible');
    const session: SessionStateV2 = runtime.session as SessionStateV2;
    const snapshot: SessionSnapshotV2 = snapshotOf(runtime);

    expect(snapshot.lifecycle.kind).toBe('active');
    expect(snapshot.phase).toBe('focus');
    expect(snapshot.config).toEqual(session.config);
    expect(snapshot.startedAt).toBe(session.startedAt);
    expect(snapshot.phaseStartedAt).toBe(session.phaseStartedAt);
    expect(snapshot.phaseEndsAt).toBe(session.phaseEndsAt);
    expect(snapshot.sessionEndsAt).toBe(session.sessionEndsAt);
    expect(snapshot.sessionFocusedMs).toBe(AT - session.phaseStartedAt);
    expect(snapshot.cycleIndex).toBe(session.cycleIndex);
    expect(snapshot.bankAccrualPerMs).toBe(SETTINGS.pause.earnRatio);
    expect(snapshot.bankMs).toBe(BANK.balanceMs);
    expect(snapshot.bankCapMs).toBe(SETTINGS.pause.capMs);
    expect(snapshot.pauseCostMs).toBe(SETTINGS.pause.pauseMs);
    expect(snapshot.unlockCostMs).toBe(SETTINGS.pause.unlockMs);
    expect(snapshot.theme).toBe(SETTINGS.theme);
    expect(snapshot.scheduleActive).toBe(false);
  });

  it('carries both clocks for a timed session and null ends for an indefinite one', (): void => {
    const timed: SessionSnapshotV2 = snapshotOf(publishedWith('flexible'));
    const indefinite: SessionSnapshotV2 = snapshotOf(
      publishedFocusRuntime({
        session: untilStoppedFocusSession({
          config: sessionConfigV2({
            strictness: 'flexible',
            duration: { kind: 'until-stopped' },
            intention: INTENTION,
          }),
        }),
      }),
    );

    expect(timed.phaseEndsAt).not.toBeNull();
    expect(timed.sessionEndsAt).not.toBeNull();
    expect(indefinite.phaseEndsAt).toBeNull();
    expect(indefinite.sessionEndsAt).toBeNull();
    expect(indefinite.lifecycle.endAuthority).toEqual({
      kind: 'immediate',
      actionLabel: 'End session',
    });
  });

  it('reports a scheduled session through scheduleActive', (): void => {
    const scheduled: SessionConfigV2 = sessionConfigV2({
      strictness: 'flexible',
      source: 'schedule',
      scheduleOccurrence: scheduleOccurrence(),
      intention: INTENTION,
    });

    expect(
      snapshotOf(publishedFocusRuntime({ session: timedFocusSession({ config: scheduled }) }))
        .scheduleActive,
    ).toBe(true);
  });

  it('accrues no pause bank outside focus', (): void => {
    const paused: SessionSnapshotV2 = snapshotOf(pausedRuntime(), { at: PAUSED_AT });
    const onBreak: SessionSnapshotV2 = snapshotOf(breakRuntime(), { at: PAUSED_AT });
    const session: SessionStateV2 = pausedSession();

    expect(paused.phase).toBe('paused');
    expect(paused.bankAccrualPerMs).toBe(0);
    expect(paused.sessionFocusedMs).toBe(session.focusedMs);
    expect(paused.phaseEndsAt).toBe(session.phaseEndsAt);
    expect(onBreak.phase).toBe('break');
    expect(onBreak.bankAccrualPerMs).toBe(0);
    expect(onBreak.config?.cycling).not.toBeNull();
    expect(breakSession().phase).toBe('break');
  });

  it('hides every active field outside an active lifecycle', (): void => {
    const hidden: readonly SessionSnapshotV2[] = [
      snapshotOf(emptyRuntimeV2()),
      snapshotOf(transitionRuntime(pendingTransition('start', 'prepared'))),
      snapshotOf(committedRuntime('alarm-ready', 'friction', { gate: cancelGateState() })),
      snapshotOf(cleanupClosureRuntime()),
      snapshotOf(transitionRuntime(cleanupTransition('start', 'prepared', 'start-abandon'))),
      snapshotOf(exhaustedTransitionCleanupRuntime()),
      snapshotOf(migratedActiveFocusRuntime()),
    ];

    for (const snapshot of hidden) {
      expect(snapshot.lifecycle.kind).not.toBe('active');
      expect(snapshot.phase).toBe('idle');
      expect(snapshot.config).toBeNull();
      expect(snapshot.startedAt).toBeNull();
      expect(snapshot.phaseStartedAt).toBeNull();
      expect(snapshot.phaseEndsAt).toBeNull();
      expect(snapshot.sessionEndsAt).toBeNull();
      expect(snapshot.sessionFocusedMs).toBe(0);
      expect(snapshot.cycleIndex).toBe(0);
      expect(snapshot.bankAccrualPerMs).toBe(0);
      expect(snapshot.activeUnlocks).toEqual([]);
      expect(snapshot.gate).toBeNull();
      expect(snapshot.scheduleActive).toBe(false);
    }
  });

  it('exposes a committed Friction gate only through End authority', (): void => {
    const gate: GateState = cancelGateState({ requiredPhrase: cancelPhrase(INTENTION) });
    const snapshot: SessionSnapshotV2 = snapshotOf(
      committedRuntime('alarm-ready', 'friction', { gate }),
    );

    expect(snapshot.gate).toBeNull();
    expect(
      snapshot.lifecycle.kind === 'starting' &&
        snapshot.lifecycle.endAuthority.kind === 'friction-gate' &&
        snapshot.lifecycle.endAuthority.gate,
    ).toEqual(gate);
  });

  it('counts today attempts and drops expired unlocks', (): void => {
    const runtime: RuntimeStateV2 = publishedWith('flexible', {
      unlocks: [
        { host: 'live.example', until: AT + 1 },
        { host: 'expired.example', until: AT },
      ],
    });
    const snapshot: SessionSnapshotV2 = snapshotOf(runtime);

    expect(snapshot.activeUnlocks).toEqual([{ host: 'live.example', until: AT + 1 }]);
    expect(snapshot.attemptsToday).toBe(2);
    expect(snapshotOf(emptyRuntimeV2()).attemptsToday).toBe(0);
  });

  it('carries the next schedule the caller resolved', (): void => {
    const nextSchedule: { entryId: string; startsAt: number } = {
      entryId: 'weekday',
      startsAt: AT + 60_000,
    };

    expect(snapshotOf(emptyRuntimeV2(), { nextSchedule }).nextSchedule).toEqual(nextSchedule);
  });

  it('exposes no clocks for a committed session observed later', (): void => {
    const runtime: RuntimeStateV2 = committedRuntime('committed-pending-verification', 'flexible');
    const snapshot: SessionSnapshotV2 = snapshotOf(runtime, { at: AT + 600_000 });

    expect(snapshot.lifecycle.kind).toBe('starting');
    expect(snapshot.sessionFocusedMs).toBe(0);
    expect(snapshot.phaseStartedAt).toBeNull();
    expect(snapshot.sessionEndsAt).toBeNull();
  });

  it('detaches every projected value from the runtime it was projected from', (): void => {
    const runtime: RuntimeStateV2 = publishedWith('friction', {
      gate: cancelGateState({
        openedAt: AT - 1_000,
        readyAt: AT,
        requiredPhrase: cancelPhrase(INTENTION),
        forceEndAvailable: false,
      }),
      unlocks: [{ host: 'live.example', until: AT + 1 }],
    });
    const snapshot: SessionSnapshotV2 = snapshotOf(runtime);

    expect(snapshot.config).not.toBe(runtime.session?.config);
    expect(snapshot.activeUnlocks).not.toBe(runtime.unlocks);
    expect(snapshot.gate).not.toBe(runtime.gate);
    runtime.unlocks.push({ host: 'later.example', until: AT + 2 });
    expect(snapshot.activeUnlocks).toHaveLength(1);
    snapshot.activeUnlocks.push({ host: 'popup.example', until: AT + 3 });
    expect(runtime.unlocks).toHaveLength(2);
  });
});

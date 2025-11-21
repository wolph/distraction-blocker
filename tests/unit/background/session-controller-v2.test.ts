import { describe, expect, it } from 'vitest';
import {
  PHASE_ALARM,
  TICK_ALARM,
  TRANSITION_CLEANUP_ALARM,
} from '../../../src/background/alarms-v2';
import type { FrozenDocumentCommand } from '../../../src/background/enforcement-persistence-v2';
import type {
  PendingEnforcementTransition,
  RuntimeStateV2,
} from '../../../src/background/runtime-v2-types';
import { parseRuntimeStateV2 } from '../../../src/background/runtime-v2-validation';
import { SessionControllerV2 } from '../../../src/background/session-controller-v2';
import { DEFAULT_SETTINGS, GATE_EXPIRY_MS } from '../../../src/shared/constants';
import type {
  CommandResponseV2,
  SessionCommandResultCodeV2,
  StartSessionResponseV2,
} from '../../../src/shared/messages';
import { isSessionSnapshotV2 } from '../../../src/shared/runtime-validation';
import { localDateStr, localMidnightAfter } from '../../../src/shared/time';
import type {
  GateState,
  SessionConfigV2,
  SessionSnapshotV2,
  SessionStateV2,
} from '../../../src/shared/types';
import {
  type ControllerEffectsFakeV2,
  createControllerEffectsFakeV2,
  createRuntimePortsFakeV2,
  createScheduleRunnerPortsFakeV2,
  type RuntimePortsFakeV2,
  type ScheduleRunnerPortsFakeV2,
} from './runtime-ports-fake';
import {
  ACTIVATION_AT,
  ACTIVE_OPERATION_ID,
  breakRuntime,
  breakSession,
  CLEANUP_OPERATION_ID,
  cleanupClosureRuntime,
  cleanupTransition,
  documentKey,
  emptyRuntimeV2,
  OTHER_EPOCH_ID,
  OTHER_OPERATION_ID,
  pausedRuntime,
  pausedSession,
  pendingTransition,
  publishedFocusRuntime,
  SECOND_TARGET_URL,
  SESSION_ID,
  STARTING_OPERATION_ID,
  sessionConfigV2,
  TARGET_URL,
  TRANSITION_ID,
  timedFocusSession,
  transitionPostCleanupClosure,
  transitionRuntime,
  untilStoppedFocusSession,
} from './runtime-v2-fixtures';

const BLOCKED_URL: string = 'https://facebook.com/feed';
const DOC_ONE: string = 'document-1';
/** A document the frozen fixtures do not hold, so a navigation freezes its command from the URL. */
const DOC_BLOCKED: string = 'document-9';
const AT: number = ACTIVATION_AT + 60_000;
/** Enough scripted UUIDs for a start, its cleanup, and several live-view operations. */
const IDS: readonly string[] = [
  SESSION_ID,
  TRANSITION_ID,
  STARTING_OPERATION_ID,
  ACTIVE_OPERATION_ID,
  CLEANUP_OPERATION_ID,
  OTHER_OPERATION_ID,
  '60000000-0000-4000-8000-000000000001',
  '60000000-0000-4000-8000-000000000002',
  '60000000-0000-4000-8000-000000000003',
  '60000000-0000-4000-8000-000000000004',
  '60000000-0000-4000-8000-000000000005',
  '60000000-0000-4000-8000-000000000006',
];

interface HarnessV2 {
  controller: SessionControllerV2;
  ports: RuntimePortsFakeV2;
  schedule: ScheduleRunnerPortsFakeV2;
  effects: ControllerEffectsFakeV2;
}

function harness(
  runtime: RuntimeStateV2 = emptyRuntimeV2({ runtimeRevision: 0 }),
  options: Parameters<typeof createRuntimePortsFakeV2>[1] = {},
): HarnessV2 {
  const ports: RuntimePortsFakeV2 = createRuntimePortsFakeV2(runtime, {
    now: AT,
    ids: [...IDS],
    tabs: [{ tabId: 11, url: BLOCKED_URL, documentId: DOC_ONE }],
    ...options,
  });
  const schedule: ScheduleRunnerPortsFakeV2 = createScheduleRunnerPortsFakeV2();
  const effects: ControllerEffectsFakeV2 = createControllerEffectsFakeV2();
  return {
    controller: new SessionControllerV2(ports, schedule, effects),
    ports,
    schedule,
    effects,
  };
}

function flexibleConfig(overrides: Partial<SessionConfigV2> = {}): SessionConfigV2 {
  return sessionConfigV2({ strictness: 'flexible', ...overrides });
}

/** The runtime revision of every enforcement command the transport received, in order. */
function sentRevisions(ports: RuntimePortsFakeV2): number[] {
  return ports.sends.flatMap((sent): number[] =>
    sent.message.command === 'apply-enforcement' ? [sent.message.runtimeRevision] : [],
  );
}

/** The gate an active overlay carries, or null for any other presentation. */
function overlayGate(command: FrozenDocumentCommand | undefined): GateState | null {
  const overlay = command?.overlay ?? null;
  return overlay !== null && overlay.presentation === 'active' ? overlay.gate : null;
}

/** Every legacy event of one kind the controller committed, in order. */
function eventsOf(ports: RuntimePortsFakeV2, t: string): Array<Record<string, unknown>> {
  return ports.commits.flatMap(
    (commit): Array<Record<string, unknown>> =>
      commit.events
        .filter((event): boolean => event.t === t)
        .map((event): Record<string, unknown> => event as unknown as Record<string, unknown>),
  );
}

/** Opens a gate, waits past its delay, and confirms it with the phrase it persisted. */
async function confirmOpenGate(
  controller: SessionControllerV2,
  ports: RuntimePortsFakeV2,
): Promise<CommandResponseV2<SessionCommandResultCodeV2>> {
  ports.advance(60_000);
  return controller.confirmGate(ports.current().gate?.requiredPhrase ?? null);
}

describe('SessionControllerV2 startSession', (): void => {
  it('converts the config to a manual candidate and publishes', async (): Promise<void> => {
    const { controller, ports } = harness();
    const response: StartSessionResponseV2 = await controller.startSession(flexibleConfig());
    const prepared = ports.writes[0]?.pendingEnforcementTransition;

    expect(response).toEqual({ ok: true, code: 'ok' });
    expect(prepared?.kind).toBe('start');
    expect(prepared?.trigger).toBe('manual');
    expect(prepared?.candidate?.source).toBe('manual');
    expect(prepared?.candidate?.scheduleOccurrence).toBeNull();
    expect(prepared?.candidate?.scheduleWindow).toBeNull();
    expect(prepared?.candidate?.duration).toEqual({ kind: 'manual-timed', minutes: 25 });
    expect(prepared?.candidate?.mode).toBe(flexibleConfig().mode);
    expect(ports.current().pendingEnforcementTransition).toBeNull();
    expect(ports.current().session?.sessionId).toBe(SESSION_ID);
  });

  it('converts an indefinite config to an until-stopped plan', async (): Promise<void> => {
    const { controller, ports } = harness();
    await controller.startSession(
      flexibleConfig({ duration: { kind: 'until-stopped' }, cycling: null }),
    );

    expect(ports.writes[0]?.pendingEnforcementTransition?.candidate?.duration).toEqual({
      kind: 'until-stopped',
    });
    expect(ports.current().session?.sessionEndsAt).toBeNull();
  });

  it('rejects a config the boundary refuses without writing', async (): Promise<void> => {
    const { controller, ports } = harness();
    const hostile: SessionConfigV2 = {
      ...flexibleConfig(),
      rules: new Proxy(flexibleConfig().rules, {}),
    };
    const response: StartSessionResponseV2 = await controller.startSession(hostile);

    expect(response.ok).toBe(false);
    expect(response.code).toBe('invalid-request');
    expect(ports.writes).toHaveLength(0);
    expect(ports.sends).toHaveLength(0);
  });

  it('answers the failure code with no cleanupPending when nothing was sent', async (): Promise<void> => {
    const { controller, ports, effects } = harness(emptyRuntimeV2({ runtimeRevision: 0 }), {
      audit: 'website-access-lost',
    });
    await controller.recover();
    const response: StartSessionResponseV2 = await controller.startSession(flexibleConfig());

    expect(response.ok).toBe(false);
    expect(response.code).toBe('website-access-lost');
    expect('cleanupPending' in response ? response.cleanupPending : undefined).toBeUndefined();
    // No enforcement was ever sent, so nothing under a starting or active presentation went out.
    // The clear batch the entry freezes is a separate concern, recorded in the task report.
    for (const send of ports.sends) {
      const message = send.message;
      if (message.command !== 'apply-enforcement') continue;
      expect(message.presentation).toBe('clear');
    }
    // The reservation-release cleanup ran to its resolution inside the command, so the lifecycle
    // the popup reads next is idle rather than a cleanup the user cannot act on.
    expect(ports.current().pendingEnforcementTransition).toBeNull();
    expect(controller.snapshot(ports.now()).lifecycle.kind).toBe('idle');
    expect(effects.broadcasts.length).toBeGreaterThan(0);
  });

  it('refuses a start while either journal exists', async (): Promise<void> => {
    const transition = harness(
      transitionRuntime(cleanupTransition('start', 'prepared', 'start-abandon')),
    );
    expect((await transition.controller.startSession(flexibleConfig())).code).toBe(
      'transition-cleanup-pending',
    );

    const closure = harness(cleanupClosureRuntime());
    expect((await closure.controller.startSession(flexibleConfig())).code).toBe(
      'closure-cleanup-pending',
    );
  });
});

describe('SessionControllerV2 end and gate commands', (): void => {
  it('closes a published Flexible session at the request time', async (): Promise<void> => {
    const { controller, ports } = harness(
      publishedFocusRuntime({
        session: timedFocusSession({ config: flexibleConfig() }),
      }),
    );
    const response: CommandResponseV2<SessionCommandResultCodeV2> =
      await controller.requestSessionEnd();

    expect(response).toEqual({ ok: true, code: 'ok' });
    expect(ports.current().session).toBeNull();
  });

  it('uses manual-completed for an indefinite session and plays no completion sound', async (): Promise<void> => {
    const { controller, ports, effects } = harness(
      publishedFocusRuntime({
        session: untilStoppedFocusSession({
          config: flexibleConfig({ duration: { kind: 'until-stopped' } }),
        }),
      }),
    );
    await controller.requestSessionEnd();
    const reasons: string[] = ports.commits.flatMap((commit): string[] =>
      commit.events
        .filter((event): boolean => event.t === 'sessionEnded')
        .map((event): string => ('reason' in event ? String(event.reason) : '')),
    );

    expect(reasons).toContain('manual-completed');
    expect(effects.sounds).not.toContain('sessionComplete');
    expect(effects.notices).toHaveLength(0);
  });

  it('refuses End for Hard and Friction and answers no-active-session when idle', async (): Promise<void> => {
    for (const strictness of ['hard', 'friction'] as const) {
      const { controller } = harness(
        publishedFocusRuntime({
          session: timedFocusSession({ config: sessionConfigV2({ strictness }) }),
        }),
      );
      expect((await controller.requestSessionEnd()).code).toBe('end-not-allowed');
    }
    expect((await harness().controller.requestSessionEnd()).code).toBe('no-active-session');
    expect((await harness(cleanupClosureRuntime()).controller.requestSessionEnd()).code).toBe(
      'no-active-session',
    );
  });

  it('reports transition cleanup while that journal exists', async (): Promise<void> => {
    const { controller } = harness(
      transitionRuntime(
        cleanupTransition('start', 'alarm-ready', 'manual-end', {
          postCleanupClosure: transitionPostCleanupClosure(),
        }),
        { session: timedFocusSession() },
      ),
    );
    expect((await controller.requestSessionEnd()).code).toBe('transition-cleanup-pending');
  });

  it('opens the Friction cancel gate under a fresh operation and a higher revision', async (): Promise<void> => {
    const { controller, ports } = harness(
      publishedFocusRuntime({
        session: timedFocusSession({ config: sessionConfigV2({ strictness: 'friction' }) }),
      }),
    );
    const before: number = ports.current().runtimeRevision;
    const response: CommandResponseV2<SessionCommandResultCodeV2> = await controller.openEndGate();
    const after: RuntimeStateV2 = ports.current();

    expect(response).toEqual({ ok: true, code: 'ok' });
    expect(after.gate?.kind).toBe('cancel');
    expect(after.runtimeRevision).toBeGreaterThan(before);
    for (const command of Object.values(after.documentCommands)) {
      expect(command.runtimeRevision).toBe(after.runtimeRevision);
      expect(command.operationId).not.toBe(ACTIVE_OPERATION_ID);
    }
    // A live update never rewrites the base-policy checkpoint.
    expect(after.enforcementCheckpoint?.operationId).toBe(ACTIVE_OPERATION_ID);
    expect((await controller.openEndGate()).code).toBe('ok');
  });

  it('refuses the End gate for other strictness', async (): Promise<void> => {
    for (const strictness of ['flexible', 'hard'] as const) {
      const { controller } = harness(
        publishedFocusRuntime({
          session: timedFocusSession({ config: sessionConfigV2({ strictness }) }),
        }),
      );
      expect((await controller.openEndGate()).code).toBe('end-not-allowed');
    }
  });

  it('abandons a gate with no change to the verification budget', async (): Promise<void> => {
    expect((await harness(publishedFocusRuntime()).controller.abandonGate()).code).toBe(
      'no-active-gate',
    );

    const { controller, ports } = harness(
      publishedFocusRuntime({
        session: timedFocusSession({ config: sessionConfigV2({ strictness: 'friction' }) }),
      }),
    );
    await controller.openEndGate();
    const response: CommandResponseV2<SessionCommandResultCodeV2> = await controller.abandonGate();

    expect(response).toEqual({ ok: true, code: 'ok' });
    expect(ports.current().gate).toBeNull();
    // Spec 1021: a committed Friction transition persists its gate and refreezes the active view,
    // and neither the attempt count nor the ten-second budget moves.
    const committed = harness(
      transitionRuntime(pendingTransition('start', 'alarm-ready'), {
        session: timedFocusSession({ config: sessionConfigV2({ strictness: 'friction' }) }),
      }),
    );
    const before = committed.ports.current().pendingEnforcementTransition;
    expect((await committed.controller.openEndGate()).code).toBe('ok');
    const opened: RuntimeStateV2 = committed.ports.current();
    const afterOpen = opened.pendingEnforcementTransition;

    expect(parseRuntimeStateV2(opened)).not.toBeNull();
    expect(opened.gate?.kind).toBe('cancel');
    expect(afterOpen?.activeView?.runtimeRevision).toBe(
      (before?.activeView?.runtimeRevision ?? 0) + 1,
    );
    expect(opened.runtimeRevision).toBe(afterOpen?.activeView?.runtimeRevision);
    expect(opened.documentCommands).toEqual(afterOpen?.activeView?.documents);
    expect(afterOpen?.freshnessAttempts).toBe(before?.freshnessAttempts);
    expect(afterOpen?.verificationStartedAt).toBe(before?.verificationStartedAt);

    expect((await committed.controller.abandonGate()).code).toBe('ok');
    const abandoned: RuntimeStateV2 = committed.ports.current();
    expect(abandoned.gate).toBeNull();
    expect(parseRuntimeStateV2(abandoned)).not.toBeNull();
    expect(abandoned.pendingEnforcementTransition?.stage).toBe('alarm-ready');
    expect(abandoned.pendingEnforcementTransition?.freshnessAttempts).toBe(
      before?.freshnessAttempts,
    );
    expect(abandoned.pendingEnforcementTransition?.verificationStartedAt).toBe(
      before?.verificationStartedAt,
    );

    // Hard is the one strictness that refuses End outright.
    const hard = harness(
      transitionRuntime(pendingTransition('start', 'alarm-ready'), {
        session: timedFocusSession({ config: sessionConfigV2({ strictness: 'hard' }) }),
      }),
    );
    expect((await hard.controller.openEndGate()).code).toBe('end-not-allowed');
  });

  /** A committed transition whose frozen view matches the live tabs, inside its ten-second budget. */
  function restartHarness(
    options: Parameters<typeof createRuntimePortsFakeV2>[1] = {},
    transition: Partial<PendingEnforcementTransition> = {},
  ): HarnessV2 {
    return harness(
      transitionRuntime(pendingTransition('start', 'active-verified', transition), {
        session: timedFocusSession({ config: sessionConfigV2({ strictness: 'friction' }) }),
      }),
      {
        now: ACTIVATION_AT + 5_000,
        tabs: [
          { tabId: 11, url: TARGET_URL, documentId: DOC_ONE },
          { tabId: 12, url: SECOND_TARGET_URL, documentId: 'document-2' },
        ],
        ...options,
      },
    );
  }

  /** Every freshness attempt count a write recorded, so the restart can be pinned to one attempt. */
  function attemptCounts(ports: RuntimePortsFakeV2): number[] {
    return ports.writes.flatMap((write): number[] =>
      write.pendingEnforcementTransition === null
        ? []
        : [write.pendingEnforcementTransition.freshnessAttempts],
    );
  }

  it('restarts the verification pass when a gate lands at active-verified', async (): Promise<void> => {
    for (const command of ['open', 'abandon'] as const) {
      const { controller, ports } = restartHarness();
      const before = ports.current().pendingEnforcementTransition;
      const attempts: number = before?.freshnessAttempts ?? 0;
      const sentAtCommand: number = ports.sends.length;
      expect(before?.checkpoint).not.toBeNull();
      expect((await controller.openEndGate()).code).toBe('ok');
      if (command === 'abandon') expect((await controller.abandonGate()).code).toBe('ok');

      const restarted = ports.current().pendingEnforcementTransition;
      // The refreeze replaced the operation the candidate checkpoint attested, so the checkpoint is
      // discarded and the pass restarts from the stage that does not require it.
      expect(parseRuntimeStateV2(ports.current())).not.toBeNull();
      expect(restarted?.stage).toBe('alarm-ready');
      expect(restarted?.checkpoint).toBeNull();
      // The count gives back the attempt the restart re-spends, so the runner's increment lands on
      // the number the transition already had rather than a new one.
      expect(restarted?.freshnessAttempts).toBe(attempts - 1);
      expect(restarted?.verificationStartedAt).toBe(before?.verificationStartedAt);
      const operationId: string | undefined = restarted?.activeView?.operationId;
      expect(operationId).not.toBe(before?.activeOperationId);
      expect(ports.current().documentCommands).toEqual(restarted?.activeView?.documents);
      // The documents holding the old view get the replacement at once, not at the next pass.
      expect(
        ports.sends
          .slice(sentAtCommand)
          .some((sent): boolean => sent.message.operationId === operationId),
      ).toBe(true);
      expect(eventsOf(ports, command === 'abandon' ? 'gateResisted' : 'gateOpened')).toHaveLength(
        1,
      );

      // The next drive is recovery's. It runs the pass against the replacement view, on the same
      // attempt number and the same deadline the gate found.
      const sentBefore: number = ports.sends.length;
      await controller.recover();
      const reissued = ports.sends.slice(sentBefore);
      expect(reissued.length).toBeGreaterThan(0);
      expect(reissued.every((sent): boolean => sent.message.operationId === operationId)).toBe(
        true,
      );
      expect(
        ports.writes.some(
          (write): boolean =>
            write.pendingEnforcementTransition?.stage === 'active-verified' &&
            write.pendingEnforcementTransition.freshnessAttempts === attempts,
        ),
      ).toBe(true);
      expect(Math.max(...attemptCounts(ports))).toBe(attempts);
      expect(
        ports.writes.every(
          (write): boolean =>
            write.pendingEnforcementTransition === null ||
            write.pendingEnforcementTransition.verificationStartedAt ===
              before?.verificationStartedAt,
        ),
      ).toBe(true);
      // A finished pass publishes, and the gate the user is deliberating over survives it.
      expect(parseRuntimeStateV2(ports.current())).not.toBeNull();
      expect(ports.current().pendingEnforcementTransition).toBeNull();
      if (command === 'abandon') expect(ports.current().gate).toBeNull();
      else expect(ports.current().gate?.kind).toBe('cancel');
    }
  });

  it('never revives a transition whose freshness budget is already spent', async (): Promise<void> => {
    // Spec 775 spends the budget two ways, and a gate action must not revive either: the deadline
    // arrives, or the count is already three inside the ten seconds.
    const spent: ReadonlyArray<[string, HarnessV2]> = [
      ['deadline', restartHarness({ now: ACTIVATION_AT + 60_000 })],
      ['attempts', restartHarness({}, { freshnessAttempts: 3 })],
    ];
    for (const [label, { controller, ports }] of spent) {
      const before = ports.current().pendingEnforcementTransition;
      expect((await controller.openEndGate()).code, label).toBe('ok');

      const stepped = ports.current().pendingEnforcementTransition;
      // The row still has to be valid, so the invalidated checkpoint goes. The attempt count does
      // not come back, because no pass is coming to spend it.
      expect(parseRuntimeStateV2(ports.current()), label).not.toBeNull();
      expect(stepped?.stage, label).toBe('alarm-ready');
      expect(stepped?.checkpoint, label).toBeNull();
      expect(stepped?.freshnessAttempts, label).toBe(before?.freshnessAttempts);

      await controller.recover();

      // The drive begins no attempt, so it fails the transition instead of reviving it.
      expect(Math.max(...attemptCounts(ports)), label).toBe(before?.freshnessAttempts);
      expect(ports.current().pendingEnforcementTransition?.stage ?? 'resolved', label).not.toBe(
        'alarm-ready',
      );
      expect(
        ports.writes.some(
          (write): boolean =>
            write.pendingEnforcementTransition?.stage === 'cleanup' &&
            write.pendingEnforcementTransition.failure === 'tab-enforcement-failed',
        ),
        label,
      ).toBe(true);
    }
  });

  it('restarts a pre-commit pass when a live refresh lands at starting-verified', async (): Promise<void> => {
    const { controller, ports } = harness(
      transitionRuntime(pendingTransition('start', 'starting-verified')),
    );
    const before = ports.current().pendingEnforcementTransition;
    await controller.refreshLiveViews();

    const after: RuntimeStateV2 = ports.current();
    const restarted = after.pendingEnforcementTransition;
    expect(parseRuntimeStateV2(after)).not.toBeNull();
    expect(restarted?.stage).toBe('registration-audited');
    expect(restarted?.startingCheckpoint).toBeNull();
    expect(restarted?.freshnessAttempts).toBe(before?.freshnessAttempts);
    expect(restarted?.startingView?.runtimeRevision).toBe(after.runtimeRevision);
  });

  it('records gate events raised during a committed transition', async (): Promise<void> => {
    const { controller, ports } = harness(
      transitionRuntime(pendingTransition('start', 'alarm-ready'), {
        session: timedFocusSession({ config: sessionConfigV2({ strictness: 'friction' }) }),
      }),
    );
    expect((await controller.openEndGate()).code).toBe('ok');
    expect((await controller.abandonGate()).code).toBe('ok');

    expect(eventsOf(ports, 'gateOpened')).toHaveLength(1);
    expect(eventsOf(ports, 'gateResisted')).toHaveLength(1);
    expect(parseRuntimeStateV2(ports.current())).not.toBeNull();
  });

  it('ends a committed transition through its cleanup journal, not as no-active-session', async (): Promise<void> => {
    const { controller, ports } = harness(
      transitionRuntime(pendingTransition('start', 'alarm-ready'), {
        session: timedFocusSession({ config: sessionConfigV2({ strictness: 'friction' }) }),
      }),
    );
    expect((await controller.openEndGate()).code).toBe('ok');
    const response: CommandResponseV2<SessionCommandResultCodeV2> = await confirmOpenGate(
      controller,
      ports,
    );

    expect(response.code).not.toBe('no-active-session');
    expect(response).toEqual({ ok: true, code: 'ok' });
    // The End is the transition's, so it leaves through the transition journal rather than the
    // bare closure a published session would take.
    const after: RuntimeStateV2 = ports.current();
    expect(parseRuntimeStateV2(after)).not.toBeNull();
    expect(after.gate).toBeNull();
    const cleanupAt: number = ports.writes.findIndex(
      (write): boolean => write.pendingEnforcementTransition?.stage === 'cleanup',
    );
    const closureAt: number = ports.writes.findIndex(
      (write): boolean => write.pendingClosure !== null,
    );
    // A published session prepares its closure directly. This one reverses the transition first,
    // so the cleanup journal exists before any closure does.
    expect(cleanupAt).toBeGreaterThanOrEqual(0);
    expect(closureAt).toBeGreaterThan(cleanupAt);
  });

  it('gates confirmation on readiness and the typed phrase', async (): Promise<void> => {
    const { controller, ports } = harness(
      publishedFocusRuntime({
        session: timedFocusSession({ config: sessionConfigV2({ strictness: 'friction' }) }),
      }),
    );
    await controller.openEndGate();
    expect((await controller.confirmGate(null)).code).toBe('gate-not-ready');
    ports.advance(60_000);
    expect((await controller.confirmGate('the wrong phrase')).code).toBe('confirmation-mismatch');
    expect((await controller.confirmGate(ports.current().gate?.requiredPhrase ?? null)).code).toBe(
      'ok',
    );
    expect(ports.current().session).toBeNull();
  });

  it('spends the bank and begins a pause with a read-back alarm before the commit', async (): Promise<void> => {
    const { controller, ports, effects } = harness(publishedFocusRuntime(), {
      bank: { balanceMs: 600_000 },
    });
    expect((await controller.openGate('pause', null)).code).toBe('ok');
    const response: CommandResponseV2<SessionCommandResultCodeV2> = await confirmOpenGate(
      controller,
      ports,
    );

    expect(response).toEqual({ ok: true, code: 'ok' });
    expect(ports.current().session?.phase).toBe('paused');
    expect(ports.current().enforcementCheckpoint).toBeNull();
    expect(effects.clears).toBeGreaterThan(0);
    expect(ports.bank().balanceMs).toBe(600_000 - DEFAULT_SETTINGS.pause.pauseMs);
    // The replacement alarm is read back before the paused runtime lands, so a refused alarm cannot
    // leave a paused session with nothing to wake it. `writes` is the write count at the call.
    const pausedWrite: number = ports.writes.findIndex(
      (write): boolean => write.session?.phase === 'paused',
    );
    const created: number = ports.alarmCalls.findIndex(
      (call): boolean => call.kind === 'create' && call.name === PHASE_ALARM,
    );
    expect(pausedWrite).toBeGreaterThanOrEqual(0);
    expect(created).toBeGreaterThanOrEqual(0);
    expect(ports.alarmCallWrites[created]).toBe(pausedWrite);
  });

  it('charges the bank and records exactly one event per gate command', async (): Promise<void> => {
    const economy = { ...DEFAULT_SETTINGS.pause };
    const { controller, ports } = harness(publishedFocusRuntime(), {
      bank: { balanceMs: economy.pauseMs * 2 },
      economy,
    });
    expect((await controller.openGate('pause', null)).code).toBe('ok');
    expect(eventsOf(ports, 'gateOpened')).toHaveLength(1);
    const before: number = ports.bank().balanceMs;
    expect((await confirmOpenGate(controller, ports)).code).toBe('ok');

    expect(ports.bank().balanceMs).toBe(before - economy.pauseMs);
    expect(eventsOf(ports, 'pauseTaken')).toHaveLength(1);
    expect(eventsOf(ports, 'pauseTaken')[0]).toMatchObject({ ms: economy.pauseMs });
    expect(ports.current().session?.phase).toBe('paused');
    expect(ports.current().gate).toBeNull();
  });

  it('charges the bank and records one event for an unlock', async (): Promise<void> => {
    const economy = { ...DEFAULT_SETTINGS.pause };
    const { controller, ports } = harness(publishedFocusRuntime(), {
      bank: { balanceMs: economy.unlockMs },
      economy,
    });
    await controller.openGate('unlockSite', 'facebook.com');
    const before: number = ports.bank().balanceMs;
    expect((await confirmOpenGate(controller, ports)).code).toBe('ok');

    expect(ports.bank().balanceMs).toBe(before - economy.unlockMs);
    expect(eventsOf(ports, 'unlockTaken')).toHaveLength(1);
    expect(eventsOf(ports, 'unlockTaken')[0]).toMatchObject({
      host: 'facebook.com',
      ms: economy.unlockMs,
    });
    // One balance buys one unlock: the second confirmation cannot afford its cost.
    expect((await controller.openGate('unlockSite', 'twitter.com')).code).toBe('ok');
    expect((await confirmOpenGate(controller, ports)).code).toBe('end-not-allowed');
    expect(eventsOf(ports, 'unlockTaken')).toHaveLength(1);
    expect(ports.bank().balanceMs).toBe(before - economy.unlockMs);
  });

  it('records a resisted event when a gate is abandoned', async (): Promise<void> => {
    const { controller, ports } = harness(
      publishedFocusRuntime({
        session: timedFocusSession({ config: sessionConfigV2({ strictness: 'friction' }) }),
      }),
    );
    await controller.openEndGate();
    expect((await controller.abandonGate()).code).toBe('ok');

    expect(eventsOf(ports, 'gateOpened')).toHaveLength(1);
    expect(eventsOf(ports, 'gateResisted')).toHaveLength(1);
    expect(eventsOf(ports, 'gateResisted')[0]).toMatchObject({ gate: 'cancel' });
  });

  it('keeps the session and throws when the closure write will not land', async (): Promise<void> => {
    const { controller, ports } = harness(
      publishedFocusRuntime({ session: timedFocusSession({ config: flexibleConfig() }) }),
      { failWrites: true },
    );
    let thrown: unknown = null;
    try {
      await controller.requestSessionEnd();
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).not.toBeNull();
    expect(ports.current().session).not.toBeNull();
    expect(ports.current().pendingClosure).toBeNull();
  });

  it('refuses an economy gate while a transition is durable', async (): Promise<void> => {
    const { controller, ports } = harness(
      transitionRuntime(pendingTransition('start', 'alarm-ready'), {
        session: timedFocusSession(),
      }),
      { bank: { balanceMs: 600_000 } },
    );
    expect((await controller.openGate('pause', null)).code).toBe('end-not-allowed');
    expect((await controller.openGate('unlockSite', 'facebook.com')).code).toBe('end-not-allowed');
    expect(ports.current().gate).toBeNull();
  });

  it('leaves focus durable when the pause alarm cannot be read back', async (): Promise<void> => {
    const { controller, ports } = harness(publishedFocusRuntime(), {
      bank: { balanceMs: 600_000 },
      alarmReadBack: 'missing',
    });
    await controller.openGate('pause', null);
    const before: number = ports.bank().balanceMs;
    await confirmOpenGate(controller, ports);

    expect(ports.current().session?.phase).not.toBe('paused');
    // A refused alarm costs nothing, because the spend and the alarm share one checkpoint.
    expect(eventsOf(ports, 'pauseTaken')).toHaveLength(0);
    expect(ports.commits.every((commit): boolean => commit.bank.balanceMs >= before)).toBe(true);
  });

  it('clears the page an unlock paid for and re-blocks it when the unlock lapses', async (): Promise<void> => {
    const economy = { ...DEFAULT_SETTINGS.pause };
    const { controller, ports } = harness(publishedFocusRuntime(), {
      bank: { balanceMs: economy.unlockMs },
      economy,
    });
    const key: string = documentKey(11, DOC_BLOCKED);
    await controller.handleNavigation(
      { tabId: 11, documentId: DOC_BLOCKED, url: BLOCKED_URL },
      null,
    );
    expect(ports.current().documentCommands[key]?.verdict.blocked).toBe(true);

    await controller.openGate('unlockSite', 'facebook.com');
    expect((await confirmOpenGate(controller, ports)).code).toBe('ok');

    // The live update the purchase commits re-evaluates the verdict, so the page they paid for is
    // clear before they navigate anywhere.
    const bought = ports.current().documentCommands[key];
    expect(bought?.verdict.blocked).toBe(false);
    expect(bought?.presentation).toBe('clear');
    expect(bought?.overlay).toBeNull();

    // And the expiry is the same live update in reverse.
    ports.advance(economy.unlockMs + 1_000);
    await controller.tick();
    const lapsed = ports.current().documentCommands[key];
    expect(ports.current().unlocks).toEqual([]);
    expect(lapsed?.verdict.blocked).toBe(true);
    expect(lapsed?.presentation).toBe('active');
    expect(lapsed?.runtimeRevision).toBeGreaterThan(bought?.runtimeRevision ?? 0);
    expect(sentRevisions(ports)).toContain(lapsed?.runtimeRevision);
  });

  it('takes an expired gate off the overlay and records the resistance', async (): Promise<void> => {
    const { controller, ports } = harness(
      publishedFocusRuntime({
        session: timedFocusSession({ config: sessionConfigV2({ strictness: 'friction' }) }),
      }),
    );
    const key: string = documentKey(11, DOC_BLOCKED);
    await controller.handleNavigation(
      { tabId: 11, documentId: DOC_BLOCKED, url: BLOCKED_URL },
      null,
    );
    expect((await controller.openEndGate()).code).toBe('ok');
    expect(overlayGate(ports.current().documentCommands[key])).not.toBeNull();

    // A gate the user walked away from lapses on the shared window, not a private one.
    ports.advance(GATE_EXPIRY_MS + ports.gateSettings().delayMs + 1_000);
    await controller.tick();

    expect(ports.current().gate).toBeNull();
    expect(eventsOf(ports, 'gateResisted')).toHaveLength(1);
    expect(eventsOf(ports, 'gateResisted')[0]).toMatchObject({ gate: 'cancel' });
    // The overlay the page is still showing loses the controls the gate gave it.
    const cleared = ports.current().documentCommands[key];
    expect(overlayGate(cleared)).toBeNull();
    expect(sentRevisions(ports)).toContain(cleared?.runtimeRevision);
  });

  it('adds a site unlock for an unlock gate', async (): Promise<void> => {
    const { controller, ports } = harness(publishedFocusRuntime(), {
      bank: { balanceMs: 600_000 },
    });
    expect((await controller.openGate('unlockSite', 'facebook.com')).code).toBe('ok');
    expect((await confirmOpenGate(controller, ports)).code).toBe('ok');

    expect(ports.current().unlocks).toContainEqual({
      host: 'facebook.com',
      until: ports.now() + DEFAULT_SETTINGS.pause.unlockMs,
    });
    expect(ports.current().gate).toBeNull();
    expect(ports.bank().balanceMs).toBe(600_000 - DEFAULT_SETTINGS.pause.unlockMs);
  });

  it('resumes from a pause and starts the next focus early from a break', async (): Promise<void> => {
    const paused = harness(pausedRuntime());
    expect((await paused.controller.resumeFromPause()).code).toBe('ok');
    expect(paused.ports.current().session?.phase).toBe('focus');

    // The core requires two minutes of break before an early focus and the boundary must still be
    // ahead, so the fixture's break runs long enough for both.
    const longBreak: SessionStateV2 = breakSession({
      phaseEndsAt: breakSession().phaseStartedAt + 600_000,
    });
    const onBreak = harness(breakRuntime({ session: longBreak }), {
      now: longBreak.phaseStartedAt + 150_000,
    });
    expect((await onBreak.controller.startNextFocusEarly()).code).toBe('ok');
    expect(onBreak.ports.current().session?.phase).toBe('focus');
  });

  it('answers retry codes for the wrong journal and a live batch', async (): Promise<void> => {
    const idle = harness();
    expect((await idle.controller.retryTransitionCleanup()).code).toBe('retry-not-available');
    expect((await idle.controller.retryClosureCleanup()).code).toBe('retry-not-available');

    const live = harness(
      transitionRuntime(cleanupTransition('start', 'prepared', 'start-abandon')),
    );
    expect((await live.controller.retryClosureCleanup()).code).toBe('retry-not-available');
    expect((await live.controller.retryTransitionCleanup()).code).toBe('retry-not-available');
  });
});

describe('SessionControllerV2 alarms and ticks', (): void => {
  it('ignores an unknown or hostile alarm name', async (): Promise<void> => {
    const { controller, ports } = harness(publishedFocusRuntime());
    await controller.handleAlarm('not-an-alarm');
    await controller.handleAlarm(`${TICK_ALARM} `);
    expect(ports.writes).toHaveLength(0);
  });

  it('runs a tick that publishes the current projection', async (): Promise<void> => {
    const { controller, effects } = harness();
    await controller.recover();
    await controller.handleAlarm(TICK_ALARM);
    expect(effects.broadcasts.length).toBeGreaterThan(0);
    expect(effects.badges.length).toBeGreaterThan(0);
  });

  it('walks each finished local day, settling before it asks the Engine to close it', async (): Promise<void> => {
    const session: SessionStateV2 = timedFocusSession();
    const today: string = localDateStr(session.phaseStartedAt);
    const twoDaysBack: string = localDateStr(session.phaseStartedAt - 2 * 86_400_000);
    const oneDayBack: string = localDateStr(session.phaseStartedAt - 86_400_000);
    const single = harness(publishedFocusRuntime({ session, date: oneDayBack, todayAgg: null }), {
      now: session.phaseStartedAt + 60_000,
    });
    single.ports.onRolloverAdvanceDate = true;
    await single.controller.tick();
    expect(single.ports.rollovers).toEqual([localMidnightAfter(oneDayBack)]);
    expect(single.ports.current().date).toBe(today);

    const double = harness(publishedFocusRuntime({ session, date: twoDaysBack, todayAgg: null }), {
      now: session.phaseStartedAt + 60_000,
    });
    double.ports.onRolloverAdvanceDate = true;
    await double.controller.tick();
    expect(double.ports.rollovers).toEqual([
      localMidnightAfter(twoDaysBack),
      localMidnightAfter(oneDayBack),
    ]);
    expect(double.ports.current().date).toBe(today);
  });

  it('hands a future date backward to the Engine in one call', async (): Promise<void> => {
    const session: SessionStateV2 = timedFocusSession();
    const ahead: string = localDateStr(session.phaseStartedAt + 3 * 86_400_000);
    const { controller, ports } = harness(
      publishedFocusRuntime({ session, date: ahead, todayAgg: null }),
      { now: session.phaseStartedAt + 60_000 },
    );
    await controller.tick();

    expect(ports.rollovers).toEqual([session.phaseStartedAt + 60_000]);
  });

  it('settles the durable session and expires what the instant expires', async (): Promise<void> => {
    // The local date rollover is not the controller's: `runtime.date` and `todayAgg` belong to the
    // retained Engine and `RuntimePortsV2` exposes no port for them. See the task report.
    const session: SessionStateV2 = timedFocusSession();
    const { controller, ports } = harness(
      publishedFocusRuntime({
        session,
        unlocks: [{ host: 'expired.example', until: session.phaseStartedAt + 1_000 }],
      }),
      { now: session.phaseStartedAt + 120_000 },
    );
    await controller.recover();
    await controller.tick();
    const after: RuntimeStateV2 = ports.current();

    expect(after.unlocks).toEqual([]);
    expect(after.session?.phaseStartedAt).toBe(session.phaseStartedAt);
    expect(controller.snapshot(ports.now()).sessionFocusedMs).toBeGreaterThan(0);
  });

  it('dispatches a cleanup alarm only to its own journal', async (): Promise<void> => {
    const transition = harness(
      transitionRuntime(cleanupTransition('start', 'prepared', 'start-abandon')),
    );
    await transition.controller.handleAlarm(TRANSITION_CLEANUP_ALARM);
    expect(transition.ports.writes.length).toBeGreaterThan(0);

    const closure = harness(cleanupClosureRuntime());
    const before: number = closure.ports.writes.length;
    await closure.controller.handleAlarm(TRANSITION_CLEANUP_ALARM);
    expect(closure.ports.writes).toHaveLength(before);
  });

  it('retries a due cleanup from a tick, because tick reads the durable journal', async (): Promise<void> => {
    const { controller, ports } = harness(
      transitionRuntime(cleanupTransition('start', 'prepared', 'start-abandon')),
    );
    await controller.tick();
    expect(ports.sends.length).toBeGreaterThan(0);
  });
});

describe('SessionControllerV2 navigation and documents', (): void => {
  const target: { tabId: number; documentId: string; url: string } = {
    tabId: 11,
    documentId: DOC_ONE,
    url: BLOCKED_URL,
  };

  it('records an attempt only for a blocked verdict with a non-null kind', async (): Promise<void> => {
    const { controller, effects } = harness(publishedFocusRuntime());
    await controller.handleNavigation(target, 'navigation');
    expect(effects.attempts).toEqual([{ url: BLOCKED_URL, tabId: 11, kind: 'navigation' }]);

    const sweeping = harness(publishedFocusRuntime());
    await sweeping.controller.handleNavigation(target, null);
    expect(sweeping.effects.attempts).toHaveLength(0);
  });

  it('freezes a late document into the tuple the frozen ones already hold', async (): Promise<void> => {
    const { controller, ports } = harness(publishedFocusRuntime());
    const before: RuntimeStateV2 = ports.current();
    await controller.handleNavigation(
      { tabId: 11, documentId: DOC_BLOCKED, url: BLOCKED_URL },
      null,
    );

    // While the command map is the current authority every command repeats the runtime revision,
    // so a late arrival joins that revision instead of raising it out from under the others.
    const after: RuntimeStateV2 = ports.current();
    expect(parseRuntimeStateV2(after)).not.toBeNull();
    expect(after.runtimeRevision).toBe(before.runtimeRevision);
    expect(after.documentCommands[documentKey(11, DOC_BLOCKED)]?.runtimeRevision).toBe(
      before.runtimeRevision,
    );
    expect(after.documentCommands[documentKey(11, DOC_ONE)]).toEqual(
      before.documentCommands[documentKey(11, DOC_ONE)],
    );
  });

  it('routes a navigation to the journal that owns the target', async (): Promise<void> => {
    // A closure cleanup owns its clear batch, and a navigation joins it.
    const closing = harness(cleanupClosureRuntime());
    const target = { tabId: 11, documentId: DOC_BLOCKED, url: BLOCKED_URL };
    expect(
      Object.keys(closing.ports.current().pendingClosure?.cleanupProgress?.clearCommands ?? {}),
    ).not.toContain(documentKey(11, DOC_BLOCKED));
    await closing.controller.handleNavigation(target, 'navigation');
    const closure = closing.ports.current().pendingClosure;

    expect(parseRuntimeStateV2(closing.ports.current())).not.toBeNull();
    expect(Object.keys(closure?.cleanupProgress?.clearCommands ?? {})).toContain(
      documentKey(11, DOC_BLOCKED),
    );
    expect(closing.ports.sends.some((sent): boolean => sent.documentId === DOC_BLOCKED)).toBe(true);
    // A cleanup page is not a blocked page, so nothing is recorded as an attempt.
    expect(closing.effects.attempts).toHaveLength(0);

    // A committed transition owns its frozen view, and a navigation joins that instead.
    const starting = harness(
      transitionRuntime(pendingTransition('start', 'alarm-ready'), {
        session: timedFocusSession(),
      }),
    );
    await starting.controller.handleNavigation(target, 'navigation');
    const view = starting.ports.current().pendingEnforcementTransition?.activeView;

    expect(parseRuntimeStateV2(starting.ports.current())).not.toBeNull();
    expect(Object.keys(view?.documents ?? {})).toContain(documentKey(11, DOC_BLOCKED));
    expect(starting.ports.sends.some((sent): boolean => sent.documentId === DOC_BLOCKED)).toBe(
      true,
    );
  });

  it('returns the reset command before the newest persisted command', async (): Promise<void> => {
    const { controller, ports } = harness(publishedFocusRuntime({ epochResetAcks: {} }));
    const commands = await controller.documentCommandsFor(target, null);

    expect(commands[0]?.command).toBe('reset-enforcement-epoch');
    expect(commands[1]?.command).toBe('apply-enforcement');
    expect(ports.current().documentCommands[documentKey(11, DOC_ONE)]).toBeDefined();
  });

  it('applies the attempt rule to documentCommandsFor as well', async (): Promise<void> => {
    const { controller, effects } = harness(publishedFocusRuntime());
    await controller.documentCommandsFor(target, 'existing');
    expect(effects.attempts).toEqual([{ url: BLOCKED_URL, tabId: 11, kind: 'existing' }]);
  });

  it('sources stoppedPage from the durable tab claim', async (): Promise<void> => {
    const { controller } = harness(
      publishedFocusRuntime({
        documentCommands: {},
        tabStates: { 11: { muteUrl: null, priorMuted: null, stoppedDocumentId: DOC_ONE } },
      }),
    );
    const commands = await controller.documentCommandsFor(target, null);
    const applied = commands.find((command): boolean => command.command === 'apply-enforcement');

    expect(applied?.command === 'apply-enforcement' ? applied.overlay?.stoppedPage : null).toBe(
      true,
    );
  });

  it('refreshes a checkpoint record only for a target the checkpoint already named', async (): Promise<void> => {
    const { controller, ports } = harness(publishedFocusRuntime());
    const command = ports.current().documentCommands[documentKey(11, DOC_ONE)];
    const named = ports.current().enforcementCheckpoint?.documents[0];
    if (command === undefined || named === undefined) throw new Error('expected a verified target');
    const refreshed = {
      ...structuredClone(named),
      tabId: command.tabId,
      documentId: command.documentId,
      url: command.expectedUrl,
      operationId: command.operationId,
      enforcementEpoch: command.enforcementEpoch,
      basePolicyRevision: command.basePolicyRevision,
      runtimeRevision: command.runtimeRevision,
      verdict: structuredClone(command.verdict),
      handledAt: ports.now(),
    };
    await controller.recordDocumentAck(refreshed);
    expect(ports.current().enforcementCheckpoint?.documents).toContainEqual(refreshed);

    // An ack for a document the checkpoint never verified adds nothing.
    const before: RuntimeStateV2 = ports.current();
    await controller.recordDocumentAck({ ...refreshed, tabId: 99, documentId: 'document-99' });
    expect(ports.current().enforcementCheckpoint).toEqual(before.enforcementCheckpoint);
    // Nor does one for another epoch.
    await controller.recordDocumentAck({ ...refreshed, enforcementEpoch: OTHER_EPOCH_ID });
    expect(ports.current().enforcementCheckpoint).toEqual(before.enforcementCheckpoint);
    // Nor one for a live operation the checkpoint itself never ran: a live refresh re-freezes the
    // commands under a new operation while the checkpoint keeps the one it verified.
    await controller.refreshLiveViews();
    const live = ports.current().documentCommands[documentKey(11, DOC_ONE)];
    if (live === undefined) throw new Error('expected a refrozen command');
    expect(live.operationId).not.toBe(ports.current().enforcementCheckpoint?.operationId);
    const stale: RuntimeStateV2 = ports.current();
    await controller.recordDocumentAck({
      ...refreshed,
      operationId: live.operationId,
      runtimeRevision: live.runtimeRevision,
    });
    expect(ports.current().enforcementCheckpoint).toEqual(stale.enforcementCheckpoint);
  });

  it('refreshes every live view under a new operation and a higher revision', async (): Promise<void> => {
    const { controller, ports } = harness(publishedFocusRuntime());
    const before: RuntimeStateV2 = ports.current();
    await controller.refreshLiveViews();
    const after: RuntimeStateV2 = ports.current();

    expect(after.runtimeRevision).toBeGreaterThan(before.runtimeRevision);
    expect(after.enforcementCheckpoint).toEqual(before.enforcementCheckpoint);
    for (const command of Object.values(after.documentCommands)) {
      expect(command.runtimeRevision).toBe(after.runtimeRevision);
    }
  });
});

describe('SessionControllerV2 publication and serialization', (): void => {
  it('settles the read through its own instant past a finite phase end', async (): Promise<void> => {
    // A cycling session, so the boundary one second back is a phase end rather than the session end.
    const cycling = { focusMin: 10, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 };
    const focusEndsAt: number = ACTIVATION_AT + 600_000;
    const sessionEndsAt: number = timedFocusSession().sessionEndsAt ?? 0;
    const { controller } = harness(
      publishedFocusRuntime({
        session: timedFocusSession({
          config: sessionConfigV2({ cycling }),
          phaseEndsAt: focusEndsAt,
          sessionEndsAt,
        }),
      }),
    );
    const at: number = focusEndsAt + 1_000;
    const snapshot: SessionSnapshotV2 = controller.snapshot(at);

    // Spec 358: the read settles first, so it is the break the user is in, with focus capped at the
    // boundary rather than still running past it.
    expect(isSessionSnapshotV2(snapshot)).toBe(true);
    expect(snapshot.phase).toBe('break');
    expect(snapshot.sessionFocusedMs).toBe(focusEndsAt - ACTIVATION_AT);
    expect(snapshot.phaseEndsAt).toBeGreaterThan(at);
  });

  it('rolls focus into its break as a live update the pages can see', async (): Promise<void> => {
    const cycling = { focusMin: 10, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 };
    const focusEndsAt: number = ACTIVATION_AT + 600_000;
    const { controller, ports, effects } = harness(
      publishedFocusRuntime({
        unlocks: [],
        session: timedFocusSession({
          config: sessionConfigV2({ cycling }),
          phaseEndsAt: focusEndsAt,
          sessionEndsAt: timedFocusSession().sessionEndsAt ?? 0,
        }),
      }),
    );
    const key: string = documentKey(11, DOC_BLOCKED);
    await controller.handleNavigation(
      { tabId: 11, documentId: DOC_BLOCKED, url: BLOCKED_URL },
      null,
    );
    expect(ports.current().documentCommands[key]?.verdict.blocked).toBe(true);

    ports.advance(focusEndsAt + 1_000 - ports.now());
    await controller.tick();

    // The break is durable, publishable, and visible: no focus checkpoint attests a phase that
    // ended, and every open document gets the clear the new phase means.
    const after: RuntimeStateV2 = ports.current();
    expect(parseRuntimeStateV2(after)).not.toBeNull();
    expect(after.session?.phase).toBe('break');
    expect(after.enforcementCheckpoint).toBeNull();
    expect(after.documentCommands[key]?.presentation).toBe('clear');
    expect(sentRevisions(ports)).toContain(after.documentCommands[key]?.runtimeRevision);
    expect(effects.clears).toBeGreaterThan(0);
    expect(controller.snapshot(ports.now()).lifecycle.kind).toBe('active');
  });

  it('reports the idle shape for a boundary this worker has not written yet', async (): Promise<void> => {
    const { controller } = harness(publishedFocusRuntime());
    const session = publishedFocusRuntime().session;
    const past: number = (session?.sessionEndsAt ?? 0) + 1_000;
    const snapshot: SessionSnapshotV2 = controller.snapshot(past);

    // A completed timer needs a closure no read can run, and the validator rejects an active
    // snapshot past its own end, so the read reports what the next tick will make durable.
    expect(isSessionSnapshotV2(snapshot)).toBe(true);
    expect(snapshot.phase).toBe('idle');
    expect(snapshot.config).toBeNull();
  });

  it('builds a valid snapshot and never broadcasts before recover', async (): Promise<void> => {
    const { controller, ports, effects } = harness(publishedFocusRuntime());
    const snapshot: SessionSnapshotV2 = controller.snapshot(ports.now());

    expect(isSessionSnapshotV2(snapshot)).toBe(true);
    expect(effects.broadcasts).toHaveLength(0);
    await controller.recover();
    expect(effects.broadcasts.length).toBeGreaterThan(0);
    expect(controller.hasActiveSession()).toBe(true);
  });

  it('projects starting for a committed transition', (): void => {
    const { controller, ports } = harness(
      transitionRuntime(pendingTransition('start', 'alarm-ready'), {
        session: timedFocusSession(),
      }),
    );
    const snapshot: SessionSnapshotV2 = controller.snapshot(ports.now());

    expect(snapshot.lifecycle.kind).toBe('starting');
    expect(snapshot.phase).toBe('idle');
    expect(isSessionSnapshotV2(snapshot)).toBe(true);
  });

  it('serializes two concurrent end requests into one closure', async (): Promise<void> => {
    const { controller, ports } = harness(
      publishedFocusRuntime({ session: timedFocusSession({ config: flexibleConfig() }) }),
    );
    const [first, second] = await Promise.all([
      controller.requestSessionEnd(),
      controller.requestSessionEnd(),
    ]);
    const codes: string[] = [first.code, second.code].sort();

    expect(codes).toEqual(['no-active-session', 'ok']);
    expect(ports.current().session).toBeNull();
  });
});

describe('SessionControllerV2 recovery', (): void => {
  it('recovers each journal stage and publishes the recovered lifecycle', async (): Promise<void> => {
    const runtimes: readonly RuntimeStateV2[] = [
      emptyRuntimeV2({ runtimeRevision: 0 }),
      publishedFocusRuntime(),
      transitionRuntime(pendingTransition('start', 'prepared')),
      cleanupClosureRuntime(),
    ];

    for (const runtime of runtimes) {
      const { controller, ports, effects } = harness(runtime);
      await controller.recover();
      const last: SessionSnapshotV2 | undefined = effects.broadcasts[effects.broadcasts.length - 1];

      expect(effects.broadcasts.length).toBeGreaterThan(0);
      expect(last?.lifecycle.kind).toBe(controller.snapshot(ports.now()).lifecycle.kind);
      expect(isSessionSnapshotV2(last as SessionSnapshotV2)).toBe(true);
    }
  });

  it('answers every command with a code rather than throwing across the boundary', async (): Promise<void> => {
    const { controller } = harness(
      transitionRuntime(cleanupTransition('resume', 'prepared', 'resume-restore'), {
        session: pausedSession(),
      }),
    );
    const responses: ReadonlyArray<CommandResponseV2<SessionCommandResultCodeV2>> =
      await Promise.all([
        controller.requestSessionEnd(),
        controller.openEndGate(),
        controller.abandonGate(),
        controller.confirmGate(null),
        controller.openGate('pause', null),
        controller.resumeFromPause(),
        controller.startNextFocusEarly(),
      ]);

    for (const response of responses) {
      expect(response).toEqual({
        ok: false,
        code: 'transition-cleanup-pending',
        error: 'transition-cleanup-pending',
      });
    }
  });
});

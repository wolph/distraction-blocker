import { describe, expect, it } from 'vitest';
import { TRANSITION_CLEANUP_ALARM } from '../../../src/background/alarms-v2';
import type { FrozenDocumentCommand } from '../../../src/background/enforcement-persistence-v2';
import type { RuntimeCommitInputV2 } from '../../../src/background/runtime-checkpoint-v2';
import type { RuntimePortsV2 } from '../../../src/background/runtime-ports-v2';
import type {
  CleanupProgress,
  CleanupRetryState,
  CleanupTabClaim,
  PendingClosure,
  PendingEnforcementTransition,
  PostCleanupClosure,
  RuntimeStateV2,
} from '../../../src/background/runtime-v2-types';
import { parseRuntimeStateV2 } from '../../../src/background/runtime-v2-validation';
import {
  type CleanupEffectPortsV2,
  enterTransitionCleanupV2,
  handleCleanupNavigationV2,
  retryTransitionCleanupV2,
  runTransitionCleanupAttemptV2,
} from '../../../src/background/transition-cleanup-v2';
import { emptyDaily } from '../../../src/core/stats';
import { CLEANUP_MAX_AUTOMATIC_ATTEMPTS } from '../../../src/shared/constants';
import type { DocumentContentCommand } from '../../../src/shared/enforcement-v2';
import { CoreError } from '../../../src/shared/errors';
import { syncAggKey } from '../../../src/shared/storage-keys';
import { localDateStr } from '../../../src/shared/time';
import type { DailyAgg, SessionStateV2 } from '../../../src/shared/types';
import {
  appliedResponseFor,
  createRuntimePortsFakeV2,
  type FakeResponderV2,
  type FakeSendV2,
  noReceiverResponder,
  type RuntimePortsFakeV2,
} from './runtime-ports-fake';
import {
  ACTIVATION_AT,
  CLEANUP_OPERATION_ID,
  commitCheckpointRuntime,
  documentKey,
  emptyRuntimeV2,
  OTHER_OPERATION_ID,
  pausedSession,
  pendingTransition,
  SESSION_ID,
  timedFocusSession,
  transitionRuntime,
} from './runtime-v2-fixtures';

const DOC_ONE: string = 'document-1';
const BLOCKED_URL: string = 'https://facebook.com/feed';

/**
 * Production restores the tabs it can and answers with those alone, so a claim it could not settle
 * comes back unresolved. `unresolved` names the tab ids this fake withholds, which is the only way
 * a test can ask what this journal does with a claim that did not settle.
 */
function effectsFake(
  onRestore?: () => Promise<void> | void,
  unresolved: readonly number[] = [],
): CleanupEffectPortsV2 & { badges: number; reloaded: number } {
  const record = {
    badges: 0,
    reloaded: 0,
    restoreTabClaims: async (claims: readonly CleanupTabClaim[]): Promise<number[]> => {
      await onRestore?.();
      return claims
        .map((claim: CleanupTabClaim): number => claim.tabId)
        .filter((tabId: number): boolean => !unresolved.includes(tabId));
    },
    reloadStoppedDocuments: async (): Promise<void> => {
      record.reloaded += 1;
    },
    requestBlankBadge: (): void => {
      record.badges += 1;
    },
  };
  return record;
}

/** A committed start whose durable focus session the cleanup causes can close. */
function committedRuntime(): RuntimeStateV2 {
  return transitionRuntime(pendingTransition('start', 'alarm-ready'), {
    session: timedFocusSession(),
    tabStates: { 11: { muteUrl: BLOCKED_URL, priorMuted: false, stoppedDocumentId: DOC_ONE } },
  });
}

/** A pre-commit start, which abandons rather than closing anything. */
function preCommitRuntime(): RuntimeStateV2 {
  return transitionRuntime(pendingTransition('start', 'registration-audited'));
}

function fakeFor(
  runtime: RuntimeStateV2,
  options: Parameters<typeof createRuntimePortsFakeV2>[1] = {},
): RuntimePortsFakeV2 {
  return createRuntimePortsFakeV2(runtime, {
    now: ACTIVATION_AT + 30_000,
    ids: [CLEANUP_OPERATION_ID, OTHER_OPERATION_ID],
    tabs: [{ tabId: 11, url: BLOCKED_URL, documentId: DOC_ONE }],
    ...options,
  });
}

function storedTransition(fake: RuntimePortsFakeV2): PendingEnforcementTransition {
  const transition: PendingEnforcementTransition | null =
    fake.current().pendingEnforcementTransition;
  if (transition === null) throw new Error('expected a durable transition');
  return transition;
}

function storedProgress(fake: RuntimePortsFakeV2): CleanupProgress {
  const progress: CleanupProgress | null = storedTransition(fake).cleanupProgress;
  if (progress === null) throw new Error('expected durable cleanup progress');
  return progress;
}

describe('enterTransitionCleanupV2', (): void => {
  it('installs the clear batch and the runtime command map in one write', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(preCommitRuntime());
    const before: RuntimeStateV2 = fake.current();
    const next: RuntimeStateV2 = await enterTransitionCleanupV2(fake, {
      cause: 'start-abandon',
      failure: 'tab-enforcement-failed',
      endedAt: fake.now(),
    });
    const transition: PendingEnforcementTransition = storedTransition(fake);
    const progress: CleanupProgress = storedProgress(fake);

    expect(fake.writes).toHaveLength(1);
    expect(transition.stage).toBe('cleanup');
    expect(transition.cleanupFrom).toBe('registration-audited');
    expect(transition.cleanupCause).toBe('start-abandon');
    expect(transition.failure).toBe('tab-enforcement-failed');
    expect(transition.preparedTargetReservations).toEqual({});
    expect(progress.cleanupOperationId).toBe(CLEANUP_OPERATION_ID);
    expect(progress.clearRuntimeRevision).toBeGreaterThan(before.runtimeRevision);
    expect(progress.clearRuntimeRevision).toBeGreaterThan(
      before.pendingEnforcementTransition?.startingView.runtimeRevision ?? 0,
    );
    expect(progress.resolvedTabIds).toEqual([]);
    expect(progress.retry.batch).toBe(1);
    expect(progress.retry.automaticAttempt).toBe(0);
    expect(progress.retry.nextAttemptAt).toBe(fake.now());
    expect(next.runtimeRevision).toBe(progress.clearRuntimeRevision);
    expect(next.documentCommands).toEqual(progress.clearCommands);
    expect(Object.keys(progress.clearCommands).length).toBeGreaterThan(0);
    expect(fake.sends).toHaveLength(0);
    expect(fake.alarmCalls).toHaveLength(0);
  });

  it('writes its entry while a commit is in flight', async (): Promise<void> => {
    // The entry composes a new transition, which is a projected field, so with a checkpoint
    // outstanding it wrote a runtime the checkpoint no longer described and the storage boundary
    // refused it. A refused entry leaves the transition where it was, so nothing cleans up.
    const fake: RuntimePortsFakeV2 = fakeFor(commitCheckpointRuntime(committedRuntime()));

    await enterTransitionCleanupV2(fake, {
      cause: 'manual-end',
      failure: null,
      endedAt: fake.now(),
    });

    expect(storedTransition(fake).stage).toBe('cleanup');
    expect(fake.current().commitCheckpoint?.projection.pendingEnforcementTransition).toEqual(
      storedTransition(fake),
    );
  });

  it('freezes clear commands under the identity the source stage had', async (): Promise<void> => {
    const reserved: RuntimePortsFakeV2 = fakeFor(preCommitRuntime());
    await enterTransitionCleanupV2(reserved, {
      cause: 'start-abandon',
      failure: null,
      endedAt: reserved.now(),
    });
    for (const command of Object.values(storedProgress(reserved).clearCommands)) {
      expect(command.sessionId).toBeNull();
      expect(command.reservedSessionId).toBe(SESSION_ID);
      expect(command.presentation).toBe('clear');
      expect(command.overlay).toBeNull();
    }

    const durable: RuntimePortsFakeV2 = fakeFor(committedRuntime());
    await enterTransitionCleanupV2(durable, {
      cause: 'manual-end',
      failure: null,
      endedAt: durable.now(),
    });
    for (const command of Object.values(storedProgress(durable).clearCommands)) {
      expect(command.sessionId).toBe(SESSION_ID);
      expect(command.reservedSessionId).toBeNull();
    }
  });

  it('captures a closure for exactly the causes that end a durable session', async (): Promise<void> => {
    const closing: ReadonlyArray<['timer-completed' | 'manual-end' | 'transition-failed', string]> =
      [
        ['timer-completed', 'timer-completed'],
        ['manual-end', 'manual-canceled'],
        ['transition-failed', 'alarm-failed'],
      ];

    for (const [cause, reason] of closing) {
      const fake: RuntimePortsFakeV2 = fakeFor(committedRuntime());
      await enterTransitionCleanupV2(fake, {
        cause,
        failure: cause === 'transition-failed' ? 'alarm-failed' : null,
        endedAt: fake.now(),
      });
      const transition: PendingEnforcementTransition = storedTransition(fake);
      expect(transition.postCleanupClosure?.projection.reason).toBe(reason);
      expect(transition.postCleanupClosure?.projection.endedAt).toBe(fake.now());
      expect(transition.postCleanupClosure?.projection.sessionId).toBe(SESSION_ID);
      expect(transition.postCleanupClosure?.cleanupSeed.tabClaims.length).toBeGreaterThan(0);
      expect(fake.current().session).not.toBeNull();
    }

    for (const cause of ['start-abandon', 'resume-restore'] as const) {
      const runtime: RuntimeStateV2 =
        cause === 'start-abandon'
          ? preCommitRuntime()
          : transitionRuntime(pendingTransition('resume', 'registration-audited'), {
              session: pausedSession(),
            });
      const fake: RuntimePortsFakeV2 = fakeFor(runtime);
      await enterTransitionCleanupV2(fake, { cause, failure: null, endedAt: fake.now() });
      expect(storedTransition(fake).postCleanupClosure).toBeNull();
      expect(fake.current().session).toEqual(cause === 'start-abandon' ? null : pausedSession());
    }
  });

  it('releases reservations with an empty batch after an audit failure', async (): Promise<void> => {
    // Spec 766: no clear is sent before registration is audited, so there is nothing to clear.
    for (const failure of ['website-access-lost', 'content-registration-failed'] as const) {
      const fake: RuntimePortsFakeV2 = fakeFor(preCommitRuntime());
      await enterTransitionCleanupV2(fake, {
        cause: 'start-abandon',
        failure,
        endedAt: fake.now(),
      });
      const progress: CleanupProgress = storedProgress(fake);

      expect(progress.targets).toEqual({});
      expect(progress.clearCommands).toEqual({});
      expect(storedTransition(fake).preparedTargetReservations).toEqual({});
      expect(fake.current().documentCommands).toEqual({});

      const resolved: RuntimeStateV2 = await runTransitionCleanupAttemptV2(fake, effectsFake());
      expect(fake.sends).toHaveLength(0);
      expect(resolved.pendingEnforcementTransition).toBeNull();
    }
  });

  it('releases reservations with an empty batch from the pre-audit stage', async (): Promise<void> => {
    // Spec 766 keys the exemption on the stage, not on the failure that reached it: an abandon at
    // `prepared` carries no failure at all, and nothing was sent from that stage either.
    const fake: RuntimePortsFakeV2 = fakeFor(
      transitionRuntime(pendingTransition('start', 'prepared')),
    );

    await enterTransitionCleanupV2(fake, {
      cause: 'start-abandon',
      failure: null,
      endedAt: fake.now(),
    });

    expect(storedProgress(fake).clearCommands).toEqual({});
    expect(storedProgress(fake).targets).toEqual({});
    expect(fake.current().documentCommands).toEqual({});
    expect(fake.sends).toHaveLength(0);
  });

  it('keeps the frozen batch for a failure after the audit', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(preCommitRuntime());
    await enterTransitionCleanupV2(fake, {
      cause: 'start-abandon',
      failure: 'tab-enforcement-failed',
      endedAt: fake.now(),
    });

    expect(Object.keys(storedProgress(fake).clearCommands).length).toBeGreaterThan(0);
  });

  it('refuses a transition-failed cleanup that names no failure', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(committedRuntime());
    await expect(
      enterTransitionCleanupV2(fake, {
        cause: 'transition-failed',
        failure: null,
        endedAt: fake.now(),
      }),
    ).rejects.toThrow(CoreError);
    expect(fake.writes).toHaveLength(0);
  });
});

describe('runTransitionCleanupAttemptV2', (): void => {
  async function inCleanup(
    runtime: RuntimeStateV2,
    cause: Parameters<typeof enterTransitionCleanupV2>[1]['cause'],
    failure: Parameters<typeof enterTransitionCleanupV2>[1]['failure'] = null,
    options: Parameters<typeof createRuntimePortsFakeV2>[1] = {},
  ): Promise<RuntimePortsFakeV2> {
    const fake: RuntimePortsFakeV2 = fakeFor(runtime, options);
    await enterTransitionCleanupV2(fake, { cause, failure, endedAt: fake.now() });
    return fake;
  }

  it('clears owned alarms, blanks the badge, and reissues the frozen clear commands', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = await inCleanup(committedRuntime(), 'manual-end');
    const effects = effectsFake();
    const frozen = structuredClone(storedProgress(fake).clearCommands);
    await runTransitionCleanupAttemptV2(fake, effects);

    expect(fake.alarmCalls.some((call): boolean => call.kind === 'clear')).toBe(true);
    expect(effects.badges).toBeGreaterThan(0);
    expect(effects.reloaded).toBeGreaterThan(0);
    const cleared: FakeSendV2[] = fake.sends.filter(
      (send: FakeSendV2): boolean => send.message.command === 'apply-enforcement',
    );
    expect(cleared.length).toBeGreaterThan(0);
    for (const send of cleared) {
      const command: FrozenDocumentCommand | undefined =
        frozen[documentKey(send.tabId, send.documentId)];
      const message: DocumentContentCommand = send.message;
      expect(command).toBeDefined();
      if (message.command !== 'apply-enforcement') throw new Error('expected an enforcement send');
      expect(message.operationId).toBe(command?.operationId);
      expect(message.runtimeRevision).toBe(command?.runtimeRevision);
    }
  });

  it('resolves a start-abandon by clearing the transition and keeping the revisions', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = await inCleanup(preCommitRuntime(), 'start-abandon');
    const clearRevision: number = storedProgress(fake).clearRuntimeRevision;
    const baseRevision: number = fake.current().basePolicyRevision;
    const resolved: RuntimeStateV2 = await runTransitionCleanupAttemptV2(fake, effectsFake());

    expect(resolved.pendingEnforcementTransition).toBeNull();
    expect(resolved.pendingClosure).toBeNull();
    expect(resolved.session).toBeNull();
    expect(resolved.runtimeRevision).toBe(clearRevision);
    expect(resolved.basePolicyRevision).toBe(baseRevision);
    expect(resolved.handledScheduleOccurrences).toEqual(
      preCommitRuntime().handledScheduleOccurrences,
    );
  });

  it('restores a resume by recreating the saved phase alarm before the commit', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = await inCleanup(
      transitionRuntime(pendingTransition('resume', 'registration-audited'), {
        session: pausedSession(),
      }),
      'resume-restore',
    );
    const resolved: RuntimeStateV2 = await runTransitionCleanupAttemptV2(fake, effectsFake());

    expect(resolved.pendingEnforcementTransition).toBeNull();
    expect(resolved.session).toEqual(pausedSession());
    expect(resolved.enforcementCheckpoint).toBeNull();
    expect(fake.alarmCalls.some((call): boolean => call.kind === 'create')).toBe(true);
  });

  it('hands a captured closure to pendingClosure in one checkpoint', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = await inCleanup(committedRuntime(), 'manual-end');
    const captured = storedTransition(fake).postCleanupClosure;
    const transitionClearRevision: number = storedProgress(fake).clearRuntimeRevision;
    const commitsBefore: number = fake.commits.length;
    const resolved: RuntimeStateV2 = await runTransitionCleanupAttemptV2(fake, effectsFake());
    const closure: PendingClosure | null = resolved.pendingClosure;

    expect(fake.commits).toHaveLength(commitsBefore + 1);
    expect(resolved.pendingEnforcementTransition).toBeNull();
    expect(resolved.session).toBeNull();
    expect(closure?.stage).toBe('cleanup');
    expect(closure?.projection).toEqual(captured?.projection);
    expect(closure?.cleanupSeed).toEqual(captured?.cleanupSeed);
    if (closure?.stage !== 'cleanup') throw new Error('expected a cleanup closure');
    expect(closure.cleanupProgress.clearRuntimeRevision).toBeGreaterThan(transitionClearRevision);
    expect(closure.cleanupProgress.cleanupOperationId).not.toBe(CLEANUP_OPERATION_ID);
    expect(resolved.runtimeRevision).toBe(closure.cleanupProgress.clearRuntimeRevision);
    expect(resolved.documentCommands).toEqual(closure.cleanupProgress.clearCommands);
    const commit: RuntimeCommitInputV2 | undefined = fake.commits[commitsBefore];
    expect(commit?.events.length).toBeGreaterThan(0);
    expect(Object.keys(commit?.aggregateSets ?? {}).length).toBeGreaterThan(0);
  });

  it('hands an unresolved claim to the closure that inherits it', async (): Promise<void> => {
    // Production restores what it can and answers with those tabs alone. The closure runner treats
    // a claim it could not settle as a failed attempt; this journal has no such guard, and this is
    // what makes that difference safe for a cause that hands off: the claim travels into the
    // closure journal unresolved, and the closure's own guard then owns it.
    const fake: RuntimePortsFakeV2 = await inCleanup(committedRuntime(), 'manual-end');
    expect(
      storedProgress(fake).tabClaims.map((claim: CleanupTabClaim): number => claim.tabId),
    ).toEqual([11]);

    const resolved: RuntimeStateV2 = await runTransitionCleanupAttemptV2(
      fake,
      effectsFake(undefined, [11]),
    );

    const closure: PendingClosure | null = resolved.pendingClosure;
    if (closure?.stage !== 'cleanup') throw new Error('expected a cleanup closure');
    expect(
      closure.cleanupProgress.tabClaims.map((claim: CleanupTabClaim): number => claim.tabId),
    ).toEqual([11]);
    expect(closure.cleanupProgress.resolvedTabIds).toEqual([]);
  });

  it('clears an abandoned start whose claim never resolved, and nothing inherits it', async (): Promise<void> => {
    // The same unresolved claim under a cause that hands nothing off. The transition clears, so
    // the mute this claim describes outlives every journal that could restore it: there is no
    // pending closure, no transition, and no retry. Measured, not assumed, and the asymmetry with
    // the closure runner's guard is reported rather than closed here, because whether an abandoned
    // start should keep retrying a tab it cannot restore is a rule this file does not own.
    const fake: RuntimePortsFakeV2 = await inCleanup(
      transitionRuntime(pendingTransition('start', 'registration-audited'), {
        tabStates: { 11: { muteUrl: BLOCKED_URL, priorMuted: false, stoppedDocumentId: DOC_ONE } },
      }),
      'start-abandon',
    );
    expect(
      storedProgress(fake).tabClaims.map((claim: CleanupTabClaim): number => claim.tabId),
    ).toEqual([11]);

    const resolved: RuntimeStateV2 = await runTransitionCleanupAttemptV2(
      fake,
      effectsFake(undefined, [11]),
    );

    expect(resolved.pendingEnforcementTransition).toBeNull();
    expect(resolved.pendingClosure).toBeNull();
    expect(fake.alarmCalls.filter((call): boolean => call.kind === 'create')).toEqual([]);
    // And the claim really was unresolved when that happened: no write this attempt made ever
    // recorded tab 11 as settled, so the clear above is the journal ending on an open claim.
    const everResolved: boolean = fake.writes.some((write: RuntimeStateV2): boolean =>
      (write.pendingEnforcementTransition?.cleanupProgress?.resolvedTabIds ?? []).includes(11),
    );
    expect(everResolved).toBe(false);
  });

  it('resolves an attempt while a commit is in flight', async (): Promise<void> => {
    // The attempt's own writes change the transition and the command map, both projected. With a
    // checkpoint outstanding the storage boundary refused the resolve, so the cleanup that had
    // already sent every clear could never record that it had finished, and it retried forever.
    const fake: RuntimePortsFakeV2 = await inCleanup(
      commitCheckpointRuntime(preCommitRuntime()),
      'start-abandon',
    );

    // Anything the attempt commits stays in flight too, so every later write in the attempt runs
    // against an outstanding checkpoint rather than only the first one.
    fake.holdCommitReplay();
    const resolved: RuntimeStateV2 = await runTransitionCleanupAttemptV2(fake, effectsFake());

    expect(resolved.pendingEnforcementTransition).toBeNull();
    expect(fake.current().pendingEnforcementTransition).toBeNull();
    expect(fake.current().commitCheckpoint?.projection.pendingEnforcementTransition).toBeNull();
    expect(fake.current().commitCheckpoint?.projection.documentCommands).toEqual(
      fake.current().documentCommands,
    );

    // And the window closes the way production closes it, leaving the resolved runtime durable
    // with nothing left to replay.
    fake.completeCommitReplay();
    expect(fake.current().commitCheckpoint).toBeNull();
    expect(parseRuntimeStateV2(fake.current())).not.toBeNull();
  });

  it('adopts the ended day and clears the focus watermark with the handoff', async (): Promise<void> => {
    // The closure builder hands over three things and the handoff used to keep one. Without the
    // other two the next session earns no pause budget until it out-focuses the dead one, and the
    // next start on the same day commits the stale aggregate over the one this closure just wrote,
    // losing the completed session and its focus from durable stats.
    const fake: RuntimePortsFakeV2 = await inCleanup(committedRuntime(), 'manual-end');
    const commitsBefore: number = fake.commits.length;

    const resolved: RuntimeStateV2 = await runTransitionCleanupAttemptV2(fake, effectsFake());

    expect(resolved.accruedFocusMs).toBe(0);
    const commit: RuntimeCommitInputV2 | undefined = fake.commits[commitsBefore];
    const endedKey: string = `agg:${fake.deviceId()}:${resolved.date}`;
    expect(commit?.aggregateSets[endedKey]).toBeDefined();
    expect(resolved.todayAgg).toEqual(commit?.aggregateSets[endedKey]);
  });

  it('records a failed attempt and schedules its retry alarm', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = await inCleanup(committedRuntime(), 'manual-end');
    fake.respondForDocument(11, DOC_ONE, noReceiverResponder());
    await runTransitionCleanupAttemptV2(fake, effectsFake());
    const progress: CleanupProgress = storedProgress(fake);

    expect(progress.retry.automaticAttempt).toBe(1);
    expect(progress.retry.lastError).not.toBeNull();
    expect(progress.retry.nextAttemptAt).not.toBeNull();
    expect(
      fake.alarmCalls.some(
        (call): boolean => call.kind === 'create' && call.name === TRANSITION_CLEANUP_ALARM,
      ),
    ).toBe(true);
    expect(storedTransition(fake).stage).toBe('cleanup');
  });

  it('stops scheduling once the twelfth attempt has failed', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = await inCleanup(committedRuntime(), 'manual-end');
    fake.respondForDocument(11, DOC_ONE, noReceiverResponder());
    for (let attempt: number = 0; attempt < CLEANUP_MAX_AUTOMATIC_ATTEMPTS; attempt++) {
      await runTransitionCleanupAttemptV2(fake, effectsFake());
    }
    const progress: CleanupProgress = storedProgress(fake);
    const scheduled: number = fake.alarmCalls.filter(
      (call): boolean => call.kind === 'create' && call.name === TRANSITION_CLEANUP_ALARM,
    ).length;

    expect(progress.retry.automaticAttempt).toBe(CLEANUP_MAX_AUTOMATIC_ATTEMPTS);
    expect(progress.retry.nextAttemptAt).toBeNull();
    expect(scheduled).toBe(CLEANUP_MAX_AUTOMATIC_ATTEMPTS - 1);
  });

  it('reissues the same batch after a restart mid-attempt', async (): Promise<void> => {
    const first: RuntimePortsFakeV2 = await inCleanup(committedRuntime(), 'manual-end');
    first.respondForDocument(11, DOC_ONE, noReceiverResponder());
    await runTransitionCleanupAttemptV2(first, effectsFake());
    const persisted: RuntimeStateV2 = first.current();
    const progress: CleanupProgress = storedProgress(first);

    // The restarted worker meets the same unreachable target, so the batch is still durable and
    // directly comparable with the one the crashed worker persisted.
    const restarted: RuntimePortsFakeV2 = fakeFor(persisted, { ids: [OTHER_OPERATION_ID] });
    restarted.respondForDocument(11, DOC_ONE, noReceiverResponder());
    await runTransitionCleanupAttemptV2(restarted, effectsFake());
    const after: CleanupProgress = storedProgress(restarted);

    expect(after.cleanupOperationId).toBe(progress.cleanupOperationId);
    expect(after.clearRuntimeRevision).toBe(progress.clearRuntimeRevision);
    expect(after.clearCommands).toEqual(progress.clearCommands);
    expect(after.targets).toEqual(progress.targets);
    for (const send of restarted.sends) {
      expect(send.message.operationId).toBe(progress.cleanupOperationId);
    }
  });
});

describe('retryTransitionCleanupV2', (): void => {
  it('refuses a retry unless the batch is exhausted', async (): Promise<void> => {
    const idle: RuntimePortsFakeV2 = fakeFor(emptyRuntimeV2());
    expect((await retryTransitionCleanupV2(idle)).code).toBe('retry-not-available');
    expect(idle.writes).toHaveLength(0);

    const live: RuntimePortsFakeV2 = fakeFor(preCommitRuntime());
    await enterTransitionCleanupV2(live, {
      cause: 'start-abandon',
      failure: null,
      endedAt: live.now(),
    });
    const writes: number = live.writes.length;
    expect((await retryTransitionCleanupV2(live)).code).toBe('retry-not-available');
    expect(live.writes).toHaveLength(writes);
  });

  it('starts the next batch with a new operation and a higher clear revision', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(committedRuntime(), {
      ids: [CLEANUP_OPERATION_ID, OTHER_OPERATION_ID],
    });
    await enterTransitionCleanupV2(fake, {
      cause: 'manual-end',
      failure: null,
      endedAt: fake.now(),
    });
    fake.respondForDocument(11, DOC_ONE, noReceiverResponder());
    for (let attempt: number = 0; attempt < CLEANUP_MAX_AUTOMATIC_ATTEMPTS; attempt++) {
      await runTransitionCleanupAttemptV2(fake, effectsFake());
    }
    const before: CleanupProgress = storedProgress(fake);
    const closureBefore = storedTransition(fake).postCleanupClosure;
    const result = await retryTransitionCleanupV2(fake);
    const after: CleanupProgress = storedProgress(fake);

    expect(result.code).toBe('ok');
    expect(after.cleanupOperationId).toBe(OTHER_OPERATION_ID);
    expect(after.clearRuntimeRevision).toBeGreaterThan(before.clearRuntimeRevision);
    expect(after.retry.batch).toBe(before.retry.batch + 1);
    expect(after.retry.automaticAttempt).toBe(0);
    expect(after.retry.nextAttemptAt).toBe(fake.now());
    expect(after.targets).toEqual(before.targets);
    expect(after.tabClaims).toEqual(before.tabClaims);
    expect(after.resolvedTabIds).toEqual(before.resolvedTabIds);
    expect(storedTransition(fake).postCleanupClosure).toEqual(closureBefore);
    expect(fake.current().runtimeRevision).toBe(after.clearRuntimeRevision);
    expect(fake.current().documentCommands).toEqual(after.clearCommands);
    for (const command of Object.values(after.clearCommands)) {
      expect(command.operationId).toBe(OTHER_OPERATION_ID);
      expect(command.runtimeRevision).toBe(after.clearRuntimeRevision);
    }
  });
});

describe('handleCleanupNavigationV2', (): void => {
  it('adds a newly discovered target durably before it sends clear', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(committedRuntime());
    await enterTransitionCleanupV2(fake, {
      cause: 'manual-end',
      failure: null,
      endedAt: fake.now(),
    });
    const before: CleanupProgress = storedProgress(fake);
    const writes: number = fake.writes.length;
    await handleCleanupNavigationV2(fake, {
      tabId: 12,
      documentId: 'document-12',
      url: 'https://news.example.com/story',
    });
    const after: CleanupProgress = storedProgress(fake);
    const key: string = documentKey(12, 'document-12');

    expect(fake.writes.length).toBeGreaterThan(writes);
    expect(after.targets[key]).toBeDefined();
    expect(after.clearCommands[key]?.operationId).toBe(before.cleanupOperationId);
    expect(after.clearCommands[key]?.runtimeRevision).toBe(before.clearRuntimeRevision);
    for (const [existingKey, command] of Object.entries(before.clearCommands)) {
      expect(after.clearCommands[existingKey]).toEqual(command);
    }
    expect(fake.sends.some((send): boolean => send.documentId === 'document-12')).toBe(true);
    expect(parseRuntimeStateV2(fake.current())).not.toBeNull();
  });

  it('records a discovered target while a commit is in flight', async (): Promise<void> => {
    // Discovery is the shared cleanup step every journal uses, and it writes the progress before
    // it sends. Refused while a checkpoint was outstanding, the document was cleared with nothing
    // durable saying so, so the cleanup could never account for the tab it had already handled.
    const fake: RuntimePortsFakeV2 = fakeFor(commitCheckpointRuntime(committedRuntime()));
    await enterTransitionCleanupV2(fake, {
      cause: 'manual-end',
      failure: null,
      endedAt: fake.now(),
    });

    await handleCleanupNavigationV2(fake, {
      tabId: 12,
      documentId: 'document-12',
      url: 'https://news.example.com/story',
    });

    const key: string = documentKey(12, 'document-12');
    expect(storedProgress(fake).targets[key]).toBeDefined();
    expect(fake.current().commitCheckpoint?.projection.pendingEnforcementTransition).toEqual(
      storedTransition(fake),
    );
  });

  it('resets the discovered document before it sends that document its clear', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(committedRuntime());
    await enterTransitionCleanupV2(fake, {
      cause: 'manual-end',
      failure: null,
      endedAt: fake.now(),
    });

    await handleCleanupNavigationV2(fake, {
      tabId: 12,
      documentId: 'document-12',
      url: 'https://news.example.com/story',
    });

    // A document found by navigation has never acknowledged this epoch, so its clear is only
    // legal after the handshake every other clear in the batch performs.
    const discovered: FakeSendV2[] = fake.sends.filter(
      (send: FakeSendV2): boolean => send.documentId === 'document-12',
    );
    expect(discovered.map((send: FakeSendV2): string => send.message.command)).toEqual([
      'reset-enforcement-epoch',
      'apply-enforcement',
    ]);
    expect(Object.keys(fake.current().epochResetAcks)).toContain(documentKey(12, 'document-12'));
  });

  it('ignores a target outside the enforceable set', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(committedRuntime());
    await enterTransitionCleanupV2(fake, {
      cause: 'manual-end',
      failure: null,
      endedAt: fake.now(),
    });
    const writes: number = fake.writes.length;
    await handleCleanupNavigationV2(fake, {
      tabId: 13,
      documentId: 'document-13',
      url: 'chrome://settings',
    });

    expect(fake.writes).toHaveLength(writes);
    expect(fake.sends.some((send): boolean => send.documentId === 'document-13')).toBe(false);
  });
});

describe('transition cleanup discovery', (): void => {
  async function inManualEndCleanup(
    options: Parameters<typeof createRuntimePortsFakeV2>[1] = {},
  ): Promise<RuntimePortsFakeV2> {
    const fake: RuntimePortsFakeV2 = fakeFor(committedRuntime(), options);
    await enterTransitionCleanupV2(fake, {
      cause: 'manual-end',
      failure: null,
      endedAt: fake.now(),
    });
    return fake;
  }

  it('discovers, resets, and clears a document opened after the freeze', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = await inManualEndCleanup();
    const before: CleanupProgress = storedProgress(fake);
    const key: string = documentKey(12, 'document-12');
    fake.setTabs([
      { tabId: 11, url: BLOCKED_URL, documentId: DOC_ONE },
      { tabId: 12, url: 'https://news.example.com/story', documentId: 'document-12' },
    ]);

    await runTransitionCleanupAttemptV2(fake, effectsFake());

    // Spec 1150 does not scope discovery to one journal, so the transition batch picks up a
    // document that appeared while it was clearing, under its own operation and clear revision.
    // A clean attempt then hands the closure off and clears the transition, so the evidence is the
    // durable write the discovery made before its first send.
    const carried: RuntimeStateV2[] = fake.writes.filter((write: RuntimeStateV2): boolean =>
      Object.hasOwn(write.documentCommands, key),
    );
    const command: FrozenDocumentCommand | undefined = carried[0]?.documentCommands[key];
    expect(carried.length).toBeGreaterThan(0);
    expect(command?.expectedUrl).toBe('https://news.example.com/story');
    expect(command?.operationId).toBe(before.cleanupOperationId);
    expect(command?.runtimeRevision).toBe(before.clearRuntimeRevision);
    expect(
      fake.sends
        .filter((send: FakeSendV2): boolean => send.documentId === 'document-12')
        .map((send: FakeSendV2): string => send.message.command),
    ).toEqual(['reset-enforcement-epoch', 'apply-enforcement']);
  });

  it('enumerates a post-audit batch that froze no commands', async (): Promise<void> => {
    // Spec 766 exempts the pre-audit abandon, not an empty batch: a cleanup that got past the audit
    // owns whatever appears while it runs, however many commands it happened to freeze.
    const base: PendingEnforcementTransition = pendingTransition('start', 'alarm-ready');
    const transition: PendingEnforcementTransition = {
      ...base,
      startingView: { ...base.startingView, documents: {} },
      activeView: base.activeView === null ? null : { ...base.activeView, documents: {} },
    };
    const fake: RuntimePortsFakeV2 = fakeFor(
      transitionRuntime(transition, { session: timedFocusSession() }),
      { tabs: [{ tabId: 12, url: 'https://news.example.com/story', documentId: 'document-12' }] },
    );
    await enterTransitionCleanupV2(fake, {
      cause: 'manual-end',
      failure: null,
      endedAt: fake.now(),
    });
    const frozen: CleanupProgress = storedProgress(fake);
    const key: string = documentKey(12, 'document-12');

    expect(frozen.clearCommands).toEqual({});

    await runTransitionCleanupAttemptV2(fake, effectsFake());

    const carried: RuntimeStateV2[] = fake.writes.filter((write: RuntimeStateV2): boolean =>
      Object.hasOwn(write.documentCommands, key),
    );
    expect(carried.length).toBeGreaterThan(0);
    expect(carried[0]?.documentCommands[key]?.operationId).toBe(frozen.cleanupOperationId);
    expect(carried[0]?.documentCommands[key]?.runtimeRevision).toBe(frozen.clearRuntimeRevision);
    expect(
      fake.sends
        .filter((send: FakeSendV2): boolean => send.documentId === 'document-12')
        .map((send: FakeSendV2): string => send.message.command),
    ).toEqual(['reset-enforcement-epoch', 'apply-enforcement']);
  });

  it('exempts a cleanup that entered before the audit from discovery', async (): Promise<void> => {
    // Spec 766: nothing was sent before the registration audit, so a cleanup entered from
    // `prepared` must not invent a first send for a document it never touched, whatever the
    // failure that ended it was.
    const fake: RuntimePortsFakeV2 = fakeFor(
      transitionRuntime(pendingTransition('start', 'prepared')),
    );
    await enterTransitionCleanupV2(fake, {
      cause: 'start-abandon',
      failure: null,
      endedAt: fake.now(),
    });
    expect(storedTransition(fake).cleanupFrom).toBe('prepared');
    fake.setTabs([
      { tabId: 11, url: BLOCKED_URL, documentId: DOC_ONE },
      { tabId: 12, url: 'https://news.example.com/story', documentId: 'document-12' },
    ]);

    await runTransitionCleanupAttemptV2(fake, effectsFake());

    expect(
      fake.sends.filter((send: FakeSendV2): boolean => send.documentId === 'document-12'),
    ).toEqual([]);
  });

  it('leaves the frozen batch untouched across two failed attempts', async (): Promise<void> => {
    // The unreachable document fails at its epoch reset under the strict policy, so this pins that
    // a failing attempt rewrites no target and no command, not anything about a moved document.
    const fake: RuntimePortsFakeV2 = await inManualEndCleanup();
    const frozen: CleanupProgress = storedProgress(fake);
    fake.respondForDocument(11, DOC_ONE, noReceiverResponder());

    await runTransitionCleanupAttemptV2(fake, effectsFake());
    const first: CleanupProgress = storedProgress(fake);
    await runTransitionCleanupAttemptV2(fake, effectsFake());

    expect(first.clearCommands).toEqual(frozen.clearCommands);
    expect(storedProgress(fake).clearCommands).toEqual(frozen.clearCommands);
    expect(storedProgress(fake).targets).toEqual(frozen.targets);
  });

  it('keeps the journal open when an unreachable document is one the batch froze', async (): Promise<void> => {
    // A tab claim is not a proxy for an overlay: `Engine.dropEmptyTabState` drops a tab's state
    // unless it was muted or stopped, so an overlaid tab can hold no claim by the time cleanup
    // runs. The frozen batch is the stronger evidence, and it keeps the answer fatal.
    const fake: RuntimePortsFakeV2 = fakeFor(preCommitRuntime());
    await enterTransitionCleanupV2(fake, {
      cause: 'start-abandon',
      failure: null,
      endedAt: fake.now(),
    });
    const frozen: CleanupProgress = storedProgress(fake);
    expect(frozen.tabClaims).toEqual([]);
    expect(Object.keys(frozen.clearCommands)).toContain(documentKey(11, DOC_ONE));
    fake.respondForDocument(11, DOC_ONE, noReceiverResponder());

    await runTransitionCleanupAttemptV2(fake, effectsFake());

    const progress: CleanupProgress = storedProgress(fake);
    expect(progress.retry.automaticAttempt).toBe(1);
    expect(progress.retry.lastError).toContain('answered no-receiver');
  });

  /** A document answering from the URL it moved to inside its own document. */
  function movedDocumentResponder(observedUrl: string, handledAt: number): FakeResponderV2 {
    return (message: DocumentContentCommand): unknown => ({
      version: 1,
      disposition: message.command === 'apply-enforcement' ? 'applied' : 'epoch-reset',
      operationId: message.operationId,
      enforcementEpoch: message.enforcementEpoch,
      documentId: message.documentId,
      observedUrl,
      handledAt,
      ...(message.command === 'apply-enforcement'
        ? {
            sessionId: message.sessionId,
            reservedSessionId: message.reservedSessionId,
            basePolicyRevision: message.basePolicyRevision,
            runtimeRevision: message.runtimeRevision,
            presentation: message.presentation,
            verdict: message.verdict,
            overlay: message.overlay,
          }
        : {}),
    });
  }

  it('reaches the clear when a moved document answers the reset from its new URL', async (): Promise<void> => {
    // A cleanup reset carries no verdict: it establishes epoch agreement so the clear that follows
    // is accepted, and removing an overlay is correct on any URL. Without this the batch stops at
    // the reset for every attempt, and a manual retry meets the same wall because the URL sticks.
    const fake: RuntimePortsFakeV2 = await inManualEndCleanup();
    fake.respondForDocument(
      11,
      DOC_ONE,
      movedDocumentResponder('https://facebook.com/feed/story', fake.now()),
    );

    await runTransitionCleanupAttemptV2(fake, effectsFake());

    expect(
      fake.sends
        .filter((send: FakeSendV2): boolean => send.documentId === DOC_ONE)
        .map((send: FakeSendV2): string => send.message.command),
    ).toEqual(['reset-enforcement-epoch', 'apply-enforcement']);
    expect(fake.current().pendingEnforcementTransition).toBeNull();
  });

  it('keeps every other reset mismatch fatal during cleanup', async (): Promise<void> => {
    // The narrowing is one field wide. An answer that echoes a different operation is still an
    // answer to a command this cleanup did not send.
    const fake: RuntimePortsFakeV2 = await inManualEndCleanup();
    // The clear would be answered correctly, so only the reset's echoed operation is wrong: nothing
    // else can end the attempt, and widening the narrowing by one field would let it resolve.
    fake.respondForDocument(11, DOC_ONE, (message: DocumentContentCommand): unknown =>
      message.command === 'apply-enforcement'
        ? appliedResponseFor(message, fake.now())
        : {
            version: 1,
            disposition: 'epoch-reset',
            operationId: OTHER_OPERATION_ID,
            enforcementEpoch: message.enforcementEpoch,
            documentId: message.documentId,
            observedUrl: BLOCKED_URL,
            handledAt: fake.now(),
          },
    );

    await runTransitionCleanupAttemptV2(fake, effectsFake());

    expect(storedProgress(fake).retry.lastError).toContain('answered mismatch');
    expect(fake.current().pendingEnforcementTransition).not.toBeNull();
  });

  it('defers an unreachable document this cleanup never overlaid', async (): Promise<void> => {
    // Spec 1345 shape: a page discovered on a tab this cleanup holds no claim for was never sent
    // anything by this journal, so a missing receiver is nothing to clear rather than a lost clear.
    const fake: RuntimePortsFakeV2 = await inManualEndCleanup();
    fake.setTabs([
      { tabId: 11, url: BLOCKED_URL, documentId: DOC_ONE },
      { tabId: 12, url: 'https://news.example.com/story', documentId: 'document-12' },
    ]);
    fake.respondForDocument(12, 'document-12', noReceiverResponder());

    await runTransitionCleanupAttemptV2(fake, effectsFake());

    expect(fake.current().pendingEnforcementTransition).toBeNull();
  });

  it('keeps the journal open when an unreachable document is on a claimed tab', async (): Promise<void> => {
    // The same answer from a tab this cleanup claimed is a clear that did not land: the session
    // overlaid that page, so spec 758 and spec 1954 keep it fatal.
    const fake: RuntimePortsFakeV2 = await inManualEndCleanup();
    const runtime: RuntimeStateV2 = fake.current();
    await fake.writeRuntime({
      ...runtime,
      tabStates: {
        ...runtime.tabStates,
        12: {
          muteUrl: 'https://news.example.com/story',
          priorMuted: false,
          stoppedDocumentId: null,
        },
      },
    });
    fake.setTabs([
      { tabId: 11, url: BLOCKED_URL, documentId: DOC_ONE },
      { tabId: 12, url: 'https://news.example.com/story', documentId: 'document-12' },
    ]);
    fake.respondForDocument(12, 'document-12', noReceiverResponder());

    await runTransitionCleanupAttemptV2(fake, effectsFake());

    const progress: CleanupProgress = storedProgress(fake);
    expect(progress.retry.automaticAttempt).toBe(1);
    expect(progress.retry.lastError).toContain('answered no-receiver');
  });

  it('fails the attempt when a discovered claim contradicts the captured one', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = await inManualEndCleanup();
    const captured: CleanupTabClaim[] = storedProgress(fake).tabClaims;
    const runtime: RuntimeStateV2 = fake.current();
    await fake.writeRuntime({
      ...runtime,
      tabStates: {
        11: { muteUrl: 'https://example.com/other', priorMuted: false, stoppedDocumentId: DOC_ONE },
      },
    });

    await runTransitionCleanupAttemptV2(fake, effectsFake());

    const progress: CleanupProgress = storedProgress(fake);
    expect(progress.retry.lastError).toContain('contradictory claim');
    expect(progress.tabClaims).toEqual(captured);
    expect(storedTransition(fake).stage).toBe('cleanup');
  });
});

describe('transition cleanup closure capture', (): void => {
  it('loads the end day even when the retained phase settles no focus', async (): Promise<void> => {
    // A paused retained session settles nothing, and the worker day has already rolled, so the
    // projection needs a stored aggregate for a day earlier than `runtime.date`. Loading it is
    // what keeps the capture from throwing and from replacing that finished day.
    const endedAt: number = ACTIVATION_AT + 30_000;
    const endedDate: string = localDateStr(endedAt);
    const rolledDate: string = localDateStr(endedAt + 86_400_000);
    const stored: DailyAgg = {
      ...emptyDaily(endedDate),
      focusMs: 600_000,
      sessionsStarted: 2,
      attempts: { 'example.com': 3 },
    };
    const loads: string[][] = [];
    const fake: RuntimePortsFakeV2 = fakeFor(
      transitionRuntime(pendingTransition('resume', 'registration-audited'), {
        session: pausedSession(),
        tabStates: { 11: { muteUrl: BLOCKED_URL, priorMuted: false, stoppedDocumentId: DOC_ONE } },
        date: rolledDate,
        todayAgg: emptyDaily(rolledDate),
      }),
      { aggregates: { [syncAggKey('device-1', endedDate)]: stored } },
    );
    const accrued: number = fake.current().accruedFocusMs;
    const ports: RuntimePortsV2 = {
      ...fake,
      loadAggregates: async (keys: readonly string[]): Promise<Record<string, DailyAgg>> => {
        loads.push([...keys]);
        return fake.loadAggregates(keys);
      },
    };

    await enterTransitionCleanupV2(ports, {
      cause: 'timer-completed',
      failure: null,
      endedAt,
    });

    const closure: PostCleanupClosure | null = storedTransition(fake).postCleanupClosure;
    const ended: DailyAgg | undefined =
      closure?.projection.aggregateSets[syncAggKey('device-1', endedDate)];
    expect(loads[0]).toContain(syncAggKey('device-1', endedDate));
    expect(ended?.attempts).toEqual(stored.attempts);
    expect(ended?.sessionsStarted).toBe(stored.sessionsStarted);
    // The finished day kept its own focus and gained only what this closure settled, which is what
    // seeding it empty would have destroyed.
    const settled: number = Math.max(0, (closure?.projection.focusedMs ?? 0) - accrued);
    expect(ended?.focusMs).toBe(stored.focusMs + settled);
    expect(ended?.sessionsCompleted).toBe(stored.sessionsCompleted + 1);
  });
});

describe('transition cleanup timer upgrade and retry scheduling', (): void => {
  /** A resume cleanup whose durable pause has already run past its fixed end. */
  async function pastFixedEnd(
    options: Parameters<typeof createRuntimePortsFakeV2>[1] = {},
  ): Promise<RuntimePortsFakeV2> {
    const session: SessionStateV2 = pausedSession();
    const fake: RuntimePortsFakeV2 = fakeFor(
      transitionRuntime(pendingTransition('resume', 'registration-audited'), { session }),
      options,
    );
    await enterTransitionCleanupV2(fake, {
      cause: 'resume-restore',
      failure: null,
      endedAt: fake.now(),
    });
    fake.setNow((session.sessionEndsAt ?? 0) + 1_000);
    return fake;
  }

  it('upgrades an expired resume to timer completion and hands it off', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = await pastFixedEnd();
    const endsAt: number = pausedSession().sessionEndsAt ?? 0;
    const resolved: RuntimeStateV2 = await runTransitionCleanupAttemptV2(fake, effectsFake());
    const closure: PendingClosure | null = resolved.pendingClosure;

    expect(resolved.pendingEnforcementTransition).toBeNull();
    expect(resolved.session).toBeNull();
    expect(closure?.stage).toBe('cleanup');
    expect(closure?.projection.reason).toBe('timer-completed');
    expect(closure?.projection.endedAt).toBe(endsAt);
  });

  it('treats a refused retry alarm as one more failed attempt', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(committedRuntime(), { alarmReadBack: 'missing' });
    await enterTransitionCleanupV2(fake, {
      cause: 'manual-end',
      failure: null,
      endedAt: fake.now(),
    });
    fake.respondForDocument(11, DOC_ONE, noReceiverResponder());
    await runTransitionCleanupAttemptV2(fake, effectsFake());
    const progress: CleanupProgress = storedProgress(fake);

    // One attempt failed, and every scheduling attempt after it also failed, so the schedule ran
    // all the way to the manual retry rather than leaving a live nextAttemptAt nothing will fire.
    expect(progress.retry.automaticAttempt).toBe(CLEANUP_MAX_AUTOMATIC_ATTEMPTS);
    expect(progress.retry.nextAttemptAt).toBeNull();
    expect(progress.retry.lastError).toBe('cleanup could not schedule its retry alarm');
    expect((await retryTransitionCleanupV2(fake)).code).toBe('ok');
  });

  it('advances the schedule by exactly one when a read-back is refused once', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(committedRuntime(), { alarmReadBackFailures: 1 });
    await enterTransitionCleanupV2(fake, {
      cause: 'manual-end',
      failure: null,
      endedAt: fake.now(),
    });
    fake.respondForDocument(11, DOC_ONE, noReceiverResponder());
    await runTransitionCleanupAttemptV2(fake, effectsFake());
    const progress: CleanupProgress = storedProgress(fake);

    // One effect failure plus one refused read-back: the refusal contributes exactly one more
    // attempt, and the schedule is live again once the retry alarm is finally accepted.
    expect(progress.retry.automaticAttempt).toBe(2);
    expect(progress.retry.nextAttemptAt).not.toBeNull();
    expect(progress.retry.lastError).toBe('cleanup could not schedule its retry alarm');
  });

  it('exhausts into manual retry when a refused read-back lands on the last attempt', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(committedRuntime());
    await enterTransitionCleanupV2(fake, {
      cause: 'manual-end',
      failure: null,
      endedAt: fake.now(),
    });
    fake.respondForDocument(11, DOC_ONE, noReceiverResponder());
    // Ten failures whose retry alarms are all accepted, so the schedule is still live and the
    // twelfth attempt has not been reached by effect failures alone.
    for (let attempt: number = 0; attempt < CLEANUP_MAX_AUTOMATIC_ATTEMPTS - 2; attempt++) {
      await runTransitionCleanupAttemptV2(fake, effectsFake());
    }
    const midway: CleanupRetryState = storedProgress(fake).retry;
    expect(midway.automaticAttempt).toBe(CLEANUP_MAX_AUTOMATIC_ATTEMPTS - 2);
    expect(midway.nextAttemptAt).not.toBeNull();
    expect((await retryTransitionCleanupV2(fake)).code).toBe('retry-not-available');

    // The eleventh failure's alarm is refused, and it is that refusal that carries the schedule to
    // exhaustion: without it the batch would sit at eleven with a live next attempt.
    fake.setAlarmReadBack('missing');
    await runTransitionCleanupAttemptV2(fake, effectsFake());
    const progress: CleanupProgress = storedProgress(fake);

    expect(progress.retry.automaticAttempt).toBe(CLEANUP_MAX_AUTOMATIC_ATTEMPTS);
    expect(progress.retry.nextAttemptAt).toBeNull();
    expect(progress.retry.lastError).toBe('cleanup could not schedule its retry alarm');
    expect((await retryTransitionCleanupV2(fake)).code).toBe('ok');
  });
});

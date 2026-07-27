import { describe, expect, it } from 'vitest';
import type { FrozenDocumentCommand } from '../../../src/background/enforcement-persistence-v2';
import type { DeferredBlockClaim } from '../../../src/background/runtime-leaf-types';
import type {
  PendingEnforcementTransition,
  RuntimeCommitCheckpointV2,
  RuntimeStateV2,
  TransitionStage,
} from '../../../src/background/runtime-v2-types';
import { parseRuntimeStateV2 } from '../../../src/background/runtime-v2-validation';
import type { GateState, HandledScheduleOccurrence } from '../../../src/shared/types';
import {
  ACTIVATION_AT,
  ACTIVE_OPERATION_ID,
  ATTEMPT_DEBOUNCE_KEY,
  activeCommandMap,
  BASE_POLICY_REVISION,
  bankState,
  breakRuntime,
  breakSession,
  CLEANUP_OPERATION_ID,
  CLEAR_RUNTIME_REVISION,
  type CleanupClosureV2,
  cancelGateState,
  cleanupClosure,
  cleanupClosureRuntime,
  cleanupTransition,
  clearCommandMap,
  commitCheckpointRuntime,
  dailyAgg,
  deferredBlockClaim,
  deferredBlockClaimMap,
  deferredClaimKey,
  documentKey,
  ENTRY_ID,
  emptyRuntimeV2,
  epochResetAck,
  epochResetAckMap,
  frozenActiveView,
  gatedActiveOverlay,
  handledOccurrence,
  handledOccurrenceLog,
  LOCAL_DATE,
  MAX_HANDLED_SCHEDULE_OCCURRENCES,
  manualCandidate,
  migratedActiveFocusRuntime,
  NOW,
  OTHER_EPOCH_ID,
  OTHER_OPERATION_ID,
  OTHER_SESSION_ID,
  PUBLISHED_REVISION,
  pausedRuntime,
  pausedSession,
  pendingTransition,
  preparedClosure,
  preparedClosureRuntime,
  publishedFocusRuntime,
  RUNTIME_CLOSED_AT,
  resumedFocusSession,
  retainedClearCommandMap,
  runtimeClosureProjection,
  runtimeCommitCheckpoint,
  runtimeTabState,
  SESSION_ID,
  TARGET_URL,
  type TransitionCleanupCause,
  type TransitionCleanupFrom,
  type TransitionKind,
  timedFocusSession,
  transitionActiveCheckpoint,
  transitionCheckpoint,
  transitionPostCleanupClosure,
  transitionRuntime,
  untilStoppedFocusSession,
} from './runtime-v2-fixtures';

type UnknownRecord = Record<string, unknown>;
type JournalStage = Exclude<TransitionStage, 'cleanup'>;

const JOURNAL_STAGES: readonly JournalStage[] = [
  'prepared',
  'registration-audited',
  'starting-verified',
  'committed-pending-verification',
  'alarm-ready',
  'active-verified',
];
const CLOSING_CLEANUP_CAUSES: readonly TransitionCleanupCause[] = [
  'timer-completed',
  'manual-end',
  'transition-failed',
];
const VALID_GATE: GateState = {
  kind: 'pause',
  host: null,
  openedAt: ACTIVATION_AT,
  readyAt: ACTIVATION_AT + 5_000,
  requiredPhrase: null,
  forceEndAvailable: false,
};

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
    expect((): RuntimeStateV2 | null => parseRuntimeStateV2(value)).not.toThrow();
    expect(parseRuntimeStateV2(value)).toBeNull();
  }
}

function expectAccepted(values: readonly RuntimeStateV2[]): void {
  for (const value of values) expect(parseRuntimeStateV2(value)).toEqual(value);
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

/** A cleanup transition runtime whose projected end sits on the runtime timeline. */
function cleanupTransitionRuntime(
  kind: TransitionKind,
  cleanupFrom: TransitionCleanupFrom,
  cause: TransitionCleanupCause,
  overrides: Partial<RuntimeStateV2> = {},
): RuntimeStateV2 {
  const closing: boolean = CLOSING_CLEANUP_CAUSES.includes(cause);
  return transitionRuntime(
    cleanupTransition(
      kind,
      cleanupFrom,
      cause,
      closing ? { postCleanupClosure: transitionPostCleanupClosure() } : {},
    ),
    overrides,
  );
}

/** Replaces one field of the commit checkpoint a runtime carries. */
function withCheckpointKey(runtime: RuntimeStateV2, key: string, replacement: unknown): unknown {
  const checkpoint: RuntimeCommitCheckpointV2 = runtimeCommitCheckpoint(runtime);
  return withKey(runtime, 'commitCheckpoint', withKey(checkpoint, key, replacement));
}

/** Replaces one projected field of the commit checkpoint a runtime carries. */
function withProjectedKey(runtime: RuntimeStateV2, key: string, replacement: unknown): unknown {
  const checkpoint: RuntimeCommitCheckpointV2 = runtimeCommitCheckpoint(runtime);
  return withCheckpointKey(runtime, 'projection', withKey(checkpoint.projection, key, replacement));
}

describe('background runtime fixtures', (): void => {
  it('accepts the empty runtime and every published phase', (): void => {
    expectAccepted([
      emptyRuntimeV2(),
      emptyRuntimeV2({ gate: VALID_GATE }),
      publishedFocusRuntime(),
      pausedRuntime(),
      breakRuntime(),
    ]);
  });

  it('accepts journal-free focus with a null checkpoint as migration authority', (): void => {
    expectAccepted([migratedActiveFocusRuntime()]);
  });

  it('accepts an accrued watermark ahead of the settled session focus', (): void => {
    expectAccepted([
      migratedActiveFocusRuntime({ accruedFocusMs: Number.MAX_SAFE_INTEGER }),
      transitionRuntime(pendingTransition('start', 'active-verified'), {
        accruedFocusMs: 90_000,
        session: timedFocusSession({ focusedMs: 1_000 }),
      }),
    ]);
  });

  it('accepts start and resume transitions at every stage', (): void => {
    for (const stage of JOURNAL_STAGES) {
      expectAccepted([
        transitionRuntime(pendingTransition('start', stage)),
        transitionRuntime(pendingTransition('resume', stage)),
        transitionRuntime(
          pendingTransition('resume', stage, { trigger: 'break-expired', priorPhase: 'break' }),
        ),
      ]);
    }
  });

  it('accepts cleanup transitions with and without a post-cleanup closure', (): void => {
    expectAccepted([
      cleanupTransitionRuntime('start', 'prepared', 'start-abandon'),
      cleanupTransitionRuntime('resume', 'registration-audited', 'resume-restore'),
      cleanupTransitionRuntime('start', 'active-verified', 'timer-completed'),
      cleanupTransitionRuntime('start', 'alarm-ready', 'manual-end'),
      cleanupTransitionRuntime('resume', 'committed-pending-verification', 'transition-failed'),
      cleanupTransitionRuntime('resume', 'starting-verified', 'timer-completed'),
    ]);
  });

  it('accepts prepared and cleanup closures', (): void => {
    expectAccepted([preparedClosureRuntime(), cleanupClosureRuntime()]);
  });

  it('accepts a runtime carrying a v2 commit checkpoint', (): void => {
    expectAccepted([
      commitCheckpointRuntime(),
      commitCheckpointRuntime(publishedFocusRuntime()),
      commitCheckpointRuntime(transitionRuntime(pendingTransition('resume', 'alarm-ready'))),
    ]);
  });
});

describe('background runtime top-level leaves', (): void => {
  it('rejects non-record roots and inexact key sets', (): void => {
    expectRejected([
      null,
      undefined,
      'runtime',
      42,
      [emptyRuntimeV2()],
      withKey(emptyRuntimeV2(), 'scheduleActiveEntryId', null),
      withKey(emptyRuntimeV2(), 'runtimeSchemaVersion', 1),
      withKey(emptyRuntimeV2(), 'runtimeSchemaVersion', '2'),
      withoutKey(emptyRuntimeV2(), 'commitCheckpoint'),
      withoutKey(emptyRuntimeV2(), 'unlocks'),
    ]);
  });

  it('rejects missing required empty collections', (): void => {
    expectRejected([
      withKey(emptyRuntimeV2(), 'unlocks', undefined),
      withKey(emptyRuntimeV2(), 'epochResetAcks', undefined),
      withKey(emptyRuntimeV2(), 'documentCommands', null),
      withKey(emptyRuntimeV2(), 'handledScheduleOccurrences', null),
      withKey(emptyRuntimeV2(), 'tabStates', undefined),
    ]);
  });

  it('rejects invalid session, gate, and unlock leaves', (): void => {
    expectRejected([
      withKey(publishedFocusRuntime(), 'session', withKey(timedFocusSession(), 'phase', 'idle')),
      withKey(publishedFocusRuntime(), 'session', withKey(timedFocusSession(), 'version', 1)),
      withKey(publishedFocusRuntime(), 'session', withoutKey(timedFocusSession(), 'pausedFrom')),
      withKey(emptyRuntimeV2(), 'gate', withKey(VALID_GATE, 'host', 'example.com')),
      withKey(emptyRuntimeV2(), 'gate', withKey(VALID_GATE, 'readyAt', ACTIVATION_AT - 1)),
      withKey(emptyRuntimeV2(), 'unlocks', [{ host: ' ', until: NOW }]),
      withKey(emptyRuntimeV2(), 'unlocks', { 0: { host: 'example.com', until: NOW } }),
    ]);
  });

  it('rejects invalid tab states and tombstones', (): void => {
    expectRejected([
      withKey(emptyRuntimeV2(), 'tabStates', { eleven: runtimeTabState() }),
      withKey(emptyRuntimeV2(), 'tabStates', { '-1': runtimeTabState() }),
      withKey(emptyRuntimeV2(), 'tabStates', { '011': runtimeTabState() }),
      withKey(emptyRuntimeV2(), 'tabStates', { 11: withKey(runtimeTabState(), 'muteUrl', '') }),
      withKey(emptyRuntimeV2(), 'removedTabTombstones', { 11: false }),
      withKey(emptyRuntimeV2(), 'removedTabTombstones', { 11: 1 }),
      withKey(emptyRuntimeV2(), 'removedTabTombstones', { open: true }),
    ]);
    expectAccepted([
      emptyRuntimeV2({ tabStates: { 0: runtimeTabState({ priorMuted: null, muteUrl: null }) } }),
    ]);
  });

  it('rejects invalid attempt debounce marks', (): void => {
    expectRejected([
      withKey(emptyRuntimeV2(), 'attemptDebounce', { [ATTEMPT_DEBOUNCE_KEY]: -1 }),
      withKey(emptyRuntimeV2(), 'attemptDebounce', { [ATTEMPT_DEBOUNCE_KEY]: 1.5 }),
      withKey(emptyRuntimeV2(), 'attemptDebounce', { [ATTEMPT_DEBOUNCE_KEY]: `${NOW}` }),
      withKey(emptyRuntimeV2(), 'attemptDebounce', [NOW]),
    ]);
  });

  it('rejects invalid deferred block claims', (): void => {
    const stopped: DeferredBlockClaim = deferredBlockClaim();
    const key: string = deferredClaimKey(stopped);
    const attemptOnly: DeferredBlockClaim = {
      attemptAt: ACTIVATION_AT,
      kind: 'existing',
      sessionId: SESSION_ID,
      stage: 'attempt',
      tabId: 11,
      url: TARGET_URL,
    };

    expectRejected([
      withKey(emptyRuntimeV2(), 'deferredBlockClaims', {
        [key]: withoutKey(stopped, 'documentId'),
      }),
      withKey(emptyRuntimeV2(), 'deferredBlockClaims', {
        [key]: withKey(stopped, 'documentId', ''),
      }),
      withKey(emptyRuntimeV2(), 'deferredBlockClaims', { [key]: withKey(stopped, 'extra', 1) }),
      withKey(emptyRuntimeV2(), 'deferredBlockClaims', { [key]: withKey(stopped, 'url', '') }),
      withKey(emptyRuntimeV2(), 'deferredBlockClaims', { [key]: withKey(stopped, 'tabId', -1) }),
      withKey(emptyRuntimeV2(), 'deferredBlockClaims', {
        [key]: withKey(stopped, 'stage', 'done'),
      }),
      withKey(emptyRuntimeV2(), 'deferredBlockClaims', {
        [key]: withKey(stopped, 'kind', 'existing'),
      }),
    ]);
    expectAccepted([
      emptyRuntimeV2({ deferredBlockClaims: { [deferredClaimKey(attemptOnly)]: attemptOnly } }),
      emptyRuntimeV2({ deferredBlockClaims: deferredBlockClaimMap() }),
    ]);
  });

  it('rejects an invalid schedule unavailable notice token', (): void => {
    expectRejected([
      withKey(emptyRuntimeV2(), 'scheduleUnavailableNoticeToken', 42),
      withKey(emptyRuntimeV2(), 'scheduleUnavailableNoticeToken', undefined),
    ]);
    // The token is an opaque identity the runner compares, and the version 1 reader stores any
    // string, so a migrated runtime carrying a blank one is accepted rather than refused.
    expectAccepted([
      emptyRuntimeV2({ scheduleUnavailableNoticeToken: `${ENTRY_ID}@${LOCAL_DATE}` }),
      emptyRuntimeV2({ scheduleUnavailableNoticeToken: '' }),
      emptyRuntimeV2({ scheduleUnavailableNoticeToken: '   ' }),
    ]);
  });

  it('caps handled occurrences at 256 unique tokens with exact expiry', (): void => {
    expectRejected([
      withKey(emptyRuntimeV2(), 'handledScheduleOccurrences', [
        handledOccurrence(),
        handledOccurrence(),
      ]),
      withKey(emptyRuntimeV2(), 'handledScheduleOccurrences', [
        handledOccurrence({ expiresAt: NOW }),
      ]),
      withKey(
        emptyRuntimeV2(),
        'handledScheduleOccurrences',
        handledOccurrenceLog(MAX_HANDLED_SCHEDULE_OCCURRENCES + 1),
      ),
    ]);
    expectAccepted([
      emptyRuntimeV2({
        handledScheduleOccurrences: handledOccurrenceLog(MAX_HANDLED_SCHEDULE_OCCURRENCES),
      }),
      emptyRuntimeV2({ handledScheduleOccurrences: handledOccurrenceLog(3).reverse() }),
    ]);
  });

  it('rejects an invalid epoch, revisions, and reset acknowledgements', (): void => {
    expectRejected([
      withKey(emptyRuntimeV2(), 'enforcementEpoch', 'epoch'),
      withKey(emptyRuntimeV2(), 'enforcementEpoch', ''),
      withKey(emptyRuntimeV2(), 'enforcementEpoch', null),
      withKey(emptyRuntimeV2(), 'basePolicyRevision', -1),
      withKey(emptyRuntimeV2(), 'basePolicyRevision', 1.5),
      withKey(emptyRuntimeV2(), 'runtimeRevision', -1),
      withKey(emptyRuntimeV2(), 'epochResetAcks', { wrong: epochResetAck() }),
      // The record carries no page address. One that does is the shape a build before the record
      // stored, and the runtime refuses it rather than keeping the address it was meant to drop.
      withKey(emptyRuntimeV2(), 'epochResetAcks', {
        [documentKey(11, 'document-1')]: withKey(epochResetAck(), 'url', TARGET_URL),
      }),
    ]);
  });

  it('rejects invalid document command maps', (): void => {
    const commands: ReturnType<typeof activeCommandMap> = activeCommandMap({
      operationId: ACTIVE_OPERATION_ID,
      runtimeRevision: PUBLISHED_REVISION,
    });
    const command: unknown = commands[documentKey(11, 'document-1')];

    expectRejected([
      withKey(publishedFocusRuntime(), 'documentCommands', { wrong: command }),
      withKey(publishedFocusRuntime(), 'documentCommands', {
        [documentKey(11, 'document-1')]: withoutKey(command as object, 'tabId'),
      }),
    ]);
  });

  it('rejects invalid dates and today aggregates', (): void => {
    expectRejected([
      withKey(emptyRuntimeV2(), 'date', '2026-13-01'),
      withKey(emptyRuntimeV2(), 'date', 'today'),
      withKey(emptyRuntimeV2(), 'date', null),
      withKey(emptyRuntimeV2(), 'lastPruneDate', '2026-02-30'),
      withKey(emptyRuntimeV2(), 'todayAgg', dailyAgg({ date: '2026-09-03' })),
      withKey(emptyRuntimeV2(), 'todayAgg', withKey(dailyAgg(), 'extra', 1)),
      withKey(emptyRuntimeV2(), 'todayAgg', withoutKey(dailyAgg(), 'focusMs')),
      withKey(emptyRuntimeV2(), 'todayAgg', withKey(dailyAgg(), 'focusMs', -1)),
    ]);
    expectAccepted([
      emptyRuntimeV2({
        todayAgg: withoutKey(
          withoutKey(dailyAgg(), 'pauseMsEarned'),
          'unlockMsSpent',
        ) as unknown as ReturnType<typeof dailyAgg>,
      }),
    ]);
  });

  it('validates the commit checkpoint leaves', (): void => {
    const base: RuntimeStateV2 = cleanupClosureRuntime();

    expectRejected([
      withCheckpointKey(base, 'version', 1),
      withCheckpointKey(base, 'checkpointId', 42),
      withCheckpointKey(base, 'bank', { balanceMs: -1 }),
      withCheckpointKey(base, 'events', [{ t: 'unknown', at: NOW }]),
      withCheckpointKey(base, 'events', sparseArray(bankState())),
      withCheckpointKey(base, 'syncBank', 'true'),
      withCheckpointKey(base, 'aggregateSets', { bad: dailyAgg() }),
      withCheckpointKey(base, 'aggregateRemoves', ['bad']),
      withCheckpointKey(base, 'aggregateSets', undefined),
      withKey(base, 'commitCheckpoint', {
        bank: bankState(),
        events: [],
        syncBank: false,
      }),
      withKey(
        base,
        'commitCheckpoint',
        withoutKey(runtimeCommitCheckpoint(base), 'aggregateRemoves'),
      ),
    ]);
    expectAccepted([
      commitCheckpointRuntime(base, { checkpointId: '' }),
      commitCheckpointRuntime(base, { checkpointId: 'not-a-uuid' }),
      commitCheckpointRuntime(base, { events: [], aggregateSets: {}, aggregateRemoves: [] }),
    ]);
  });
});

describe('background runtime epoch, revision, and checkpoint relationships', (): void => {
  it('requires reset acknowledgements to match the current epoch without a revision', (): void => {
    expectRejected([
      publishedFocusRuntime({
        epochResetAcks: epochResetAckMap({ enforcementEpoch: OTHER_EPOCH_ID }),
      }),
    ]);
    expectAccepted([
      publishedFocusRuntime({
        epochResetAcks: epochResetAckMap({ handledAt: 0, operationId: OTHER_OPERATION_ID }),
      }),
    ]);
  });

  it('matches an enforcement checkpoint on epoch, session, base revision, and context', (): void => {
    expectRejected([
      publishedFocusRuntime({
        enforcementCheckpoint: transitionActiveCheckpoint('start'),
        enforcementEpoch: OTHER_EPOCH_ID,
      }),
      publishedFocusRuntime({ session: timedFocusSession({ sessionId: OTHER_SESSION_ID }) }),
      publishedFocusRuntime({ basePolicyRevision: BASE_POLICY_REVISION + 1 }),
      transitionRuntime(pendingTransition('start', 'active-verified'), {
        enforcementCheckpoint: transitionActiveCheckpoint('start'),
      }),
      emptyRuntimeV2({ enforcementCheckpoint: transitionActiveCheckpoint('start') }),
    ]);
    expectAccepted([
      publishedFocusRuntime({
        runtimeRevision: PUBLISHED_REVISION + 5,
        documentCommands: activeCommandMap({
          operationId: ACTIVE_OPERATION_ID,
          runtimeRevision: PUBLISHED_REVISION + 5,
        }),
      }),
      publishedFocusRuntime({
        enforcementCheckpoint: transitionCheckpoint({
          operationId: OTHER_OPERATION_ID,
          kind: 'recovery',
        }),
      }),
    ]);
  });

  it('requires pause and break to hold no focus checkpoint', (): void => {
    expectRejected([
      pausedRuntime({ enforcementCheckpoint: transitionActiveCheckpoint('start') }),
      breakRuntime({ enforcementCheckpoint: transitionActiveCheckpoint('start') }),
    ]);
  });

  it('requires the current runtime revision to match the current document commands', (): void => {
    expectRejected([
      publishedFocusRuntime({ runtimeRevision: PUBLISHED_REVISION + 1 }),
      publishedFocusRuntime({
        documentCommands: activeCommandMap({
          operationId: ACTIVE_OPERATION_ID,
          runtimeRevision: PUBLISHED_REVISION,
          enforcementEpoch: OTHER_EPOCH_ID,
        }),
      }),
    ]);
    expectAccepted([emptyRuntimeV2({ runtimeRevision: 12, documentCommands: {} })]);
  });

  it('accepts a resume transition over the retained batch at its older revision', (): void => {
    const runtime: RuntimeStateV2 = transitionRuntime(pendingTransition('resume', 'prepared'));
    const commands: FrozenDocumentCommand[] = Object.values(runtime.documentCommands);

    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command.runtimeRevision).toBeLessThan(runtime.runtimeRevision);
    }
    expectAccepted([runtime, transitionRuntime(pendingTransition('resume', 'active-verified'))]);
    expectRejected([
      transitionRuntime(pendingTransition('resume', 'prepared'), {
        documentCommands: clearCommandMap({
          operationId: OTHER_OPERATION_ID,
          runtimeRevision: PUBLISHED_REVISION,
          enforcementEpoch: OTHER_EPOCH_ID,
        }),
      }),
      cleanupTransitionRuntime('resume', 'prepared', 'resume-restore', {
        documentCommands: retainedClearCommandMap(),
      }),
    ]);
  });

  it('accepts a committed Friction transition whose view carries a later cancel gate', (): void => {
    // Spec 1020-1023: Friction End persists the cancel gate and freezes a replacement active view
    // that keeps `capturedAt: activationAt`, so `gate.openedAt` is legitimately later.
    const gated: PendingEnforcementTransition = pendingTransition('start', 'alarm-ready', {
      candidate: manualCandidate({ strictness: 'friction' }),
      activeView: frozenActiveView('start', {
        documents: activeCommandMap({}, ACTIVATION_AT, gatedActiveOverlay()),
      }),
    });

    expect(cancelGateState().openedAt).toBeGreaterThan(ACTIVATION_AT);
    expectAccepted([transitionRuntime(gated)]);
  });

  it('requires the base policy revision the content compares against', (): void => {
    expectRejected([
      publishedFocusRuntime({
        documentCommands: activeCommandMap({
          operationId: ACTIVE_OPERATION_ID,
          runtimeRevision: PUBLISHED_REVISION,
          basePolicyRevision: BASE_POLICY_REVISION + 1,
        }),
      }),
      transitionRuntime(pendingTransition('start', 'alarm-ready'), {
        basePolicyRevision: BASE_POLICY_REVISION + 1,
      }),
      transitionRuntime(pendingTransition('resume', 'prepared'), {
        basePolicyRevision: BASE_POLICY_REVISION + 1,
        documentCommands: {},
      }),
      cleanupTransitionRuntime('start', 'prepared', 'start-abandon', {
        basePolicyRevision: BASE_POLICY_REVISION + 1,
      }),
    ]);
    // A pre-commit start reserves the next base, so its transition legitimately leads the runtime.
    const reserving: RuntimeStateV2 = transitionRuntime(pendingTransition('start', 'prepared'));
    expect(reserving.basePolicyRevision).toBeLessThan(BASE_POLICY_REVISION);
    expectAccepted([reserving]);
  });

  it('requires the stored transition to carry the current epoch and revision', (): void => {
    const transition: PendingEnforcementTransition = pendingTransition('start', 'alarm-ready');

    expectRejected([
      transitionRuntime(transition, { runtimeRevision: transition.runtimeRevision + 1 }),
      transitionRuntime(transition, { enforcementEpoch: OTHER_EPOCH_ID }),
      cleanupTransitionRuntime('start', 'prepared', 'start-abandon', {
        runtimeRevision: CLEAR_RUNTIME_REVISION + 1,
      }),
    ]);
  });

  it('requires cleanup runtime commands to equal the progress commands', (): void => {
    expectRejected([
      cleanupTransitionRuntime('start', 'prepared', 'start-abandon', { documentCommands: {} }),
      cleanupClosureRuntime({ documentCommands: {} }),
      cleanupClosureRuntime({
        documentCommands: clearCommandMap({
          operationId: CLEANUP_OPERATION_ID,
          runtimeRevision: CLEAR_RUNTIME_REVISION,
          expectedUrl: 'https://other.example.com/',
        }),
      }),
    ]);
  });
});

describe('background runtime session and journal relationships', (): void => {
  it('rejects a coexisting transition and closure', (): void => {
    expectRejected([
      transitionRuntime(pendingTransition('start', 'prepared'), {
        pendingClosure: preparedClosure({ projection: runtimeClosureProjection() }),
      }),
    ]);
  });

  it('requires a pre-commit start to have no session', (): void => {
    expectRejected([
      transitionRuntime(pendingTransition('start', 'prepared'), { session: timedFocusSession() }),
      transitionRuntime(pendingTransition('start', 'starting-verified'), {
        session: pausedSession(),
      }),
    ]);
  });

  it('requires a pre-commit resume to retain the exact saved phase', (): void => {
    expectRejected([
      transitionRuntime(pendingTransition('resume', 'prepared'), { session: null }),
      transitionRuntime(pendingTransition('resume', 'prepared'), {
        session: resumedFocusSession(),
      }),
      transitionRuntime(pendingTransition('resume', 'prepared'), { session: breakSession() }),
      transitionRuntime(pendingTransition('resume', 'prepared'), {
        session: pausedSession({ sessionId: OTHER_SESSION_ID }),
      }),
    ]);
  });

  it('requires committed transition stages to retain the matching focus', (): void => {
    expectRejected([
      transitionRuntime(pendingTransition('start', 'alarm-ready'), { session: null }),
      transitionRuntime(pendingTransition('start', 'alarm-ready'), { session: pausedSession() }),
      transitionRuntime(pendingTransition('start', 'alarm-ready'), {
        session: timedFocusSession({ sessionId: OTHER_SESSION_ID }),
      }),
      transitionRuntime(pendingTransition('start', 'alarm-ready'), {
        session: timedFocusSession({ phaseStartedAt: ACTIVATION_AT + 1_000 }),
      }),
      transitionRuntime(pendingTransition('resume', 'active-verified'), {
        session: resumedFocusSession({ phaseStartedAt: ACTIVATION_AT - 1_000 }),
      }),
    ]);
  });

  it('requires cleanup source rows to preserve their session relationship', (): void => {
    expectRejected([
      cleanupTransitionRuntime('start', 'prepared', 'start-abandon', {
        session: timedFocusSession(),
      }),
      cleanupTransitionRuntime('resume', 'prepared', 'resume-restore', { session: null }),
      cleanupTransitionRuntime('resume', 'prepared', 'resume-restore', {
        session: resumedFocusSession(),
      }),
      cleanupTransitionRuntime('start', 'active-verified', 'timer-completed', { session: null }),
      cleanupTransitionRuntime('start', 'active-verified', 'timer-completed', {
        session: timedFocusSession({ sessionId: OTHER_SESSION_ID }),
      }),
      cleanupTransitionRuntime('start', 'active-verified', 'timer-completed', {
        session: timedFocusSession({ phaseStartedAt: RUNTIME_CLOSED_AT + 1_000 }),
      }),
    ]);
  });

  it('requires a prepared closure to keep its session unless a checkpoint clears it', (): void => {
    const detached: RuntimeStateV2 = preparedClosureRuntime({
      session: null,
      enforcementCheckpoint: null,
    });

    expectRejected([
      detached,
      preparedClosureRuntime({
        session: untilStoppedFocusSession({ sessionId: OTHER_SESSION_ID }),
        enforcementCheckpoint: null,
      }),
    ]);
    expectAccepted([commitCheckpointRuntime(detached)]);
  });

  it('requires a cleanup closure to clear its session and repeat runtime authority', (): void => {
    expectRejected([
      cleanupClosureRuntime({ session: untilStoppedFocusSession() }),
      cleanupClosureRuntime({ basePolicyRevision: BASE_POLICY_REVISION + 1 }),
      cleanupClosureRuntime({ enforcementEpoch: OTHER_EPOCH_ID }),
      cleanupClosureRuntime({ runtimeRevision: CLEAR_RUNTIME_REVISION + 1 }),
    ]);
  });

  it('lets the maintenance tick prune a projected handled record during cleanup', (): void => {
    const first: HandledScheduleOccurrence = handledOccurrence({
      entryId: 'entry-0',
      token: `entry-0@${LOCAL_DATE}`,
    });
    const second: HandledScheduleOccurrence = handledOccurrence({
      entryId: 'entry-1',
      token: `entry-1@${LOCAL_DATE}`,
    });
    const closure: CleanupClosureV2 = cleanupClosure({
      projection: runtimeClosureProjection({ handledOccurrences: [first, second] }),
    });

    expectAccepted([
      cleanupClosureRuntime({ pendingClosure: closure, handledScheduleOccurrences: [second] }),
      cleanupClosureRuntime({ pendingClosure: closure, handledScheduleOccurrences: [first] }),
      cleanupClosureRuntime({ pendingClosure: closure, handledScheduleOccurrences: [] }),
    ]);
    expectRejected([
      cleanupClosureRuntime({
        pendingClosure: closure,
        handledScheduleOccurrences: [first, handledOccurrence()],
      }),
      cleanupClosureRuntime({
        pendingClosure: closure,
        handledScheduleOccurrences: [{ ...first, reason: 'started' }],
      }),
    ]);
  });

  it('projects handled records only for a cleanup closure', (): void => {
    const first: HandledScheduleOccurrence = handledOccurrence({
      entryId: 'entry-0',
      token: `entry-0@${LOCAL_DATE}`,
    });
    const second: HandledScheduleOccurrence = handledOccurrence({
      entryId: 'entry-1',
      token: `entry-1@${LOCAL_DATE}`,
    });
    const closure: CleanupClosureV2 = cleanupClosure({
      projection: runtimeClosureProjection({ handledOccurrences: [first, second] }),
    });

    expectRejected([
      cleanupClosureRuntime({
        pendingClosure: closure,
        handledScheduleOccurrences: [second, first],
      }),
    ]);
    expectAccepted([
      cleanupClosureRuntime({
        pendingClosure: closure,
        handledScheduleOccurrences: [first, second],
      }),
      preparedClosureRuntime({ handledScheduleOccurrences: [] }),
      cleanupTransitionRuntime('start', 'active-verified', 'manual-end', {
        handledScheduleOccurrences: [],
      }),
    ]);
  });

  it('requires the commit checkpoint projection to equal every projected field', (): void => {
    const base: RuntimeStateV2 = publishedFocusRuntime();

    expectRejected([
      withProjectedKey(base, 'runtimeRevision', base.runtimeRevision + 1),
      withProjectedKey(base, 'session', null),
      withProjectedKey(base, 'accruedFocusMs', base.accruedFocusMs + 1),
      withProjectedKey(base, 'documentCommands', {}),
      withProjectedKey(base, 'enforcementEpoch', OTHER_EPOCH_ID),
      withCheckpointKey(
        base,
        'projection',
        withoutKey(runtimeCommitCheckpoint(base).projection, 'gate'),
      ),
      withCheckpointKey(
        base,
        'projection',
        withKey(runtimeCommitCheckpoint(base).projection, 'date', LOCAL_DATE),
      ),
    ]);
    expectAccepted([commitCheckpointRuntime(base)]);
  });
});

describe('background runtime hostile input and detachment', (): void => {
  it('rejects hostile roots and nested journals', (): void => {
    const closure: RuntimeStateV2 = cleanupClosureRuntime();
    const transition: RuntimeStateV2 = transitionRuntime(
      pendingTransition('start', 'active-verified'),
    );

    expectRejected([
      new Proxy(emptyRuntimeV2(), {}),
      Proxy.revocable<object>(emptyRuntimeV2(), {}).proxy,
      cyclicRecord(),
      withKey(emptyRuntimeV2(), 'tabStates', cyclicRecord()),
      withKey(publishedFocusRuntime(), 'session', new Proxy(timedFocusSession(), {})),
      withKey(closure, 'pendingClosure', new Proxy(closure.pendingClosure as object, {})),
      withKey(
        transition,
        'pendingEnforcementTransition',
        new Proxy(transition.pendingEnforcementTransition as object, {}),
      ),
      withCheckpointKey(
        closure,
        'projection',
        new Proxy(runtimeCommitCheckpoint(closure).projection, {}),
      ),
      withKey(emptyRuntimeV2(), 'todayAgg', new Proxy(dailyAgg(), {})),
    ]);
  });

  it('rejects throwing traps and symbol keys at every level', (): void => {
    const throwing: unknown = new Proxy<UnknownRecord>(
      {},
      {
        get: (): never => {
          throw new Error('get trap');
        },
        ownKeys: (): never => {
          throw new Error('ownKeys trap');
        },
      },
    );

    expectRejected([
      throwing,
      withKey(emptyRuntimeV2(), 'documentCommands', throwing),
      { ...emptyRuntimeV2(), [Symbol('extra')]: true },
      withKey(publishedFocusRuntime(), 'session', {
        ...timedFocusSession(),
        [Symbol('extra')]: true,
      }),
      withKey(emptyRuntimeV2(), 'todayAgg', { ...dailyAgg(), [Symbol('extra')]: true }),
    ]);
  });

  it('rejects accessor properties without reading them', (): void => {
    let reads: number = 0;
    const accessorSession: UnknownRecord = { ...timedFocusSession() };
    Object.defineProperty(accessorSession, 'focusedMs', {
      configurable: true,
      enumerable: true,
      get: (): number => {
        reads += 1;
        return 0;
      },
    });

    expectRejected([withKey(publishedFocusRuntime(), 'session', accessorSession)]);
    expect(reads).toBe(0);
  });

  it('does not execute a getter installed by a sibling proxy during inspection', (): void => {
    let getterCalls: number = 0;
    const runtime: RuntimeStateV2 = publishedFocusRuntime();
    const mutable: UnknownRecord = { ...timedFocusSession() };
    const trap: unknown = new Proxy(runtimeTabState(), {
      getPrototypeOf: (target: object): object | null => {
        Object.defineProperty(mutable, 'focusedMs', {
          configurable: true,
          enumerable: true,
          get: (): number => {
            getterCalls += 1;
            return 0;
          },
        });
        return Reflect.getPrototypeOf(target);
      },
    });

    expectRejected([{ ...runtime, session: mutable, tabStates: { 11: trap } }]);
    expect(getterCalls).toBe(0);
  });

  it('rejects sparse arrays and over-deep nesting in every journal', (): void => {
    let deep: UnknownRecord = {};
    for (let level: number = 0; level < 200; level++) deep = { nested: deep };
    const closure: RuntimeStateV2 = cleanupClosureRuntime();
    const projection: unknown = (closure.pendingClosure as CleanupClosureV2).projection;

    expectRejected([
      withKey(emptyRuntimeV2(), 'unlocks', sparseArray({ host: 'example.com', until: NOW })),
      withKey(emptyRuntimeV2(), 'handledScheduleOccurrences', sparseArray(handledOccurrence())),
      withKey(
        closure,
        'pendingClosure',
        withKey(
          closure.pendingClosure as object,
          'projection',
          withKey(projection as object, 'events', sparseArray(handledOccurrence())),
        ),
      ),
      withKey(emptyRuntimeV2(), 'todayAgg', deep),
      withKey(emptyRuntimeV2(), 'attemptDebounce', deep),
    ]);
  });

  it('returns one detached root snapshot and keeps legal acyclic aliases', (): void => {
    const shared: HandledScheduleOccurrence = handledOccurrence();
    const source: RuntimeStateV2 = cleanupClosureRuntime({
      pendingClosure: cleanupClosure({
        projection: runtimeClosureProjection({ handledOccurrences: [shared] }),
      }),
      handledScheduleOccurrences: [shared],
    });
    const parsed: RuntimeStateV2 = parseRuntimeStateV2(source) as RuntimeStateV2;
    const closure: CleanupClosureV2 = parsed.pendingClosure as CleanupClosureV2;

    expect(parsed).toEqual(source);
    expect(parsed).not.toBe(source);
    expect(parsed.handledScheduleOccurrences[0]).toBe(closure.projection.handledOccurrences[0]);
    expect(parsed.handledScheduleOccurrences[0]).not.toBe(shared);

    source.handledScheduleOccurrences[0] = handledOccurrence({ handledAt: 0, expiresAt: 0 });
    expect(parsed.handledScheduleOccurrences[0]).toEqual(shared);
    parsed.unlocks.push({ host: 'example.com', until: NOW });
    expect(source.unlocks).toHaveLength(0);
  });

  it('accepts an empty runtime and a runtime with no document targets', (): void => {
    expectAccepted([
      emptyRuntimeV2(),
      publishedFocusRuntime({
        documentCommands: {},
        epochResetAcks: {},
        tabStates: {},
        deferredBlockClaims: {},
        attemptDebounce: {},
      }),
    ]);
  });
});

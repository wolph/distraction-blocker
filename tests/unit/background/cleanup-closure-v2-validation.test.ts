import { describe, expect, it } from 'vitest';
import {
  parseCleanupEnforcementTarget,
  parseCleanupProgress,
  parseCleanupRetryState,
  parseCleanupSeed,
  parseCleanupTabClaim,
  parseClosureProjection,
  parsePendingClosure,
  parsePostCleanupClosure,
  validateDetachedCleanupProgress,
  validateDetachedCleanupSeed,
  validateDetachedClosureProjection,
  validateDetachedPendingClosure,
} from '../../../src/background/cleanup-closure-v2-validation';
import type { FrozenDocumentCommand } from '../../../src/background/enforcement-persistence-v2';
import type {
  CleanupProgress,
  CleanupTabClaim,
  ClosureProjection,
  PostCleanupClosure,
} from '../../../src/background/runtime-v2-types';
import type { SessionEndedEventV2 } from '../../../src/shared/types';
import {
  AGGREGATE_KEY,
  ARCHIVE_AGGREGATE_KEY,
  bankState,
  budgetEarnedEvent,
  CLEANUP_OPERATION_ID,
  CLEAR_RUNTIME_REVISION,
  type CleanupClosureV2,
  cleanupClosure,
  cleanupProgress,
  cleanupRetryState,
  cleanupSeed,
  cleanupTabClaim,
  cleanupTarget,
  cleanupTargetMap,
  clearCommand,
  clearCommandMap,
  closureProjection,
  dailyAgg,
  documentKey,
  EPOCH_ID,
  HANDLED_OCCURRENCE_TTL_MS,
  handledOccurrence,
  migrationInvalidActiveClosure,
  migrationInvalidActiveEndEvent,
  NOW,
  OTHER_EPOCH_ID,
  OTHER_OPERATION_ID,
  OTHER_SESSION_ID,
  type PreparedClosureV2,
  postCleanupClosure,
  preparedClosure,
  SECOND_TARGET_URL,
  SESSION_ID,
  scheduleOccurrence,
  sessionEndedEvent,
  TARGET_URL,
} from './runtime-v2-fixtures';

type UnknownRecord = Record<string, unknown>;

function withKey(value: object, key: string, replacement: unknown): UnknownRecord {
  return { ...value, [key]: replacement };
}

function withoutKey(value: object, key: string): UnknownRecord {
  const clone: UnknownRecord = { ...value };
  Reflect.deleteProperty(clone, key);
  return clone;
}

function expectRejected<T>(parse: (value: unknown) => T | null, values: readonly unknown[]): void {
  for (const value of values) {
    expect((): T | null => parse(value)).not.toThrow();
    expect(parse(value)).toBeNull();
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

describe('background cleanup retry state parsing', (): void => {
  it('accepts a fresh batch, a mid-batch attempt, and an exhausted batch', (): void => {
    const accepted: readonly unknown[] = [
      cleanupRetryState({ batch: 0, automaticAttempt: 0, nextAttemptAt: NOW }),
      cleanupRetryState({ batch: 3, automaticAttempt: 11, lastError: 'clear command timed out' }),
      cleanupRetryState({ automaticAttempt: 12, nextAttemptAt: null }),
    ];

    for (const value of accepted) {
      expect(parseCleanupRetryState(value)).toEqual(value);
    }
  });

  it('requires a non-negative safe integer batch', (): void => {
    expectRejected(parseCleanupRetryState, [
      cleanupRetryState({ batch: -1 }),
      cleanupRetryState({ batch: 1.5 }),
      cleanupRetryState({ batch: Number.MAX_SAFE_INTEGER + 1 }),
      cleanupRetryState({ batch: Number.NaN }),
      withKey(cleanupRetryState(), 'batch', '0'),
      withKey(cleanupRetryState(), 'batch', null),
      withoutKey(cleanupRetryState(), 'batch'),
    ]);
  });

  it('bounds the automatic attempt to the twelve-attempt cleanup budget', (): void => {
    for (let attempt: number = 0; attempt <= 11; attempt++) {
      expect(
        parseCleanupRetryState(cleanupRetryState({ automaticAttempt: attempt })),
      ).not.toBeNull();
    }
    expectRejected(parseCleanupRetryState, [
      cleanupRetryState({ automaticAttempt: 13 }),
      cleanupRetryState({ automaticAttempt: -1 }),
      cleanupRetryState({ automaticAttempt: 1.5 }),
      withKey(cleanupRetryState(), 'automaticAttempt', '3'),
    ]);
  });

  it('schedules every attempt below twelve and stops scheduling at twelve', (): void => {
    expectRejected(parseCleanupRetryState, [
      cleanupRetryState({ automaticAttempt: 11, nextAttemptAt: null }),
      cleanupRetryState({ automaticAttempt: 0, nextAttemptAt: null }),
      cleanupRetryState({ automaticAttempt: 12, nextAttemptAt: NOW }),
      cleanupRetryState({ nextAttemptAt: -1 }),
      cleanupRetryState({ nextAttemptAt: 1.5 }),
      cleanupRetryState({ nextAttemptAt: Number.NaN }),
      withKey(cleanupRetryState(), 'nextAttemptAt', `${NOW}`),
    ]);
  });

  it('keeps the last error null or non-blank', (): void => {
    expect(parseCleanupRetryState(cleanupRetryState({ lastError: null }))).not.toBeNull();
    expectRejected(parseCleanupRetryState, [
      cleanupRetryState({ lastError: '' }),
      cleanupRetryState({ lastError: '   ' }),
      withKey(cleanupRetryState(), 'lastError', 0),
      withKey(cleanupRetryState(), 'extra', true),
    ]);
  });

  it('rejects hostile retry roots', (): void => {
    expectRejected(parseCleanupRetryState, [
      new Proxy(cleanupRetryState(), {}),
      cyclicRecord(),
      [cleanupRetryState()],
      null,
      undefined,
      'retry',
    ]);
  });
});

describe('background cleanup seed and claim parsing', (): void => {
  it('accepts an empty seed and a claimed seed', (): void => {
    const accepted: readonly unknown[] = [
      cleanupSeed({ alarmNames: [], tabClaims: [] }),
      cleanupSeed(),
      cleanupTabClaim(0, { muteUrl: null, priorMuted: null, stoppedDocumentId: 'document-1' }),
    ];

    expect(parseCleanupSeed(accepted[0])).toEqual(accepted[0]);
    expect(parseCleanupSeed(accepted[1])).toEqual(accepted[1]);
    expect(parseCleanupTabClaim(accepted[2])).toEqual(accepted[2]);
    expect(validateDetachedCleanupSeed(structuredClone(cleanupSeed()))).toBe(true);
  });

  it('requires unique claims sorted by tab ID', (): void => {
    expectRejected(parseCleanupSeed, [
      cleanupSeed({ tabClaims: [cleanupTabClaim(12), cleanupTabClaim(11)] }),
      cleanupSeed({ tabClaims: [cleanupTabClaim(11), cleanupTabClaim(11)] }),
      cleanupSeed({
        tabClaims: [cleanupTabClaim(11), cleanupTabClaim(11, { muteUrl: null })],
      }),
    ]);
  });

  it('rejects invalid alarm names, claim identities, and claim states', (): void => {
    expectRejected(parseCleanupSeed, [
      cleanupSeed({ alarmNames: ['   '] }),
      withKey(cleanupSeed(), 'alarmNames', [11]),
      withKey(cleanupSeed(), 'alarmNames', {}),
      withKey(cleanupSeed(), 'alarmNames', sparseArray('phase')),
      cleanupSeed({ tabClaims: [cleanupTabClaim(-1)] }),
      cleanupSeed({ tabClaims: [cleanupTabClaim(1.5)] }),
      withKey(cleanupSeed(), 'tabClaims', [withKey(cleanupTabClaim(11), 'extra', true)]),
      withKey(cleanupSeed(), 'tabClaims', [withoutKey(cleanupTabClaim(11), 'state')]),
      withKey(cleanupSeed(), 'extra', true),
      withoutKey(cleanupSeed(), 'tabClaims'),
    ]);
    expectRejected(parseCleanupTabClaim, [
      cleanupTabClaim(11, { muteUrl: '' }),
      cleanupTabClaim(11, { stoppedDocumentId: '  ' }),
      { tabId: 11, state: withKey(cleanupTabClaim(11).state, 'priorMuted', 'false') },
      { tabId: 11, state: withoutKey(cleanupTabClaim(11).state, 'muteUrl') },
      { tabId: 11, state: withKey(cleanupTabClaim(11).state, 'url', TARGET_URL) },
    ]);
  });

  it('rejects hostile seed roots, nested claims, and sparse claim arrays', (): void => {
    let tabIdReads: number = 0;
    const accessorClaim: UnknownRecord = { ...cleanupTabClaim(11) };
    Object.defineProperty(accessorClaim, 'tabId', {
      configurable: true,
      enumerable: true,
      get: (): number => {
        tabIdReads += 1;
        return 11;
      },
    });

    expectRejected(parseCleanupSeed, [
      new Proxy(cleanupSeed(), {}),
      withKey(cleanupSeed(), 'tabClaims', [new Proxy(cleanupTabClaim(11), {})]),
      withKey(cleanupSeed(), 'tabClaims', [accessorClaim]),
      withKey(cleanupSeed(), 'tabClaims', sparseArray(cleanupTabClaim(11))),
      withKey(cleanupSeed(), 'tabClaims', [
        { tabId: 11, state: { ...cleanupTabClaim(11).state, [Symbol('extra')]: true } },
      ]),
      cyclicRecord(),
      null,
    ]);
    expect(tabIdReads).toBe(0);
    expect(
      validateDetachedCleanupSeed(
        withKey(cleanupSeed(), 'tabClaims', sparseArray(cleanupTabClaim(11))),
      ),
    ).toBe(false);
  });

  it('detaches parsed seeds in both directions', (): void => {
    const source: ReturnType<typeof cleanupSeed> = cleanupSeed();
    const parsed: ReturnType<typeof cleanupSeed> = parseCleanupSeed(source) as ReturnType<
      typeof cleanupSeed
    >;
    const parsedClaim: CleanupTabClaim = parsed.tabClaims[0] as CleanupTabClaim;
    const sourceClaim: CleanupTabClaim = source.tabClaims[0] as CleanupTabClaim;

    expect(parsed).toEqual(source);
    expect(parsed.tabClaims).not.toBe(source.tabClaims);
    sourceClaim.state.muteUrl = 'https://mutated.test/';
    expect(parsedClaim.state.muteUrl).toBe('https://example.com/muted');
    parsed.alarmNames.pop();
    expect(source.alarmNames).toHaveLength(2);
  });
});

describe('background cleanup progress parsing', (): void => {
  it('accepts a consistent stored batch and an empty target batch', (): void => {
    const empty: CleanupProgress = cleanupProgress({ targets: {}, clearCommands: {} });

    for (const value of [cleanupProgress(), empty]) {
      expect(parseCleanupProgress(value)).toEqual(value);
      expect(validateDetachedCleanupProgress(structuredClone(value))).toBe(true);
    }
    expect(parseCleanupEnforcementTarget(cleanupTarget())).toEqual(cleanupTarget());
  });

  it('ties every clear command to the stored operation and clear revision', (): void => {
    const rebatched: CleanupProgress = cleanupProgress({
      cleanupOperationId: OTHER_OPERATION_ID,
      clearRuntimeRevision: CLEAR_RUNTIME_REVISION + 1,
    });

    expect(parseCleanupProgress(rebatched)).toEqual(rebatched);
    expectRejected(parseCleanupProgress, [
      cleanupProgress({ clearCommands: clearCommandMap({ operationId: OTHER_OPERATION_ID }) }),
      cleanupProgress({ clearCommands: clearCommandMap({ runtimeRevision: 3 }) }),
      cleanupProgress({ cleanupOperationId: 'not-a-uuid' }),
      cleanupProgress({ clearRuntimeRevision: -1 }),
      cleanupProgress({ clearRuntimeRevision: 1.5 }),
      withKey(cleanupProgress(), 'cleanupOperationId', null),
    ]);
  });

  it('keeps one enforcement epoch and one session identity across the batch', (): void => {
    const reserved: CleanupProgress = cleanupProgress({
      clearCommands: clearCommandMap({ sessionId: null, reservedSessionId: SESSION_ID }),
    });

    expect(parseCleanupProgress(reserved)).toEqual(reserved);
    expectRejected(parseCleanupProgress, [
      cleanupProgress({
        clearCommands: {
          [documentKey(11, 'document-1')]: clearCommand(),
          [documentKey(12, 'document-2')]: clearCommand({
            tabId: 12,
            documentId: 'document-2',
            expectedUrl: SECOND_TARGET_URL,
            enforcementEpoch: OTHER_EPOCH_ID,
          }),
        },
      }),
      cleanupProgress({
        clearCommands: {
          [documentKey(11, 'document-1')]: clearCommand(),
          [documentKey(12, 'document-2')]: clearCommand({
            tabId: 12,
            documentId: 'document-2',
            expectedUrl: SECOND_TARGET_URL,
            sessionId: OTHER_SESSION_ID,
          }),
        },
      }),
      cleanupProgress({
        clearCommands: {
          [documentKey(11, 'document-1')]: clearCommand(),
          [documentKey(12, 'document-2')]: clearCommand({
            tabId: 12,
            documentId: 'document-2',
            expectedUrl: SECOND_TARGET_URL,
            sessionId: null,
            reservedSessionId: SESSION_ID,
          }),
        },
      }),
    ]);
  });

  it('requires one keyed target for every keyed clear command', (): void => {
    expectRejected(parseCleanupProgress, [
      cleanupProgress({ clearCommands: { [documentKey(11, 'document-1')]: clearCommand() } }),
      cleanupProgress({ targets: { [documentKey(11, 'document-1')]: cleanupTarget() } }),
      cleanupProgress({
        targets: { ...cleanupTargetMap(), [documentKey(13, 'document-3')]: cleanupTarget() },
      }),
      cleanupProgress({
        targets: {
          [documentKey(11, 'document-1')]: cleanupTarget(),
          [documentKey(12, 'document-9')]: cleanupTarget({ tabId: 12, documentId: 'document-9' }),
        },
      }),
    ]);
  });

  it('keys targets and clear commands by tab and document identity', (): void => {
    expectRejected(parseCleanupProgress, [
      cleanupProgress({
        targets: { 'document-1': cleanupTarget() },
        clearCommands: { 'document-1': clearCommand() },
      }),
      cleanupProgress({
        targets: { [documentKey(99, 'document-9')]: cleanupTarget() },
        clearCommands: { [documentKey(99, 'document-9')]: clearCommand() },
      }),
      cleanupProgress({ targets: { 'document-1': cleanupTarget() }, clearCommands: {} }),
      cleanupProgress({
        targets: { [documentKey(11, 'document-1')]: cleanupTarget({ tabId: 12 }) },
        clearCommands: { [documentKey(11, 'document-1')]: clearCommand() },
      }),
      cleanupProgress({
        targets: { [documentKey(11, 'document-1')]: cleanupTarget() },
        clearCommands: { [documentKey(11, 'document-1')]: clearCommand({ tabId: 12 }) },
      }),
      withKey(cleanupProgress(), 'targets', [cleanupTarget()]),
      withKey(cleanupProgress(), 'clearCommands', null),
    ]);
    expectRejected(parseCleanupEnforcementTarget, [
      cleanupTarget({ tabId: -1 }),
      cleanupTarget({ documentId: '  ' }),
      cleanupTarget({ expectedUrl: '' }),
      withKey(cleanupTarget(), 'url', TARGET_URL),
    ]);
  });

  it('requires each clear command to clear its own target document and URL', (): void => {
    expectRejected(parseCleanupProgress, [
      cleanupProgress({
        targets: { [documentKey(11, 'document-1')]: cleanupTarget({ expectedUrl: TARGET_URL }) },
        clearCommands: {
          [documentKey(11, 'document-1')]: clearCommand({ expectedUrl: SECOND_TARGET_URL }),
        },
      }),
      cleanupProgress({ clearCommands: clearCommandMap({ presentation: 'starting' }) }),
      cleanupProgress({
        clearCommands: clearCommandMap({
          verdict: { blocked: true, reason: 'category', categoryId: 'social', matchedPattern: 'x' },
        }),
      }),
      cleanupProgress({
        targets: { [documentKey(11, 'document-1')]: cleanupTarget() },
        clearCommands: {
          [documentKey(11, 'document-1')]: withKey(clearCommand(), 'overlay', {
            version: 1,
            presentation: 'starting',
            capturedAt: NOW,
            theme: 'dark',
            stoppedPage: false,
            copy: {
              title: 'Focus Lock is starting',
              detail: 'Applying your selected rules.',
              verdictProvenance: 'Blocked by Social media: example.com',
              stoppedPage: null,
            },
            actions: { end: 'hidden' },
          }) as unknown as FrozenDocumentCommand,
        },
      }),
    ]);
  });

  it('requires unique resolved tab IDs in tab order', (): void => {
    const resolved: CleanupProgress = cleanupProgress({ resolvedTabIds: [11, 12] });

    expect(parseCleanupProgress(resolved)).toEqual(resolved);
    expectRejected(parseCleanupProgress, [
      cleanupProgress({ resolvedTabIds: [12, 11] }),
      cleanupProgress({ resolvedTabIds: [11, 11] }),
      cleanupProgress({ resolvedTabIds: [-1] }),
      cleanupProgress({ resolvedTabIds: [1.5] }),
      withKey(cleanupProgress(), 'resolvedTabIds', ['11']),
      withKey(cleanupProgress(), 'resolvedTabIds', sparseArray(11)),
      withKey(cleanupProgress(), 'resolvedTabIds', {}),
    ]);
  });

  it('requires unique progress claims sorted by tab ID and a valid retry state', (): void => {
    expectRejected(parseCleanupProgress, [
      cleanupProgress({ tabClaims: [cleanupTabClaim(12), cleanupTabClaim(11)] }),
      cleanupProgress({ tabClaims: [cleanupTabClaim(11), cleanupTabClaim(11)] }),
      cleanupProgress({ retry: cleanupRetryState({ automaticAttempt: 13 }) }),
      cleanupProgress({ retry: cleanupRetryState({ lastError: '' }) }),
      withKey(cleanupProgress(), 'retry', null),
      withKey(cleanupProgress(), 'extra', true),
      withoutKey(cleanupProgress(), 'resolvedTabIds'),
    ]);
  });

  it('rejects hostile progress roots, hostile commands, and mutation during inspection', (): void => {
    let revisionReads: number = 0;
    const accessorCommand: UnknownRecord = { ...clearCommand() };
    Object.defineProperty(accessorCommand, 'runtimeRevision', {
      configurable: true,
      enumerable: true,
      get: (): number => {
        revisionReads += 1;
        return CLEAR_RUNTIME_REVISION;
      },
    });
    const claims: CleanupTabClaim[] = [cleanupTabClaim(11)];
    const growing: CleanupTabClaim[] = new Proxy(claims, {
      ownKeys: (target: CleanupTabClaim[]): ArrayLike<string | symbol> => {
        target.push(cleanupTabClaim(12));
        return Reflect.ownKeys(target);
      },
    });

    expectRejected(parseCleanupProgress, [
      new Proxy(cleanupProgress(), {}),
      cleanupProgress({
        targets: { [documentKey(11, 'document-1')]: cleanupTarget() },
        clearCommands: { [documentKey(11, 'document-1')]: new Proxy(clearCommand(), {}) },
      }),
      cleanupProgress({
        targets: { [documentKey(11, 'document-1')]: cleanupTarget() },
        clearCommands: {
          [documentKey(11, 'document-1')]: accessorCommand as unknown as FrozenDocumentCommand,
        },
      }),
      withKey(cleanupProgress(), 'targets', { ...cleanupTargetMap(), [Symbol('extra')]: true }),
      cyclicRecord(),
      null,
    ]);
    expect(revisionReads).toBe(0);
    expect(parseCleanupProgress(withKey(cleanupProgress(), 'tabClaims', growing))).toBeNull();
    expect(claims).toHaveLength(2);
  });

  it('detaches parsed progress in both directions', (): void => {
    const source: CleanupProgress = cleanupProgress();
    const parsed: CleanupProgress = parseCleanupProgress(source) as CleanupProgress;
    const key: string = documentKey(11, 'document-1');
    const sourceCommand: FrozenDocumentCommand = source.clearCommands[key] as FrozenDocumentCommand;
    const parsedCommand: FrozenDocumentCommand = parsed.clearCommands[key] as FrozenDocumentCommand;

    expect(parsed).toEqual(source);
    expect(parsed.clearCommands).not.toBe(source.clearCommands);
    sourceCommand.expectedUrl = 'https://mutated.test/';
    expect(parsedCommand.expectedUrl).toBe(TARGET_URL);
    parsed.retry.lastError = 'mutated';
    expect(source.retry.lastError).toBeNull();
  });
});

describe('background closure projection parsing', (): void => {
  it('accepts manual, timer, and scheduled closures', (): void => {
    const scheduled: ClosureProjection = closureProjection({
      endEvent: sessionEndedEvent({
        reason: 'timer-completed',
        outcome: 'completed',
        duration: { kind: 'timed', minutes: 25 },
        source: 'schedule',
        scheduleOccurrence: scheduleOccurrence(),
      }),
    });
    const canceled: ClosureProjection = closureProjection({
      endEvent: sessionEndedEvent({
        reason: 'manual-canceled',
        outcome: 'canceled',
        duration: { kind: 'timed', minutes: 25 },
      }),
    });

    for (const value of [closureProjection(), scheduled, canceled]) {
      expect(parseClosureProjection(value)).toEqual(value);
      expect(validateDetachedClosureProjection(structuredClone(value))).toBe(true);
    }
  });

  it('derives the closure and end event identities from the session ID', (): void => {
    expectRejected(parseClosureProjection, [
      closureProjection({ closureId: `${SESSION_ID}:closed` }),
      closureProjection({ closureId: `${OTHER_SESSION_ID}:close` }),
      closureProjection({ sessionId: OTHER_SESSION_ID }),
      closureProjection({ sessionId: 'not-a-uuid', closureId: 'not-a-uuid:close' }),
      closureProjection({ endEvent: sessionEndedEvent({ sessionId: OTHER_SESSION_ID }) }),
      closureProjection({
        endEvent: sessionEndedEvent({ eventId: `${SESSION_ID}:ended` }),
      }),
    ]);
  });

  it('requires the end event to repeat the projected reason, outcome, focus, and end time', (): void => {
    expectRejected(parseClosureProjection, [
      closureProjection({ reason: 'manual-canceled' }),
      closureProjection({ outcome: 'canceled' }),
      closureProjection({ focusedMs: 29_000 }),
      closureProjection({ endedAt: NOW }),
      withKey(closureProjection(), 'endedAt', -1),
      withKey(closureProjection(), 'focusedMs', 1.5),
      withKey(closureProjection(), 'endEvent', null),
    ]);
  });

  it('rejects an end event whose reason, outcome, and duration disagree', (): void => {
    expectRejected(parseClosureProjection, [
      closureProjection({
        endEvent: sessionEndedEvent({ reason: 'manual-completed', outcome: 'canceled' }),
      }),
      closureProjection({
        endEvent: sessionEndedEvent({
          reason: 'timer-completed',
          duration: { kind: 'until-stopped' },
        }),
      }),
      closureProjection({
        endEvent: sessionEndedEvent({ reason: 'manual-canceled', outcome: 'canceled' }),
      }),
      closureProjection({ endEvent: sessionEndedEvent({ reason: 'recovery-failed' } as never) }),
    ]);
  });

  it('ends the event list with the end event exactly once', (): void => {
    const endEvent: SessionEndedEventV2 = sessionEndedEvent();
    const settled: ClosureProjection = closureProjection({
      endEvent,
      events: [budgetEarnedEvent(), budgetEarnedEvent({ at: NOW + 20_000 }), endEvent],
    });

    expect(parseClosureProjection(settled)).toEqual(settled);
    expectRejected(parseClosureProjection, [
      closureProjection({ events: [] }),
      closureProjection({ endEvent, events: [endEvent, budgetEarnedEvent()] }),
      closureProjection({ endEvent, events: [endEvent, endEvent] }),
      closureProjection({
        endEvent,
        events: [sessionEndedEvent({ at: NOW + 1_000 }), endEvent],
      }),
      closureProjection({ events: [budgetEarnedEvent()] }),
      closureProjection({ endEvent, events: [budgetEarnedEvent({ ms: -1 }), endEvent] }),
      closureProjection({
        endEvent,
        events: [withKey(budgetEarnedEvent(), 'extra', true) as never, endEvent],
      }),
      withKey(closureProjection(), 'events', {}),
    ]);
  });

  it('increments completions only for a completed outcome', (): void => {
    expectRejected(parseClosureProjection, [
      closureProjection({ completionIncrement: 0 }),
      closureProjection({
        endEvent: sessionEndedEvent({
          reason: 'manual-canceled',
          outcome: 'canceled',
          duration: { kind: 'timed', minutes: 25 },
        }),
        completionIncrement: 1,
      }),
      withKey(closureProjection(), 'completionIncrement', 2),
      withKey(closureProjection(), 'completionIncrement', true),
    ]);
  });

  it('keeps bank, handled records, and aggregate projections in their exact domains', (): void => {
    const archived: ClosureProjection = closureProjection({
      aggregateSets: { [ARCHIVE_AGGREGATE_KEY]: dailyAgg() },
      aggregateRemoves: [AGGREGATE_KEY],
    });

    const shifted: ClosureProjection = closureProjection({
      handledOccurrences: [
        handledOccurrence({
          handledAt: NOW + 5_000,
          expiresAt: NOW + 5_000 + HANDLED_OCCURRENCE_TTL_MS,
        }),
      ],
    });

    expect(parseClosureProjection(archived)).toEqual(archived);
    expect(parseClosureProjection(shifted)).toEqual(shifted);
    expectRejected(parseClosureProjection, [
      closureProjection({ handledOccurrences: [handledOccurrence({ handledAt: NOW + 5_000 })] }),
      closureProjection({ bankAfter: bankState({ balanceMs: -1 }) }),
      closureProjection({ bankAfter: bankState({ balanceMs: Number.POSITIVE_INFINITY }) }),
      withKey(closureProjection(), 'bankAfter', withKey(bankState(), 'extra', 1)),
      closureProjection({ handledOccurrences: [handledOccurrence({ expiresAt: NOW })] }),
      closureProjection({
        handledOccurrences: [handledOccurrence({ token: 'weekday@2026-09-03' })],
      }),
      closureProjection({ handledOccurrences: [handledOccurrence({ reason: 'ended' } as never)] }),
      closureProjection({ handledOccurrences: [handledOccurrence(), handledOccurrence()] }),
      withKey(closureProjection(), 'handledOccurrences', {}),
      closureProjection({ aggregateSets: { [AGGREGATE_KEY]: dailyAgg({ date: '2026-09-03' }) } }),
      closureProjection({ aggregateSets: { 'device-1': dailyAgg() } }),
      closureProjection({ aggregateSets: { [AGGREGATE_KEY]: dailyAgg({ focusMs: -1 }) } }),
      closureProjection({
        aggregateSets: { [AGGREGATE_KEY]: withKey(dailyAgg(), 'extra', 1) as never },
      }),
      closureProjection({ aggregateRemoves: ['2026-09-02'] }),
      closureProjection({ aggregateRemoves: [ARCHIVE_AGGREGATE_KEY] }),
      withKey(closureProjection(), 'aggregateRemoves', {}),
    ]);
  });

  it('accepts an aggregate key that is both set and removed', (): void => {
    const both: ClosureProjection = closureProjection({ aggregateRemoves: [AGGREGATE_KEY] });

    expect(parseClosureProjection(both)).toEqual(both);
  });

  it('requires a scheduled closure to carry its exact occurrence', (): void => {
    expectRejected(parseClosureProjection, [
      closureProjection({
        endEvent: sessionEndedEvent({
          reason: 'manual-canceled',
          outcome: 'canceled',
          duration: { kind: 'timed', minutes: 25 },
          source: 'schedule',
          scheduleOccurrence: null,
        }),
      }),
      closureProjection({
        endEvent: sessionEndedEvent({
          source: 'schedule',
          scheduleOccurrence: scheduleOccurrence({ token: 'other@2026-09-02' }),
        }),
      }),
      closureProjection({
        endEvent: sessionEndedEvent({ scheduleOccurrence: scheduleOccurrence() }),
      }),
    ]);
  });

  it('allows a missing occurrence only for the timed canceled invalid-active-state migration', (): void => {
    const migrated: ClosureProjection = closureProjection({
      endEvent: migrationInvalidActiveEndEvent(),
      handledOccurrences: [],
    });

    expect(parseClosureProjection(migrated)).toEqual(migrated);
    expect(migrated.completionIncrement).toBe(0);
    expectRejected(parseClosureProjection, [
      closureProjection({
        endEvent: migrationInvalidActiveEndEvent({ duration: { kind: 'until-stopped' } }),
      }),
      closureProjection({
        endEvent: migrationInvalidActiveEndEvent({ reason: 'tab-enforcement-failed' }),
      }),
      closureProjection({
        endEvent: migrationInvalidActiveEndEvent(),
        completionIncrement: 1,
      }),
    ]);
  });

  it('carries no mutable cleanup progress field', (): void => {
    expectRejected(parseClosureProjection, [
      withKey(closureProjection(), 'cleanupProgress', cleanupProgress()),
      withKey(closureProjection(), 'retry', cleanupRetryState()),
      withKey(closureProjection(), 'resolvedTabIds', []),
      withKey(closureProjection(), 'cleanupOperationId', CLEANUP_OPERATION_ID),
      withKey(closureProjection(), 'tabClaims', []),
      withoutKey(closureProjection(), 'bankAfter'),
    ]);
  });

  it('rejects hostile projection roots and hostile nested events', (): void => {
    let atReads: number = 0;
    const accessorEvent: UnknownRecord = { ...budgetEarnedEvent() };
    Object.defineProperty(accessorEvent, 'at', {
      configurable: true,
      enumerable: true,
      get: (): number => {
        atReads += 1;
        return NOW;
      },
    });
    const endEvent: SessionEndedEventV2 = sessionEndedEvent();

    expectRejected(parseClosureProjection, [
      new Proxy(closureProjection(), {}),
      closureProjection({ endEvent: new Proxy(endEvent, {}) }),
      withKey(closureProjection(), 'events', sparseArray(endEvent)),
      closureProjection({ endEvent, events: [accessorEvent as never, endEvent] }),
      withKey(closureProjection(), 'handledOccurrences', [
        { ...handledOccurrence(), [Symbol('extra')]: true },
      ]),
      withKey(closureProjection(), 'bankAfter', cyclicRecord()),
      cyclicRecord(),
      null,
      [closureProjection()],
    ]);
    expect(atReads).toBe(0);
  });

  it('detaches parsed projections in both directions', (): void => {
    const source: ClosureProjection = closureProjection();
    const parsed: ClosureProjection = parseClosureProjection(source) as ClosureProjection;

    expect(parsed).toEqual(source);
    expect(parsed.endEvent).not.toBe(source.endEvent);
    source.endEvent.focusedMs = 1;
    expect(parsed.endEvent.focusedMs).toBe(30_000);
    parsed.events.pop();
    expect(source.events).toHaveLength(2);
  });

  it('preserves the alias between the end event and the last stored event', (): void => {
    const parsed: ClosureProjection = parseClosureProjection(
      closureProjection(),
    ) as ClosureProjection;

    expect(parsed.events[parsed.events.length - 1]).toBe(parsed.endEvent);
  });
});

describe('background pending closure parsing', (): void => {
  it('accepts a prepared closure, a cleanup closure, and the migration cleanup closure', (): void => {
    for (const value of [preparedClosure(), cleanupClosure(), migrationInvalidActiveClosure()]) {
      expect(parsePendingClosure(value)).toEqual(value);
      expect(validateDetachedPendingClosure(structuredClone(value))).toBe(true);
    }
  });

  it('holds cleanup progress in the cleanup stage only', (): void => {
    expectRejected(parsePendingClosure, [
      preparedClosure({ cleanupProgress: cleanupProgress() as never }),
      withKey(cleanupClosure(), 'cleanupProgress', null),
      withKey(cleanupClosure(), 'cleanupProgress', cleanupProgress({ resolvedTabIds: [11, 11] })),
      withKey(cleanupClosure(), 'stage', 'cleaning'),
      withKey(cleanupClosure(), 'version', 2),
      withoutKey(cleanupClosure(), 'cleanupProgress'),
      withKey(cleanupClosure(), 'extra', true),
    ]);
  });

  it('carries no mutable cleanup progress field inside the immutable seed', (): void => {
    expectRejected(parsePendingClosure, [
      withKey(
        cleanupClosure(),
        'cleanupSeed',
        withKey(cleanupSeed(), 'retry', cleanupRetryState()),
      ),
      withKey(cleanupClosure(), 'cleanupSeed', withKey(cleanupSeed(), 'resolvedTabIds', [])),
      withKey(
        cleanupClosure(),
        'cleanupSeed',
        withKey(cleanupSeed(), 'cleanupOperationId', CLEANUP_OPERATION_ID),
      ),
      withKey(
        cleanupClosure(),
        'projection',
        withKey(closureProjection(), 'retry', cleanupRetryState()),
      ),
    ]);
  });

  it('continues every seed claim into progress without contradicting it', (): void => {
    const filled: CleanupClosureV2 = cleanupClosure({
      cleanupSeed: cleanupSeed({
        tabClaims: [cleanupTabClaim(11, { stoppedDocumentId: null }), cleanupTabClaim(12)],
      }),
    });
    const discovered: CleanupClosureV2 = cleanupClosure({
      cleanupProgress: cleanupProgress({
        tabClaims: [cleanupTabClaim(11), cleanupTabClaim(12), cleanupTabClaim(13)],
      }),
    });

    for (const value of [filled, discovered]) {
      expect(parsePendingClosure(value)).toEqual(value);
    }
    expectRejected(parsePendingClosure, [
      cleanupClosure({
        cleanupProgress: cleanupProgress({ tabClaims: [cleanupTabClaim(12)] }),
      }),
      cleanupClosure({
        cleanupProgress: cleanupProgress({
          tabClaims: [cleanupTabClaim(11, { priorMuted: true }), cleanupTabClaim(12)],
        }),
      }),
      cleanupClosure({
        cleanupProgress: cleanupProgress({
          tabClaims: [cleanupTabClaim(11, { muteUrl: null }), cleanupTabClaim(12)],
        }),
      }),
    ]);
  });

  it('clears documents under the closed session identity', (): void => {
    expectRejected(parsePendingClosure, [
      cleanupClosure({
        cleanupProgress: cleanupProgress({
          clearCommands: clearCommandMap({ sessionId: OTHER_SESSION_ID }),
        }),
      }),
      cleanupClosure({
        cleanupProgress: cleanupProgress({
          clearCommands: clearCommandMap({ sessionId: null, reservedSessionId: SESSION_ID }),
        }),
      }),
    ]);
  });

  it('rejects hostile closure roots and hostile nested authority', (): void => {
    expectRejected(parsePendingClosure, [
      new Proxy(cleanupClosure(), {}),
      withKey(cleanupClosure(), 'projection', new Proxy(closureProjection(), {})),
      withKey(cleanupClosure(), 'cleanupSeed', new Proxy(cleanupSeed(), {})),
      withKey(cleanupClosure(), 'cleanupProgress', new Proxy(cleanupProgress(), {})),
      cyclicRecord(),
      null,
      'cleanup',
    ]);
  });

  it('detaches parsed closures in both directions', (): void => {
    const source: PreparedClosureV2 = preparedClosure();
    const parsed: PreparedClosureV2 = parsePendingClosure(source) as PreparedClosureV2;

    expect(parsed).toEqual(source);
    expect(parsed.projection).not.toBe(source.projection);
    source.cleanupSeed.alarmNames.push('tick');
    expect(parsed.cleanupSeed.alarmNames).toHaveLength(2);
    parsed.projection.bankAfter.balanceMs = 0;
    expect(source.projection.bankAfter.balanceMs).toBe(120_000);
  });
});

describe('background post-cleanup closure parsing', (): void => {
  it('accepts an immutable projection and seed handoff', (): void => {
    const value: PostCleanupClosure = postCleanupClosure();

    expect(parsePostCleanupClosure(value)).toEqual(value);
  });

  it('rejects cleanup progress and invalid handoff members', (): void => {
    expectRejected(parsePostCleanupClosure, [
      withKey(postCleanupClosure(), 'cleanupProgress', cleanupProgress()),
      withKey(postCleanupClosure(), 'cleanupProgress', null),
      withKey(postCleanupClosure(), 'projection', closureProjection({ completionIncrement: 0 })),
      withKey(postCleanupClosure(), 'cleanupSeed', cleanupSeed({ alarmNames: [''] })),
      withoutKey(postCleanupClosure(), 'cleanupSeed'),
      new Proxy(postCleanupClosure(), {}),
      null,
    ]);
  });

  it('keeps the closure projection contract on the handoff projection', (): void => {
    expectRejected(parsePostCleanupClosure, [
      postCleanupClosure({ projection: closureProjection({ endedAt: NOW }) }),
      postCleanupClosure({ projection: closureProjection({ closureId: 'wrong' }) }),
      postCleanupClosure({ projection: closureProjection({ events: [] }) }),
    ]);
  });
});

describe('background epoch and revision independence', (): void => {
  it('compares cleanup epochs only for equality', (): void => {
    const relabelled: CleanupProgress = cleanupProgress({
      clearCommands: clearCommandMap({
        enforcementEpoch: OTHER_EPOCH_ID,
        operationId: CLEANUP_OPERATION_ID,
        runtimeRevision: CLEAR_RUNTIME_REVISION,
      }),
    });

    expect(parseCleanupProgress(relabelled)).toEqual(relabelled);
    expect(relabelled.clearCommands[documentKey(11, 'document-1')]?.enforcementEpoch).toBe(
      OTHER_EPOCH_ID,
    );
    expect(EPOCH_ID).not.toBe(OTHER_EPOCH_ID);
  });
});

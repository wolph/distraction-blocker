import { describe, expect, it } from 'vitest';
import {
  validateDetachedCleanupProgress,
  validateDetachedCleanupRetryState,
  validateDetachedCleanupSeed,
} from '../../../src/background/cleanup-closure-v2-validation';
import {
  addCleanupTargetV2,
  beginManualCleanupBatchV2,
  buildCleanupProgressV2,
  buildCleanupSeedV2,
  buildFrozenClearCommandV2,
  CLEANUP_MAX_AUTOMATIC_ATTEMPTS,
  CLEANUP_RETRY_DELAYS_MS,
  type ClearCommandIdentityV2,
  documentCommandKeyV2,
  freshCleanupRetryStateV2,
  mergeCleanupTabClaimV2,
  NO_SESSION_VERDICT,
  nextCleanupAttemptAtV2,
  recordCleanupAttemptFailureV2,
  replaceCleanupBatchV2,
  resolveCleanupTabV2,
} from '../../../src/background/cleanup-progress-v2';
import type { FrozenDocumentCommand } from '../../../src/background/enforcement-persistence-v2';
import { validateDetachedFrozenDocumentCommand } from '../../../src/background/enforcement-persistence-v2-validation';
import type { RuntimeTabState } from '../../../src/background/runtime-leaf-types';
import type {
  CleanupEnforcementTarget,
  CleanupProgress,
  CleanupRetryState,
  CleanupSeed,
} from '../../../src/background/runtime-v2-types';
import { CoreError } from '../../../src/shared/errors';
import {
  BASE_POLICY_REVISION,
  CLEANUP_OPERATION_ID,
  CLEAR_RUNTIME_REVISION,
  documentKey,
  EPOCH_ID,
  NOW,
  OTHER_OPERATION_ID,
  OTHER_SESSION_ID,
  runtimeTabState,
  SECOND_TARGET_URL,
  SESSION_ID,
  TARGET_URL,
} from './runtime-v2-fixtures';

const SIX_HOURS_MS: number = 6 * 60 * 60_000;
const IDENTITY: Omit<ClearCommandIdentityV2, 'operationId' | 'runtimeRevision'> = {
  enforcementEpoch: EPOCH_ID,
  sessionId: SESSION_ID,
  reservedSessionId: null,
  basePolicyRevision: BASE_POLICY_REVISION,
};
const FULL_IDENTITY: ClearCommandIdentityV2 = {
  ...IDENTITY,
  operationId: CLEANUP_OPERATION_ID,
  runtimeRevision: CLEAR_RUNTIME_REVISION,
};
const FIRST_TARGET: CleanupEnforcementTarget = {
  tabId: 11,
  documentId: 'document-1',
  expectedUrl: TARGET_URL,
};
const SECOND_TARGET: CleanupEnforcementTarget = {
  tabId: 12,
  documentId: 'document-2',
  expectedUrl: SECOND_TARGET_URL,
};
const THIRD_TARGET: CleanupEnforcementTarget = {
  tabId: 13,
  documentId: 'document-3',
  expectedUrl: 'https://third.example/page',
};
const FIRST_KEY: string = documentKey(11, 'document-1');
const SECOND_KEY: string = documentKey(12, 'document-2');
const THIRD_KEY: string = documentKey(13, 'document-3');

function expectInvalidRule(run: () => unknown): void {
  expect(run).toThrow(CoreError);
  try {
    run();
    expect.unreachable('expected an invalid-rule CoreError');
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).code).toBe('invalid-rule');
  }
}

function seedFixture(): CleanupSeed {
  return buildCleanupSeedV2(['closure-cleanup', 'phase'], {
    11: runtimeTabState(),
    12: runtimeTabState({ muteUrl: null }),
  });
}

function progressFixture(): CleanupProgress {
  return buildCleanupProgressV2({
    cleanupOperationId: CLEANUP_OPERATION_ID,
    clearRuntimeRevision: CLEAR_RUNTIME_REVISION,
    targets: [FIRST_TARGET, SECOND_TARGET],
    identity: IDENTITY,
    seed: seedFixture(),
    at: NOW,
    batch: 0,
  });
}

describe('cleanup retry schedule', (): void => {
  it('exposes the six explicit delays and the twelve attempt bound', (): void => {
    expect(CLEANUP_RETRY_DELAYS_MS).toEqual([
      60_000, 120_000, 300_000, 900_000, 1_800_000, 3_600_000,
    ]);
    expect(CLEANUP_MAX_AUTOMATIC_ATTEMPTS).toBe(12);
  });

  it.each([
    [0, 0],
    [1, 60_000],
    [2, 120_000],
    [3, 300_000],
    [4, 900_000],
    [5, 1_800_000],
    [6, 3_600_000],
    [7, SIX_HOURS_MS],
    [8, SIX_HOURS_MS],
    [9, SIX_HOURS_MS],
    [10, SIX_HOURS_MS],
    [11, SIX_HOURS_MS],
  ])('schedules the attempt after attempt %i', (attempt: number, delay: number): void => {
    expect(nextCleanupAttemptAtV2(attempt, NOW)).toBe(NOW + delay);
  });

  it('stops scheduling once the twelfth attempt is spent', (): void => {
    expect(nextCleanupAttemptAtV2(CLEANUP_MAX_AUTOMATIC_ATTEMPTS, NOW)).toBeNull();
  });

  it('rejects arithmetic that leaves the safe range', (): void => {
    expectInvalidRule((): number | null => nextCleanupAttemptAtV2(1, Number.MAX_SAFE_INTEGER));
    expectInvalidRule((): number | null => nextCleanupAttemptAtV2(1, -1));
  });
});

describe('cleanup retry state', (): void => {
  it('starts a batch with an immediate first attempt', (): void => {
    const retry: CleanupRetryState = freshCleanupRetryStateV2(2, NOW);

    expect(retry).toEqual({ batch: 2, automaticAttempt: 0, nextAttemptAt: NOW, lastError: null });
    expect(validateDetachedCleanupRetryState(retry)).toBe(true);
  });

  it('records a failure with its error and the next scheduled attempt', (): void => {
    const first: CleanupRetryState = recordCleanupAttemptFailureV2(
      freshCleanupRetryStateV2(0, NOW),
      NOW,
      'clear command was not acknowledged',
    );

    expect(first).toEqual({
      batch: 0,
      automaticAttempt: 1,
      nextAttemptAt: NOW + 60_000,
      lastError: 'clear command was not acknowledged',
    });
    expect(validateDetachedCleanupRetryState(first)).toBe(true);
  });

  it('never mutates the retry state it is given', (): void => {
    const fresh: CleanupRetryState = freshCleanupRetryStateV2(0, NOW);

    recordCleanupAttemptFailureV2(fresh, NOW, 'first failure');
    beginManualCleanupBatchV2(fresh, NOW);

    expect(fresh).toEqual({ batch: 0, automaticAttempt: 0, nextAttemptAt: NOW, lastError: null });
  });

  it('exhausts a batch after twelve failures and starts the next batch manually', (): void => {
    let retry: CleanupRetryState = freshCleanupRetryStateV2(0, NOW);
    for (let attempt: number = 1; attempt <= CLEANUP_MAX_AUTOMATIC_ATTEMPTS; attempt++) {
      retry = recordCleanupAttemptFailureV2(retry, NOW, `attempt ${attempt} failed`);
      expect(retry.automaticAttempt).toBe(attempt);
    }

    expect(retry.nextAttemptAt).toBeNull();
    expect(retry.lastError).toBe('attempt 12 failed');
    expect(validateDetachedCleanupRetryState(retry)).toBe(true);

    const manual: CleanupRetryState = beginManualCleanupBatchV2(retry, NOW + 1);

    expect(manual).toEqual({
      batch: 1,
      automaticAttempt: 0,
      nextAttemptAt: NOW + 1,
      lastError: null,
    });
    expect(validateDetachedCleanupRetryState(manual)).toBe(true);
  });

  it('refuses a thirteenth automatic failure and a blank error', (): void => {
    let retry: CleanupRetryState = freshCleanupRetryStateV2(0, NOW);
    for (let attempt: number = 1; attempt <= CLEANUP_MAX_AUTOMATIC_ATTEMPTS; attempt++) {
      retry = recordCleanupAttemptFailureV2(retry, NOW, 'failed');
    }

    expectInvalidRule((): CleanupRetryState => recordCleanupAttemptFailureV2(retry, NOW, 'failed'));
    expectInvalidRule(
      (): CleanupRetryState =>
        recordCleanupAttemptFailureV2(freshCleanupRetryStateV2(0, NOW), NOW, '  '),
    );
  });
});

describe('frozen clear commands', (): void => {
  it('freezes one clear command for its target', (): void => {
    const command: FrozenDocumentCommand = buildFrozenClearCommandV2(FIRST_TARGET, FULL_IDENTITY);

    expect(command).toEqual({
      version: 1,
      command: 'apply-enforcement',
      operationId: CLEANUP_OPERATION_ID,
      enforcementEpoch: EPOCH_ID,
      sessionId: SESSION_ID,
      reservedSessionId: null,
      basePolicyRevision: BASE_POLICY_REVISION,
      runtimeRevision: CLEAR_RUNTIME_REVISION,
      documentId: 'document-1',
      expectedUrl: TARGET_URL,
      presentation: 'clear',
      verdict: NO_SESSION_VERDICT,
      overlay: null,
      tabId: 11,
    });
    expect(NO_SESSION_VERDICT).toEqual({
      blocked: false,
      reason: 'no-session',
      categoryId: null,
      matchedPattern: null,
    });
    expect(validateDetachedFrozenDocumentCommand(command)).toBe(true);
  });

  it('gives every command its own verdict object', (): void => {
    const first: FrozenDocumentCommand = buildFrozenClearCommandV2(FIRST_TARGET, FULL_IDENTITY);
    const second: FrozenDocumentCommand = buildFrozenClearCommandV2(SECOND_TARGET, FULL_IDENTITY);

    expect(first.verdict).not.toBe(NO_SESSION_VERDICT);
    expect(first.verdict).not.toBe(second.verdict);
  });

  it('accepts a reserved session identity', (): void => {
    const command: FrozenDocumentCommand = buildFrozenClearCommandV2(FIRST_TARGET, {
      ...FULL_IDENTITY,
      sessionId: null,
      reservedSessionId: SESSION_ID,
    });

    expect(command.sessionId).toBeNull();
    expect(command.reservedSessionId).toBe(SESSION_ID);
    expect(validateDetachedFrozenDocumentCommand(command)).toBe(true);
  });

  it.each([
    { sessionId: SESSION_ID, reservedSessionId: OTHER_SESSION_ID },
    { sessionId: null, reservedSessionId: null },
    { sessionId: 'not-a-uuid', reservedSessionId: null },
  ])('rejects the ambiguous session identity %#', (identity: Partial<ClearCommandIdentityV2>) => {
    expectInvalidRule(
      (): FrozenDocumentCommand =>
        buildFrozenClearCommandV2(FIRST_TARGET, { ...FULL_IDENTITY, ...identity }),
    );
  });

  it('rejects an identity or target the frozen command validator refuses', (): void => {
    expectInvalidRule(
      (): FrozenDocumentCommand =>
        buildFrozenClearCommandV2(FIRST_TARGET, { ...FULL_IDENTITY, enforcementEpoch: 'epoch' }),
    );
    expectInvalidRule(
      (): FrozenDocumentCommand =>
        buildFrozenClearCommandV2({ ...FIRST_TARGET, expectedUrl: '' }, FULL_IDENTITY),
    );
    expectInvalidRule(
      (): FrozenDocumentCommand =>
        buildFrozenClearCommandV2(FIRST_TARGET, { ...FULL_IDENTITY, basePolicyRevision: -1 }),
    );
  });
});

describe('document command keys', (): void => {
  it('keys a command by tab and document', (): void => {
    expect(documentCommandKeyV2(11, 'document-1')).toBe('11:document-1');
  });

  it.each([[1.5], [-1], [Number.MAX_SAFE_INTEGER + 1], [Number.NaN]])(
    'rejects the tab ID %#',
    (tabId: number): void => {
      expectInvalidRule((): string => documentCommandKeyV2(tabId, 'document-1'));
    },
  );

  it.each([[''], ['   ']])('rejects the document ID %#', (documentId: string): void => {
    expectInvalidRule((): string => documentCommandKeyV2(11, documentId));
  });
});

describe('cleanup seed', (): void => {
  it('claims each tab once with its captured state', (): void => {
    const seed: CleanupSeed = seedFixture();

    expect(seed).toEqual({
      alarmNames: ['closure-cleanup', 'phase'],
      tabClaims: [
        { tabId: 11, state: runtimeTabState() },
        { tabId: 12, state: runtimeTabState({ muteUrl: null }) },
      ],
    });
    expect(validateDetachedCleanupSeed(seed)).toBe(true);
  });

  it('sorts claims by tab ID when the record iterates out of order', (): void => {
    const tabStates: Record<number, RuntimeTabState> = {
      4294967296: runtimeTabState(),
      4294967295: runtimeTabState({ priorMuted: true }),
    };

    const seed: CleanupSeed = buildCleanupSeedV2([], tabStates);

    expect(seed.tabClaims.map((claim: { tabId: number }): number => claim.tabId)).toEqual([
      4_294_967_295, 4_294_967_296,
    ]);
    expect(validateDetachedCleanupSeed(seed)).toBe(true);
  });

  it('clones every captured state and alarm list', (): void => {
    const state: RuntimeTabState = runtimeTabState();
    const alarmNames: string[] = ['closure-cleanup'];
    const tabStates: Record<number, RuntimeTabState> = { 11: state };

    const seed: CleanupSeed = buildCleanupSeedV2(alarmNames, tabStates);
    state.muteUrl = 'https://example.com/changed';
    alarmNames.push('phase');
    tabStates[12] = runtimeTabState();

    expect(seed).toEqual({
      alarmNames: ['closure-cleanup'],
      tabClaims: [{ tabId: 11, state: runtimeTabState() }],
    });
  });

  it.each([
    { 'tab-1': runtimeTabState() },
    { '04': runtimeTabState() },
    { '-1': runtimeTabState() },
    { 11: { ...runtimeTabState(), extra: true } },
    { 11: { muteUrl: '', priorMuted: false, stoppedDocumentId: null } },
    { 11: { muteUrl: null, priorMuted: 'yes', stoppedDocumentId: null } },
  ])('rejects the hostile tab state record %#', (tabStates: Record<string, unknown>): void => {
    expectInvalidRule(
      (): CleanupSeed =>
        buildCleanupSeedV2([], tabStates as unknown as Record<number, RuntimeTabState>),
    );
  });

  it('rejects a blank alarm name', (): void => {
    expectInvalidRule((): CleanupSeed => buildCleanupSeedV2([' '], {}));
  });
});

describe('cleanup progress', (): void => {
  it('freezes one target and one command per key over the seed claims', (): void => {
    const seed: CleanupSeed = seedFixture();
    const progress: CleanupProgress = buildCleanupProgressV2({
      cleanupOperationId: CLEANUP_OPERATION_ID,
      clearRuntimeRevision: CLEAR_RUNTIME_REVISION,
      targets: [FIRST_TARGET, SECOND_TARGET],
      identity: IDENTITY,
      seed,
      at: NOW,
      batch: 3,
    });

    expect(Object.keys(progress.targets)).toEqual([FIRST_KEY, SECOND_KEY]);
    expect(progress.targets[FIRST_KEY]).toEqual(FIRST_TARGET);
    expect(progress.clearCommands[FIRST_KEY]).toEqual(
      buildFrozenClearCommandV2(FIRST_TARGET, FULL_IDENTITY),
    );
    expect(progress.clearCommands[SECOND_KEY]).toEqual(
      buildFrozenClearCommandV2(SECOND_TARGET, FULL_IDENTITY),
    );
    expect(progress.tabClaims).toEqual(seed.tabClaims);
    expect(progress.resolvedTabIds).toEqual([]);
    expect(progress.retry).toEqual(freshCleanupRetryStateV2(3, NOW));
    expect(validateDetachedCleanupProgress(progress)).toBe(true);
  });

  it('detaches the claims it copies from the seed', (): void => {
    const seed: CleanupSeed = seedFixture();
    const progress: CleanupProgress = buildCleanupProgressV2({
      cleanupOperationId: CLEANUP_OPERATION_ID,
      clearRuntimeRevision: CLEAR_RUNTIME_REVISION,
      targets: [],
      identity: IDENTITY,
      seed,
      at: NOW,
      batch: 0,
    });

    const claim: { state: RuntimeTabState } | undefined = progress.tabClaims[0];
    if (claim !== undefined) claim.state.muteUrl = 'https://example.com/changed';

    expect(seed.tabClaims[0]?.state.muteUrl).toBe(runtimeTabState().muteUrl);
    expect(progress.targets).toEqual({});
    expect(progress.clearCommands).toEqual({});
  });

  it('rejects an operation ID the progress validator refuses', (): void => {
    expectInvalidRule(
      (): CleanupProgress =>
        buildCleanupProgressV2({
          cleanupOperationId: 'not-a-uuid',
          clearRuntimeRevision: CLEAR_RUNTIME_REVISION,
          targets: [FIRST_TARGET],
          identity: IDENTITY,
          seed: seedFixture(),
          at: NOW,
          batch: 0,
        }),
    );
  });
});

describe('cleanup claim merging', (): void => {
  it('inserts a newly discovered claim in tab order', (): void => {
    const progress: CleanupProgress = progressFixture();

    const merged: CleanupProgress = mergeCleanupTabClaimV2(progress, {
      tabId: 5,
      state: runtimeTabState({ stoppedDocumentId: 'document-5' }),
    });

    expect(merged.tabClaims.map((claim: { tabId: number }): number => claim.tabId)).toEqual([
      5, 11, 12,
    ]);
    expect(progress.tabClaims.map((claim: { tabId: number }): number => claim.tabId)).toEqual([
      11, 12,
    ]);
    expect(validateDetachedCleanupProgress(merged)).toBe(true);
  });

  it('fills only a saved null and keeps every saved non-null field', (): void => {
    const progress: CleanupProgress = progressFixture();

    const merged: CleanupProgress = mergeCleanupTabClaimV2(progress, {
      tabId: 12,
      state: {
        muteUrl: 'https://example.com/discovered',
        priorMuted: false,
        stoppedDocumentId: 'document-1',
      },
    });

    expect(merged.tabClaims[1]).toEqual({
      tabId: 12,
      state: runtimeTabState({ muteUrl: 'https://example.com/discovered' }),
    });
    expect(progress.tabClaims[1]).toEqual({ tabId: 12, state: runtimeTabState({ muteUrl: null }) });
  });

  it('keeps a saved non-null field when the observation is null', (): void => {
    const progress: CleanupProgress = progressFixture();

    const merged: CleanupProgress = mergeCleanupTabClaimV2(progress, {
      tabId: 11,
      state: { muteUrl: null, priorMuted: null, stoppedDocumentId: null },
    });

    expect(merged.tabClaims[0]).toEqual({ tabId: 11, state: runtimeTabState() });
  });

  it.each([
    { muteUrl: 'https://example.com/other', priorMuted: false, stoppedDocumentId: 'document-1' },
    { muteUrl: null, priorMuted: true, stoppedDocumentId: 'document-1' },
    { muteUrl: null, priorMuted: null, stoppedDocumentId: 'document-9' },
  ])('rejects contradictory ownership %#', (state: RuntimeTabState): void => {
    const progress: CleanupProgress = progressFixture();

    expectInvalidRule(
      (): CleanupProgress => mergeCleanupTabClaimV2(progress, { tabId: 11, state }),
    );
  });

  it('rejects a malformed claim', (): void => {
    const progress: CleanupProgress = progressFixture();

    expectInvalidRule(
      (): CleanupProgress =>
        mergeCleanupTabClaimV2(progress, {
          tabId: -1,
          state: runtimeTabState(),
        }),
    );
  });
});

describe('newly discovered cleanup targets', (): void => {
  it('adds a keyed target under the existing operation and clear revision', (): void => {
    const progress: CleanupProgress = progressFixture();

    const added: CleanupProgress = addCleanupTargetV2(progress, THIRD_TARGET, IDENTITY);

    expect(added.targets[THIRD_KEY]).toEqual(THIRD_TARGET);
    expect(added.clearCommands[THIRD_KEY]).toEqual(
      buildFrozenClearCommandV2(THIRD_TARGET, FULL_IDENTITY),
    );
    expect(added.clearCommands[FIRST_KEY]).toEqual(progress.clearCommands[FIRST_KEY]);
    expect(added.clearCommands[SECOND_KEY]).toEqual(progress.clearCommands[SECOND_KEY]);
    expect(added.cleanupOperationId).toBe(progress.cleanupOperationId);
    expect(added.clearRuntimeRevision).toBe(progress.clearRuntimeRevision);
    expect(Object.keys(progress.targets)).toEqual([FIRST_KEY, SECOND_KEY]);
    expect(validateDetachedCleanupProgress(added)).toBe(true);
  });

  it('leaves an already known document unchanged', (): void => {
    const progress: CleanupProgress = progressFixture();

    const again: CleanupProgress = addCleanupTargetV2(
      progress,
      { ...FIRST_TARGET, expectedUrl: 'https://example.com/moved' },
      IDENTITY,
    );

    expect(again).toEqual(progress);
  });

  it('rejects a target whose identity disagrees with the batch', (): void => {
    const progress: CleanupProgress = progressFixture();

    expectInvalidRule(
      (): CleanupProgress =>
        addCleanupTargetV2(progress, THIRD_TARGET, {
          ...IDENTITY,
          sessionId: null,
          reservedSessionId: SESSION_ID,
        }),
    );
  });
});

describe('resolved cleanup tabs', (): void => {
  it('keeps resolved tab IDs unique and sorted', (): void => {
    const progress: CleanupProgress = progressFixture();

    const resolved: CleanupProgress = resolveCleanupTabV2(
      resolveCleanupTabV2(resolveCleanupTabV2(progress, 12), 11),
      12,
    );

    expect(resolved.resolvedTabIds).toEqual([11, 12]);
    expect(progress.resolvedTabIds).toEqual([]);
    expect(validateDetachedCleanupProgress(resolved)).toBe(true);
  });

  it('rejects a malformed tab ID', (): void => {
    const progress: CleanupProgress = progressFixture();

    expectInvalidRule((): CleanupProgress => resolveCleanupTabV2(progress, -1));
  });
});

describe('manual cleanup batches', (): void => {
  it('replaces the batch identity and keeps every recorded fact', (): void => {
    const progress: CleanupProgress = resolveCleanupTabV2(progressFixture(), 11);

    const replaced: CleanupProgress = replaceCleanupBatchV2(progress, {
      cleanupOperationId: OTHER_OPERATION_ID,
      clearRuntimeRevision: CLEAR_RUNTIME_REVISION + 1,
      at: NOW + 5,
    });

    expect(replaced.cleanupOperationId).toBe(OTHER_OPERATION_ID);
    expect(replaced.clearRuntimeRevision).toBe(CLEAR_RUNTIME_REVISION + 1);
    expect(Object.keys(replaced.clearCommands)).toEqual([FIRST_KEY, SECOND_KEY]);
    for (const command of Object.values(replaced.clearCommands)) {
      expect(command.operationId).toBe(OTHER_OPERATION_ID);
      expect(command.runtimeRevision).toBe(CLEAR_RUNTIME_REVISION + 1);
    }
    expect(replaced.clearCommands[FIRST_KEY]).toEqual({
      ...buildFrozenClearCommandV2(FIRST_TARGET, FULL_IDENTITY),
      operationId: OTHER_OPERATION_ID,
      runtimeRevision: CLEAR_RUNTIME_REVISION + 1,
    });
    expect(replaced.targets).toEqual(progress.targets);
    expect(replaced.tabClaims).toEqual(progress.tabClaims);
    expect(replaced.resolvedTabIds).toEqual(progress.resolvedTabIds);
    expect(replaced.retry).toEqual(beginManualCleanupBatchV2(progress.retry, NOW + 5));
    expect(validateDetachedCleanupProgress(replaced)).toBe(true);
    expect(progress.cleanupOperationId).toBe(CLEANUP_OPERATION_ID);
    expect(progress.clearCommands[FIRST_KEY]?.operationId).toBe(CLEANUP_OPERATION_ID);
  });

  it('rejects a replacement identity the progress validator refuses', (): void => {
    const progress: CleanupProgress = progressFixture();

    expectInvalidRule(
      (): CleanupProgress =>
        replaceCleanupBatchV2(progress, {
          cleanupOperationId: 'not-a-uuid',
          clearRuntimeRevision: CLEAR_RUNTIME_REVISION + 1,
          at: NOW + 5,
        }),
    );
  });
});

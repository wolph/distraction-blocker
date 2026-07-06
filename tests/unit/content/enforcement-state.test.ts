import { describe, expect, it } from 'vitest';
import type { ContentCommandResultV2 } from '../../../src/content/enforcement-state';
import {
  canonicalSessionIdentityV2,
  compareEnforcementTuplesV2,
  createContentEnforcementState,
  handleContentCommandV2,
} from '../../../src/content/enforcement-state';
import type {
  ContentEnforcementResponse,
  ContentEnforcementState,
  ContentEnforcementTuple,
  DocumentContentCommand,
  DocumentEnforcementCommand,
  DocumentOverlayView,
  ResetEnforcementEpochCommand,
} from '../../../src/shared/enforcement-v2';
import {
  parseContentEnforcementResponse,
  parseDocumentContentCommand,
} from '../../../src/shared/enforcement-v2-validation';
import { CoreError } from '../../../src/shared/errors';
import type { Verdict } from '../../../src/shared/types';

type StartingOverlay = Extract<DocumentOverlayView, { presentation: 'starting' }>;
type ActiveOverlay = Extract<DocumentOverlayView, { presentation: 'active' }>;
type ActiveCopy = ActiveOverlay['copy'];

const NOW: number = 1_750_000_000_000;
const OBSERVED_URL: string = 'https://example.com/path';
const DOCUMENT_ID: string = 'document-1';
const SESSION_ID: string = '10000000-0000-4000-8000-000000000001';
const OTHER_SESSION_ID: string = '10000000-0000-4000-8000-000000000002';
const OPERATION_A: string = '20000000-0000-4000-8000-000000000001';
const OPERATION_B: string = '20000000-0000-4000-8000-000000000002';
const OPERATION_C: string = '20000000-0000-4000-8000-000000000003';
const EPOCH_A: string = '30000000-0000-4000-8000-000000000001';
const EPOCH_B: string = '30000000-0000-4000-8000-000000000002';
const EPOCH_C: string = '30000000-0000-4000-8000-000000000003';
const PROVENANCE: string = 'Blocked by Social media: example.com';
const BLOCKED_VERDICT: Verdict = {
  blocked: true,
  reason: 'category',
  categoryId: 'social',
  matchedPattern: 'example.com',
};
const CLEAR_VERDICT: Verdict = {
  blocked: false,
  reason: 'no-session',
  categoryId: null,
  matchedPattern: null,
};
const ALLOWED_VERDICT: Verdict = {
  blocked: false,
  reason: 'unlock',
  categoryId: null,
  matchedPattern: 'example.com',
};

function activeCopy(overrides: Partial<ActiveCopy> = {}): ActiveCopy {
  return {
    status: { kind: 'timed', text: 'Focus Lock is active for 1:00 more.' },
    lockedUntil: 'Locked until 14:35',
    intention: 'Finish the release notes',
    attempts: '2 attempts blocked today',
    verdictProvenance: PROVENANCE,
    stoppedPage: null,
    bankUnit: 'pause banked',
    pauseAction: 'Pause blocking for 1 min',
    unlockAction: 'Unlock this site for 2 min',
    endAction: 'End session',
    bankWaitFallback: 'earn pause time by focusing',
    bankWaitPrefix: 'ready in',
    gateTitle: null,
    gateBack: 'Never mind, back to work',
    gatePhraseLabel: 'Type this to confirm:',
    gateForceEnd: 'Ignore timeout and end anyway',
    gateConfirm: null,
    transportError: 'Focus Lock could not update this action. Try again.',
    ...overrides,
  };
}

function activeOverlay(overrides: Partial<ActiveOverlay> = {}): ActiveOverlay {
  return {
    version: 1,
    presentation: 'active',
    theme: 'dark',
    sessionId: SESSION_ID,
    phase: 'focus',
    mode: 'blacklist',
    strictness: 'flexible',
    duration: { kind: 'timed', minutes: 25 },
    timing: {
      capturedAt: NOW,
      phaseStartedAt: NOW - 1_000,
      phaseEndsAt: NOW + 60_000,
      sessionEndsAt: NOW + 120_000,
    },
    economy: {
      bankMs: 60_000,
      bankAccrualPerMs: 1 / 6,
      bankCapMs: 300_000,
      pauseCostMs: 60_000,
      unlockCostMs: 120_000,
    },
    gate: null,
    activeUnlocks: [{ host: 'example.com', until: NOW + 30_000 }],
    attemptsToday: 2,
    stoppedPage: false,
    actions: { state: 'ready', end: 'request-end', pause: 'request-gate', unlock: 'request-gate' },
    copy: activeCopy(),
    ...overrides,
  };
}

function startingOverlay(overrides: Partial<StartingOverlay> = {}): StartingOverlay {
  return {
    version: 1,
    presentation: 'starting',
    capturedAt: NOW,
    theme: 'dark',
    stoppedPage: false,
    copy: {
      title: 'Focus Lock is starting',
      detail: 'Applying your selected rules.',
      verdictProvenance: PROVENANCE,
      stoppedPage: null,
    },
    actions: { end: 'hidden' },
    ...overrides,
  };
}

function enforcementCommand(
  overrides: Partial<DocumentEnforcementCommand> = {},
): DocumentEnforcementCommand {
  return {
    version: 1,
    command: 'apply-enforcement',
    operationId: OPERATION_A,
    enforcementEpoch: EPOCH_A,
    sessionId: SESSION_ID,
    reservedSessionId: null,
    basePolicyRevision: 4,
    runtimeRevision: 7,
    documentId: DOCUMENT_ID,
    expectedUrl: OBSERVED_URL,
    presentation: 'active',
    verdict: BLOCKED_VERDICT,
    overlay: activeOverlay(),
    ...overrides,
  };
}

function clearCommand(
  overrides: Partial<DocumentEnforcementCommand> = {},
): DocumentEnforcementCommand {
  return enforcementCommand({
    presentation: 'clear',
    verdict: CLEAR_VERDICT,
    overlay: null,
    ...overrides,
  });
}

function allowedCommand(
  overrides: Partial<DocumentEnforcementCommand> = {},
): DocumentEnforcementCommand {
  return enforcementCommand({
    presentation: 'active',
    verdict: ALLOWED_VERDICT,
    overlay: null,
    ...overrides,
  });
}

function startingCommand(
  overrides: Partial<DocumentEnforcementCommand> = {},
): DocumentEnforcementCommand {
  return enforcementCommand({
    sessionId: null,
    reservedSessionId: SESSION_ID,
    presentation: 'starting',
    verdict: BLOCKED_VERDICT,
    overlay: startingOverlay(),
    ...overrides,
  });
}

function resetCommand(
  overrides: Partial<ResetEnforcementEpochCommand> = {},
): ResetEnforcementEpochCommand {
  return {
    version: 1,
    command: 'reset-enforcement-epoch',
    operationId: OPERATION_C,
    enforcementEpoch: EPOCH_A,
    documentId: DOCUMENT_ID,
    expectedUrl: OBSERVED_URL,
    ...overrides,
  };
}

function tuple(overrides: Partial<ContentEnforcementTuple> = {}): ContentEnforcementTuple {
  return {
    enforcementEpoch: EPOCH_A,
    sessionId: SESSION_ID,
    reservedSessionId: null,
    basePolicyRevision: 4,
    runtimeRevision: 7,
    ...overrides,
  };
}

/** Drives the machine so every fixture state is one the machine itself can reach. */
function resetTo(
  epoch: string,
  state: ContentEnforcementState = createContentEnforcementState(),
): ContentEnforcementState {
  return handleContentCommandV2(state, resetCommand({ enforcementEpoch: epoch }), OBSERVED_URL, NOW)
    .state;
}

function stateWith(
  command: DocumentEnforcementCommand,
  epoch: string = EPOCH_A,
): ContentEnforcementState {
  return handleContentCommandV2(resetTo(epoch), command, OBSERVED_URL, NOW).state;
}

/** Asserts the produced response is exactly what the landed parser accepts and carries no tab ID. */
function parsedResponse(result: ContentCommandResultV2): ContentEnforcementResponse {
  const response: ContentEnforcementResponse | null = result.response;
  if (response === null) throw new Error('expected a response');
  expect(Object.hasOwn(response, 'tabId')).toBe(false);
  expect(parseContentEnforcementResponse(response)).toEqual(response);
  return response;
}

describe('command fixtures', () => {
  it('are exactly what the landed command parser accepts', () => {
    const commands: readonly DocumentContentCommand[] = [
      enforcementCommand(),
      clearCommand(),
      allowedCommand(),
      startingCommand(),
      resetCommand(),
    ];

    for (const command of commands) {
      expect(parseDocumentContentCommand(command)).toEqual(command);
    }
  });
});

describe('createContentEnforcementState', () => {
  it('starts with no epoch, no tuple, and no view', () => {
    expect(createContentEnforcementState()).toEqual({
      enforcementEpoch: null,
      retiredEnforcementEpochs: [],
      tuple: null,
      presentation: null,
      verdict: null,
      overlay: null,
    });
  });

  it('returns a fresh container every call', () => {
    expect(createContentEnforcementState()).not.toBe(createContentEnforcementState());
  });
});

describe('compareEnforcementTuplesV2', () => {
  it('throws an invalid-rule CoreError across unequal epochs', () => {
    const left: ContentEnforcementTuple = tuple();
    const right: ContentEnforcementTuple = tuple({ enforcementEpoch: EPOCH_B });

    expect((): -1 | 0 | 1 => compareEnforcementTuplesV2(left, right)).toThrow(CoreError);
    try {
      compareEnforcementTuplesV2(left, right);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(CoreError);
      expect((error as CoreError).code).toBe('invalid-rule');
    }
  });

  it('compares base revision first', () => {
    const higherBase: ContentEnforcementTuple = tuple({
      basePolicyRevision: 5,
      runtimeRevision: 0,
    });
    const lowerBase: ContentEnforcementTuple = tuple({ basePolicyRevision: 4, runtimeRevision: 9 });

    expect(compareEnforcementTuplesV2(higherBase, lowerBase)).toBe(1);
    expect(compareEnforcementTuplesV2(lowerBase, higherBase)).toBe(-1);
  });

  it('compares runtime revision second', () => {
    const base: ContentEnforcementTuple = tuple({ runtimeRevision: 7 });

    expect(compareEnforcementTuplesV2(base, tuple({ runtimeRevision: 8 }))).toBe(-1);
    expect(compareEnforcementTuplesV2(base, tuple({ runtimeRevision: 7 }))).toBe(0);
    expect(compareEnforcementTuplesV2(base, tuple({ runtimeRevision: 6 }))).toBe(1);
  });

  it('ignores session identity, which is checked separately', () => {
    const reserved: ContentEnforcementTuple = tuple({
      sessionId: null,
      reservedSessionId: OTHER_SESSION_ID,
    });

    expect(compareEnforcementTuplesV2(tuple(), reserved)).toBe(0);
  });
});

describe('canonicalSessionIdentityV2', () => {
  it('is stable for the same identity in the same field', () => {
    expect(canonicalSessionIdentityV2(tuple({ runtimeRevision: 9 }))).toBe(
      canonicalSessionIdentityV2(tuple()),
    );
  });

  it('is one identity across the reserved field and the durable field', () => {
    const reserved: ContentEnforcementTuple = tuple({
      sessionId: null,
      reservedSessionId: SESSION_ID,
    });

    expect(canonicalSessionIdentityV2(reserved)).toBe(canonicalSessionIdentityV2(tuple()));
  });

  it('separates two different session identities', () => {
    expect(canonicalSessionIdentityV2(tuple({ sessionId: OTHER_SESSION_ID }))).not.toBe(
      canonicalSessionIdentityV2(tuple()),
    );
  });

  it('throws an invalid-rule CoreError for a tuple with two identities or none', () => {
    const both: ContentEnforcementTuple = tuple({ reservedSessionId: OTHER_SESSION_ID });
    const neither: ContentEnforcementTuple = tuple({ sessionId: null, reservedSessionId: null });

    expect(() => canonicalSessionIdentityV2(both)).toThrow(CoreError);
    expect(() => canonicalSessionIdentityV2(neither)).toThrow(CoreError);
  });
});

describe('handleContentCommandV2 command admission', () => {
  it('rejects an enforcement command carrying two session identities', () => {
    // The parser excludes this pair, so it can only arrive by bypassing it. Both identities
    // collapsed onto one shared key before, which made two unrelated sessions compare equal.
    const command: DocumentEnforcementCommand = enforcementCommand({
      reservedSessionId: OTHER_SESSION_ID,
    });
    const state: ContentEnforcementState = resetTo(EPOCH_A);

    const result: ContentCommandResultV2 = handleContentCommandV2(
      state,
      command,
      OBSERVED_URL,
      NOW,
    );

    expect(result.response).toBeNull();
    expect(result.render).toBe('none');
    expect(result.state.tuple).toBeNull();
  });

  it('rejects a command carrying only the tag fields the response echoes', () => {
    // An unparsed object with the right tag used to reach the apply branch and produce a
    // response whose echoed fields were undefined, which the landed parser refuses.
    const command: DocumentContentCommand = {
      command: 'apply-enforcement',
      operationId: OPERATION_A,
      enforcementEpoch: EPOCH_A,
      documentId: DOCUMENT_ID,
    } as unknown as DocumentContentCommand;
    const state: ContentEnforcementState = resetTo(EPOCH_A);

    const result: ContentCommandResultV2 = handleContentCommandV2(
      state,
      command,
      OBSERVED_URL,
      NOW,
    );

    expect(result.response).toBeNull();
    expect(result.render).toBe('none');
  });
});

describe('handleContentCommandV2 epoch handshake', () => {
  it('answers reset-required with a null current epoch for a fresh document', () => {
    const state: ContentEnforcementState = createContentEnforcementState();

    const result: ContentCommandResultV2 = handleContentCommandV2(
      state,
      enforcementCommand(),
      OBSERVED_URL,
      NOW,
    );
    const response: ContentEnforcementResponse = parsedResponse(result);

    expect(response).toEqual({
      version: 1,
      disposition: 'reset-required',
      operationId: OPERATION_A,
      enforcementEpoch: EPOCH_A,
      documentId: DOCUMENT_ID,
      observedUrl: OBSERVED_URL,
      requestedEpoch: EPOCH_A,
      currentEpoch: null,
      handledAt: NOW,
    });
    expect(result.render).toBe('none');
    expect(result.state).toEqual(state);
  });

  it('clears the document and retires the prior epoch on a reset for a new epoch', () => {
    const state: ContentEnforcementState = stateWith(enforcementCommand());

    const result: ContentCommandResultV2 = handleContentCommandV2(
      state,
      resetCommand({ enforcementEpoch: EPOCH_B }),
      OBSERVED_URL,
      NOW + 1,
    );
    const response: ContentEnforcementResponse = parsedResponse(result);

    expect(response).toEqual({
      version: 1,
      disposition: 'epoch-reset',
      operationId: OPERATION_C,
      enforcementEpoch: EPOCH_B,
      documentId: DOCUMENT_ID,
      observedUrl: OBSERVED_URL,
      handledAt: NOW + 1,
    });
    expect(result.state).toEqual({
      enforcementEpoch: EPOCH_B,
      retiredEnforcementEpochs: [EPOCH_A],
      tuple: null,
      presentation: null,
      verdict: null,
      overlay: null,
    });
    expect(result.render).toBe('clear');
  });

  it('retires nothing when the document had no epoch yet', () => {
    const result: ContentCommandResultV2 = handleContentCommandV2(
      createContentEnforcementState(),
      resetCommand(),
      OBSERVED_URL,
      NOW,
    );

    expect(parsedResponse(result).disposition).toBe('epoch-reset');
    expect(result.state.enforcementEpoch).toBe(EPOCH_A);
    expect(result.state.retiredEnforcementEpochs).toEqual([]);
    expect(result.render).toBe('clear');
  });

  it('keeps a newer same-epoch view when reset replays for the current epoch', () => {
    const state: ContentEnforcementState = stateWith(enforcementCommand());

    const result: ContentCommandResultV2 = handleContentCommandV2(
      state,
      resetCommand({ enforcementEpoch: EPOCH_A, operationId: OPERATION_B }),
      OBSERVED_URL,
      NOW + 2,
    );

    expect(parsedResponse(result)).toEqual({
      version: 1,
      disposition: 'epoch-reset',
      operationId: OPERATION_B,
      enforcementEpoch: EPOCH_A,
      documentId: DOCUMENT_ID,
      observedUrl: OBSERVED_URL,
      handledAt: NOW + 2,
    });
    expect(result.state).toEqual(state);
    expect(result.render).toBe('none');
  });

  it('rejects a reset naming a retired epoch without mutating state', () => {
    const state: ContentEnforcementState = resetTo(EPOCH_B, resetTo(EPOCH_A));

    const result: ContentCommandResultV2 = handleContentCommandV2(
      state,
      resetCommand({ enforcementEpoch: EPOCH_A, operationId: OPERATION_B }),
      OBSERVED_URL,
      NOW + 3,
    );

    expect(parsedResponse(result)).toEqual({
      version: 1,
      disposition: 'epoch-reset-rejected',
      operationId: OPERATION_B,
      enforcementEpoch: EPOCH_A,
      currentEpoch: EPOCH_B,
      reason: 'retired-epoch',
      documentId: DOCUMENT_ID,
      observedUrl: OBSERVED_URL,
      handledAt: NOW + 3,
    });
    expect(result.state).toEqual(state);
    expect(result.render).toBe('none');
  });

  it('answers reset-required for an enforcement command naming a retired epoch', () => {
    const state: ContentEnforcementState = resetTo(EPOCH_B, stateWith(enforcementCommand()));

    const result: ContentCommandResultV2 = handleContentCommandV2(
      state,
      enforcementCommand({ operationId: OPERATION_B }),
      OBSERVED_URL,
      NOW + 4,
    );
    const response: ContentEnforcementResponse = parsedResponse(result);

    expect(response.disposition).toBe('reset-required');
    if (response.disposition !== 'reset-required') throw new Error('expected reset-required');
    expect(response.requestedEpoch).toBe(EPOCH_A);
    expect(response.currentEpoch).toBe(EPOCH_B);
    expect(result.state).toEqual(state);
    expect(result.render).toBe('none');
  });

  it('answers reset-required with the current epoch for a different non-retired epoch', () => {
    const state: ContentEnforcementState = stateWith(enforcementCommand());

    const result: ContentCommandResultV2 = handleContentCommandV2(
      state,
      enforcementCommand({ enforcementEpoch: EPOCH_C, operationId: OPERATION_B }),
      OBSERVED_URL,
      NOW + 4,
    );

    expect(parsedResponse(result)).toEqual({
      version: 1,
      disposition: 'reset-required',
      operationId: OPERATION_B,
      enforcementEpoch: EPOCH_C,
      documentId: DOCUMENT_ID,
      observedUrl: OBSERVED_URL,
      requestedEpoch: EPOCH_C,
      currentEpoch: EPOCH_A,
      handledAt: NOW + 4,
    });
    expect(result.state).toEqual(state);
    expect(result.render).toBe('none');
  });
});

describe('handleContentCommandV2 tuple comparison', () => {
  it('applies a higher tuple and renders a blocked verdict', () => {
    const state: ContentEnforcementState = resetTo(EPOCH_A);
    const command: DocumentEnforcementCommand = enforcementCommand();

    const result: ContentCommandResultV2 = handleContentCommandV2(
      state,
      command,
      OBSERVED_URL,
      NOW + 5,
    );

    expect(parsedResponse(result)).toEqual({
      version: 1,
      disposition: 'applied',
      operationId: OPERATION_A,
      enforcementEpoch: EPOCH_A,
      sessionId: SESSION_ID,
      reservedSessionId: null,
      basePolicyRevision: 4,
      runtimeRevision: 7,
      documentId: DOCUMENT_ID,
      observedUrl: OBSERVED_URL,
      presentation: 'active',
      verdict: BLOCKED_VERDICT,
      overlay: activeOverlay(),
      handledAt: NOW + 5,
    });
    expect(result.state).toEqual({
      enforcementEpoch: EPOCH_A,
      retiredEnforcementEpochs: [],
      tuple: tuple(),
      presentation: 'active',
      verdict: BLOCKED_VERDICT,
      overlay: activeOverlay(),
    });
    expect(result.render).toBe('apply');
  });

  it('renders clear for an allowed verdict and for a clear command', () => {
    const state: ContentEnforcementState = stateWith(enforcementCommand());

    const allowed: ContentCommandResultV2 = handleContentCommandV2(
      state,
      allowedCommand({ operationId: OPERATION_B, runtimeRevision: 8 }),
      OBSERVED_URL,
      NOW + 6,
    );
    const cleared: ContentCommandResultV2 = handleContentCommandV2(
      state,
      clearCommand({ operationId: OPERATION_C, runtimeRevision: 9 }),
      OBSERVED_URL,
      NOW + 7,
    );

    expect(parsedResponse(allowed).disposition).toBe('applied');
    expect(allowed.render).toBe('clear');
    expect(allowed.state.overlay).toBeNull();
    expect(allowed.state.verdict).toEqual(ALLOWED_VERDICT);
    expect(parsedResponse(cleared).disposition).toBe('applied');
    expect(cleared.render).toBe('clear');
    expect(cleared.state.presentation).toBe('clear');
    expect(cleared.state.overlay).toBeNull();
  });

  it('lets a higher base revision with runtime revision zero replace the session identity', () => {
    const state: ContentEnforcementState = stateWith(enforcementCommand());

    const result: ContentCommandResultV2 = handleContentCommandV2(
      state,
      startingCommand({
        operationId: OPERATION_B,
        basePolicyRevision: 5,
        runtimeRevision: 0,
        reservedSessionId: OTHER_SESSION_ID,
      }),
      OBSERVED_URL,
      NOW + 8,
    );

    expect(parsedResponse(result).disposition).toBe('applied');
    expect(result.state.tuple).toEqual(
      tuple({
        sessionId: null,
        reservedSessionId: OTHER_SESSION_ID,
        basePolicyRevision: 5,
        runtimeRevision: 0,
      }),
    );
    expect(result.state.presentation).toBe('starting');
    expect(result.render).toBe('apply');
  });

  it('applies the durable promotion of a reserved identity at the same base revision', () => {
    const state: ContentEnforcementState = stateWith(startingCommand({ runtimeRevision: 0 }));

    const result: ContentCommandResultV2 = handleContentCommandV2(
      state,
      enforcementCommand({ operationId: OPERATION_B, runtimeRevision: 1 }),
      OBSERVED_URL,
      NOW + 9,
    );

    expect(parsedResponse(result).disposition).toBe('applied');
    expect(result.state.tuple).toEqual(tuple({ runtimeRevision: 1 }));
    expect(result.state.presentation).toBe('active');
    expect(result.render).toBe('apply');
  });

  it('compares a reservation against its promotion by tuple, not by field', () => {
    const state: ContentEnforcementState = stateWith(enforcementCommand({ runtimeRevision: 1 }));

    const result: ContentCommandResultV2 = handleContentCommandV2(
      state,
      startingCommand({ operationId: OPERATION_B, runtimeRevision: 0 }),
      OBSERVED_URL,
      NOW + 9,
    );
    const response: ContentEnforcementResponse = parsedResponse(result);

    expect(response.disposition).toBe('stale-command');
    if (response.disposition !== 'stale-command') throw new Error('expected stale-command');
    expect(response.requested.reservedSessionId).toBe(SESSION_ID);
    expect(response.current.sessionId).toBe(SESSION_ID);
    expect(result.state).toEqual(state);
  });

  it('rejects an equal base revision naming a different session identity', () => {
    const state: ContentEnforcementState = stateWith(enforcementCommand());

    const result: ContentCommandResultV2 = handleContentCommandV2(
      state,
      enforcementCommand({
        operationId: OPERATION_B,
        runtimeRevision: 9,
        sessionId: OTHER_SESSION_ID,
        overlay: activeOverlay({ sessionId: OTHER_SESSION_ID }),
      }),
      OBSERVED_URL,
      NOW + 10,
    );

    expect(result.response).toBeNull();
    expect(result.render).toBe('none');
    expect(result.state).toEqual(state);
  });

  it('answers stale-command for a lower runtime revision without mutating', () => {
    const state: ContentEnforcementState = stateWith(enforcementCommand());

    const result: ContentCommandResultV2 = handleContentCommandV2(
      state,
      enforcementCommand({ operationId: OPERATION_B, runtimeRevision: 6 }),
      OBSERVED_URL,
      NOW + 11,
    );

    expect(parsedResponse(result)).toEqual({
      version: 1,
      disposition: 'stale-command',
      operationId: OPERATION_B,
      enforcementEpoch: EPOCH_A,
      documentId: DOCUMENT_ID,
      observedUrl: OBSERVED_URL,
      requested: {
        enforcementEpoch: EPOCH_A,
        sessionId: SESSION_ID,
        reservedSessionId: null,
        basePolicyRevision: 4,
        runtimeRevision: 6,
      },
      current: {
        enforcementEpoch: EPOCH_A,
        sessionId: SESSION_ID,
        reservedSessionId: null,
        basePolicyRevision: 4,
        runtimeRevision: 7,
      },
      handledAt: NOW + 11,
    });
    expect(result.state).toEqual(state);
    expect(result.render).toBe('none');
  });

  it('answers stale-command for a lower base revision from an older session', () => {
    const newerBase: ContentEnforcementState = stateWith(
      enforcementCommand({ basePolicyRevision: 5, runtimeRevision: 2 }),
    );

    const result: ContentCommandResultV2 = handleContentCommandV2(
      newerBase,
      startingCommand({ operationId: OPERATION_B, basePolicyRevision: 4, runtimeRevision: 9 }),
      OBSERVED_URL,
      NOW + 12,
    );
    const response: ContentEnforcementResponse = parsedResponse(result);

    expect(response.disposition).toBe('stale-command');
    if (response.disposition !== 'stale-command') throw new Error('expected stale-command');
    expect(response.requested).toEqual({
      enforcementEpoch: EPOCH_A,
      sessionId: null,
      reservedSessionId: SESSION_ID,
      basePolicyRevision: 4,
      runtimeRevision: 9,
    });
    expect(response.current).toEqual({
      enforcementEpoch: EPOCH_A,
      sessionId: SESSION_ID,
      reservedSessionId: null,
      basePolicyRevision: 5,
      runtimeRevision: 2,
    });
    expect(result.state).toEqual(newerBase);
    expect(result.render).toBe('none');
  });

  it('answers applied for an equal tuple with a structurally equal view', () => {
    const state: ContentEnforcementState = stateWith(enforcementCommand());

    const result: ContentCommandResultV2 = handleContentCommandV2(
      state,
      enforcementCommand({ operationId: OPERATION_B }),
      OBSERVED_URL,
      NOW + 13,
    );
    const response: ContentEnforcementResponse = parsedResponse(result);

    expect(response.disposition).toBe('applied');
    expect(response.operationId).toBe(OPERATION_B);
    expect(result.state).toEqual(state);
    expect(result.render).toBe('apply');
  });

  it('rejects an equal tuple whose overlay differs', () => {
    const state: ContentEnforcementState = stateWith(enforcementCommand());

    const result: ContentCommandResultV2 = handleContentCommandV2(
      state,
      enforcementCommand({
        operationId: OPERATION_B,
        overlay: activeOverlay({
          timing: {
            capturedAt: NOW + 500,
            phaseStartedAt: NOW - 1_000,
            phaseEndsAt: NOW + 60_000,
            sessionEndsAt: NOW + 120_000,
          },
        }),
      }),
      OBSERVED_URL,
      NOW + 14,
    );

    expect(result.response).toBeNull();
    expect(result.render).toBe('none');
    expect(result.state).toEqual(state);
  });

  it('rejects an equal tuple whose verdict or presentation differs', () => {
    const state: ContentEnforcementState = stateWith(enforcementCommand());

    const verdictDrift: ContentCommandResultV2 = handleContentCommandV2(
      state,
      enforcementCommand({
        operationId: OPERATION_B,
        verdict: { ...BLOCKED_VERDICT, matchedPattern: 'other.example' },
      }),
      OBSERVED_URL,
      NOW + 15,
    );
    const presentationDrift: ContentCommandResultV2 = handleContentCommandV2(
      state,
      enforcementCommand({
        operationId: OPERATION_B,
        presentation: 'clear',
        verdict: CLEAR_VERDICT,
        overlay: null,
      }),
      OBSERVED_URL,
      NOW + 16,
    );

    expect(verdictDrift.response).toBeNull();
    expect(verdictDrift.state).toEqual(state);
    expect(presentationDrift.response).toBeNull();
    expect(presentationDrift.state).toEqual(state);
  });

  it('applies the first command after a reset even when its revisions are lower', () => {
    const applied: ContentEnforcementState = stateWith(
      enforcementCommand({ basePolicyRevision: 9, runtimeRevision: 9 }),
    );
    const afterReset: ContentEnforcementState = resetTo(EPOCH_B, applied);

    const result: ContentCommandResultV2 = handleContentCommandV2(
      afterReset,
      startingCommand({
        enforcementEpoch: EPOCH_B,
        basePolicyRevision: 0,
        runtimeRevision: 0,
      }),
      OBSERVED_URL,
      NOW + 17,
    );

    expect(parsedResponse(result).disposition).toBe('applied');
    expect(result.state.tuple).toEqual(
      tuple({
        enforcementEpoch: EPOCH_B,
        sessionId: null,
        reservedSessionId: SESSION_ID,
        basePolicyRevision: 0,
        runtimeRevision: 0,
      }),
    );
  });
});

describe('handleContentCommandV2 echoes and detachment', () => {
  it('echoes the command document and the observed URL argument', () => {
    const state: ContentEnforcementState = resetTo(EPOCH_A);

    const result: ContentCommandResultV2 = handleContentCommandV2(
      state,
      enforcementCommand({ documentId: 'document-9', expectedUrl: 'https://example.com/expected' }),
      'https://example.com/observed',
      NOW + 18,
    );
    const response: ContentEnforcementResponse = parsedResponse(result);

    expect(response.documentId).toBe('document-9');
    expect(response.observedUrl).toBe('https://example.com/observed');
  });

  it('detaches the returned state from the previous state and from the command', () => {
    const overlay: ActiveOverlay = activeOverlay();
    const command: DocumentEnforcementCommand = enforcementCommand({ overlay });
    const state: ContentEnforcementState = resetTo(EPOCH_A);

    const result: ContentCommandResultV2 = handleContentCommandV2(
      state,
      command,
      OBSERVED_URL,
      NOW + 19,
    );
    overlay.theme = 'light';
    command.verdict = CLEAR_VERDICT;

    expect(result.state).not.toBe(state);
    expect(result.state.retiredEnforcementEpochs).not.toBe(state.retiredEnforcementEpochs);
    expect(result.state.overlay).not.toBe(overlay);
    expect(result.state.overlay).toEqual(activeOverlay());
    expect(result.state.verdict).toEqual(BLOCKED_VERDICT);
  });

  it('detaches a pass-through state from the previous state', () => {
    const state: ContentEnforcementState = stateWith(enforcementCommand());

    const result: ContentCommandResultV2 = handleContentCommandV2(
      state,
      enforcementCommand({ operationId: OPERATION_B, runtimeRevision: 1 }),
      OBSERVED_URL,
      NOW + 20,
    );

    expect(result.state).not.toBe(state);
    expect(result.state).toEqual(state);
    expect(result.state.retiredEnforcementEpochs).not.toBe(state.retiredEnforcementEpochs);
    expect(result.state.tuple).not.toBe(state.tuple);
    // The stored view is a module-owned snapshot nothing mutates, so it is shared on purpose.
    expect(result.state.overlay).toBe(state.overlay);
    expect(result.state.verdict).toBe(state.verdict);
  });

  it('answers applied again for a byte-identical replay after a worker restart', () => {
    const state: ContentEnforcementState = stateWith(enforcementCommand());

    const replay: ContentCommandResultV2 = handleContentCommandV2(
      state,
      enforcementCommand(),
      OBSERVED_URL,
      NOW + 21,
    );
    const response: ContentEnforcementResponse = parsedResponse(replay);

    expect(response.disposition).toBe('applied');
    expect(response.operationId).toBe(OPERATION_A);
    expect(replay.state).toEqual(state);
  });
});

describe('handleContentCommandV2 hostile input', () => {
  it('rejects an overlay proxy that changes between reads without throwing', () => {
    const target: ActiveOverlay = activeOverlay();
    let reads: number = 0;
    const hostileOverlay: ActiveOverlay = new Proxy<ActiveOverlay>(target, {
      getOwnPropertyDescriptor(
        object: ActiveOverlay,
        key: string | symbol,
      ): PropertyDescriptor | undefined {
        const descriptor: PropertyDescriptor | undefined = Reflect.getOwnPropertyDescriptor(
          object,
          key,
        );
        if (key !== 'theme' || descriptor === undefined) return descriptor;
        reads += 1;
        return { ...descriptor, value: reads % 2 === 0 ? 'light' : 'dark' };
      },
    });
    const state: ContentEnforcementState = stateWith(enforcementCommand());

    const result: ContentCommandResultV2 = handleContentCommandV2(
      state,
      enforcementCommand({ operationId: OPERATION_B, overlay: hostileOverlay }),
      OBSERVED_URL,
      NOW + 22,
    );

    expect(result.response).toBeNull();
    expect(result.render).toBe('none');
    expect(result.state).toEqual(state);
    expect(result.state.overlay).toEqual(activeOverlay());
  });

  it('rejects a command carrying an accessor field without throwing', () => {
    const state: ContentEnforcementState = stateWith(enforcementCommand());
    const hostile: DocumentContentCommand = Object.defineProperty(
      enforcementCommand({ operationId: OPERATION_B }),
      'runtimeRevision',
      {
        get(): number {
          return 99;
        },
        enumerable: true,
        configurable: true,
      },
    );

    const result: ContentCommandResultV2 = handleContentCommandV2(
      state,
      hostile,
      OBSERVED_URL,
      NOW + 23,
    );

    expect(result.response).toBeNull();
    expect(result.render).toBe('none');
    expect(result.state).toEqual(state);
  });

  it('rejects a command missing the fields every response echoes', () => {
    const state: ContentEnforcementState = stateWith(enforcementCommand());
    const hostile: DocumentContentCommand = {
      command: 'apply-enforcement',
    } as unknown as DocumentContentCommand;

    const result: ContentCommandResultV2 = handleContentCommandV2(
      state,
      hostile,
      OBSERVED_URL,
      NOW + 24,
    );

    expect(result.response).toBeNull();
    expect(result.render).toBe('none');
    expect(result.state).toEqual(state);
  });

  it('answers an unparsed hostile object without throwing', () => {
    const state: ContentEnforcementState = createContentEnforcementState();
    const hostile: DocumentContentCommand = {
      command: 'apply-enforcement',
    } as unknown as DocumentContentCommand;

    const result: ContentCommandResultV2 = handleContentCommandV2(
      state,
      hostile,
      OBSERVED_URL,
      NOW + 24,
    );

    // Not an either. The two neighbouring cases assert `toBeNull()` outright, and an assertion
    // that holds whichever way the code answers cannot notice the answer changing.
    expect(result.response).toBeNull();
    expect(result.render).toBe('none');
    expect(result.state).toEqual(state);
  });
});

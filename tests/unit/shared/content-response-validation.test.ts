import { describe, expect, it } from 'vitest';
import type {
  ContentEnforcementResponse,
  DocumentContentCommand,
  DocumentEnforcementCommand,
  DocumentOverlayView,
  ResetEnforcementEpochCommand,
} from '../../../src/shared/enforcement-v2';
import {
  parseContentEnforcementResponse,
  parseDocumentContentCommand,
  parseResetEnforcementEpochCommand,
  validateDetachedContentEnforcementResponse,
} from '../../../src/shared/enforcement-v2-validation';
import type { Verdict } from '../../../src/shared/types';

type UnknownRecord = Record<string, unknown>;
type AppliedResponse = Extract<ContentEnforcementResponse, { disposition: 'applied' }>;
type StaleCommandResponse = Extract<ContentEnforcementResponse, { disposition: 'stale-command' }>;
type ResetRequiredResponse = Extract<ContentEnforcementResponse, { disposition: 'reset-required' }>;
type EpochResetResponse = Extract<ContentEnforcementResponse, { disposition: 'epoch-reset' }>;
type EpochResetRejectedResponse = Extract<
  ContentEnforcementResponse,
  { disposition: 'epoch-reset-rejected' }
>;
type ContentTuple = StaleCommandResponse['requested'];
type ActiveOverlay = Extract<DocumentOverlayView, { presentation: 'active' }>;
type StartingOverlay = Extract<DocumentOverlayView, { presentation: 'starting' }>;

const NOW: number = 1_750_000_000_000;
const SESSION_ID: string = '10000000-0000-4000-8000-000000000001';
const OTHER_SESSION_ID: string = '10000000-0000-4000-8000-000000000002';
const RESERVED_SESSION_ID: string = '10000000-0000-4000-8000-000000000003';
const OPERATION_ID: string = '20000000-0000-4000-8000-000000000001';
const EPOCH_ID: string = '30000000-0000-4000-8000-000000000001';
const OTHER_EPOCH_ID: string = '30000000-0000-4000-8000-000000000002';
const DOCUMENT_ID: string = 'document-1';
const OBSERVED_URL: string = 'https://example.com/path';
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

function startingOverlay(): StartingOverlay {
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
    duration: { kind: 'until-stopped' },
    timing: {
      capturedAt: NOW,
      phaseStartedAt: NOW - 1_000,
      phaseEndsAt: null,
      sessionEndsAt: null,
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
    copy: {
      status: {
        kind: 'until-stopped',
        text: 'Until stopped',
      },
      lockedUntil: null,
      intention: 'Finish the release notes',
      verdictProvenance: PROVENANCE,
      stoppedPage: null,
      bankUnit: 'site access credit',
      pauseAction: 'Unlock all sites 1:00 - costs 1:00 credit',
      unlockAction: 'Unlock this site 2:00 - costs 2:00 credit',
      endAction: 'End session',
      bankWaitPrefix: 'Ready in',
      gateTitle: null,
      gateBack: 'Keep focusing',
      gatePhraseLabel: 'Type this to confirm:',
      gateForceEnd: 'Ignore timeout and end anyway',
      gateConfirm: null,
      transportError: 'Focus Lock could not update this action. Try again.',
      accessSummary: 'Need a break or site access?',
      accessNote: 'You can step away at any time. Site access uses credit.',
      costAboveLimit: 'Cost exceeds the credit limit',
      earningOff: 'Credit earning is turned off',
      notEnoughFocus: 'Not enough time in this focus block',
      gateSaid: null,
      nextStep: 'Your next step',
      remainingSuffix: null,
      minuteLabel: 'min',
      underMinuteLabel: 'Less than a minute',
      updatingLabel: 'Updating session',
    },
    ...overrides,
  };
}

function resetCommand(
  overrides: Partial<ResetEnforcementEpochCommand> = {},
): ResetEnforcementEpochCommand {
  return {
    version: 1,
    command: 'reset-enforcement-epoch',
    operationId: OPERATION_ID,
    enforcementEpoch: EPOCH_ID,
    documentId: DOCUMENT_ID,
    expectedUrl: OBSERVED_URL,
    ...overrides,
  };
}

function enforcementCommand(
  overrides: Partial<DocumentEnforcementCommand> = {},
): DocumentEnforcementCommand {
  return {
    version: 1,
    command: 'apply-enforcement',
    operationId: OPERATION_ID,
    enforcementEpoch: EPOCH_ID,
    sessionId: SESSION_ID,
    reservedSessionId: null,
    basePolicyRevision: 4,
    runtimeRevision: 7,
    documentId: DOCUMENT_ID,
    expectedUrl: OBSERVED_URL,
    presentation: 'active',
    verdict: { ...BLOCKED_VERDICT },
    overlay: activeOverlay(),
    ...overrides,
  };
}

function applied(overrides: Partial<AppliedResponse> = {}): AppliedResponse {
  return {
    version: 1,
    disposition: 'applied',
    operationId: OPERATION_ID,
    enforcementEpoch: EPOCH_ID,
    sessionId: SESSION_ID,
    reservedSessionId: null,
    basePolicyRevision: 4,
    runtimeRevision: 7,
    documentId: DOCUMENT_ID,
    observedUrl: OBSERVED_URL,
    presentation: 'active',
    verdict: { ...BLOCKED_VERDICT },
    overlay: activeOverlay(),
    handledAt: NOW,
    ...overrides,
  };
}

function tuple(overrides: Partial<ContentTuple> = {}): ContentTuple {
  return {
    enforcementEpoch: EPOCH_ID,
    sessionId: SESSION_ID,
    reservedSessionId: null,
    basePolicyRevision: 4,
    runtimeRevision: 7,
    ...overrides,
  };
}

function staleCommand(overrides: Partial<StaleCommandResponse> = {}): StaleCommandResponse {
  return {
    version: 1,
    disposition: 'stale-command',
    operationId: OPERATION_ID,
    enforcementEpoch: EPOCH_ID,
    documentId: DOCUMENT_ID,
    observedUrl: OBSERVED_URL,
    requested: tuple({ runtimeRevision: 6 }),
    current: tuple(),
    handledAt: NOW,
    ...overrides,
  };
}

function resetRequired(overrides: Partial<ResetRequiredResponse> = {}): ResetRequiredResponse {
  return {
    version: 1,
    disposition: 'reset-required',
    operationId: OPERATION_ID,
    enforcementEpoch: EPOCH_ID,
    documentId: DOCUMENT_ID,
    observedUrl: OBSERVED_URL,
    requestedEpoch: EPOCH_ID,
    currentEpoch: null,
    handledAt: NOW,
    ...overrides,
  };
}

function epochReset(overrides: Partial<EpochResetResponse> = {}): EpochResetResponse {
  return {
    version: 1,
    disposition: 'epoch-reset',
    operationId: OPERATION_ID,
    enforcementEpoch: EPOCH_ID,
    documentId: DOCUMENT_ID,
    observedUrl: OBSERVED_URL,
    handledAt: NOW,
    ...overrides,
  };
}

function epochResetRejected(
  overrides: Partial<EpochResetRejectedResponse> = {},
): EpochResetRejectedResponse {
  return {
    version: 1,
    disposition: 'epoch-reset-rejected',
    operationId: OPERATION_ID,
    enforcementEpoch: EPOCH_ID,
    currentEpoch: OTHER_EPOCH_ID,
    reason: 'retired-epoch',
    documentId: DOCUMENT_ID,
    observedUrl: OBSERVED_URL,
    handledAt: NOW,
    ...overrides,
  };
}

function withKey(value: object, key: string, replacement: unknown): UnknownRecord {
  return { ...value, [key]: replacement };
}

function withoutKey(value: object, key: string): UnknownRecord {
  const clone: UnknownRecord = { ...value };
  Reflect.deleteProperty(clone, key);
  return clone;
}

function everyResponse(): readonly ContentEnforcementResponse[] {
  return [applied(), staleCommand(), resetRequired(), epochReset(), epochResetRejected()];
}

function expectResetCommandRejected(values: readonly unknown[]): void {
  for (const value of values) {
    expect((): ResetEnforcementEpochCommand | null =>
      parseResetEnforcementEpochCommand(value),
    ).not.toThrow();
    expect(parseResetEnforcementEpochCommand(value)).toBeNull();
  }
}

function expectContentCommandRejected(values: readonly unknown[]): void {
  for (const value of values) {
    expect((): DocumentContentCommand | null => parseDocumentContentCommand(value)).not.toThrow();
    expect(parseDocumentContentCommand(value)).toBeNull();
  }
}

function expectResponseRejected(values: readonly unknown[]): void {
  for (const value of values) {
    expect((): ContentEnforcementResponse | null =>
      parseContentEnforcementResponse(value),
    ).not.toThrow();
    expect(parseContentEnforcementResponse(value)).toBeNull();
  }
}

describe('reset enforcement epoch command parsing', (): void => {
  it('accepts the canonical reset command and detaches it in both directions', (): void => {
    const source: ResetEnforcementEpochCommand = resetCommand();
    const parsed: ResetEnforcementEpochCommand | null = parseResetEnforcementEpochCommand(source);

    expect(parsed).toEqual(source);
    expect(parsed).not.toBe(source);

    const detached: ResetEnforcementEpochCommand = parsed as ResetEnforcementEpochCommand;
    source.documentId = 'document-2';
    expect(detached.documentId).toBe(DOCUMENT_ID);
    detached.expectedUrl = 'https://other.example/';
    expect(source.expectedUrl).toBe(OBSERVED_URL);
  });

  it('rejects reset commands with the wrong version, tag, or blank identity', (): void => {
    expectResetCommandRejected([
      withKey(resetCommand(), 'version', 2),
      withKey(resetCommand(), 'command', 'apply-enforcement'),
      withKey(resetCommand(), 'command', 'reset-epoch'),
      resetCommand({ operationId: 'not-a-uuid' }),
      withKey(resetCommand(), 'operationId', ''),
      resetCommand({ enforcementEpoch: 'not-a-uuid' }),
      resetCommand({ documentId: '   ' }),
      resetCommand({ expectedUrl: '' }),
    ]);
  });

  it('rejects reset commands with extra, missing, or worker-owned keys', (): void => {
    expectResetCommandRejected([
      withKey(resetCommand(), 'tabId', 7),
      withKey(resetCommand(), 'extra', true),
      withoutKey(resetCommand(), 'expectedUrl'),
      withoutKey(resetCommand(), 'command'),
      { ...resetCommand(), [Symbol('extra')]: true },
      new Proxy(resetCommand(), {}),
      null,
      'reset-enforcement-epoch',
    ]);
  });
});

describe('document content command parsing', (): void => {
  it('accepts both arms of the content command union', (): void => {
    const reset: ResetEnforcementEpochCommand = resetCommand();
    const enforce: DocumentEnforcementCommand = enforcementCommand();

    expect(parseDocumentContentCommand(reset)).toEqual(reset);
    expect(parseDocumentContentCommand(enforce)).toEqual(enforce);
    expect(parseDocumentContentCommand(enforce)).not.toBe(enforce);
  });

  it('rejects the v1 applyBlock and clearBlock payload shapes', (): void => {
    expectContentCommandRejected([
      { type: 'applyBlock' },
      { type: 'clearBlock' },
      { type: 'applyBlock', snapshot: { version: 2 } },
      { type: 'clearBlock', snapshot: null },
      withoutKey(withKey(resetCommand(), 'type', 'clearBlock'), 'command'),
      withKey(enforcementCommand(), 'command', 'applyBlock'),
    ]);
  });

  it('detaches an accepted enforcement command in both directions', (): void => {
    const source: DocumentEnforcementCommand = enforcementCommand();
    const parsed: DocumentContentCommand = parseDocumentContentCommand(
      source,
    ) as DocumentContentCommand;

    source.verdict.reason = 'custom';
    expect(parsed).toHaveProperty('verdict.reason', 'category');

    const enforcement: DocumentEnforcementCommand = parsed as DocumentEnforcementCommand;
    enforcement.overlay = null;
    expect(source.overlay).not.toBeNull();
  });
});

describe('content enforcement response parsing', (): void => {
  it('accepts every disposition and detaches applied responses in both directions', (): void => {
    for (const response of everyResponse()) {
      expect(parseContentEnforcementResponse(response)).toEqual(response);
      expect(validateDetachedContentEnforcementResponse(structuredClone(response))).toBe(true);
    }

    const source: AppliedResponse = applied();
    const parsed: AppliedResponse = parseContentEnforcementResponse(source) as AppliedResponse;

    expect(parsed).not.toBe(source);
    source.verdict.reason = 'custom';
    expect(parsed.verdict.reason).toBe('category');
    parsed.overlay = null;
    expect(source.overlay).not.toBeNull();
  });

  it('accepts a provisional starting applied response and a clear applied response', (): void => {
    const starting: AppliedResponse = applied({
      sessionId: null,
      reservedSessionId: RESERVED_SESSION_ID,
      basePolicyRevision: 4,
      runtimeRevision: 0,
      presentation: 'starting',
      overlay: startingOverlay(),
    });
    const cleared: AppliedResponse = applied({
      presentation: 'clear',
      verdict: { ...CLEAR_VERDICT },
      overlay: null,
    });

    expect(parseContentEnforcementResponse(starting)).toEqual(starting);
    expect(parseContentEnforcementResponse(cleared)).toEqual(cleared);
  });

  it('rejects applied responses whose overlay disagrees with the presentation', (): void => {
    expectResponseRejected([
      applied({ presentation: 'clear', verdict: { ...CLEAR_VERDICT }, overlay: activeOverlay() }),
      applied({ presentation: 'clear', verdict: { ...CLEAR_VERDICT }, overlay: startingOverlay() }),
      applied({ overlay: null }),
      applied({ presentation: 'starting', overlay: activeOverlay() }),
      applied({ presentation: 'active', overlay: startingOverlay() }),
      applied({ presentation: 'clear', overlay: null }),
      applied({ overlay: activeOverlay({ sessionId: OTHER_SESSION_ID }) }),
      applied({ verdict: { ...CLEAR_VERDICT } }),
    ]);
  });

  it('rejects applied responses with a broken identity, revision, or envelope', (): void => {
    expectResponseRejected([
      applied({ sessionId: null }),
      applied({ reservedSessionId: RESERVED_SESSION_ID }),
      applied({ operationId: 'not-a-uuid' }),
      applied({ enforcementEpoch: 'not-a-uuid' }),
      applied({ basePolicyRevision: -1 }),
      applied({ runtimeRevision: 1.5 }),
      applied({ documentId: '  ' }),
      applied({ observedUrl: '' }),
      applied({ handledAt: -1 }),
      withKey(applied(), 'version', 2),
      withKey(applied(), 'presentation', 'blocked'),
      withKey(applied(), 'verdict', withoutKey(BLOCKED_VERDICT, 'matchedPattern')),
      withoutKey(applied(), 'handledAt'),
      withKey(applied(), 'extra', true),
    ]);
  });

  it('accepts stale-command responses that are strictly lower within one epoch', (): void => {
    const lowerRuntime: StaleCommandResponse = staleCommand();
    const lowerBaseSameSession: StaleCommandResponse = staleCommand({
      requested: tuple({ basePolicyRevision: 3, runtimeRevision: 99 }),
      current: tuple(),
    });
    const lowerBaseNewReservedSession: StaleCommandResponse = staleCommand({
      requested: tuple({
        basePolicyRevision: 3,
        sessionId: OTHER_SESSION_ID,
        runtimeRevision: 12,
      }),
      current: tuple({
        basePolicyRevision: 4,
        sessionId: null,
        reservedSessionId: RESERVED_SESSION_ID,
        runtimeRevision: 0,
      }),
    });

    for (const response of [lowerRuntime, lowerBaseSameSession, lowerBaseNewReservedSession]) {
      expect(parseContentEnforcementResponse(response)).toEqual(response);
    }
  });

  it('rejects stale-command tuples that are not strictly lower or not same-session', (): void => {
    expectResponseRejected([
      staleCommand({ requested: tuple(), current: tuple() }),
      staleCommand({ requested: tuple({ runtimeRevision: 8 }), current: tuple() }),
      staleCommand({
        requested: tuple({ basePolicyRevision: 5, runtimeRevision: 0 }),
        current: tuple(),
      }),
      staleCommand({ requested: tuple({ sessionId: OTHER_SESSION_ID, runtimeRevision: 6 }) }),
      staleCommand({
        requested: tuple({
          sessionId: null,
          reservedSessionId: RESERVED_SESSION_ID,
          runtimeRevision: 6,
        }),
      }),
      staleCommand({ requested: tuple({ runtimeRevision: 6, sessionId: null }) }),
    ]);
  });

  it('rejects every stale-command comparison across unequal epochs', (): void => {
    expectResponseRejected([
      staleCommand({
        requested: tuple({ enforcementEpoch: OTHER_EPOCH_ID, runtimeRevision: 6 }),
      }),
      staleCommand({ current: tuple({ enforcementEpoch: OTHER_EPOCH_ID }) }),
      staleCommand({ enforcementEpoch: OTHER_EPOCH_ID }),
      staleCommand({
        requested: tuple({ enforcementEpoch: 'not-a-uuid', runtimeRevision: 6 }),
      }),
      withKey(staleCommand(), 'requested', withoutKey(tuple({ runtimeRevision: 6 }), 'sessionId')),
      withKey(staleCommand(), 'current', withKey(tuple(), 'tabId', 7)),
      withKey(staleCommand(), 'requested', null),
    ]);
  });

  it('accepts reset-required with a null or different current epoch', (): void => {
    const fresh: ResetRequiredResponse = resetRequired();
    const rotated: ResetRequiredResponse = resetRequired({ currentEpoch: OTHER_EPOCH_ID });

    expect(parseContentEnforcementResponse(fresh)).toEqual(fresh);
    expect(parseContentEnforcementResponse(rotated)).toEqual(rotated);
  });

  it('rejects reset-required rows that echo the wrong epoch', (): void => {
    expectResponseRejected([
      resetRequired({ currentEpoch: EPOCH_ID }),
      resetRequired({ requestedEpoch: OTHER_EPOCH_ID }),
      resetRequired({ currentEpoch: 'not-a-uuid' }),
      resetRequired({ requestedEpoch: 'not-a-uuid' }),
      withoutKey(resetRequired(), 'currentEpoch'),
      withKey(resetRequired(), 'requested', tuple()),
    ]);
  });

  it('pins the exact epoch-reset and epoch-reset-rejected rows', (): void => {
    expectResponseRejected([
      withKey(epochReset(), 'currentEpoch', OTHER_EPOCH_ID),
      withoutKey(epochReset(), 'observedUrl'),
      withKey(epochResetRejected(), 'reason', 'retired'),
      withKey(epochResetRejected(), 'reason', null),
      epochResetRejected({ currentEpoch: EPOCH_ID }),
      epochResetRejected({ currentEpoch: 'not-a-uuid' }),
      withoutKey(epochResetRejected(), 'reason'),
      withKey(epochReset(), 'disposition', 'epoch-retired'),
      withKey(epochReset(), 'disposition', 'applied'),
    ]);
  });

  it('rejects a tabId key in every disposition', (): void => {
    expectResponseRejected(
      everyResponse().map(
        (response: ContentEnforcementResponse): UnknownRecord => withKey(response, 'tabId', 7),
      ),
    );
  });

  it('rejects hostile roots, accessors, symbol keys, sparse arrays, and cycles', (): void => {
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
    const accessorDisposition: UnknownRecord = withoutKey(applied(), 'disposition');
    let dispositionReads: number = 0;
    Object.defineProperty(accessorDisposition, 'disposition', {
      configurable: true,
      enumerable: true,
      get: (): string => {
        dispositionReads += 1;
        return 'applied';
      },
    });
    const sparseRetiredEpochs: string[] = ['a', 'b'];
    Reflect.deleteProperty(sparseRetiredEpochs, 0);
    const sparseUnlocks: unknown[] = [{ host: 'example.com', until: NOW + 30_000 }, undefined];
    Reflect.deleteProperty(sparseUnlocks, 1);
    const cycle: UnknownRecord = {};
    cycle.self = cycle;

    expectResponseRejected([
      throwing,
      accessorDisposition,
      { ...applied(), [Symbol('extra')]: true },
      withKey(applied(), 'retiredEnforcementEpochs', sparseRetiredEpochs),
      withKey(applied(), 'overlay', withKey(activeOverlay(), 'activeUnlocks', sparseUnlocks)),
      withKey(applied(), 'overlay', cycle),
      cycle,
      new Proxy(applied(), {}),
      [applied()],
      null,
      'applied',
    ]);
    expectResetCommandRejected([throwing]);
    expectContentCommandRejected([throwing]);
    expect(dispositionReads).toBe(0);
  });

  it('rejects a response mutated between the check and the read', (): void => {
    let handledAtReads: number = 0;
    const drifting: unknown = new Proxy<UnknownRecord>(
      { ...applied() },
      {
        getOwnPropertyDescriptor: (
          target: UnknownRecord,
          key: string | symbol,
        ): PropertyDescriptor | undefined => {
          const descriptor: PropertyDescriptor | undefined = Reflect.getOwnPropertyDescriptor(
            target,
            key,
          );
          if (key !== 'handledAt' || descriptor === undefined) return descriptor;
          handledAtReads += 1;
          return { ...descriptor, value: NOW + handledAtReads };
        },
      },
    );

    expect((): ContentEnforcementResponse | null =>
      parseContentEnforcementResponse(drifting),
    ).not.toThrow();
    expect(parseContentEnforcementResponse(drifting)).toBeNull();
  });

  it('exposes a detached response predicate that rejects live roots', (): void => {
    expect(validateDetachedContentEnforcementResponse(structuredClone(applied()))).toBe(true);
    expect(validateDetachedContentEnforcementResponse(structuredClone(epochReset()))).toBe(true);
    expect(validateDetachedContentEnforcementResponse(null)).toBe(false);
    expect(validateDetachedContentEnforcementResponse('applied')).toBe(false);
    expect(
      validateDetachedContentEnforcementResponse(structuredClone(withKey(applied(), 'tabId', 7))),
    ).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import type {
  DocumentEnforcementAck,
  DocumentEpochResetAck,
  EnforcementCheckpoint,
  EnforcementTargetExclusion,
  FrozenDocumentCommand,
} from '../../../src/background/enforcement-persistence-v2';
import {
  parseDocumentEnforcementAck,
  parseDocumentEpochResetAck,
  parseEnforcementCheckpoint,
  parseEnforcementTargetExclusion,
  parseFrozenDocumentCommand,
  validateDetachedDocumentEnforcementAck,
  validateDetachedDocumentEpochResetAck,
  validateDetachedEnforcementCheckpoint,
  validateDetachedEnforcementTargetExclusion,
  validateDetachedFrozenDocumentCommand,
} from '../../../src/background/enforcement-persistence-v2-validation';
import type { DocumentOverlayView } from '../../../src/shared/enforcement-v2';
import type { Verdict } from '../../../src/shared/types';

type StartingOverlay = Extract<DocumentOverlayView, { presentation: 'starting' }>;
type ActiveOverlay = Extract<DocumentOverlayView, { presentation: 'active' }>;
type ActiveCopy = ActiveOverlay['copy'];
type UnknownRecord = Record<string, unknown>;

const NOW: number = 1_750_000_000_000;
const AUDITED_AT: number = NOW - 2_000;
const COMPLETED_AT: number = NOW + 2_000;
const SESSION_ID: string = '10000000-0000-4000-8000-000000000001';
const OTHER_SESSION_ID: string = '10000000-0000-4000-8000-000000000002';
const OPERATION_ID: string = '20000000-0000-4000-8000-000000000001';
const OTHER_OPERATION_ID: string = '20000000-0000-4000-8000-000000000002';
const EPOCH_ID: string = '30000000-0000-4000-8000-000000000001';
const OTHER_EPOCH_ID: string = '30000000-0000-4000-8000-000000000002';
const PROVENANCE: string = 'Blocked by Social media: example.com';
const TARGET_URL: string = 'https://example.com/path';
const EXCLUDED_URL: string = 'https://chromewebstore.google.com/detail/example';
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

function activeCopy(): ActiveCopy {
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
    gateConfirm: null,
    transportError: 'Focus Lock could not update this action. Try again.',
  };
}

function activeOverlay(sessionId: string = SESSION_ID): ActiveOverlay {
  return {
    version: 1,
    presentation: 'active',
    theme: 'dark',
    sessionId,
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
  };
}

function frozenCommand(overrides: Partial<FrozenDocumentCommand> = {}): FrozenDocumentCommand {
  return {
    version: 1,
    command: 'apply-enforcement',
    operationId: OPERATION_ID,
    enforcementEpoch: EPOCH_ID,
    sessionId: SESSION_ID,
    reservedSessionId: null,
    basePolicyRevision: 4,
    runtimeRevision: 7,
    tabId: 11,
    documentId: 'document-1',
    expectedUrl: TARGET_URL,
    presentation: 'active',
    verdict: BLOCKED_VERDICT,
    overlay: activeOverlay(),
    ...overrides,
  };
}

function frozenStartingCommand(
  overrides: Partial<FrozenDocumentCommand> = {},
): FrozenDocumentCommand {
  return frozenCommand({
    sessionId: null,
    reservedSessionId: SESSION_ID,
    runtimeRevision: 0,
    presentation: 'starting',
    overlay: startingOverlay(),
    ...overrides,
  });
}

function frozenClearCommand(overrides: Partial<FrozenDocumentCommand> = {}): FrozenDocumentCommand {
  return frozenCommand({
    presentation: 'clear',
    verdict: CLEAR_VERDICT,
    overlay: null,
    ...overrides,
  });
}

function enforcementAck(overrides: Partial<DocumentEnforcementAck> = {}): DocumentEnforcementAck {
  return {
    version: 1,
    operationId: OPERATION_ID,
    enforcementEpoch: EPOCH_ID,
    sessionId: SESSION_ID,
    reservedSessionId: null,
    basePolicyRevision: 4,
    runtimeRevision: 7,
    tabId: 11,
    documentId: 'document-1',
    url: TARGET_URL,
    verdict: BLOCKED_VERDICT,
    handledAt: NOW,
    ...overrides,
  };
}

function secondAck(overrides: Partial<DocumentEnforcementAck> = {}): DocumentEnforcementAck {
  return enforcementAck({
    tabId: 12,
    documentId: 'document-2',
    url: 'https://news.example.com/story',
    ...overrides,
  });
}

function epochResetAck(overrides: Partial<DocumentEpochResetAck> = {}): DocumentEpochResetAck {
  return {
    version: 1,
    operationId: OPERATION_ID,
    enforcementEpoch: EPOCH_ID,
    tabId: 11,
    documentId: 'document-1',
    url: TARGET_URL,
    handledAt: NOW,
    ...overrides,
  };
}

function exclusion(
  overrides: Partial<EnforcementTargetExclusion> = {},
): EnforcementTargetExclusion {
  return {
    tabId: 21,
    documentId: 'document-9',
    url: EXCLUDED_URL,
    reason: 'known-unsupported',
    ...overrides,
  };
}

function checkpoint(overrides: Partial<EnforcementCheckpoint> = {}): EnforcementCheckpoint {
  return {
    version: 1,
    operationId: OPERATION_ID,
    enforcementEpoch: EPOCH_ID,
    sessionId: SESSION_ID,
    basePolicyRevision: 4,
    kind: 'activation',
    registrationAuditedAt: AUDITED_AT,
    completedAt: COMPLETED_AT,
    targetGeneration: 3,
    documents: [enforcementAck(), secondAck()],
    exclusions: [exclusion()],
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

describe('background frozen document command parsing', (): void => {
  it('accepts starting, active, and clear frozen commands', (): void => {
    for (const value of [frozenCommand(), frozenStartingCommand(), frozenClearCommand()]) {
      expect(parseFrozenDocumentCommand(value)).toEqual(value);
      expect(validateDetachedFrozenDocumentCommand(structuredClone(value))).toBe(true);
    }
  });

  it('requires worker-owned non-negative integer tab authority', (): void => {
    expect(parseFrozenDocumentCommand(frozenCommand({ tabId: 0 }))).not.toBeNull();
    expectRejected(parseFrozenDocumentCommand, [
      withoutKey(frozenCommand(), 'tabId'),
      frozenCommand({ tabId: -1 }),
      frozenCommand({ tabId: 1.5 }),
      frozenCommand({ tabId: Number.MAX_SAFE_INTEGER + 1 }),
      withKey(frozenCommand(), 'tabId', '11'),
      withKey(frozenCommand(), 'tabId', null),
      withKey(frozenCommand(), 'tabId', Number.NaN),
    ]);
  });

  it('owns the wider frozen key set instead of the wire command key set', (): void => {
    expectRejected(parseFrozenDocumentCommand, [
      withKey(frozenCommand(), 'extra', true),
      withKey(frozenCommand(), 'url', TARGET_URL),
      withoutKey(frozenCommand(), 'overlay'),
    ]);
    expect(
      validateDetachedFrozenDocumentCommand(structuredClone(withKey(frozenCommand(), 'extra', 1))),
    ).toBe(false);
  });

  it('keeps the canonical clear verdict and a null overlay on a frozen clear command', (): void => {
    expectRejected(parseFrozenDocumentCommand, [
      frozenClearCommand({ verdict: { ...CLEAR_VERDICT, blocked: true } }),
      frozenClearCommand({ verdict: { ...CLEAR_VERDICT, reason: 'default' } }),
      frozenClearCommand({ verdict: { ...CLEAR_VERDICT, categoryId: 'social' } }),
      frozenClearCommand({ verdict: { ...CLEAR_VERDICT, matchedPattern: 'example.com' } }),
      frozenClearCommand({ verdict: BLOCKED_VERDICT }),
      frozenClearCommand({ overlay: activeOverlay() }),
      frozenClearCommand({ overlay: startingOverlay() }),
    ]);
  });

  it('requires exactly one durable or reserved session identity', (): void => {
    expectRejected(parseFrozenDocumentCommand, [
      frozenCommand({ sessionId: null, reservedSessionId: null }),
      frozenCommand({ sessionId: SESSION_ID, reservedSessionId: OTHER_SESSION_ID }),
      frozenCommand({ sessionId: SESSION_ID, reservedSessionId: SESSION_ID }),
      frozenCommand({ sessionId: 'not-a-uuid' }),
      frozenStartingCommand({ reservedSessionId: 'not-a-uuid' }),
    ]);
  });

  it('rejects invalid document, url, operation, epoch, revision, and presentation leaves', (): void => {
    expectRejected(parseFrozenDocumentCommand, [
      withKey(frozenCommand(), 'version', 2),
      withKey(frozenCommand(), 'command', 'apply-block'),
      frozenCommand({ operationId: 'not-a-uuid' }),
      frozenCommand({ enforcementEpoch: 'not-a-uuid' }),
      frozenCommand({ basePolicyRevision: -1 }),
      frozenCommand({ runtimeRevision: 1.5 }),
      frozenCommand({ documentId: '   ' }),
      frozenCommand({ expectedUrl: '' }),
      withKey(frozenCommand(), 'presentation', 'blocked'),
      frozenCommand({ presentation: 'starting' }),
      frozenCommand({ overlay: activeOverlay(OTHER_SESSION_ID) }),
      withKey(frozenCommand(), 'verdict', { ...BLOCKED_VERDICT, reason: 'unknown' }),
      frozenCommand({ overlay: null }),
    ]);
  });

  it('rejects hostile frozen roots and hostile nested values', (): void => {
    let accessorReads: number = 0;
    const accessorCommand: UnknownRecord = { ...frozenCommand() };
    Object.defineProperty(accessorCommand, 'tabId', {
      configurable: true,
      enumerable: true,
      get: (): number => {
        accessorReads += 1;
        return 11;
      },
    });

    expectRejected(parseFrozenDocumentCommand, [
      new Proxy(frozenCommand(), {}),
      withKey(frozenCommand(), 'overlay', new Proxy(activeOverlay(), {})),
      accessorCommand,
      withKey(frozenCommand(), 'verdict', { ...BLOCKED_VERDICT, [Symbol('extra')]: true }),
      withKey(frozenCommand(), 'overlay', cyclicRecord()),
      cyclicRecord(),
      null,
      undefined,
      'apply-enforcement',
      [frozenCommand()],
    ]);
    expect(accessorReads).toBe(0);
  });

  it('detaches parsed frozen commands in both directions', (): void => {
    const source: FrozenDocumentCommand = frozenCommand();
    const parsed: FrozenDocumentCommand = parseFrozenDocumentCommand(
      source,
    ) as FrozenDocumentCommand;

    expect(parsed).toEqual(source);
    expect(parsed).not.toBe(source);

    source.verdict.reason = 'custom';
    expect(parsed.verdict.reason).toBe('category');
    parsed.overlay = null;
    expect(source.overlay).not.toBeNull();
  });
});

describe('background document enforcement acknowledgement parsing', (): void => {
  it('accepts durable and reserved acknowledgements', (): void => {
    const reserved: DocumentEnforcementAck = enforcementAck({
      sessionId: null,
      reservedSessionId: SESSION_ID,
      runtimeRevision: 0,
    });

    for (const value of [enforcementAck(), reserved, enforcementAck({ verdict: CLEAR_VERDICT })]) {
      expect(parseDocumentEnforcementAck(value)).toEqual(value);
      expect(validateDetachedDocumentEnforcementAck(structuredClone(value))).toBe(true);
    }
  });

  it('claims no applied-response overlay equality', (): void => {
    const blocked: DocumentEnforcementAck = enforcementAck({ verdict: BLOCKED_VERDICT });

    expect(parseDocumentEnforcementAck(blocked)).toEqual(blocked);
    expectRejected(parseDocumentEnforcementAck, [
      withKey(blocked, 'overlay', activeOverlay()),
      withKey(blocked, 'overlay', null),
      withKey(blocked, 'presentation', 'active'),
    ]);
  });

  it('rejects invalid acknowledgement leaves and exact-schema violations', (): void => {
    expectRejected(parseDocumentEnforcementAck, [
      withKey(enforcementAck(), 'version', 2),
      enforcementAck({ operationId: 'not-a-uuid' }),
      enforcementAck({ enforcementEpoch: 'not-a-uuid' }),
      enforcementAck({ sessionId: null, reservedSessionId: null }),
      enforcementAck({ sessionId: SESSION_ID, reservedSessionId: OTHER_SESSION_ID }),
      enforcementAck({ basePolicyRevision: -1 }),
      enforcementAck({ runtimeRevision: 1.5 }),
      enforcementAck({ tabId: -1 }),
      enforcementAck({ documentId: ' ' }),
      enforcementAck({ url: '' }),
      withKey(enforcementAck(), 'verdict', { ...BLOCKED_VERDICT, categoryId: 'memes' }),
      withKey(enforcementAck(), 'verdict', withoutKey(BLOCKED_VERDICT, 'matchedPattern')),
      enforcementAck({ handledAt: -1 }),
      withKey(enforcementAck(), 'extra', true),
      withoutKey(enforcementAck(), 'handledAt'),
      new Proxy(enforcementAck(), {}),
      cyclicRecord(),
      null,
    ]);
  });

  it('detaches parsed acknowledgements in both directions', (): void => {
    const source: DocumentEnforcementAck = enforcementAck();
    const parsed: DocumentEnforcementAck = parseDocumentEnforcementAck(
      source,
    ) as DocumentEnforcementAck;

    expect(parsed).toEqual(source);
    source.verdict.matchedPattern = 'other.example';
    expect(parsed.verdict.matchedPattern).toBe('example.com');
    parsed.verdict.blocked = false;
    expect(source.verdict.blocked).toBe(true);
  });
});

describe('background epoch reset acknowledgement parsing', (): void => {
  it('accepts any epoch UUID as pure equality authority', (): void => {
    for (const value of [epochResetAck(), epochResetAck({ enforcementEpoch: OTHER_EPOCH_ID })]) {
      expect(parseDocumentEpochResetAck(value)).toEqual(value);
      expect(validateDetachedDocumentEpochResetAck(structuredClone(value))).toBe(true);
    }
  });

  it('carries no revision or session authority', (): void => {
    expectRejected(parseDocumentEpochResetAck, [
      withKey(epochResetAck(), 'basePolicyRevision', 4),
      withKey(epochResetAck(), 'runtimeRevision', 7),
      withKey(epochResetAck(), 'sessionId', SESSION_ID),
      withKey(epochResetAck(), 'verdict', CLEAR_VERDICT),
    ]);
  });

  it('detaches parsed reset acknowledgements from their source', (): void => {
    const source: DocumentEpochResetAck = epochResetAck();
    const parsed: DocumentEpochResetAck = parseDocumentEpochResetAck(
      source,
    ) as DocumentEpochResetAck;

    expect(parsed).toEqual(source);
    expect(parsed).not.toBe(source);
    source.url = 'https://mutated.test/';
    expect(parsed.url).toBe(TARGET_URL);
    parsed.tabId = 99;
    expect(source.tabId).toBe(11);
  });

  it('rejects invalid reset leaves and hostile roots', (): void => {
    expectRejected(parseDocumentEpochResetAck, [
      withKey(epochResetAck(), 'version', 2),
      epochResetAck({ operationId: 'not-a-uuid' }),
      epochResetAck({ enforcementEpoch: 'not-a-uuid' }),
      epochResetAck({ tabId: 1.5 }),
      epochResetAck({ documentId: '' }),
      epochResetAck({ url: '  ' }),
      epochResetAck({ handledAt: Number.NaN }),
      withoutKey(epochResetAck(), 'enforcementEpoch'),
      new Proxy(epochResetAck(), {}),
      null,
    ]);
  });
});

describe('background enforcement target exclusion parsing', (): void => {
  it('accepts known-unsupported targets with and without a document identity', (): void => {
    for (const value of [exclusion(), exclusion({ documentId: null })]) {
      expect(parseEnforcementTargetExclusion(value)).toEqual(value);
      expect(validateDetachedEnforcementTargetExclusion(structuredClone(value))).toBe(true);
    }
  });

  it('detaches parsed exclusions from their source', (): void => {
    const source: EnforcementTargetExclusion = exclusion();
    const parsed: EnforcementTargetExclusion = parseEnforcementTargetExclusion(
      source,
    ) as EnforcementTargetExclusion;

    expect(parsed).toEqual(source);
    expect(parsed).not.toBe(source);
    source.url = 'https://mutated.test/';
    expect(parsed.url).toBe(EXCLUDED_URL);
    parsed.documentId = null;
    expect(source.documentId).toBe('document-9');
  });

  it('rejects invalid exclusion leaves and exact-schema violations', (): void => {
    expectRejected(parseEnforcementTargetExclusion, [
      exclusion({ tabId: -1 }),
      exclusion({ documentId: '  ' }),
      exclusion({ url: '' }),
      withKey(exclusion(), 'reason', 'unreachable'),
      withKey(exclusion(), 'extra', true),
      withoutKey(exclusion(), 'reason'),
      new Proxy(exclusion(), {}),
      null,
    ]);
  });
});

describe('background enforcement checkpoint parsing', (): void => {
  it('accepts an intrinsically consistent checkpoint and keeps empty collections', (): void => {
    const empty: EnforcementCheckpoint = checkpoint({ documents: [], exclusions: [] });

    for (const value of [checkpoint(), empty, checkpoint({ kind: 'resume-strengthening' })]) {
      expect(parseEnforcementCheckpoint(value)).toEqual(value);
      expect(validateDetachedEnforcementCheckpoint(structuredClone(value))).toBe(true);
    }
    expectRejected(parseEnforcementCheckpoint, [
      withoutKey(checkpoint(), 'exclusions'),
      withKey(checkpoint(), 'documents', null),
      withKey(checkpoint(), 'exclusions', {}),
    ]);
  });

  it('accepts a starting checkpoint whose acknowledgements carry the reserved identity', (): void => {
    const reserved: EnforcementCheckpoint = checkpoint({
      documents: [
        enforcementAck({ sessionId: null, reservedSessionId: SESSION_ID, runtimeRevision: 0 }),
        secondAck({ sessionId: null, reservedSessionId: SESSION_ID, runtimeRevision: 0 }),
      ],
    });

    expect(parseEnforcementCheckpoint(reserved)).toEqual(reserved);
    expectRejected(parseEnforcementCheckpoint, [
      checkpoint({
        documents: [enforcementAck({ sessionId: null, reservedSessionId: OTHER_SESSION_ID })],
      }),
      checkpoint({ documents: [enforcementAck({ sessionId: OTHER_SESSION_ID })] }),
    ]);
  });

  it('does not reject document or exclusion array order', (): void => {
    const forward: EnforcementCheckpoint = checkpoint({
      documents: [enforcementAck(), secondAck()],
      exclusions: [exclusion(), exclusion({ tabId: 22, documentId: null })],
    });
    const reversed: EnforcementCheckpoint = checkpoint({
      documents: [secondAck(), enforcementAck()],
      exclusions: [exclusion({ tabId: 22, documentId: null }), exclusion()],
    });

    expect(parseEnforcementCheckpoint(forward)).toEqual(forward);
    expect(parseEnforcementCheckpoint(reversed)).toEqual(reversed);
  });

  it('requires unique exact tab and document identities', (): void => {
    expectRejected(parseEnforcementCheckpoint, [
      checkpoint({ documents: [enforcementAck(), enforcementAck()] }),
      checkpoint({ documents: [enforcementAck(), enforcementAck({ url: 'https://other.test/' })] }),
      checkpoint({ exclusions: [exclusion(), exclusion()] }),
      checkpoint({
        exclusions: [exclusion({ documentId: null }), exclusion({ documentId: null })],
      }),
    ]);
  });

  it('keeps a null document ID distinct from a document called null', (): void => {
    // `${tabId}:${documentId}` folds the two onto one key, which refuses a checkpoint that
    // legitimately excludes both a tab with no document ID and a document identified as "null".
    const distinct: EnforcementCheckpoint = checkpoint({
      exclusions: [
        exclusion({ tabId: 21, documentId: null }),
        exclusion({ tabId: 21, documentId: 'null' }),
      ],
    });

    expect(parseEnforcementCheckpoint(distinct)).toEqual(distinct);
  });

  it('rejects one top-frame tab target in both documents and exclusions', (): void => {
    expectRejected(parseEnforcementCheckpoint, [
      checkpoint({ exclusions: [exclusion({ tabId: 11 })] }),
      checkpoint({ exclusions: [exclusion({ tabId: 12, documentId: null })] }),
    ]);
    const disjoint: EnforcementCheckpoint = checkpoint({ exclusions: [exclusion({ tabId: 13 })] });
    expect(parseEnforcementCheckpoint(disjoint)).toEqual(disjoint);
  });

  it('requires one shared operation-time runtime revision across acknowledgements', (): void => {
    for (const revision of [0, 7, 4_096]) {
      const shared: EnforcementCheckpoint = checkpoint({
        documents: [
          enforcementAck({ runtimeRevision: revision }),
          secondAck({ runtimeRevision: revision }),
        ],
      });
      expect(parseEnforcementCheckpoint(shared)).toEqual(shared);
    }
    expectRejected(parseEnforcementCheckpoint, [
      checkpoint({ documents: [enforcementAck(), secondAck({ runtimeRevision: 8 })] }),
      checkpoint({ documents: [enforcementAck({ runtimeRevision: 0 }), secondAck()] }),
    ]);
  });

  it('stores no current runtime revision to compare a checkpoint against', (): void => {
    expectRejected(parseEnforcementCheckpoint, [
      withKey(checkpoint(), 'runtimeRevision', 7),
      withKey(checkpoint(), 'runtimeRevision', 9),
    ]);
  });

  it('requires documents to agree with the checkpoint operation, epoch, and base revision', (): void => {
    expectRejected(parseEnforcementCheckpoint, [
      checkpoint({ documents: [enforcementAck({ operationId: OTHER_OPERATION_ID })] }),
      checkpoint({ documents: [enforcementAck({ enforcementEpoch: OTHER_EPOCH_ID })] }),
      checkpoint({ documents: [enforcementAck({ basePolicyRevision: 5 })] }),
      checkpoint({ operationId: OTHER_OPERATION_ID }),
      checkpoint({ enforcementEpoch: OTHER_EPOCH_ID }),
      checkpoint({ basePolicyRevision: 5 }),
      checkpoint({ sessionId: OTHER_SESSION_ID }),
    ]);
  });

  it('requires the audit time to precede the completion time', (): void => {
    expectRejected(parseEnforcementCheckpoint, [
      checkpoint({ registrationAuditedAt: COMPLETED_AT + 1, documents: [], exclusions: [] }),
    ]);
  });

  it('accepts acknowledgements handled outside the audit and completion times', (): void => {
    const early: EnforcementCheckpoint = checkpoint({
      documents: [enforcementAck({ handledAt: AUDITED_AT - 1 })],
    });
    const late: EnforcementCheckpoint = checkpoint({
      documents: [enforcementAck({ handledAt: COMPLETED_AT + 1 })],
    });
    const spread: EnforcementCheckpoint = checkpoint({
      documents: [
        enforcementAck({ handledAt: AUDITED_AT - 60_000 }),
        secondAck({ handledAt: COMPLETED_AT + 60_000 }),
      ],
    });

    for (const value of [early, late, spread]) {
      expect(parseEnforcementCheckpoint(value)).toEqual(value);
    }
  });

  it('rejects invalid checkpoint identity, kind, time, and generation leaves', (): void => {
    expectRejected(parseEnforcementCheckpoint, [
      withKey(checkpoint(), 'version', 2),
      checkpoint({ operationId: 'not-a-uuid' }),
      checkpoint({ enforcementEpoch: 'not-a-uuid' }),
      checkpoint({ sessionId: 'not-a-uuid' }),
      withKey(checkpoint(), 'sessionId', null),
      checkpoint({ basePolicyRevision: -1 }),
      withKey(checkpoint(), 'kind', 'starting'),
      checkpoint({ registrationAuditedAt: -1 }),
      checkpoint({ completedAt: 1.5 }),
      checkpoint({ targetGeneration: -1 }),
      checkpoint({ targetGeneration: Number.MAX_SAFE_INTEGER + 1 }),
      withKey(checkpoint(), 'extra', true),
    ]);
  });

  it('rejects hostile checkpoint roots and hostile nested collections', (): void => {
    let handledReads: number = 0;
    const accessorAck: UnknownRecord = { ...enforcementAck() };
    Object.defineProperty(accessorAck, 'handledAt', {
      configurable: true,
      enumerable: true,
      get: (): number => {
        handledReads += 1;
        return NOW;
      },
    });

    expectRejected(parseEnforcementCheckpoint, [
      new Proxy(checkpoint(), {}),
      checkpoint({ documents: [new Proxy(enforcementAck(), {})] }),
      checkpoint({ exclusions: [new Proxy(exclusion(), {})] }),
      withKey(checkpoint(), 'documents', sparseArray(enforcementAck())),
      withKey(checkpoint(), 'exclusions', sparseArray(exclusion())),
      withKey(checkpoint(), 'documents', [accessorAck]),
      withKey(checkpoint(), 'documents', [withKey(enforcementAck(), 'extra', 1)]),
      withKey(checkpoint(), 'sessionId', cyclicRecord()),
      cyclicRecord(),
      null,
    ]);
    expect(handledReads).toBe(0);
    expect(
      validateDetachedEnforcementCheckpoint(
        withKey(checkpoint(), 'documents', sparseArray(enforcementAck())),
      ),
    ).toBe(false);
    expect(
      validateDetachedEnforcementCheckpoint(
        withKey(checkpoint(), 'exclusions', sparseArray(exclusion())),
      ),
    ).toBe(false);
  });

  it('rejects a document array that grows while it is inspected', (): void => {
    const documents: DocumentEnforcementAck[] = [enforcementAck()];
    const growing: DocumentEnforcementAck[] = new Proxy(documents, {
      ownKeys: (target: DocumentEnforcementAck[]): ArrayLike<string | symbol> => {
        target.push(secondAck());
        return Reflect.ownKeys(target);
      },
    });

    expect(parseEnforcementCheckpoint(withKey(checkpoint(), 'documents', growing))).toBeNull();
    expect(documents).toHaveLength(2);
    expect(parseEnforcementCheckpoint(checkpoint({ documents }))).not.toBeNull();
  });

  it('detaches parsed checkpoints in both directions', (): void => {
    const first: DocumentEnforcementAck = enforcementAck();
    const source: EnforcementCheckpoint = checkpoint({ documents: [first, secondAck()] });
    const parsed: EnforcementCheckpoint = parseEnforcementCheckpoint(
      source,
    ) as EnforcementCheckpoint;
    const parsedFirst: DocumentEnforcementAck = parsed.documents[0] as DocumentEnforcementAck;

    expect(parsed).toEqual(source);
    expect(parsed.documents).not.toBe(source.documents);

    first.url = 'https://mutated.test/';
    expect(parsedFirst.url).toBe(TARGET_URL);
    parsed.exclusions.pop();
    expect(source.exclusions).toHaveLength(1);
  });
});

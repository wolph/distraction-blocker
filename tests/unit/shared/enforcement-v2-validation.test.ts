import { describe, expect, it } from 'vitest';
import type {
  DocumentEnforcementCommand,
  DocumentOverlayView,
} from '../../../src/shared/enforcement-v2';
import {
  parseDocumentEnforcementCommand,
  parseDocumentOverlayView,
  validateDetachedDocumentEnforcementCommand,
  validateDetachedDocumentEnforcementCommandFields,
  validateDetachedDocumentOverlayView,
  validateDetachedVerdict,
} from '../../../src/shared/enforcement-v2-validation';
import type { GateState, SiteUnlock, Verdict } from '../../../src/shared/types';

type StartingOverlay = Extract<DocumentOverlayView, { presentation: 'starting' }>;
type ActiveOverlay = Extract<DocumentOverlayView, { presentation: 'active' }>;
type ActiveCopy = ActiveOverlay['copy'];
type ActiveActions = ActiveOverlay['actions'];
type ActiveTiming = ActiveOverlay['timing'];
type ActiveEconomy = ActiveOverlay['economy'];
type UnknownRecord = Record<string, unknown>;

const NOW: number = 1_750_000_000_000;
const SESSION_ID: string = '10000000-0000-4000-8000-000000000001';
const OTHER_SESSION_ID: string = '10000000-0000-4000-8000-000000000002';
const OPERATION_ID: string = '20000000-0000-4000-8000-000000000001';
const EPOCH_ID: string = '30000000-0000-4000-8000-000000000001';
const STOPPED_COPY: NonNullable<ActiveCopy['stoppedPage']> =
  'This page did not load. It will load by itself when the session ends.';
const UNTIL_STOPPED_TEXT: Extract<ActiveCopy['status'], { kind: 'until-stopped' }>['text'] =
  'Focus Lock is active until you end it from the popup.';
const PROVENANCE: string = 'Blocked by Social media: example.com';
const READY_ACTIONS: ActiveActions = {
  state: 'ready',
  end: 'request-end',
  pause: 'request-gate',
  unlock: 'request-gate',
};
const HIDDEN_END_ACTIONS: ActiveActions = { ...READY_ACTIONS, end: 'hidden' };
const GATE_END_ACTIONS: ActiveActions = { ...READY_ACTIONS, end: 'open-end-gate' };
const GATE_ACTIONS: ActiveActions = {
  state: 'gate',
  end: 'hidden',
  pause: 'hidden',
  unlock: 'hidden',
};
const PAUSE_GATE: GateState = {
  kind: 'pause',
  host: null,
  openedAt: NOW - 500,
  readyAt: NOW + 500,
  requiredPhrase: null,
};
const UNLOCK_GATE: GateState = {
  kind: 'unlockSite',
  host: 'example.com',
  openedAt: NOW - 500,
  readyAt: NOW + 500,
  requiredPhrase: 'unlock example.com',
};
const CANCEL_GATE: GateState = {
  kind: 'cancel',
  host: null,
  openedAt: NOW - 500,
  readyAt: NOW + 500,
  requiredPhrase: 'end session',
};
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

function activeCopy(overrides: Partial<ActiveCopy> = {}): ActiveCopy {
  return {
    status: { kind: 'timed', text: 'Focus Lock is active for 1:00 more.' },
    lockedUntil: 'Locked until 14:35',
    intention: 'Finish the release notes',
    attempts: '2 attempts blocked today',
    verdictProvenance: PROVENANCE,
    stoppedPage: null,
    bankUnit: 'site access credit',
    pauseAction: 'Pause blocking for 1 min',
    unlockAction: 'Unlock this site for 2 min',
    endAction: 'End session',
    bankWaitFallback: 'earn site access credit by focusing',
    bankWaitPrefix: 'ready in',
    gateTitle: null,
    gateBack: 'Never mind, back to work',
    gatePhraseLabel: 'Type this to confirm:',
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
    actions: READY_ACTIONS,
    copy: activeCopy(),
    ...overrides,
  };
}

function indefiniteOverlay(overrides: Partial<ActiveOverlay> = {}): ActiveOverlay {
  return activeOverlay({
    duration: { kind: 'until-stopped' },
    timing: {
      capturedAt: NOW,
      phaseStartedAt: NOW - 1_000,
      phaseEndsAt: null,
      sessionEndsAt: null,
    },
    actions: HIDDEN_END_ACTIONS,
    copy: indefiniteCopy(),
    ...overrides,
  });
}

function indefiniteCopy(overrides: Partial<ActiveCopy> = {}): ActiveCopy {
  return activeCopy({
    status: { kind: 'until-stopped', text: UNTIL_STOPPED_TEXT },
    lockedUntil: null,
    ...overrides,
  });
}

function gatedOverlay(gate: GateState, overrides: Partial<ActiveOverlay> = {}): ActiveOverlay {
  return activeOverlay({
    gate,
    actions: GATE_ACTIONS,
    copy: activeCopy({ gateTitle: 'Pause blocking for 1 min', gateConfirm: 'Take the pause' }),
    ...overrides,
  });
}

function command(overrides: Partial<DocumentEnforcementCommand> = {}): DocumentEnforcementCommand {
  return {
    version: 1,
    command: 'apply-enforcement',
    operationId: OPERATION_ID,
    enforcementEpoch: EPOCH_ID,
    sessionId: SESSION_ID,
    reservedSessionId: null,
    basePolicyRevision: 4,
    runtimeRevision: 7,
    documentId: 'document-1',
    expectedUrl: 'https://example.com/path',
    presentation: 'active',
    verdict: BLOCKED_VERDICT,
    overlay: activeOverlay(),
    ...overrides,
  };
}

function clearCommand(
  overrides: Partial<DocumentEnforcementCommand> = {},
): DocumentEnforcementCommand {
  return command({ presentation: 'clear', verdict: CLEAR_VERDICT, overlay: null, ...overrides });
}

function withKey(value: object, key: string, replacement: unknown): UnknownRecord {
  return { ...value, [key]: replacement };
}

function withoutKey(value: object, key: string): UnknownRecord {
  const clone: UnknownRecord = { ...value };
  Reflect.deleteProperty(clone, key);
  return clone;
}

function withCopyKey(
  overlay: DocumentOverlayView,
  key: string,
  replacement: unknown,
): UnknownRecord {
  return withKey(overlay, 'copy', withKey(overlay.copy, key, replacement));
}

function expectOverlayRejected(values: readonly unknown[]): void {
  for (const value of values) {
    expect((): DocumentOverlayView | null => parseDocumentOverlayView(value)).not.toThrow();
    expect(parseDocumentOverlayView(value)).toBeNull();
  }
}

function expectCommandRejected(values: readonly unknown[]): void {
  for (const value of values) {
    expect((): DocumentEnforcementCommand | null =>
      parseDocumentEnforcementCommand(value),
    ).not.toThrow();
    expect(parseDocumentEnforcementCommand(value)).toBeNull();
  }
}

describe('shared enforcement v2 overlay parsing', (): void => {
  it('accepts both approved starting rows', (): void => {
    const stopped: StartingOverlay = startingOverlay({
      stoppedPage: true,
      copy: { ...startingOverlay().copy, stoppedPage: STOPPED_COPY },
    });

    for (const value of [startingOverlay(), stopped]) {
      expect(parseDocumentOverlayView(value)).toEqual(value);
      expect(validateDetachedDocumentOverlayView(structuredClone(value))).toBe(true);
    }
  });

  it('accepts every approved active row', (): void => {
    const rows: readonly ActiveOverlay[] = [
      activeOverlay(),
      activeOverlay({ strictness: 'friction', actions: GATE_END_ACTIONS }),
      activeOverlay({ strictness: 'hard', actions: HIDDEN_END_ACTIONS }),
      activeOverlay({ mode: 'whitelist', theme: 'light', copy: activeCopy({ intention: null }) }),
      indefiniteOverlay(),
      gatedOverlay(PAUSE_GATE),
      gatedOverlay(UNLOCK_GATE, {
        copy: activeCopy({ gateTitle: 'Unlock example.com', gateConfirm: 'Unlock this site' }),
      }),
      gatedOverlay(CANCEL_GATE, {
        copy: activeCopy({ gateTitle: 'End this session', gateConfirm: 'End the session' }),
      }),
      indefiniteOverlay({
        gate: PAUSE_GATE,
        actions: GATE_ACTIONS,
        copy: indefiniteCopy({
          gateTitle: 'Pause blocking for 1 min',
          gateConfirm: 'Take the pause',
        }),
      }),
      activeOverlay({ stoppedPage: true, copy: activeCopy({ stoppedPage: STOPPED_COPY }) }),
      activeOverlay({ activeUnlocks: [] }),
    ];

    for (const value of rows) {
      expect(parseDocumentOverlayView(value)).toEqual(value);
      expect(validateDetachedDocumentOverlayView(structuredClone(value))).toBe(true);
    }
  });

  it('rejects starting rows with wrong copy, a clock, or a visible End', (): void => {
    const copy: StartingOverlay['copy'] = startingOverlay().copy;

    expectOverlayRejected([
      withCopyKey(startingOverlay(), 'title', 'Starting'),
      withCopyKey(startingOverlay(), 'detail', 'Applying rules'),
      startingOverlay({ copy: { ...copy, verdictProvenance: '   ' } }),
      startingOverlay({ copy: { ...copy, stoppedPage: STOPPED_COPY } }),
      startingOverlay({ stoppedPage: true }),
      withKey(startingOverlay(), 'actions', { end: 'request-end' }),
      withKey(startingOverlay(), 'timing', { capturedAt: NOW }),
      withoutKey(startingOverlay(), 'capturedAt'),
      withKey(startingOverlay(), 'version', 2),
      withKey(startingOverlay(), 'capturedAt', -1),
      withKey(startingOverlay(), 'presentation', 'active'),
    ]);
  });

  it('rejects active rows outside the focus phase and off-contract leaves', (): void => {
    expectOverlayRejected([
      withKey(activeOverlay(), 'phase', 'break'),
      withKey(activeOverlay(), 'phase', 'paused'),
      withKey(activeOverlay(), 'phase', 'idle'),
      withKey(activeOverlay(), 'sessionId', 'not-a-uuid'),
      withKey(activeOverlay(), 'mode', 'allowlist'),
      withKey(activeOverlay(), 'strictness', 'strict'),
      withKey(activeOverlay(), 'theme', 'midnight'),
      withKey(activeOverlay(), 'version', 2),
      withKey(activeOverlay(), 'stoppedPage', 'false'),
      withKey(activeOverlay(), 'duration', { kind: 'timed' }),
      withKey(activeOverlay(), 'duration', { kind: 'until-stopped', minutes: 25 }),
      withKey(activeOverlay(), 'gate', { ...PAUSE_GATE, readyAt: PAUSE_GATE.openedAt - 1 }),
      // The End action is paired with the strictness, not free: Flexible ends immediately and
      // Friction has to open its cancel gate, because the worker refuses an immediate end for
      // anything but Flexible. Either row crossed over describes a control that cannot work.
      activeOverlay({ strictness: 'friction' }),
      activeOverlay({ actions: GATE_END_ACTIONS }),
    ]);
  });

  it('accepts a first freeze at the phase boundary', (): void => {
    const timing: ActiveTiming = activeOverlay().timing;
    const atBoundary: ActiveOverlay = activeOverlay({
      timing: { ...timing, phaseEndsAt: NOW, sessionEndsAt: NOW },
    });

    expect(parseDocumentOverlayView(atBoundary)).not.toBeNull();
  });

  it('enforces timed timing and copy', (): void => {
    const timing: ActiveTiming = activeOverlay().timing;

    expectOverlayRejected([
      activeOverlay({ timing: { ...timing, phaseEndsAt: null } }),
      activeOverlay({ timing: { ...timing, sessionEndsAt: null } }),
      activeOverlay({ timing: { ...timing, phaseEndsAt: NOW - 1 } }),
      activeOverlay({ timing: { ...timing, sessionEndsAt: NOW + 30_000 } }),
      activeOverlay({ timing: { ...timing, phaseStartedAt: NOW + 1 } }),
      activeOverlay({ copy: activeCopy({ lockedUntil: null }) }),
      activeOverlay({ copy: activeCopy({ lockedUntil: '   ' }) }),
      activeOverlay({ copy: indefiniteCopy() }),
      activeOverlay({ copy: activeCopy({ status: { kind: 'timed', text: '  ' } }) }),
      withKey(activeOverlay(), 'timing', withoutKey(timing, 'sessionEndsAt')),
    ]);
    expect(
      parseDocumentOverlayView(
        activeOverlay({ timing: { ...timing, sessionEndsAt: timing.phaseEndsAt } }),
      ),
    ).not.toBeNull();
  });

  it('enforces until-stopped timing and copy', (): void => {
    const timing: ActiveTiming = indefiniteOverlay().timing;

    expectOverlayRejected([
      indefiniteOverlay({ timing: { ...timing, phaseEndsAt: NOW + 1 } }),
      indefiniteOverlay({ timing: { ...timing, sessionEndsAt: NOW + 1 } }),
      indefiniteOverlay({ copy: activeCopy() }),
      withCopyKey(indefiniteOverlay(), 'status', {
        kind: 'until-stopped',
        text: 'Focus Lock is active.',
      }),
      indefiniteOverlay({ copy: indefiniteCopy({ lockedUntil: 'Locked until tomorrow' }) }),
      indefiniteOverlay({ strictness: 'friction' }),
      indefiniteOverlay({ strictness: 'hard' }),
    ]);
  });

  it('derives the End action from duration, strictness, and gate state', (): void => {
    expectOverlayRejected([
      activeOverlay({ actions: HIDDEN_END_ACTIONS }),
      activeOverlay({ strictness: 'friction', actions: HIDDEN_END_ACTIONS }),
      activeOverlay({ strictness: 'hard' }),
      indefiniteOverlay({ actions: READY_ACTIONS }),
      withKey(gatedOverlay(PAUSE_GATE), 'actions', { ...GATE_ACTIONS, end: 'request-end' }),
    ]);
  });

  it('requires action state and gate copy to agree with gate presence', (): void => {
    const gated: ActiveOverlay = gatedOverlay(PAUSE_GATE);

    expectOverlayRejected([
      activeOverlay({ actions: GATE_ACTIONS }),
      gatedOverlay(PAUSE_GATE, { actions: HIDDEN_END_ACTIONS }),
      withKey(gated, 'actions', { ...GATE_ACTIONS, pause: 'request-gate' }),
      withKey(gated, 'actions', { ...GATE_ACTIONS, unlock: 'request-gate' }),
      withKey(activeOverlay(), 'actions', { ...READY_ACTIONS, pause: 'hidden' }),
      withKey(activeOverlay(), 'actions', { ...READY_ACTIONS, unlock: 'hidden' }),
      withKey(activeOverlay(), 'actions', withoutKey(READY_ACTIONS, 'unlock')),
      gatedOverlay(PAUSE_GATE, { copy: activeCopy({ gateConfirm: 'Take the pause' }) }),
      gatedOverlay(PAUSE_GATE, { copy: activeCopy({ gateTitle: 'Pause blocking for 1 min' }) }),
      gatedOverlay(PAUSE_GATE, {
        copy: activeCopy({ gateTitle: '   ', gateConfirm: 'Take the pause' }),
      }),
      gatedOverlay(PAUSE_GATE, {
        copy: activeCopy({ gateTitle: 'Pause blocking for 1 min', gateConfirm: '   ' }),
      }),
      activeOverlay({ copy: activeCopy({ gateTitle: 'Pause blocking for 1 min' }) }),
      activeOverlay({ copy: activeCopy({ gateConfirm: 'Take the pause' }) }),
      gatedOverlay({ ...PAUSE_GATE, host: 'example.com' }),
      gatedOverlay({ ...UNLOCK_GATE, host: null }),
    ]);
  });

  it('requires exact fixed active copy and non-blank rendered copy', (): void => {
    const overlay: ActiveOverlay = activeOverlay();

    expectOverlayRejected([
      withCopyKey(overlay, 'bankUnit', 'pause saved'),
      withCopyKey(overlay, 'endAction', 'Stop session'),
      withCopyKey(overlay, 'bankWaitFallback', 'focus to earn'),
      withCopyKey(overlay, 'bankWaitPrefix', 'ready at'),
      withCopyKey(overlay, 'gateBack', 'Back to work'),
      withCopyKey(overlay, 'gatePhraseLabel', 'Type this:'),
      withCopyKey(overlay, 'transportError', 'Try again.'),
      withCopyKey(overlay, 'headline', 'extra'),
      withKey(overlay, 'copy', withoutKey(overlay.copy, 'intention')),
      activeOverlay({ copy: activeCopy({ attempts: '   ' }) }),
      activeOverlay({ copy: activeCopy({ pauseAction: '' }) }),
      activeOverlay({ copy: activeCopy({ unlockAction: ' ' }) }),
      activeOverlay({ copy: activeCopy({ verdictProvenance: '\t' }) }),
      activeOverlay({ copy: activeCopy({ intention: '   ' }) }),
    ]);
    expect(
      parseDocumentOverlayView(activeOverlay({ copy: activeCopy({ intention: null }) })),
    ).not.toBeNull();
  });

  it('requires stopped-page copy agreement in the active row', (): void => {
    expectOverlayRejected([
      activeOverlay({ stoppedPage: true }),
      activeOverlay({ copy: activeCopy({ stoppedPage: STOPPED_COPY }) }),
      withCopyKey(activeOverlay({ stoppedPage: true }), 'stoppedPage', 'The page stopped.'),
    ]);
  });

  it('enforces unlock freshness against capturedAt and lets a gate open later', (): void => {
    const fresh: SiteUnlock = { host: 'example.com', until: NOW + 1 };

    expectOverlayRejected([
      activeOverlay({ activeUnlocks: [{ host: 'example.com', until: NOW }] }),
      activeOverlay({ activeUnlocks: [{ host: 'example.com', until: NOW - 1 }] }),
      activeOverlay({ activeUnlocks: [fresh, { host: 'other.example', until: NOW - 1 }] }),
      activeOverlay({ activeUnlocks: [{ host: '   ', until: NOW + 1 }] }),
    ]);
    expect(parseDocumentOverlayView(activeOverlay({ activeUnlocks: [fresh] }))).not.toBeNull();
    // `capturedAt` is a frozen anchor, not a clock reading. A Friction End opens its cancel gate
    // after activation and the replacement view keeps the anchor, so a later gate is legal.
    for (const openedAt of [NOW - 500, NOW, NOW + 1, NOW + 30_000]) {
      const gate: GateState = { ...CANCEL_GATE, openedAt, readyAt: openedAt + 5_000 };
      const gated: ActiveOverlay = gatedOverlay(gate, {
        copy: activeCopy({ gateTitle: 'End this session', gateConfirm: 'End the session' }),
      });
      expect(parseDocumentOverlayView(gated)).not.toBeNull();
    }
  });

  it('enforces timestamp, count, cap, and cost numeric domains', (): void => {
    const timing: ActiveTiming = activeOverlay().timing;
    const economy: ActiveEconomy = activeOverlay().economy;

    expectOverlayRejected([
      activeOverlay({ timing: { ...timing, capturedAt: -1 } }),
      activeOverlay({ timing: { ...timing, capturedAt: 1.5 } }),
      activeOverlay({ timing: { ...timing, phaseStartedAt: Number.NaN } }),
      activeOverlay({ timing: { ...timing, phaseEndsAt: Number.MAX_SAFE_INTEGER + 1 } }),
      activeOverlay({ attemptsToday: -1 }),
      activeOverlay({ attemptsToday: 1.5 }),
      activeOverlay({ attemptsToday: Number.POSITIVE_INFINITY }),
      activeOverlay({ economy: { ...economy, bankMs: Number.NaN } }),
      activeOverlay({ economy: { ...economy, bankMs: -1 } }),
      activeOverlay({ economy: { ...economy, bankAccrualPerMs: Number.POSITIVE_INFINITY } }),
      activeOverlay({ economy: { ...economy, bankAccrualPerMs: -0.5 } }),
      activeOverlay({ economy: { ...economy, bankCapMs: 1.5 } }),
      activeOverlay({ economy: { ...economy, bankCapMs: 30_000 } }),
      activeOverlay({ economy: { ...economy, pauseCostMs: -1 } }),
      activeOverlay({ economy: { ...economy, pauseCostMs: 1.5 } }),
      activeOverlay({ economy: { ...economy, unlockCostMs: Number.MAX_SAFE_INTEGER } }),
    ]);
    expect(
      parseDocumentOverlayView(
        activeOverlay({ economy: { ...economy, bankMs: economy.bankCapMs } }),
      ),
    ).not.toBeNull();
  });

  it('never runs an overlay accessor, and never sees a value a proxy swaps in', (): void => {
    // Rejection alone does not prove the parser did not read the accessor. The repo's boundary
    // suites count getter calls, and this boundary had no such case.
    let attemptsReads: number = 0;
    const overlay: ActiveOverlay = activeOverlay();
    const accessorCopy: UnknownRecord = { ...overlay.copy };
    Object.defineProperty(accessorCopy, 'attempts', {
      configurable: true,
      enumerable: true,
      get: (): string => {
        attemptsReads += 1;
        return '2 attempts blocked today';
      },
    });

    expect(parseDocumentOverlayView(withKey(overlay, 'copy', accessorCopy))).toBeNull();
    expect(attemptsReads).toBe(0);

    // A proxy that mutates the record while it is being inspected must not have its later value
    // observed: the snapshot the parser works from is taken before anything can change.
    // The walk reads descriptors rather than values, so a `get` trap never fires here: the trap
    // that sees the parser coming is `getOwnPropertyDescriptor`.
    let mutations: number = 0;
    const timing: UnknownRecord = { ...overlay.timing };
    const mutating: unknown = new Proxy(timing, {
      getOwnPropertyDescriptor: (
        target: UnknownRecord,
        key: string | symbol,
      ): PropertyDescriptor | undefined => {
        mutations += 1;
        // A different but still legal instant, so only the atomicity check can refuse it.
        timing.capturedAt = overlay.timing.capturedAt - 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    expect(parseDocumentOverlayView(withKey(overlay, 'timing', mutating))).toBeNull();
    // The trap fired, so the rejection is the mutation being caught rather than the proxy being
    // skipped: the snapshot is compared against a clone taken after the walk, and they differ.
    expect(mutations).toBeGreaterThan(0);

    let commandMutations: number = 0;
    const source: UnknownRecord = { ...command() };
    const mutatingCommand: unknown = new Proxy(source, {
      getOwnPropertyDescriptor: (
        target: UnknownRecord,
        key: string | symbol,
      ): PropertyDescriptor | undefined => {
        commandMutations += 1;
        source.runtimeRevision = Number(source.runtimeRevision) + 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    expect(parseDocumentEnforcementCommand(mutatingCommand)).toBeNull();
    expect(commandMutations).toBeGreaterThan(0);
  });

  it('rejects exact-schema and hostile nested overlay data', (): void => {
    const overlay: ActiveOverlay = activeOverlay();
    const sparse: unknown[] = new Array<unknown>(2);
    sparse[0] = { host: 'example.com', until: NOW + 1 };
    const cycle: UnknownRecord = {};
    cycle.self = cycle;
    const accessorCopy: UnknownRecord = { ...overlay.copy };
    Object.defineProperty(accessorCopy, 'attempts', {
      configurable: true,
      enumerable: true,
      get: (): string => '2 attempts blocked today',
    });
    class OverlayRecord {}
    const prototyped: object = Object.assign(new OverlayRecord(), overlay.timing);

    expectOverlayRejected([
      withKey(overlay, 'extra', true),
      withoutKey(overlay, 'copy'),
      withKey(overlay, 'copy', undefined),
      withKey(overlay, 'activeUnlocks', sparse),
      withKey(overlay, 'copy', accessorCopy),
      withKey(overlay, 'economy', { ...overlay.economy, [Symbol('extra')]: true }),
      withKey(overlay, 'timing', new Proxy({ ...overlay.timing }, {})),
      // The command parser has a proxy root case; this boundary had one only in a nested field.
      new Proxy({ ...overlay }, {}),
      withKey(overlay, 'timing', prototyped),
      withKey(overlay, 'copy', cycle),
      withKey(overlay, 'activeUnlocks', { 0: { host: 'example.com', until: NOW + 1 } }),
      cycle,
      null,
      undefined,
      'active',
      [overlay],
    ]);
  });

  it('detaches parsed overlays in both directions and keeps legal aliases', (): void => {
    const shared: SiteUnlock = { host: 'example.com', until: NOW + 30_000 };
    const source: ActiveOverlay = activeOverlay({ activeUnlocks: [shared, shared] });
    const parsed: ActiveOverlay = parseDocumentOverlayView(source) as ActiveOverlay;

    expect(parsed).toEqual(source);
    expect(parsed).not.toBe(source);
    expect(parsed.activeUnlocks[0]).toBe(parsed.activeUnlocks[1]);
    expect(parsed.activeUnlocks[0]).not.toBe(shared);

    source.copy.attempts = 'source mutation';
    expect(parsed.copy.attempts).toBe('2 attempts blocked today');
    parsed.copy.verdictProvenance = 'snapshot mutation';
    expect(source.copy.verdictProvenance).toBe(PROVENANCE);
  });

  it('exposes a detached overlay predicate for callers holding one root snapshot', (): void => {
    expect(validateDetachedDocumentOverlayView(structuredClone(indefiniteOverlay()))).toBe(true);
    expect(validateDetachedDocumentOverlayView(structuredClone(startingOverlay()))).toBe(true);
    expect(
      validateDetachedDocumentOverlayView(
        structuredClone(withKey(activeOverlay(), 'attemptsToday', -1)),
      ),
    ).toBe(false);
    expect(validateDetachedDocumentOverlayView(structuredClone(activeCopy()))).toBe(false);
  });
});

describe('shared enforcement v2 command parsing', (): void => {
  it('accepts starting, active, and clear commands', (): void => {
    const starting: DocumentEnforcementCommand = command({
      sessionId: null,
      reservedSessionId: SESSION_ID,
      presentation: 'starting',
      overlay: startingOverlay(),
    });

    for (const value of [command(), starting, clearCommand()]) {
      expect(parseDocumentEnforcementCommand(value)).toEqual(value);
      expect(validateDetachedDocumentEnforcementCommand(structuredClone(value))).toBe(true);
    }
  });

  it('requires exactly one non-null session identity', (): void => {
    expectCommandRejected([
      command({ sessionId: null, reservedSessionId: null }),
      command({ sessionId: SESSION_ID, reservedSessionId: OTHER_SESSION_ID }),
      command({ sessionId: SESSION_ID, reservedSessionId: SESSION_ID }),
      command({ sessionId: 'not-a-uuid' }),
      command({ sessionId: null, reservedSessionId: 'not-a-uuid' }),
    ]);
  });

  it('requires the active overlay identity to equal the command identity', (): void => {
    expectCommandRejected([
      command({ overlay: activeOverlay({ sessionId: OTHER_SESSION_ID }) }),
      command({ sessionId: null, reservedSessionId: SESSION_ID }),
    ]);
  });

  it('requires the canonical clear verdict and a null overlay', (): void => {
    expectCommandRejected([
      clearCommand({ verdict: { ...CLEAR_VERDICT, blocked: true } }),
      clearCommand({ verdict: { ...CLEAR_VERDICT, reason: 'default' } }),
      clearCommand({ verdict: { ...CLEAR_VERDICT, categoryId: 'social' } }),
      clearCommand({ verdict: { ...CLEAR_VERDICT, matchedPattern: 'example.com' } }),
      clearCommand({ overlay: activeOverlay() }),
      clearCommand({ overlay: startingOverlay() }),
    ]);
  });

  it('requires a null overlay for every allowed verdict', (): void => {
    const allowedReasons: ReadonlyArray<Verdict['reason']> = [
      'no-session',
      'always-allow',
      'unlock',
      'excluded',
      'whitelist',
      'default',
    ];

    for (const reason of allowedReasons) {
      const allowed: DocumentEnforcementCommand = command({
        verdict: {
          blocked: false,
          reason,
          categoryId: null,
          matchedPattern: reason === 'whitelist' ? 'example.com' : null,
        },
        overlay: null,
      });
      expect(parseDocumentEnforcementCommand(allowed)).toEqual(allowed);
      expectCommandRejected([{ ...allowed, overlay: activeOverlay() }]);
    }
  });

  it('requires blocked commands to carry the matching overlay presentation', (): void => {
    expectCommandRejected([
      command({ overlay: null }),
      command({ presentation: 'starting', overlay: activeOverlay() }),
      command({ presentation: 'active', overlay: startingOverlay() }),
      command({ presentation: 'clear' }),
      clearCommand({ verdict: BLOCKED_VERDICT }),
      withKey(command(), 'presentation', 'blocked'),
    ]);
  });

  it('rejects invalid command leaves, exact-schema violations, and hostile roots', (): void => {
    const cycle: UnknownRecord = {};
    cycle.self = cycle;
    const accessorVerdict: UnknownRecord = { ...BLOCKED_VERDICT };
    Object.defineProperty(accessorVerdict, 'reason', {
      configurable: true,
      enumerable: true,
      get: (): string => 'category',
    });

    expectCommandRejected([
      withKey(command(), 'version', 2),
      withKey(command(), 'command', 'apply-block'),
      command({ operationId: 'not-a-uuid' }),
      command({ enforcementEpoch: 'not-a-uuid' }),
      command({ basePolicyRevision: -1 }),
      command({ basePolicyRevision: Number.MAX_SAFE_INTEGER + 1 }),
      command({ runtimeRevision: 1.5 }),
      command({ documentId: '   ' }),
      command({ expectedUrl: '' }),
      withKey(command(), 'verdict', { ...BLOCKED_VERDICT, reason: 'unknown' }),
      withKey(command(), 'verdict', { ...BLOCKED_VERDICT, categoryId: 'memes' }),
      withKey(command(), 'verdict', withoutKey(BLOCKED_VERDICT, 'matchedPattern')),
      withKey(command(), 'verdict', accessorVerdict),
      withKey(command(), 'verdict', { ...BLOCKED_VERDICT, [Symbol('extra')]: true }),
      withKey(command(), 'extra', true),
      withoutKey(command(), 'verdict'),
      new Proxy(command(), {}),
      withKey(command(), 'overlay', cycle),
      cycle,
      null,
      'apply-enforcement',
    ]);
  });

  it('detaches parsed commands in both directions', (): void => {
    const source: DocumentEnforcementCommand = command();
    const parsed: DocumentEnforcementCommand = parseDocumentEnforcementCommand(
      source,
    ) as DocumentEnforcementCommand;

    expect(parsed).toEqual(source);
    expect(parsed).not.toBe(source);

    source.verdict.reason = 'custom';
    expect(parsed.verdict.reason).toBe('category');
    parsed.overlay = null;
    expect(source.overlay).not.toBeNull();
  });

  it('validates command fields for a caller-owned key set', (): void => {
    const frozen: UnknownRecord = withKey(command(), 'tabId', 7);

    expect(validateDetachedDocumentEnforcementCommand(structuredClone(frozen))).toBe(false);
    // The caller names the keys it owns, so the key set is checked here rather than promised.
    expect(
      validateDetachedDocumentEnforcementCommandFields(structuredClone(frozen), ['tabId']),
    ).toBe(true);
    expect(validateDetachedDocumentEnforcementCommandFields(structuredClone(frozen))).toBe(false);
    expect(
      validateDetachedDocumentEnforcementCommandFields(
        structuredClone(withKey(frozen, 'stowaway', true)),
        ['tabId'],
      ),
    ).toBe(false);
    expect(
      validateDetachedDocumentEnforcementCommandFields(
        structuredClone(withKey(frozen, 'reservedSessionId', SESSION_ID)),
        ['tabId'],
      ),
    ).toBe(false);
    expect(validateDetachedDocumentEnforcementCommandFields(null)).toBe(false);
  });

  it('exposes a detached verdict predicate', (): void => {
    expect(validateDetachedVerdict(structuredClone(BLOCKED_VERDICT))).toBe(true);
    expect(validateDetachedVerdict(structuredClone(CLEAR_VERDICT))).toBe(true);
    expect(validateDetachedVerdict(structuredClone(withKey(CLEAR_VERDICT, 'extra', 1)))).toBe(
      false,
    );
    expect(validateDetachedVerdict(structuredClone(withoutKey(CLEAR_VERDICT, 'blocked')))).toBe(
      false,
    );
  });
});

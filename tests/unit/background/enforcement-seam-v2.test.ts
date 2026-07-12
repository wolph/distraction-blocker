// @vitest-environment jsdom
/**
 * The worker-to-content seam, with production code on both sides. The worker builds a frozen view
 * and command, the transport sends it over a port whose receiver is the real content listener, the
 * real content state machine answers, and the transport wraps only an exact acknowledgement. Every
 * module in that sentence is the shipped one: the only fake is the message channel itself.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContentTransportPortsV2 } from '../../../src/background/content-transport-v2';
import {
  type DocumentCommandOutcomeV2,
  type EpochResetOutcomeV2,
  sendDocumentEnforcementCommand,
  sendEpochResetCommand,
} from '../../../src/background/content-transport-v2';
import type {
  FrozenDocumentCommand,
  FrozenEpochResetCommand,
} from '../../../src/background/enforcement-persistence-v2';
import {
  validateDetachedDocumentEnforcementAck,
  validateDetachedDocumentEpochResetAck,
} from '../../../src/background/enforcement-persistence-v2-validation';
import {
  buildActiveOverlayView,
  buildFrozenDocumentCommandV2,
  buildFrozenEpochResetCommandV2,
} from '../../../src/background/overlay-view-v2';
import type { DocumentEnforcementHostV2 } from '../../../src/content/document-enforcement';
import { installDocumentEnforcement } from '../../../src/content/document-enforcement';
import { clearDocumentOverlay } from '../../../src/content/overlay-v2';
import { DEFAULT_LISTS, rulesFromLists } from '../../../src/shared/constants';
import type {
  ContentEnforcementResponse,
  DocumentOverlayView,
} from '../../../src/shared/enforcement-v2';
import type { SessionConfigV2, SessionStateV2, Verdict } from '../../../src/shared/types';

type MessageListener = (
  message: unknown,
  respond: (response: ContentEnforcementResponse | undefined) => void,
) => void;

const NOW: number = 1_750_000_000_000;
const TAB_ID: number = 7;
const DOCUMENT_ID: string = 'document-7';
const SESSION_ID: string = '10000000-0000-4000-8000-000000000001';
const STARTING_OPERATION_ID: string = '20000000-0000-4000-8000-000000000001';
const RESET_OPERATION_ID: string = '20000000-0000-4000-8000-000000000002';
const STALE_OPERATION_ID: string = '20000000-0000-4000-8000-000000000003';
const EPOCH_ID: string = '30000000-0000-4000-8000-000000000001';
const UNTIL_STOPPED_TEXT: string = 'Until stopped';
const BLOCKED_VERDICT: Verdict = {
  blocked: true,
  reason: 'category',
  categoryId: 'social',
  matchedPattern: 'example.com',
};

let listeners: MessageListener[];
let transport: ContentTransportPortsV2;

/**
 * The channel Chrome would own. It hands the wire message to the installed content listener and
 * resolves with whatever that listener answers, including the `undefined` of a rejected command.
 */
function installedContentPort(): ContentTransportPortsV2 {
  return {
    sendToDocument: async (
      _tabId: number,
      _documentId: string,
      message: unknown,
    ): Promise<unknown> => {
      let answer: ContentEnforcementResponse | undefined;
      let answered: boolean = false;
      for (const listener of listeners) {
        listener(message, (response: ContentEnforcementResponse | undefined): void => {
          answer = response;
          answered = true;
        });
      }
      if (!answered)
        throw new Error('Could not establish connection. Receiving end does not exist.');
      return answer;
    },
  };
}

function sessionConfig(overrides: Partial<SessionConfigV2> = {}): SessionConfigV2 {
  return {
    mode: 'blacklist',
    strictness: 'flexible',
    duration: { kind: 'until-stopped' },
    cycling: null,
    intention: 'Finish the release notes',
    source: 'manual',
    scheduleOccurrence: null,
    rules: rulesFromLists(DEFAULT_LISTS),
    ...overrides,
  };
}

function untilStoppedSession(): SessionStateV2 {
  return {
    version: 2,
    sessionId: SESSION_ID,
    config: sessionConfig(),
    startedAt: NOW - 60_000,
    sessionEndsAt: null,
    phase: 'focus',
    phaseStartedAt: NOW - 60_000,
    phaseEndsAt: null,
    cycleIndex: 0,
    pausedFrom: null,
    focusedMs: 60_000,
  };
}

function activeView(): DocumentOverlayView {
  return buildActiveOverlayView({
    targetUrl: 'https://example.com',
    capturedAt: NOW,
    theme: 'dark',
    session: untilStoppedSession(),
    economy: {
      bankMs: 60_000,
      bankAccrualPerMs: 1 / 6,
      bankCapMs: 300_000,
      pauseCostMs: 60_000,
      unlockCostMs: 120_000,
    },
    gate: null,
    activeUnlocks: [],
    attemptsToday: 2,
    stoppedPage: false,
    verdict: BLOCKED_VERDICT,
  });
}

function activeCommand(operationId: string, runtimeRevision: number): FrozenDocumentCommand {
  return buildFrozenDocumentCommandV2({
    tabId: TAB_ID,
    documentId: DOCUMENT_ID,
    expectedUrl: window.location.href,
    operationId,
    enforcementEpoch: EPOCH_ID,
    sessionId: SESSION_ID,
    reservedSessionId: null,
    basePolicyRevision: 4,
    runtimeRevision,
    verdict: BLOCKED_VERDICT,
    presentation: 'active',
    overlay: activeView(),
  });
}

function resetCommand(): FrozenEpochResetCommand {
  return buildFrozenEpochResetCommandV2({
    tabId: TAB_ID,
    documentId: DOCUMENT_ID,
    expectedUrl: window.location.href,
    operationId: RESET_OPERATION_ID,
    enforcementEpoch: EPOCH_ID,
  });
}

function overlayText(): string {
  const root: ShadowRoot | undefined = (globalThis as { __focusLockShadow?: ShadowRoot })
    .__focusLockShadow;
  if (root === undefined) throw new Error('the blocked page was not rendered');
  return root.textContent ?? '';
}

async function handshake(): Promise<EpochResetOutcomeV2> {
  return sendEpochResetCommand(transport, resetCommand());
}

beforeEach((): void => {
  listeners = [];
  transport = installedContentPort();
  const host: DocumentEnforcementHostV2 = {
    scope: {},
    document,
    window,
    now: (): number => NOW + 25,
    requestVerdict: async (): Promise<unknown> => ({ commands: [] }),
    addMessageListener: (listener: MessageListener): void => {
      listeners.push(listener);
    },
  };
  installDocumentEnforcement(host);
});

afterEach((): void => {
  clearDocumentOverlay();
  document.documentElement.replaceChildren(
    document.createElement('head'),
    document.createElement('body'),
  );
});

describe('worker to content enforcement seam', () => {
  it('round-trips the epoch handshake into an exact reset acknowledgement', async (): Promise<void> => {
    const outcome: EpochResetOutcomeV2 = await handshake();

    expect(outcome.kind).toBe('reset');
    if (outcome.kind !== 'reset') return;
    expect(validateDetachedDocumentEpochResetAck(outcome.ack)).toBe(true);
    expect(outcome.ack.tabId).toBe(TAB_ID);
    expect(outcome.ack.documentId).toBe(DOCUMENT_ID);
    expect(outcome.ack.url).toBe(window.location.href);
    expect(outcome.ack.handledAt).toBe(NOW + 25);
  });

  it('wraps an applied answer and paints the frozen status sentence', async (): Promise<void> => {
    await handshake();
    const command: FrozenDocumentCommand = activeCommand(STARTING_OPERATION_ID, 7);

    const outcome: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
      transport,
      command,
    );

    expect(outcome.kind).toBe('applied');
    if (outcome.kind !== 'applied') return;
    expect(validateDetachedDocumentEnforcementAck(outcome.ack)).toBe(true);
    expect(outcome.ack.tabId).toBe(TAB_ID);
    expect(outcome.ack.url).toBe(command.expectedUrl);
    expect(outcome.ack.operationId).toBe(STARTING_OPERATION_ID);
    expect(outcome.ack.runtimeRevision).toBe(7);
    expect(outcome.ack.verdict).toEqual(BLOCKED_VERDICT);
    expect(overlayText()).toContain(UNTIL_STOPPED_TEXT);
    expect(overlayText()).toContain('Your next step');
    expect(overlayText()).not.toContain('attempts blocked today');
    // A Flexible until-stopped page offers the same immediate End the popup does.
    expect(overlayText()).toContain('End session');
  });

  it('refuses an enforcement command before the epoch handshake', async (): Promise<void> => {
    const outcome: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
      transport,
      activeCommand(STARTING_OPERATION_ID, 7),
    );

    expect(outcome).toEqual({ kind: 'reset-required', currentEpoch: null });
    expect((globalThis as { __focusLockShadow?: ShadowRoot }).__focusLockShadow).toBeUndefined();
  });

  it('answers a lower tuple with stale-command and never wraps it', async (): Promise<void> => {
    await handshake();
    await sendDocumentEnforcementCommand(transport, activeCommand(STARTING_OPERATION_ID, 7));

    const outcome: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
      transport,
      activeCommand(STALE_OPERATION_ID, 6),
    );

    expect(outcome.kind).toBe('stale');
    if (outcome.kind !== 'stale') return;
    expect(outcome.response.disposition).toBe('stale-command');
    expect(outcome.response.requested.runtimeRevision).toBe(6);
    expect(outcome.response.current.runtimeRevision).toBe(7);
    expect(Object.hasOwn(outcome, 'ack')).toBe(false);
    expect(overlayText()).toContain(UNTIL_STOPPED_TEXT);
  });

  it('replays the same frozen command as an idempotent acknowledgement', async (): Promise<void> => {
    await handshake();
    const command: FrozenDocumentCommand = activeCommand(STARTING_OPERATION_ID, 7);
    await sendDocumentEnforcementCommand(transport, command);

    const replay: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
      transport,
      command,
    );

    expect(replay.kind).toBe('applied');
    if (replay.kind !== 'applied') return;
    expect(validateDetachedDocumentEnforcementAck(replay.ack)).toBe(true);
    expect(replay.ack.operationId).toBe(STARTING_OPERATION_ID);
  });
});

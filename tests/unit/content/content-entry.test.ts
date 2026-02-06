/** @vitest-environment jsdom */
/**
 * The content entry's host binding, driven through a chrome fake. The enforcement rules live in
 * `document-enforcement.ts` and are covered beside it: what is proven here is the one decision
 * the binding itself owns, which is whether the message channel stays open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentEnforcementCommand } from '../../../src/shared/enforcement-v2';

type ChromeListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean;

const DOCUMENT_ID: string = 'document-1';
const OPERATION_ID: string = '20000000-0000-4000-8000-000000000001';
const EPOCH_ID: string = '30000000-0000-4000-8000-000000000001';
const SESSION_ID: string = '10000000-0000-4000-8000-000000000001';

let listeners: ChromeListener[] = [];

function resetCommand(): { command: 'reset-enforcement-epoch' } & Record<string, unknown> {
  return {
    version: 1,
    command: 'reset-enforcement-epoch',
    operationId: OPERATION_ID,
    enforcementEpoch: EPOCH_ID,
    documentId: DOCUMENT_ID,
    expectedUrl: window.location.href,
  } as { command: 'reset-enforcement-epoch' } & Record<string, unknown>;
}

function enforcementCommand(): DocumentEnforcementCommand {
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
    expectedUrl: window.location.href,
    presentation: 'clear',
    verdict: { blocked: false, reason: 'no-session', categoryId: null, matchedPattern: null },
    overlay: null,
  } as DocumentEnforcementCommand;
}

/** Delivers one message to the entry's listener and reports what the adapter decided. */
function deliver(message: unknown): { held: boolean; responses: unknown[] } {
  const responses: unknown[] = [];
  let held: boolean = false;
  for (const listener of listeners) {
    held =
      listener(message, {}, (response: unknown): void => {
        responses.push(response);
      }) || held;
  }
  return { held, responses };
}

beforeEach(async (): Promise<void> => {
  listeners = [];
  vi.resetModules();
  delete (globalThis as { __focusLockContentLifecycle?: boolean }).__focusLockContentLifecycle;
  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: {
        addListener: (listener: ChromeListener): void => {
          listeners.push(listener);
        },
        removeListener: (): void => {},
      },
      sendMessage: vi.fn(async (): Promise<unknown> => ({ commands: [] })),
    },
  });
  await import('../../../src/content/index.iife');
});

afterEach((): void => {
  vi.unstubAllGlobals();
});

describe('content entry message channel', (): void => {
  it('holds the channel open for a command it answers', (): void => {
    const reset: { held: boolean; responses: unknown[] } = deliver(resetCommand());

    expect(reset.held).toBe(true);
    expect(reset.responses).toHaveLength(1);

    const apply: { held: boolean; responses: unknown[] } = deliver(enforcementCommand());

    expect(apply.held).toBe(true);
    expect(apply.responses).toHaveLength(1);
  });

  it('releases the channel for a message it never answers', (): void => {
    // A foreign message and a broadcast both leave the listener silent. Holding the channel
    // open for them would hang that sender until this document unloads.
    expect(deliver({ type: 'somethingElse' })).toEqual({ held: false, responses: [] });
    expect(deliver({ type: 'reevaluate' })).toEqual({ held: false, responses: [] });
    expect(deliver(null)).toEqual({ held: false, responses: [] });
  });
});

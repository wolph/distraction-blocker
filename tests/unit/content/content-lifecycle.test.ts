// @vitest-environment jsdom
/**
 * Master's lifecycle case on the v2 entry: a person is already inside the picker when the fresh
 * navigation's own verdict arrives and stops the document. The host, the search text, the caret
 * and the focus all survive the stop.
 */
import { afterEach, expect, it, type Mock, vi } from 'vitest';
import { clearDocumentOverlay } from '../../../src/content/overlay-v2';
import type {
  DocumentEnforcementCommand,
  ResetEnforcementEpochCommand,
} from '../../../src/shared/enforcement-v2';
import { activeView, SESSION_ID, VERDICT } from './overlay-v2-fixtures';

type ChromeListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean;

const EPOCH_ID: string = '30000000-0000-4000-8000-000000000001';

function resetCommand(): ResetEnforcementEpochCommand {
  return {
    version: 1,
    command: 'reset-enforcement-epoch',
    operationId: '20000000-0000-4000-8000-000000000001',
    enforcementEpoch: EPOCH_ID,
    documentId: 'document-1',
    expectedUrl: window.location.href,
  };
}

function applyCommand(operationId: string, runtimeRevision: number): DocumentEnforcementCommand {
  return {
    version: 1,
    command: 'apply-enforcement',
    operationId,
    enforcementEpoch: EPOCH_ID,
    sessionId: SESSION_ID,
    reservedSessionId: null,
    basePolicyRevision: 4,
    runtimeRevision,
    documentId: 'document-1',
    expectedUrl: window.location.href,
    presentation: 'active',
    verdict: VERDICT,
    overlay: activeView({ attemptsToday: runtimeRevision }),
  };
}

afterEach((): void => {
  clearDocumentOverlay();
  Reflect.deleteProperty(globalThis, '__focusLockContentLifecycle');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('keeps an already interactive overlay connected when the initial fresh navigation is stopped', async (): Promise<void> => {
  let resolveInitial: (value: unknown) => void = (): void => {};
  const listeners: ChromeListener[] = [];
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> => {
      if (request.type === 'getBlockState')
        return new Promise<unknown>((resolve: (value: unknown) => void): void => {
          resolveInitial = resolve;
        });
      if (request.type === 'getWorkTarget')
        return { ok: true, sessionId: SESSION_ID, state: 'missing', title: null };
      if (request.type === 'getWorkTabs')
        return { ok: true, tabs: [{ tabId: 7, title: 'Report', hostname: 'work.example' }] };
      if (request.type === 'getWorkTabIcon') return { ok: true, icon: null };
      throw new Error('Unexpected request');
    },
  );
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage,
      onMessage: {
        addListener: (listener: ChromeListener): void => {
          listeners.push(listener);
        },
      },
    },
  });
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
  const stop: ReturnType<typeof vi.spyOn> = vi
    .spyOn(window, 'stop')
    .mockImplementation((): void => {});
  const body: HTMLBodyElement = document.createElement('body');
  body.textContent = 'Blocked page content';
  document.documentElement.append(body);
  await import('../../../src/content/index.iife');
  expect(sendMessage).toHaveBeenCalledWith({
    type: 'getBlockState',
    url: location.href,
    docState: 'fresh',
  });
  const deliver: (message: unknown) => void = (message: unknown): void => {
    for (const listener of listeners) listener(message, {}, (): void => {});
  };
  deliver(resetCommand());
  deliver(applyCommand('20000000-0000-4000-8000-000000000002', 7));
  const root: ShadowRoot = (globalThis as unknown as { __focusLockShadow: ShadowRoot })
    .__focusLockShadow;
  const host: Element = root.host;
  await vi.waitFor((): void =>
    expect((root.querySelector('.return-work') as HTMLButtonElement).disabled).toBe(false),
  );
  (root.querySelector('.return-work') as HTMLButtonElement).click();
  const search: HTMLInputElement = root.querySelector('.work-picker-search') as HTMLInputElement;
  search.value = 'report';
  search.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  search.focus();
  search.setSelectionRange(1, 4);
  const removed: Node[] = [];
  const observer: MutationObserver = new MutationObserver((records: MutationRecord[]): void => {
    for (const record of records) removed.push(...Array.from(record.removedNodes));
  });
  observer.observe(document.documentElement, { childList: true });
  // The navigation's own answer arrives late and newer, so it is applied as a fresh stop.
  resolveInitial({ commands: [applyCommand('20000000-0000-4000-8000-000000000003', 8)] });
  await vi.waitFor((): void => expect(stop).toHaveBeenCalledOnce());
  expect(root.activeElement).toBe(search);
  expect(search.value).toBe('report');
  expect(search.selectionStart).toBe(1);
  expect(search.selectionEnd).toBe(4);
  expect(host.isConnected).toBe(true);
  expect(removed).not.toContain(host);
  expect(body.isConnected).toBe(false);
  expect(root.querySelector('.work-picker')).not.toBeNull();
  observer.disconnect();
});

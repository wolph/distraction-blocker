// @vitest-environment jsdom
import { afterEach, expect, it, type Mock, vi } from 'vitest';
import { hideOverlay } from '../../../src/content/overlay';
import { emptySnapshot } from '../../../src/shared/constants';
import type { Broadcast, ContentCommand } from '../../../src/shared/messages';
import type { SessionSnapshot, Verdict } from '../../../src/shared/types';

afterEach((): void => {
  hideOverlay(emptySnapshot(Date.now()));
  Reflect.deleteProperty(globalThis, '__focusLockContentLifecycle');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps an already interactive overlay connected when the initial fresh navigation is stopped', async (): Promise<void> => {
  const snapshot: SessionSnapshot = { ...emptySnapshot(Date.now()), phase: 'focus', startedAt: 1 };
  const verdict: Verdict = { blocked: true, reason: 'default', matchedPattern: null };
  let resolveInitial: (value: unknown) => void = (): void => {};
  let receive: (message: ContentCommand | Broadcast) => void = (): void => {};
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> => {
      if (request.type === 'getBlockState')
        return new Promise<unknown>((resolve: (value: unknown) => void): void => {
          resolveInitial = resolve;
        });
      if (request.type === 'getWorkTarget')
        return { ok: true, sessionId: 'one', state: 'missing', title: null };
      if (request.type === 'getWorkTabs')
        return { ok: true, tabs: [{ tabId: 7, title: 'Report', hostname: 'work.example' }] };
      throw new Error('Unexpected request');
    },
  );
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage,
      onMessage: {
        addListener: (listener: (message: ContentCommand | Broadcast) => void): void => {
          receive = listener;
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
  receive({ type: 'applyBlock', verdict, snapshot });
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
  resolveInitial({ verdict, snapshot });
  await vi.waitFor((): void => expect(stop).toHaveBeenCalledOnce());
  expect(root.activeElement).toBe(search);
  expect(search.value).toBe('report');
  expect(search.selectionStart).toBe(1);
  expect(search.selectionEnd).toBe(4);
  expect(host.isConnected).toBe(true);
  expect(removed).not.toContain(host);
  expect(body.isConnected).toBe(false);
  expect(root.querySelector('.notloaded')?.hasAttribute('hidden')).toBe(false);
  observer.disconnect();
});

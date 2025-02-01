import type { ContentCommand } from '../shared/messages';
import { sendRequest } from '../shared/messages';
import type { SessionSnapshot, Verdict } from '../shared/types';
import {
  claimContentLifecycle,
  docStateFor,
  installPersistedPageShow,
  recoverRestoredOverlay,
  shouldStop,
} from './gate';
import { hideOverlay, showOverlay } from './overlay';

/** True once this document stopped before loading. A stopped tab keeps
 * opaque presentation for every later overlay update. The worker
 * reloads it on unblock, which resets the flag with a fresh document.
 */
let wasStopped: boolean = false;

function removeStoppedPageContent(): void {
  for (const child of Array.from(document.documentElement.children)) {
    if (child.tagName !== 'HEAD' && child.tagName !== 'FOCUS-LOCK-OVERLAY') child.remove();
  }
}

function markStopped(): void {
  wasStopped = true;
  const head: HTMLHeadElement = document.createElement('head');
  const overlay: Element | null = document.querySelector('focus-lock-overlay');
  document.documentElement.replaceChildren(head, ...(overlay === null ? [] : [overlay]));
  const observer: MutationObserver = new MutationObserver(removeStoppedPageContent);
  observer.observe(document.documentElement, { childList: true });
  document.title = 'Locked - Focus Lock';
}

async function evaluate(docState: 'fresh' | 'loaded'): Promise<void> {
  try {
    const { verdict, snapshot }: { verdict: Verdict; snapshot: SessionSnapshot } =
      await sendRequest({
        type: 'getBlockState',
        url: location.href,
        docState,
      });
    if (verdict.blocked) {
      if (shouldStop(verdict.blocked, docState)) {
        window.stop();
        markStopped();
      }
      showOverlay(verdict, snapshot, wasStopped);
    } else {
      hideOverlay(snapshot);
    }
  } catch {
    // The worker can disappear during shutdown. Fail open until the next push.
  }
}

if (claimContentLifecycle(globalThis as unknown as Record<string, unknown>)) {
  wasStopped = recoverRestoredOverlay(document);
  chrome.runtime.onMessage.addListener((msg: ContentCommand): void => {
    if (msg.type === 'applyBlock') showOverlay(msg.verdict, msg.snapshot, wasStopped);
    else if (msg.type === 'clearBlock') hideOverlay(msg.snapshot);
    else if (msg.type === 'reevaluate') void evaluate('loaded');
  });
  installPersistedPageShow(window, (): void => {
    void evaluate('loaded');
  });
  void evaluate(docStateFor(document.readyState));
}

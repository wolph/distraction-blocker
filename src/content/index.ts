import type { ContentCommand } from '../shared/messages';
import { sendRequest } from '../shared/messages';
import { docStateFor, shouldStop } from './gate';
import { hideOverlay, showOverlay } from './overlay';

/** True once this document was stopped before loading. A stopped tab keeps
 * the opaque presentation for every later overlay update, and the worker
 * reloads it on unblock, which resets this flag with the fresh document. */
let wasStopped: boolean = false;

function markStopped(): void {
  wasStopped = true;
  if (document.head === null) {
    document.documentElement.insertBefore(
      document.createElement('head'),
      document.documentElement.firstChild,
    );
  }
  document.title = 'Locked - Focus Lock';
}

async function evaluate(docState: 'fresh' | 'loaded'): Promise<void> {
  try {
    const { verdict, snapshot } = await sendRequest({
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
    // worker unavailable (shutdown race): fail open, the next push corrects us
  }
}

chrome.runtime.onMessage.addListener((msg: ContentCommand): void => {
  if (msg.type === 'applyBlock') showOverlay(msg.verdict, msg.snapshot, wasStopped);
  else if (msg.type === 'clearBlock') hideOverlay(msg.snapshot);
  else if (msg.type === 'reevaluate') void evaluate('loaded');
});

window.addEventListener('pageshow', (ev: PageTransitionEvent): void => {
  if (ev.persisted) void evaluate('loaded');
});

void evaluate(docStateFor(document.readyState));

import type { ContentCommand } from '../shared/messages';
import { sendRequest } from '../shared/messages';
import { docStateFor, shouldStop } from './gate';
import { hideOverlay, showOverlay } from './overlay';

async function evaluate(docState: 'fresh' | 'loaded'): Promise<void> {
  try {
    const { verdict, snapshot } = await sendRequest({
      type: 'getBlockState',
      url: location.href,
      docState,
    });
    if (verdict.blocked) {
      if (shouldStop(verdict.blocked, docState)) window.stop();
      showOverlay(verdict, snapshot);
    } else {
      hideOverlay(snapshot);
    }
  } catch {
    // worker unavailable (shutdown race): fail open, the next push corrects us
  }
}

chrome.runtime.onMessage.addListener((msg: ContentCommand): void => {
  if (msg.type === 'applyBlock') showOverlay(msg.verdict, msg.snapshot);
  else if (msg.type === 'clearBlock') hideOverlay(msg.snapshot);
  else if (msg.type === 'reevaluate') void evaluate('loaded');
});

window.addEventListener('pageshow', (ev: PageTransitionEvent): void => {
  if (ev.persisted) void evaluate('loaded');
});

void evaluate(docStateFor(document.readyState));

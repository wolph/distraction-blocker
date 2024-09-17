import { emptySnapshot } from '../shared/constants';
import type { Request } from '../shared/messages';

chrome.runtime.onMessage.addListener(
  (
    msg: Request,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (r: unknown) => void,
  ): boolean => {
    if (msg.type === 'getSnapshot') {
      sendResponse(emptySnapshot(Date.now()));
      return false;
    }
    sendResponse({ ok: false, error: `stub router: unhandled ${msg.type}` });
    return false;
  },
);

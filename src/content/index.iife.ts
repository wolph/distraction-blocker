import type { ContentEnforcementResponse } from '../shared/enforcement-v2';
import { sendRequest } from '../shared/messages';
import { installDocumentEnforcement } from './document-enforcement';

/**
 * The content entry is the host binding and nothing else. Every rule about what a document applies,
 * when it stops, and what it answers lives in `installDocumentEnforcement`.
 */
installDocumentEnforcement({
  scope: globalThis as unknown as Record<string, unknown>,
  document,
  window,
  now: Date.now,
  requestVerdict: async (url: string, docState: 'fresh' | 'loaded'): Promise<unknown> =>
    await sendRequest({ type: 'getBlockState', url, docState }),
  addMessageListener: (
    listener: (
      message: unknown,
      respond: (response: ContentEnforcementResponse | undefined) => void,
    ) => void,
  ): void => {
    // The channel is held open only for a message this listener answers, which is every parsed
    // command, a rejected one included. Holding it open for a foreign message would hang that
    // sender until this document unloads, and answering twice would throw.
    chrome.runtime.onMessage.addListener(
      (
        message: unknown,
        _sender: chrome.runtime.MessageSender,
        sendResponse: (response: unknown) => void,
      ): boolean => {
        let answered: boolean = false;
        listener(message, (response: ContentEnforcementResponse | undefined): void => {
          if (answered) return;
          answered = true;
          sendResponse(response);
        });
        return answered;
      },
    );
  },
});

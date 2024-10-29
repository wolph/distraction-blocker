import type { Request } from '../shared/messages';
import type { Verdict } from '../shared/types';
import type { Engine } from './engine';

/**
 * One exhaustive switch from typed requests to engine calls. The never
 * check at the bottom keeps it exhaustive when the message union grows.
 */
export async function routeMessage(
  engine: Engine,
  msg: Request,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  switch (msg.type) {
    case 'getSnapshot':
      return engine.snapshot();
    case 'getBlockState': {
      const verdict: Verdict = engine.verdictFor(msg.url);
      const tabId: number | undefined = sender.tab?.id;
      if (verdict.blocked && tabId !== undefined) {
        await engine.recordAttempt(
          msg.url,
          tabId,
          msg.docState === 'fresh' ? 'navigation' : 'existing',
        );
        if (msg.docState === 'fresh') await engine.markStopped(tabId);
      }
      return { verdict, snapshot: engine.snapshot() };
    }
    case 'startSession':
      return engine.startSession(msg.config);
    case 'openGate':
      return engine.openGate(msg.gate, msg.host);
    case 'confirmGate':
      return engine.confirmGate(msg.typedPhrase);
    case 'abandonGate':
      return engine.abandonGate();
    case 'resumeFromPause':
      return engine.resumeFromPause();
    case 'startNextFocusEarly':
      return engine.startNextFocusEarly();
    case 'updateSettings':
      return engine.updateSettings(msg.settings);
    case 'updateLists':
      return engine.updateLists(msg.lists);
    case 'getSettings':
      return engine.getSettings();
    case 'getLists':
      return engine.getLists();
    case 'getStats':
      // wired in task 8
      return { ok: false, error: 'stats wiring lands in task 8' };
    case 'exportEvents':
      // wired in task 8
      return { ok: false, error: 'stats wiring lands in task 8' };
    case 'previewSound':
      // wired in task 7
      return { ok: false, error: 'sound wiring lands in task 7' };
    default: {
      const exhaustive: never = msg;
      return { ok: false, error: `unhandled message ${JSON.stringify(exhaustive)}` };
    }
  }
}

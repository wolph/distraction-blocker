import type { Request } from '../shared/messages';
import type { SoundSettings, Verdict } from '../shared/types';
import { playSound } from './audio';
import type { Engine } from './engine';
import type { PolicyStorage } from './policy-storage';
import { fetchStats } from './stats-service';
import { readEvents } from './stores';

/**
 * One exhaustive switch from typed requests to engine calls. The never
 * check at the bottom keeps it exhaustive when the message union grows.
 */
export async function routeMessage(
  engine: Engine,
  msg: Request,
  sender: chrome.runtime.MessageSender,
  policyStorage?: Pick<PolicyStorage, 'withAggregateStorage'>,
): Promise<unknown> {
  switch (msg.type) {
    case 'getSnapshot':
      return engine.snapshotPersisted();
    case 'getBlockState': {
      const verdict: Verdict = engine.verdictFor(msg.url);
      const tabId: number | undefined = sender.tab?.id;
      const senderOwnsUrl: boolean = sender.url === msg.url && sender.tab?.url === msg.url;
      if (verdict.blocked && tabId !== undefined && senderOwnsUrl) {
        await engine.recordAttempt(
          msg.url,
          tabId,
          msg.docState === 'fresh' ? 'navigation' : 'existing',
        );
        if (msg.docState === 'fresh' && sender.documentId !== undefined) {
          await engine.markStopped(tabId, msg.url, sender.documentId);
        }
      }
      return { verdict, snapshot: await engine.snapshotPersisted() };
    }
    case 'startSession':
      return engine.startSession(msg.config);
    case 'openGate':
      return engine.openGate(msg.gate, msg.host);
    case 'confirmGate':
      return engine.confirmGate(msg.typedPhrase);
    case 'requestSessionEnd':
      return engine.requestSessionEnd();
    case 'forceEndGate':
      return {
        ok: false,
        error: 'Force end is no longer available. Choose a Flexible session before starting.',
      };
    case 'abandonGate':
      return engine.abandonGate();
    case 'resumeFromPause':
      return engine.resumeFromPause();
    case 'startNextFocusEarly':
      return engine.startNextFocusEarly();
    case 'updateSettings':
      return engine.updateSettings(msg.settings);
    case 'updateTheme':
      return engine.updateTheme(msg.theme);
    case 'updateLists':
      return engine.updateLists(msg.lists);
    case 'getSettings':
      return engine.getSettings();
    case 'getLists':
      return engine.getLists();
    case 'getStats':
      return policyStorage === undefined
        ? fetchStats(msg.days, Date.now(), engine.statsOverlay())
        : policyStorage.withAggregateStorage((storage) =>
            fetchStats(msg.days, Date.now(), engine.statsOverlay(), storage),
          );
    case 'exportEvents':
      return { json: JSON.stringify(await readEvents(), null, 2) };
    case 'previewSound': {
      // Previews ignore the per-event toggle: the options page needs to
      // demo a sound the user is about to enable.
      const sounds: SoundSettings = engine.getSettings().sounds;
      await playSound(msg.sound, { ...sounds, [msg.sound]: true });
      return { ok: true };
    }
    default: {
      const exhaustive: never = msg;
      return { ok: false, error: `unhandled message ${JSON.stringify(exhaustive)}` };
    }
  }
}

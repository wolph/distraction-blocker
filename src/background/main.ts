import type { Request } from '../shared/messages';
import type { SessionSnapshot } from '../shared/types';
import { notify, playSound } from './audio';
import { Engine, type EnginePorts } from './engine';
import { updateIcon } from './icon';
import { routeMessage } from './router';
import {
  appendEvents,
  getDeviceId,
  loadBank,
  loadLists,
  loadRuntime,
  loadSettings,
  loadStreak,
  saveRuntime,
} from './stores';
import { SyncWriter } from './sync-writer';
import { applyBlockingFactory, injectIntoExistingTabs, registerTabListeners } from './tabs';

const SYNC_FLUSH_MS: number = 10_000;
const TICK_ALARM: string = 'tick';
const PHASE_ALARM: string = 'phase';

let engineInstance: Engine | null = null;

function currentEngine(): Engine {
  if (engineInstance === null) throw new Error('engine used before boot finished');
  return engineInstance;
}

async function boot(): Promise<Engine> {
  const now: number = Date.now();
  const [settings, lists, bank, streak, runtime, deviceId] = await Promise.all([
    loadSettings(),
    loadLists(),
    loadBank(),
    loadStreak(),
    loadRuntime(now),
    getDeviceId(),
  ]);
  const syncWriter: SyncWriter = new SyncWriter(
    SYNC_FLUSH_MS,
    async (items: Record<string, unknown>): Promise<void> => {
      await chrome.storage.sync.set(items);
    },
  );
  const ports: EnginePorts = {
    now: (): number => Date.now(),
    saveRuntime,
    queueSync: (key: string, value: unknown): void => syncWriter.queue(key, value),
    appendEvents,
    broadcast: (snapshot: SessionSnapshot): void => {
      // Rejects when no extension page is open to hear it, which is fine.
      chrome.runtime.sendMessage({ type: 'stateChanged', snapshot }).catch((): undefined => {
        return undefined;
      });
    },
    applyBlocking: applyBlockingFactory(currentEngine),
    playSound: (sound): void => {
      void playSound(sound, currentEngine().getSettings().sounds);
    },
    notify,
    updateIcon: (snapshot: SessionSnapshot): void => {
      updateIcon(snapshot, currentEngine().getSettings().badgeCountdown);
    },
    scheduleWake: (atMs: number | null): void => {
      if (atMs === null) void chrome.alarms.clear(PHASE_ALARM);
      else void chrome.alarms.create(PHASE_ALARM, { when: atMs });
    },
  };
  const engine: Engine = new Engine(ports, settings, lists, bank, streak, runtime, deviceId);
  engineInstance = engine;
  return engine;
}

/**
 * Worker entry. Listener registration happens synchronously at the top
 * level (MV3 requirement), state loading hides behind the ready promise
 * every listener awaits.
 */
export function main(): void {
  const ready: Promise<Engine> = boot();

  chrome.runtime.onMessage.addListener(
    (
      msg: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response: unknown) => void,
    ): boolean => {
      ready
        .then((engine: Engine): Promise<unknown> => routeMessage(engine, msg as Request, sender))
        .then((response: unknown): void => sendResponse(response))
        .catch((err: unknown): void => sendResponse({ ok: false, error: String(err) }));
      return true;
    },
  );

  chrome.alarms.onAlarm.addListener((): void => {
    void ready.then((engine: Engine): Promise<void> => engine.tick());
  });

  registerTabListeners((): Promise<Engine> => ready);

  chrome.runtime.onInstalled.addListener((): void => {
    void chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
    void injectIntoExistingTabs();
  });

  chrome.tabs.onRemoved.addListener((tabId: number): void => {
    void ready.then((engine: Engine): Promise<void> => engine.dropTab(tabId));
  });

  // Reloads of an already-installed extension skip onInstalled, and
  // alarm creation is idempotent, so ensure the tick exists every boot.
  void chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
}

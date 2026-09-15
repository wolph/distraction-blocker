/**
 * The only file that knows the product expects `chrome.*`. The popup gets the handful of calls it
 * makes, answered from the engine and the tab strip. Tab iframes get the bridge object and build
 * their own shim in their own realm, because the lockscreen renders into the realm's `document`.
 */
import type { Broadcast, Request } from '../../src/shared/messages';
import { DEMO_BRIDGE_KEY, type DemoBridge } from './demo-protocol';
import type { DemoEngine } from './engine';
import { activeTab, DEMO_WINDOW_ID } from './tabs-model';

type MessageListener = (
  message: unknown,
  sender: unknown,
  respond: (value: unknown) => void,
) => boolean | undefined;

function listenerSet<T>(): { add(listener: T): void; remove(listener: T): void; all(): T[] } {
  const listeners: Set<T> = new Set<T>();
  return {
    add: (listener: T): void => {
      listeners.add(listener);
    },
    remove: (listener: T): void => {
      listeners.delete(listener);
    },
    all: (): T[] => [...listeners],
  };
}

export function installPopupChrome(engine: DemoEngine, realm: Window): void {
  const messageListeners = listenerSet<MessageListener>();
  engine.onBroadcast((message: Broadcast): void => {
    for (const listener of messageListeners.all()) listener(message, {}, (): void => undefined);
  });
  const tabs = {
    query: async (): Promise<chrome.tabs.Tab[]> => {
      const tab = activeTab(engine.strip());
      return [
        {
          id: tab.tabId,
          windowId: DEMO_WINDOW_ID,
          url: tab.url,
          title: tab.title,
          active: true,
          index: 0,
          highlighted: true,
          pinned: false,
          incognito: false,
          selected: true,
          discarded: false,
          autoDiscardable: true,
          groupId: -1,
          frozen: false,
          lastAccessed: Date.now(),
        } satisfies chrome.tabs.Tab,
      ];
    },
  };
  const shim = {
    runtime: {
      sendMessage: async (request: unknown): Promise<unknown> =>
        engine.handle(request as Extract<Request, { type: Request['type'] }>),
      onMessage: { addListener: messageListeners.add, removeListener: messageListeners.remove },
      openOptionsPage: async (): Promise<void> => {
        realm.alert('The options page is not part of this demo.');
      },
    },
    tabs,
    windows: { getCurrent: async (): Promise<{ id: number }> => ({ id: DEMO_WINDOW_ID }) },
    storage: {
      onChanged: { addListener: (): void => undefined, removeListener: (): void => undefined },
    },
  };
  (realm as unknown as { chrome: unknown }).chrome = shim;
}

export function publishBridge(engine: DemoEngine, realm: Window, clockSpeed: number): void {
  const bridge: DemoBridge = {
    handle: (request: Request): Promise<unknown> =>
      engine.handle(request as Extract<Request, { type: Request['type'] }>),
    subscribe: (_tabId: number, listener: (message: Broadcast) => void): (() => void) =>
      engine.onBroadcast(listener),
    clockSpeed,
  };
  (realm as unknown as Record<string, unknown>)[DEMO_BRIDGE_KEY] = bridge;
}

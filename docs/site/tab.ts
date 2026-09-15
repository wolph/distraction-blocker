/**
 * Runs inside one fake tab. It reads its tab from the query string, asks the parent page for the
 * bridge, installs the `chrome.*` calls the lockscreen makes, and starts the real content loop with
 * a window facade whose location is the tab's fictional URL. Everything the overlay renders is the
 * product's own code rendering into this document.
 */
import { installDocumentEnforcement } from '../../src/content/document-enforcement';
import type { ContentEnforcementResponse } from '../../src/shared/enforcement-v2';
import type { Broadcast } from '../../src/shared/messages';
import { installDemoClock } from './clock';
import { DEMO_BRIDGE_KEY, type DemoBridge, TAB_ID_PARAM } from './demo-protocol';
import { DEMO_TABS, type DemoTab } from './tabs-model';

function bridgeFromParent(): DemoBridge {
  const bridge: unknown = (window.parent as unknown as Record<string, unknown>)[DEMO_BRIDGE_KEY];
  if (typeof bridge !== 'object' || bridge === null)
    throw new Error('the demo bridge is not published');
  return bridge as DemoBridge;
}

function currentTab(): DemoTab {
  const id: number = Number(new URLSearchParams(window.location.search).get(TAB_ID_PARAM));
  const tab: DemoTab | undefined = DEMO_TABS.find(
    (candidate: DemoTab): boolean => candidate.tabId === id,
  );
  if (tab === undefined) throw new Error(`unknown demo tab ${String(id)}`);
  return tab;
}

function renderPage(tab: DemoTab): void {
  const main: HTMLElement | null = document.getElementById('tab-content');
  if (main === null) return;
  document.title = tab.title;
  main.innerHTML = '';
  const heading: HTMLHeadingElement = document.createElement('h1');
  heading.textContent = tab.title;
  main.append(heading);
  if (tab.kind === 'work') {
    const label: HTMLLabelElement = document.createElement('label');
    label.textContent = 'Your draft';
    const area: HTMLTextAreaElement = document.createElement('textarea');
    area.id = 'draft';
    area.rows = 12;
    area.placeholder = 'Type here. Your text stays when you come back.';
    label.append(area);
    main.append(label);
    return;
  }
  for (let index: number = 0; index < 6; index += 1) {
    const card: HTMLElement = document.createElement('article');
    const title: HTMLHeadingElement = document.createElement('h2');
    title.textContent =
      tab.kind === 'distraction' && tab.title === 'Videos'
        ? `Video ${String(index + 1)}`
        : `Story ${String(index + 1)}`;
    const body: HTMLParagraphElement = document.createElement('p');
    body.textContent = 'Spam, spam, spam, eggs and spam.';
    card.append(title, body);
    main.append(card);
  }
}

/** The product reads `location.href` and calls `stop()`. Everything else is the real window. */
function windowFacade(url: string): Window {
  return new Proxy(window, {
    get(target: Window, property: string | symbol): unknown {
      if (property === 'location') return { href: url };
      if (property === 'stop') return (): void => undefined;
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

const tab: DemoTab = currentTab();
const bridge: DemoBridge = bridgeFromParent();
installDemoClock(window, bridge.clockSpeed);
renderPage(tab);

const listeners: Set<
  (message: unknown, sender: unknown, respond: (value: unknown) => void) => boolean | undefined
> = new Set();
bridge.subscribe(tab.tabId, (message: Broadcast): void => {
  for (const listener of listeners) listener(message, {}, (): void => undefined);
});
(window as unknown as { chrome: unknown }).chrome = {
  runtime: {
    sendMessage: (request: unknown): Promise<unknown> =>
      bridge.handle(request as Parameters<DemoBridge['handle']>[0]),
    onMessage: {
      addListener: (
        listener: (
          message: unknown,
          sender: unknown,
          respond: (value: unknown) => void,
        ) => boolean | undefined,
      ): void => {
        listeners.add(listener);
      },
      removeListener: (
        listener: (
          message: unknown,
          sender: unknown,
          respond: (value: unknown) => void,
        ) => boolean | undefined,
      ): void => {
        listeners.delete(listener);
      },
    },
  },
};

installDocumentEnforcement({
  scope: globalThis as unknown as Record<string, unknown>,
  document,
  window: windowFacade(tab.url),
  now: Date.now,
  // `bridge.handle` runs in the parent page's realm (it closes over the engine defined there), so
  // its resolved commands are plain objects built from the parent's own Object and Array. The
  // enforcement loop's parser checks a value's prototype against this realm's Object.prototype and
  // silently rejects anything else, exactly as it must reject a message a hostile page forged with
  // a foreign prototype. `structuredClone`, called here in the tab's own realm, rebuilds the value
  // with this realm's own constructors, the same normalisation `chrome.runtime.sendMessage` gives
  // the real extension for free by serialising across the process boundary.
  requestVerdict: async (url: string, docState: 'fresh' | 'loaded'): Promise<unknown> =>
    structuredClone(await bridge.handle({ type: 'getBlockState', url, docState })),
  addMessageListener: (
    listener: (
      message: unknown,
      respond: (response: ContentEnforcementResponse | undefined) => void,
    ) => void,
  ): void => {
    listeners.add(
      (message: unknown, _sender: unknown, respond: (value: unknown) => void): boolean => {
        listener(message, (response: ContentEnforcementResponse | undefined): void =>
          respond(response),
        );
        return true;
      },
    );
  },
});

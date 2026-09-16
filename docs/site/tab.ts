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
import './tab.css';

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

function el<K extends keyof HTMLElementTagNameMap>(
  name: K,
  className: string,
  text: string = '',
): HTMLElementTagNameMap[K] {
  const node: HTMLElementTagNameMap[K] = document.createElement(name);
  if (className !== '') node.className = className;
  if (text !== '') node.textContent = text;
  return node;
}

function siteHeader(wordmark: string, links: readonly string[]): HTMLElement {
  const header: HTMLElement = el('header', 'site-header');
  header.append(el('div', 'wordmark', wordmark));
  const nav: HTMLElement = el('nav', '');
  for (const link of links) nav.append(el('span', '', link));
  header.append(nav, el('div', 'search', 'Search'));
  return header;
}

function renderWorkPage(main: HTMLElement): void {
  main.append(siteHeader('Docs', ['Home', 'Shared', 'Recent']));
  const editor: HTMLElement = el('section', 'editor');
  const toolbar: HTMLElement = el('div', 'editor-toolbar');
  toolbar.append(
    el('span', 'bold', 'B'),
    el('span', 'italic', 'I'),
    el('span', '', 'U'),
    el('span', '', 'H1'),
    el('span', '', 'H2'),
    el('span', '', 'List'),
    el('span', '', 'Link'),
  );
  const page: HTMLElement = el('div', 'editor-page');
  page.append(
    el('h1', '', 'Proposal draft'),
    el('p', 'doc-meta', 'Last edited a minute ago. Only you.'),
  );
  const area: HTMLTextAreaElement = document.createElement('textarea');
  area.id = 'draft';
  area.setAttribute('aria-label', 'Your draft');
  area.placeholder = 'Type here. Your text stays when you come back.';
  page.append(area);
  editor.append(toolbar, page);
  main.append(editor);
}

const HEADLINES: readonly string[] = [
  'Council approves new cycle lanes after a year of debate',
  'Local bakery wins national prize for its sourdough',
  'Weekend weather: sun returns after a wet week',
  'Startup raises funding to build quieter electric scooters',
  'Museum extends opening hours for the summer exhibition',
];

function renderHeadlinesPage(main: HTMLElement): void {
  main.append(
    siteHeader('The Daily Headline', ['World', 'Politics', 'Business', 'Culture', 'Sport']),
  );
  const news: HTMLElement = el('section', 'news');
  const lead: HTMLElement = el('article', 'lead');
  const copy: HTMLElement = el('div', 'copy');
  copy.append(
    el('div', 'kicker', 'Breaking'),
    el('h2', '', 'Everything happened today and you should read all of it right now'),
    el(
      'p',
      '',
      'A rolling account of the day so far, updated every few minutes with the latest developments.',
    ),
  );
  lead.append(el('div', 'picture'), copy);
  const stories: HTMLElement = el('div', 'stories');
  HEADLINES.forEach((title: string, index: number): void => {
    const story: HTMLElement = el('article', 'story');
    const text: HTMLElement = el('div', '');
    text.append(el('h3', '', title), el('time', '', `${String(index * 12 + 5)} minutes ago`));
    story.append(el('div', 'picture'), text);
    stories.append(story);
  });
  news.append(lead, stories);
  main.append(news);
}

const VIDEOS: readonly { title: string; channel: string; duration: string }[] = [
  {
    title: 'I tried every productivity app so you do not have to',
    channel: 'Desk Notes',
    duration: '12:41',
  },
  { title: 'Relaxing rain sounds for 10 hours', channel: 'Calm Rooms', duration: '10:00:00' },
  { title: 'Cat discovers the printer', channel: 'Whiskers Daily', duration: '0:48' },
  { title: 'Ranking every office chair I have owned', channel: 'Desk Notes', duration: '18:03' },
  { title: 'The history of the paperclip, explained', channel: 'Small Things', duration: '9:27' },
  { title: 'One pan dinner in twenty minutes', channel: 'Weeknight Kitchen', duration: '7:15' },
];

function renderVideosPage(main: HTMLElement): void {
  main.append(siteHeader('Streamly', ['Home', 'Trending', 'Subscriptions', 'Library']));
  const grid: HTMLElement = el('section', 'videos');
  for (const video of VIDEOS) {
    const card: HTMLElement = el('article', 'video');
    const thumb: HTMLElement = el('div', 'thumb');
    thumb.append(el('span', 'duration', video.duration));
    const copy: HTMLElement = el('div', 'copy');
    copy.append(el('h3', '', video.title), el('p', '', `${video.channel} - 1.2M views`));
    card.append(thumb, copy);
    grid.append(card);
  }
  main.append(grid);
}

function renderPage(tab: DemoTab): void {
  const main: HTMLElement | null = document.getElementById('tab-content');
  if (main === null) return;
  document.title = tab.title;
  main.innerHTML = '';
  if (tab.kind === 'work') {
    renderWorkPage(main);
    return;
  }
  if (tab.title === 'Videos') renderVideosPage(main);
  else renderHeadlinesPage(main);
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
// Shares the parent page's clock base so this tab's countdown reads the same demo time as the
// popup instead of starting a fraction of a real second behind it.
installDemoClock(window, bridge.clockSpeed, bridge.clockBase);
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

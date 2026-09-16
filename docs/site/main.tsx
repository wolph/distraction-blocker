import { render } from 'preact';
import { App } from '../../src/popup/App';
import '../../src/shared/theme-control.css';
import '../../src/popup/popup.css';
// Imported after popup.css so its rules land later in the bundled stylesheet and win the cascade
// tie on shared selectors such as `html`, which is how site.css's own html reset (below) overrides
// popup.css's `html { scrollbar-width: none; block-size: 100% }` instead of losing to it.
import './site.css';
import { installPopupChrome, publishBridge } from './bridge';
import { type BrowserView, createBrowserView } from './browser-view';
import { type DemoClock, installDemoClock } from './clock';
import { DEMO_CLOCK_SPEED, TAB_ID_PARAM } from './demo-protocol';
import { createDemoEngine, type DemoEngine, type DemoEvent } from './engine';
import { createGuide, type Guide } from './guide';
import type { DemoTab } from './tabs-model';

function required<T extends HTMLElement>(id: string): T {
  const element: HTMLElement | null = document.getElementById(id);
  if (element === null) throw new Error(`missing #${id}`);
  return element as T;
}

const clock: DemoClock = installDemoClock(window, DEMO_CLOCK_SPEED);
const engine: DemoEngine = createDemoEngine(Date.now);
installPopupChrome(engine, window);
publishBridge(engine, window, DEMO_CLOCK_SPEED, clock.base);

const panel: HTMLElement = required('popup-panel');
const popupRoot: HTMLElement = required('popup');
let mounted: boolean = false;
const togglePopup = (): void => {
  panel.hidden = !panel.hidden;
  if (!panel.hidden && !mounted) {
    mounted = true;
    render(<App />, popupRoot);
  }
};

const browser: BrowserView = createBrowserView(
  engine,
  (tab: DemoTab): string => `./tab.html?${TAB_ID_PARAM}=${String(tab.tabId)}`,
  togglePopup,
);
browser.mount(required('browser'));
// The demo opens on a distracting site with no session running. Locking is the visitor's own
// first move, and the page they are on is what locks.
engine.activate(12);
browser.render();

const guide: Guide = createGuide(required<HTMLOListElement>('guide'));
engine.onEvent((event: DemoEvent): void => {
  guide.advance(event);
  if (event.type === 'returnedToWork') panel.hidden = true;
});
window.setInterval((): void => engine.tick(), 250);

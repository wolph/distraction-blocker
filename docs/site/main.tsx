import { render } from 'preact';
import { App } from '../../src/popup/App';
import '../../src/shared/theme-control.css';
import '../../src/popup/popup.css';
import { installPopupChrome, publishBridge } from './bridge';
import { createBrowserView } from './browser-view';
import { installDemoClock } from './clock';
import { DEMO_CLOCK_SPEED, TAB_ID_PARAM } from './demo-protocol';
import { createDemoEngine, type DemoEvent } from './engine';
import { createGuide } from './guide';
import type { DemoTab } from './tabs-model';

function required<T extends HTMLElement>(id: string): T {
  const element: HTMLElement | null = document.getElementById(id);
  if (element === null) throw new Error(`missing #${id}`);
  return element as T;
}

installDemoClock(window, DEMO_CLOCK_SPEED);
const engine = createDemoEngine(Date.now);
installPopupChrome(engine, window);
publishBridge(engine, window, DEMO_CLOCK_SPEED);

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

const browser = createBrowserView(
  engine,
  (tab: DemoTab): string => `./tab.html?${TAB_ID_PARAM}=${String(tab.tabId)}`,
  togglePopup,
);
browser.mount(required('browser'));

const guide = createGuide(required<HTMLOListElement>('guide'));
engine.onEvent((event: DemoEvent): void => {
  guide.advance(event);
  if (event.type === 'returnedToWork') panel.hidden = true;
});
window.setInterval((): void => engine.tick(), 250);

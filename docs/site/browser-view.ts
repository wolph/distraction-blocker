/** The pretend browser: a tab strip, a toolbar with the Focus Lock icon, one iframe per tab. */
import type { Broadcast } from '../../src/shared/messages';
import { isLocked, renderBrandIcon } from './brand-icon';
import type { DemoEngine } from './engine';
import type { DemoTab, TabStrip } from './tabs-model';

export interface BrowserView {
  mount(root: HTMLElement): void;
  render(): void;
  activeFrame(): HTMLIFrameElement;
}

export function createBrowserView(
  engine: DemoEngine,
  tabUrl: (tab: DemoTab) => string,
  onPopupToggle: () => void,
): BrowserView {
  const frames: Map<number, HTMLIFrameElement> = new Map<number, HTMLIFrameElement>();
  // One button per tab, created once in mount() and never replaced. The demo clock ticks every
  // 250ms, and every tick that changes engine state re-runs render() through onBroadcast: rebuilding
  // the strip on each render (the previous approach) replaced the node under a visitor's pointer
  // mid-click and dropped a human-speed tab click a few times in ten. Toggling classes and
  // attributes on the same long-lived elements keeps the click target stable and keeps keyboard
  // focus on whichever button already had it.
  const buttons: Map<number, HTMLButtonElement> = new Map<number, HTMLButtonElement>();
  let strip: HTMLElement = document.createElement('div');
  let viewport: HTMLElement = document.createElement('div');

  const render: () => void = (): void => {
    const model: TabStrip = engine.strip();
    for (const [tabId, button] of buttons) {
      const active: boolean = tabId === model.activeTabId;
      button.classList.toggle('tab-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    for (const [tabId, frame] of frames) frame.hidden = tabId !== model.activeTabId;
  };

  return {
    mount: (root: HTMLElement): void => {
      root.innerHTML = '';
      strip = document.createElement('div');
      strip.className = 'tab-strip';
      strip.setAttribute('role', 'tablist');
      buttons.clear();
      for (const tab of engine.strip().tabs) {
        const button: HTMLButtonElement = document.createElement('button');
        button.type = 'button';
        button.className = 'tab';
        button.textContent = tab.title;
        button.setAttribute('aria-pressed', 'false');
        button.dataset.tabId = String(tab.tabId);
        button.addEventListener('click', (): void => {
          engine.activate(tab.tabId);
          render();
        });
        buttons.set(tab.tabId, button);
        strip.append(button);
      }
      const toolbar: HTMLElement = document.createElement('div');
      toolbar.className = 'toolbar';
      const address: HTMLElement = document.createElement('div');
      address.className = 'address';
      const icon: HTMLButtonElement = document.createElement('button');
      icon.type = 'button';
      icon.className = 'extension-icon';
      icon.setAttribute('aria-label', 'Open Focus Lock');
      const setLocked: (locked: boolean) => void = (locked: boolean): void => {
        icon.replaceChildren(renderBrandIcon(locked));
        icon.dataset.locked = locked ? 'true' : 'false';
        icon.title = locked ? 'Focus Lock: sites are locked' : 'Focus Lock: no session running';
      };
      setLocked(false);
      icon.addEventListener('click', onPopupToggle);
      toolbar.append(address, icon);
      viewport = document.createElement('div');
      viewport.className = 'viewport';
      for (const tab of engine.strip().tabs) {
        const frame: HTMLIFrameElement = document.createElement('iframe');
        frame.src = tabUrl(tab);
        frame.title = tab.title;
        frame.dataset.tabId = String(tab.tabId);
        frames.set(tab.tabId, frame);
        viewport.append(frame);
      }
      root.append(strip, toolbar, viewport);
      engine.onBroadcast((message: Broadcast): void => {
        if (message.type === 'stateChanged') setLocked(isLocked(message.snapshot));
        const active: DemoTab | undefined = engine
          .strip()
          .tabs.find((tab: DemoTab): boolean => tab.tabId === engine.strip().activeTabId);
        address.textContent = active?.url ?? '';
        render();
      });
      render();
      address.textContent = engine.strip().tabs[0]?.url ?? '';
    },
    render,
    activeFrame: (): HTMLIFrameElement => {
      const frame: HTMLIFrameElement | undefined = frames.get(engine.strip().activeTabId);
      if (frame === undefined) throw new Error('no frame for the active tab');
      return frame;
    },
  };
}

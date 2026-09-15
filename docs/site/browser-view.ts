/** The pretend browser: a tab strip, a toolbar with the Focus Lock icon, one iframe per tab. */
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
  let strip: HTMLElement = document.createElement('div');
  let viewport: HTMLElement = document.createElement('div');

  const render = (): void => {
    const model: TabStrip = engine.strip();
    strip.innerHTML = '';
    for (const tab of model.tabs) {
      const button: HTMLButtonElement = document.createElement('button');
      button.type = 'button';
      button.className = tab.tabId === model.activeTabId ? 'tab tab-active' : 'tab';
      button.textContent = tab.title;
      button.setAttribute('aria-pressed', tab.tabId === model.activeTabId ? 'true' : 'false');
      button.dataset.tabId = String(tab.tabId);
      button.addEventListener('click', (): void => {
        engine.activate(tab.tabId);
        render();
      });
      strip.append(button);
    }
    for (const [tabId, frame] of frames) frame.hidden = tabId !== model.activeTabId;
  };

  return {
    mount: (root: HTMLElement): void => {
      root.innerHTML = '';
      strip = document.createElement('div');
      strip.className = 'tab-strip';
      strip.setAttribute('role', 'tablist');
      const toolbar: HTMLElement = document.createElement('div');
      toolbar.className = 'toolbar';
      const address: HTMLElement = document.createElement('div');
      address.className = 'address';
      const icon: HTMLButtonElement = document.createElement('button');
      icon.type = 'button';
      icon.className = 'extension-icon';
      icon.setAttribute('aria-label', 'Open Focus Lock');
      icon.textContent = 'FL';
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
      engine.onBroadcast((): void => {
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

import type { ContentCommand } from '../shared/messages';
import type { SessionSnapshot, Verdict } from '../shared/types';
import type { Engine } from './engine';

export interface TabState {
  /** the tab's current mute state */
  muted: boolean;
  /** the worker muted this tab and recorded its prior state */
  wasMutedByUs: boolean;
  /** the recorded mute state to restore on unblock */
  priorMuted: boolean;
  /** the tab was window.stop()ed before loading, reload on unblock */
  wasStopped: boolean;
}

export interface TabAction {
  command: 'applyBlock' | 'clearBlock';
  /** mute state to set, null for no change */
  mute: boolean | null;
  reload: boolean;
}

/** Pure per-tab decision: what to send and which side effects to run. */
export function planTabAction(verdict: Verdict, tabState: TabState): TabAction {
  if (verdict.blocked) {
    return {
      command: 'applyBlock',
      mute: tabState.wasMutedByUs && tabState.muted ? null : true,
      reload: false,
    };
  }
  return {
    command: 'clearBlock',
    mute: tabState.wasMutedByUs ? tabState.priorMuted : null,
    reload: tabState.wasStopped,
  };
}

export async function applyToTab(
  engine: Engine,
  tabId: number,
  url: string,
  mutedNow: boolean,
  attemptKind: 'navigation' | 'existing' = 'existing',
): Promise<void> {
  const verdict: Verdict = engine.verdictFor(url);
  if (verdict.blocked) await engine.recordAttempt(url, tabId, attemptKind);
  const snapshot: SessionSnapshot = engine.snapshot();
  const facts: { wasMutedByUs: boolean; priorMuted: boolean; wasStopped: boolean } =
    engine.tabFacts(tabId);
  const action: TabAction = planTabAction(verdict, { muted: mutedNow, ...facts });
  const command: ContentCommand =
    action.command === 'applyBlock'
      ? { type: 'applyBlock', verdict, snapshot }
      : { type: 'clearBlock', snapshot };
  try {
    await chrome.tabs.sendMessage(tabId, command);
  } catch {
    // tabs without the content script (chrome://, the web store) reject, fine
  }
  if (action.mute !== null) {
    try {
      await chrome.tabs.update(tabId, { muted: action.mute });
      if (action.command === 'applyBlock') {
        if (!facts.wasMutedByUs) engine.noteMuted(tabId, mutedNow);
      } else {
        engine.noteMuteRestored(tabId);
      }
    } catch {
      // the tab may be gone already
    }
  }
  if (action.reload) {
    try {
      await chrome.tabs.reload(tabId);
      engine.noteReloaded(tabId);
    } catch {
      // the tab may be gone already
    }
  }
}

/**
 * Builds EnginePorts.applyBlocking: sweep every tab, block or clear.
 * Reentrancy-guarded because a sweep can advance the engine, whose
 * commit would start a second sweep.
 */
export function applyBlockingFactory(engine: () => Engine): () => Promise<void> {
  let running = false;
  return async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const e: Engine = engine();
      const tabs: chrome.tabs.Tab[] = await chrome.tabs.query({});
      const liveTabIds: Set<number> = new Set(
        tabs.flatMap((tab: chrome.tabs.Tab): number[] => (tab.id === undefined ? [] : [tab.id])),
      );
      e.reconcileTabs(liveTabIds);
      for (const tab of tabs) {
        if (tab.id === undefined || tab.url === undefined || tab.url === '') continue;
        await applyToTab(e, tab.id, tab.url, tab.mutedInfo?.muted ?? false);
      }
      await e.flushRuntime();
    } finally {
      running = false;
    }
  };
}

/**
 * SPA and normal navigation: push a fresh verdict to just that tab.
 * Catches YouTube-style pushState navigation that never reloads.
 */
export function registerTabListeners(ready: () => Promise<Engine>): void {
  const onNav = (
    details: { tabId: number; url: string; frameId: number },
    attemptKind: 'navigation' | 'existing',
  ): void => {
    if (details.frameId !== 0) return;
    void ready().then(async (engine: Engine): Promise<void> => {
      const tab: chrome.tabs.Tab | null = await chrome.tabs
        .get(details.tabId)
        .catch((): null => null);
      if (tab === null) return;
      await applyToTab(
        engine,
        details.tabId,
        details.url,
        tab.mutedInfo?.muted ?? false,
        attemptKind,
      );
      await engine.flushRuntime();
    });
  };
  chrome.webNavigation.onCommitted.addListener((details): void => onNav(details, 'navigation'));
  chrome.webNavigation.onHistoryStateUpdated.addListener((details): void =>
    onNav(details, 'existing'),
  );
}

/** onInstalled: content scripts only auto-attach to new loads, inject into what is open. */
export async function injectIntoExistingTabs(): Promise<void> {
  const manifest: chrome.runtime.Manifest = chrome.runtime.getManifest();
  const file: string | undefined = manifest.content_scripts?.[0]?.js?.[0];
  if (file === undefined) return;
  const tabs: chrome.tabs.Tab[] = await chrome.tabs.query({
    url: ['http://*/*', 'https://*/*'],
  });
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [file] });
    } catch {
      // pages that refuse injection (web store, pdf viewer) are fine
    }
  }
}

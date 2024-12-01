import type { ContentCommand } from '../shared/messages';
import type { SessionSnapshot, Verdict } from '../shared/types';
import type { Engine, LiveTabState } from './engine';

export interface TabState {
  /** the tab's current mute state */
  muted: boolean;
  /** Chrome attributes the current mute to this extension */
  mutedByExtension?: boolean;
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

async function getTab(tabId: number): Promise<chrome.tabs.Tab | null> {
  return chrome.tabs.get(tabId).catch((): null => null);
}

async function getDocumentId(tabId: number): Promise<string | null> {
  if (chrome.webNavigation?.getFrame === undefined) return null;
  const frame: chrome.webNavigation.GetFrameResultDetails | null = await chrome.webNavigation
    .getFrame({ tabId, frameId: 0 })
    .catch((): null => null);
  return frame?.documentId ?? null;
}

async function tabStillAt(tabId: number, url: string): Promise<boolean> {
  const tab: chrome.tabs.Tab | null = await getTab(tabId);
  return tab?.url === url;
}

/** Pure per-tab decision: what to send and which side effects to run. */
export function planTabAction(verdict: Verdict, tabState: TabState): TabAction {
  const ownsTabEffects: boolean = tabState.wasMutedByUs && tabState.mutedByExtension === true;
  if (verdict.blocked) {
    return {
      command: 'applyBlock',
      mute: ownsTabEffects && tabState.muted ? null : true,
      reload: false,
    };
  }
  return {
    command: 'clearBlock',
    mute: ownsTabEffects ? tabState.priorMuted : null,
    reload: tabState.wasStopped,
  };
}

export async function applyToTab(
  engine: Engine,
  tabId: number,
  url: string,
  mutedNow: boolean,
  attemptKind: 'navigation' | 'existing' = 'existing',
  mutedByExtension = false,
  documentId: string | null = null,
): Promise<void> {
  if (!(await tabStillAt(tabId, url))) return;
  const verdict: Verdict = engine.verdictFor(url);
  if (verdict.blocked) {
    await engine.recordAttempt(url, tabId, attemptKind);
    if (!(await tabStillAt(tabId, url))) return;
  }
  const snapshot: SessionSnapshot = engine.snapshot();
  const facts: { wasMutedByUs: boolean; priorMuted: boolean; wasStopped: boolean } =
    engine.tabFacts(tabId, url, documentId);
  const action: TabAction = planTabAction(verdict, {
    muted: mutedNow,
    mutedByExtension,
    ...facts,
  });
  const command: ContentCommand =
    action.command === 'applyBlock'
      ? { type: 'applyBlock', verdict, snapshot }
      : { type: 'clearBlock', snapshot };
  if (!(await tabStillAt(tabId, url))) return;
  try {
    await chrome.tabs.sendMessage(tabId, command);
  } catch {
    // tabs without the content script (chrome://, the web store) reject, fine
  }
  if (action.command === 'applyBlock') {
    await applyMute(engine, tabId, url, facts, mutedNow, mutedByExtension);
  } else if (facts.wasMutedByUs) {
    await restoreMute(engine, tabId, url, facts.priorMuted, mutedNow, mutedByExtension);
  }
  if (action.reload) {
    if (documentId === null || !(await tabStillAt(tabId, url))) return;
    const liveDocumentId: string | null = await getDocumentId(tabId);
    if (liveDocumentId !== documentId) return;
    try {
      await chrome.tabs.reload(tabId);
      engine.noteReloaded(tabId, documentId);
    } catch {
      // the tab may be gone already
    }
  }
}

function muteState(
  tab: chrome.tabs.Tab,
  fallbackMuted: boolean,
  fallbackOwned: boolean,
): { muted: boolean; owned: boolean } {
  if (tab.mutedInfo === undefined) {
    return { muted: fallbackMuted, owned: fallbackOwned };
  }
  return {
    muted: tab.mutedInfo.muted,
    owned: tab.mutedInfo.muted && tab.mutedInfo.extensionId === chrome.runtime.id,
  };
}

async function applyMute(
  engine: Engine,
  tabId: number,
  url: string,
  facts: { wasMutedByUs: boolean; priorMuted: boolean },
  fallbackMuted: boolean,
  fallbackOwned: boolean,
): Promise<void> {
  let liveTab: chrome.tabs.Tab | null = await getTab(tabId);
  if (liveTab === null || liveTab.url !== url) return;
  let liveMute: { muted: boolean; owned: boolean } = muteState(
    liveTab,
    fallbackMuted,
    fallbackOwned,
  );
  if (liveMute.muted && !liveMute.owned) {
    if (facts.wasMutedByUs) await engine.releaseMuteClaim(tabId, url);
    return;
  }

  const newClaim: boolean = !facts.wasMutedByUs;
  if (newClaim && !(await engine.claimMute(tabId, url, liveMute.muted))) return;

  liveTab = await getTab(tabId);
  if (liveTab === null || liveTab.url !== url) {
    if (newClaim) await engine.releaseMuteClaim(tabId, url);
    return;
  }
  liveMute = muteState(liveTab, fallbackMuted, fallbackOwned);
  if (liveMute.muted) {
    if (!liveMute.owned) await engine.releaseMuteClaim(tabId, url);
    return;
  }

  try {
    await chrome.tabs.update(tabId, { muted: true });
    const updatedTab: chrome.tabs.Tab | null = await getTab(tabId);
    const updatedMute: { muted: boolean; owned: boolean } | null =
      updatedTab === null ? null : muteState(updatedTab, true, true);
    if (updatedTab === null || updatedTab.url !== url) {
      if (updatedTab !== null && updatedTab.url !== undefined && updatedMute?.owned === true) {
        await engine.transferMuteClaim(tabId, url, updatedTab.url);
      } else {
        await engine.releaseMuteClaim(tabId, url);
      }
    } else if (updatedMute?.owned !== true) {
      await engine.releaseMuteClaim(tabId, url);
    }
  } catch {
    const failedTab: chrome.tabs.Tab | null = await getTab(tabId);
    const failedMute: { muted: boolean; owned: boolean } | null =
      failedTab === null ? null : muteState(failedTab, false, false);
    if (failedTab !== null && failedTab.url !== undefined && failedMute?.owned === true) {
      if (failedTab.url !== url) await engine.transferMuteClaim(tabId, url, failedTab.url);
    } else {
      await engine.releaseMuteClaim(tabId, url);
    }
  }
}

async function restoreMute(
  engine: Engine,
  tabId: number,
  url: string,
  priorMuted: boolean,
  fallbackMuted: boolean,
  fallbackOwned: boolean,
): Promise<void> {
  const liveTab: chrome.tabs.Tab | null = await getTab(tabId);
  if (liveTab === null || liveTab.url !== url) return;
  const liveMute: { muted: boolean; owned: boolean } = muteState(
    liveTab,
    fallbackMuted,
    fallbackOwned,
  );
  if (!liveMute.owned) {
    await engine.releaseMuteClaim(tabId, url);
    return;
  }
  try {
    await chrome.tabs.update(tabId, { muted: priorMuted });
    await engine.releaseMuteClaim(tabId, url);
  } catch {
    // the tab may be gone already
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
      const documentIds: Map<number, string | null> = new Map();
      await Promise.all(
        tabs.map(async (tab: chrome.tabs.Tab): Promise<void> => {
          if (tab.id !== undefined) documentIds.set(tab.id, await getDocumentId(tab.id));
        }),
      );
      const liveTabs: Map<number, LiveTabState> = new Map(
        tabs.flatMap(
          (tab: chrome.tabs.Tab): Array<[number, LiveTabState]> =>
            tab.id === undefined || tab.url === undefined || tab.url === ''
              ? []
              : [
                  [
                    tab.id,
                    {
                      url: tab.url,
                      mutedByExtension: tab.mutedInfo?.extensionId === chrome.runtime.id,
                      documentId: documentIds.get(tab.id) ?? null,
                    },
                  ],
                ],
        ),
      );
      e.reconcileTabs(liveTabs);
      for (const tab of tabs) {
        if (tab.id === undefined || tab.url === undefined || tab.url === '') continue;
        await applyToTab(
          e,
          tab.id,
          tab.url,
          tab.mutedInfo?.muted ?? false,
          'existing',
          tab.mutedInfo?.extensionId === chrome.runtime.id,
          documentIds.get(tab.id) ?? null,
        );
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
export function registerTabListeners(
  ready: () => Promise<Engine>,
  reportError: (error: unknown) => void,
): void {
  const onNav = (
    details: { tabId: number; url: string; frameId: number; documentId?: string },
    attemptKind: 'navigation' | 'existing',
  ): void => {
    if (details.frameId !== 0) return;
    void ready()
      .then(async (engine: Engine): Promise<void> => {
        const tab: chrome.tabs.Tab | null = await chrome.tabs
          .get(details.tabId)
          .catch((): null => null);
        if (tab === null || tab.url !== details.url) return;
        if (tab.mutedInfo?.extensionId === chrome.runtime.id) {
          engine.rebindTab(details.tabId, details.url);
        }
        await applyToTab(
          engine,
          details.tabId,
          details.url,
          tab.mutedInfo?.muted ?? false,
          attemptKind,
          tab.mutedInfo?.extensionId === chrome.runtime.id,
          details.documentId ?? null,
        );
        await engine.flushRuntime();
      })
      .catch(reportError);
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

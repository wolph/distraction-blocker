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

type TabReadResult = { ok: true; tab: chrome.tabs.Tab } | { ok: false; error: unknown };

type DocumentReadResult = { ok: true; documentId: string | null } | { ok: false; error: unknown };

async function readTab(tabId: number): Promise<TabReadResult> {
  try {
    return { ok: true, tab: await chrome.tabs.get(tabId) };
  } catch (error: unknown) {
    return { ok: false, error };
  }
}

async function getTab(tabId: number): Promise<chrome.tabs.Tab | null> {
  const result: TabReadResult = await readTab(tabId);
  return result.ok ? result.tab : null;
}

async function readDocumentId(tabId: number): Promise<DocumentReadResult> {
  if (chrome.webNavigation?.getFrame === undefined) return { ok: true, documentId: null };
  try {
    const frame: chrome.webNavigation.GetFrameResultDetails | null =
      await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    return { ok: true, documentId: frame?.documentId ?? null };
  } catch (error: unknown) {
    return { ok: false, error };
  }
}

async function getDocumentId(tabId: number): Promise<string | null> {
  const result: DocumentReadResult = await readDocumentId(tabId);
  return result.ok ? result.documentId : null;
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
  cancelMuteContinuation(tabId);
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
    await applyMute(engine, tabId, url, facts, mutedNow, mutedByExtension, documentId);
  } else if (facts.wasMutedByUs) {
    await restoreMute(engine, tabId, url, facts.priorMuted, mutedNow, mutedByExtension, documentId);
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

interface TabIdentity {
  url: string;
  documentId: string | null;
}

interface LiveTabIdentity {
  tab: chrome.tabs.Tab;
  identity: TabIdentity;
}

const MUTE_CORRECTION_LIMIT = 3;

interface MuteContinuation {
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const muteContinuations: Map<number, MuteContinuation> = new Map();

function cancelMuteContinuation(tabId: number): void {
  const continuation: MuteContinuation | undefined = muteContinuations.get(tabId);
  if (continuation === undefined) return;
  continuation.cancelled = true;
  if (continuation.timer !== null) clearTimeout(continuation.timer);
  muteContinuations.delete(tabId);
}

function muteContinuationCancelled(continuation: MuteContinuation | null): boolean {
  return continuation?.cancelled === true;
}

function missingUrlAfterMuteUpdate(tabId: number): Error {
  return new Error(`Tab ${tabId} has no URL after a mute update`);
}

function muteCorrectionLimitError(tabId: number): Error {
  return new Error(`Tab ${tabId} exceeded the mute correction limit`);
}

async function readLiveTabIdentity(engine: Engine, tabId: number): Promise<LiveTabIdentity | null> {
  const tabRead: TabReadResult = await readTab(tabId);
  if (!tabRead.ok) {
    engine.reportError(tabRead.error);
    return null;
  }
  const url: string | undefined = tabRead.tab.url;
  if (url === undefined || url === '') {
    engine.reportError(missingUrlAfterMuteUpdate(tabId));
    return null;
  }
  const documentRead: DocumentReadResult = await readDocumentId(tabId);
  if (!documentRead.ok) {
    engine.reportError(documentRead.error);
    return null;
  }
  return {
    tab: tabRead.tab,
    identity: { url, documentId: documentRead.documentId },
  };
}

function identityChanged(previous: TabIdentity, current: TabIdentity): boolean {
  if (previous.url !== current.url) return true;
  return (
    previous.documentId !== null &&
    current.documentId !== null &&
    previous.documentId !== current.documentId
  );
}

async function settleMuteUpdate(
  engine: Engine,
  tabId: number,
  sourceIdentity: TabIdentity,
  priorMuted: boolean,
  initiallyBlocked: boolean,
  initialLiveTab: LiveTabIdentity | null = null,
  continuation: MuteContinuation | null = null,
): Promise<void> {
  let updateIdentity: TabIdentity = sourceIdentity;
  let desiredBlocked: boolean = initiallyBlocked;
  let desiredMuted: boolean = initiallyBlocked ? true : priorMuted;
  let correctionsRemaining = MUTE_CORRECTION_LIMIT;
  let pendingLiveTab: LiveTabIdentity | null = initialLiveTab;
  let lastUpdateRejected = false;

  while (true) {
    if (muteContinuationCancelled(continuation)) return;
    const liveTab: LiveTabIdentity | null =
      pendingLiveTab ?? (await readLiveTabIdentity(engine, tabId));
    pendingLiveTab = null;
    if (liveTab === null || muteContinuationCancelled(continuation)) return;
    const liveIdentity: TabIdentity = liveTab.identity;
    const liveUrl: string = liveIdentity.url;
    const changedIdentity: boolean = identityChanged(updateIdentity, liveIdentity);
    if (changedIdentity) {
      desiredBlocked = engine.verdictFor(liveUrl).blocked;
      desiredMuted = desiredBlocked ? true : priorMuted;
    }
    const liveMute: { muted: boolean; owned: boolean } = muteState(
      liveTab.tab,
      desiredMuted,
      desiredMuted,
    );
    if (liveMute.muted && !liveMute.owned) {
      await engine.settleMuteClaim(tabId, null);
      return;
    }
    if (lastUpdateRejected && !changedIdentity && liveMute.muted !== desiredMuted) return;
    lastUpdateRejected = false;
    if (liveMute.muted === desiredMuted) {
      if (desiredBlocked && liveMute.owned) {
        await engine.settleMuteClaim(tabId, liveUrl);
      } else {
        await engine.settleMuteClaim(tabId, null);
      }
      return;
    }

    if (correctionsRemaining === 0) {
      engine.reportError(muteCorrectionLimitError(tabId));
      scheduleMuteContinuation(engine, tabId, liveIdentity, priorMuted, desiredBlocked);
      return;
    }

    if (muteContinuationCancelled(continuation)) return;
    try {
      await chrome.tabs.update(tabId, { muted: desiredMuted });
    } catch (error: unknown) {
      engine.reportError(error);
      lastUpdateRejected = true;
    }
    correctionsRemaining -= 1;
    updateIdentity = liveIdentity;
  }
}

function scheduleMuteContinuation(
  engine: Engine,
  tabId: number,
  sourceIdentity: TabIdentity,
  priorMuted: boolean,
  initiallyBlocked: boolean,
): void {
  cancelMuteContinuation(tabId);
  const continuation: MuteContinuation = { cancelled: false, timer: null };
  continuation.timer = setTimeout((): void => {
    continuation.timer = null;
    if (continuation.cancelled || muteContinuations.get(tabId) !== continuation) return;
    void settleMuteUpdate(
      engine,
      tabId,
      sourceIdentity,
      priorMuted,
      initiallyBlocked,
      null,
      continuation,
    )
      .catch((error: unknown): void => {
        engine.reportError(error);
      })
      .finally((): void => {
        if (muteContinuations.get(tabId) === continuation) muteContinuations.delete(tabId);
      });
  }, 0);
  muteContinuations.set(tabId, continuation);
}

async function applyMute(
  engine: Engine,
  tabId: number,
  url: string,
  facts: { wasMutedByUs: boolean; priorMuted: boolean },
  fallbackMuted: boolean,
  fallbackOwned: boolean,
  documentId: string | null,
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
  } catch (error: unknown) {
    engine.reportError(error);
    const failedTab: LiveTabIdentity | null = await readLiveTabIdentity(engine, tabId);
    if (failedTab === null) return;
    const sourceIdentity: TabIdentity = { url, documentId };
    if (identityChanged(sourceIdentity, failedTab.identity)) {
      await settleMuteUpdate(engine, tabId, sourceIdentity, facts.priorMuted, true, failedTab);
      return;
    }
    const failedMute: { muted: boolean; owned: boolean } = muteState(failedTab.tab, false, false);
    if (!failedMute.owned) {
      await engine.releaseMuteClaim(tabId, url);
    }
    return;
  }
  await settleMuteUpdate(engine, tabId, { url, documentId }, facts.priorMuted, true);
}

async function restoreMute(
  engine: Engine,
  tabId: number,
  url: string,
  priorMuted: boolean,
  fallbackMuted: boolean,
  fallbackOwned: boolean,
  documentId: string | null,
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
  } catch (error: unknown) {
    engine.reportError(error);
    const failedTab: LiveTabIdentity | null = await readLiveTabIdentity(engine, tabId);
    if (failedTab === null) return;
    const sourceIdentity: TabIdentity = { url, documentId };
    if (identityChanged(sourceIdentity, failedTab.identity)) {
      await settleMuteUpdate(engine, tabId, sourceIdentity, priorMuted, false, failedTab);
    }
    return;
  }
  await settleMuteUpdate(engine, tabId, { url, documentId }, priorMuted, false);
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

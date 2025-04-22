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

const tabTaskTails: Map<number, Promise<void>> = new Map();
const tabTaskVersions: Map<number, number> = new Map();
let tabTaskSequence: number = 0;
const tabOperationVersions: Map<number, number> = new Map();
const tabOperationUrls: Map<number, string | null> = new Map();
interface TabOperationLeaseState {
  count: number;
}

interface RemovedTabClaim {
  cleanupPromise: Promise<void> | null;
  engine: Engine;
  url: string;
}

const activeTabOperationLeases: Map<number, TabOperationLeaseState> = new Map();
let tabOperationSequence: number = 0;

function acquireTabOperationLease(tabId: number): () => void {
  let leaseState: TabOperationLeaseState | undefined = activeTabOperationLeases.get(tabId);
  if (leaseState === undefined) {
    leaseState = { count: 0 };
    activeTabOperationLeases.set(tabId, leaseState);
  }
  leaseState.count += 1;
  let released: boolean = false;
  return (): void => {
    if (released) return;
    released = true;
    leaseState.count -= 1;
    if (leaseState.count === 0 && activeTabOperationLeases.get(tabId) === leaseState) {
      activeTabOperationLeases.delete(tabId);
    }
  };
}

function releaseRemovedTabClaim(tabId: number, claim: RemovedTabClaim): Promise<void> {
  const cleanup: Promise<void> =
    claim.cleanupPromise ??
    Promise.resolve().then((): Promise<void> => claim.engine.releaseMuteClaim(tabId, claim.url));
  return cleanup.catch((error: unknown): void => claim.engine.reportError(error));
}

export function invalidateRemovedTab(tabId: number): Promise<void> {
  beginTabOperation(tabId, null);
  tabTaskVersions.delete(tabId);
  tabTaskTails.delete(tabId);

  const continuation: MuteContinuation | undefined = muteContinuations.get(tabId);
  if (continuation !== undefined) {
    continuation.cancelled = true;
    if (continuation.timer !== null) {
      clearTimeout(continuation.timer);
      continuation.timer = null;
    }
    muteContinuations.delete(tabId);
  }
  const inherited: InheritedMuteClaim | undefined = inheritedMuteClaims.get(tabId);
  inheritedMuteClaims.delete(tabId);
  activeTabOperationLeases.delete(tabId);

  const claims: RemovedTabClaim[] = [];
  if (continuation !== undefined) {
    claims.push({
      cleanupPromise: continuation.cleanupPromise,
      engine: continuation.engine,
      url: continuation.ownedUrl,
    });
  }
  if (
    inherited !== undefined &&
    !claims.some(
      (claim: RemovedTabClaim): boolean =>
        claim.engine === inherited.engine && claim.url === inherited.url,
    )
  ) {
    claims.push(inherited);
  }
  const cleanups: Promise<void>[] = claims.map((claim: RemovedTabClaim): Promise<void> => {
    const cleanup: Promise<void> = releaseRemovedTabClaim(tabId, claim);
    if (continuation?.engine === claim.engine && continuation.ownedUrl === claim.url) {
      continuation.cleanupPromise = cleanup;
    }
    if (inherited?.engine === claim.engine && inherited.url === claim.url) {
      inherited.cleanupPromise = cleanup;
    }
    return cleanup;
  });
  return Promise.all(cleanups).then((): void => undefined);
}

function nextTabOperationVersion(): number {
  tabOperationSequence += 1;
  return tabOperationSequence;
}

function acceptTabOperation(
  tabId: number,
  operationVersion: number,
  operationUrl: string | null = null,
): boolean {
  const currentVersion: number | undefined = tabOperationVersions.get(tabId);
  if (currentVersion !== undefined && currentVersion > operationVersion) return false;
  tabOperationVersions.set(tabId, operationVersion);
  tabOperationUrls.set(tabId, operationUrl);
  return true;
}

function beginTabOperation(tabId: number, operationUrl: string | null = null): number {
  const operationVersion: number = nextTabOperationVersion();
  acceptTabOperation(tabId, operationVersion, operationUrl);
  return operationVersion;
}

function enqueueTabTask<T>(tabId: number, task: (taskVersion: number) => Promise<T>): Promise<T> {
  tabTaskSequence += 1;
  const taskVersion: number = tabTaskSequence;
  tabTaskVersions.set(tabId, taskVersion);
  const previous: Promise<void> = tabTaskTails.get(tabId) ?? Promise.resolve();
  const result: Promise<T> = previous.then((): Promise<T> => task(taskVersion));
  const tail: Promise<void> = result.then(
    (): void => undefined,
    (): void => undefined,
  );
  tabTaskTails.set(tabId, tail);
  void tail.then((): void => {
    if (tabTaskTails.get(tabId) === tail) tabTaskTails.delete(tabId);
  });
  return result;
}

interface TabApplyInput {
  url: string;
  mutedNow: boolean;
  mutedByExtension: boolean;
  documentId: string | null;
}

interface ResolvedTabApplyOptions {
  beforeEffects?(input: TabApplyInput, taskVersion: number): void;
  afterEffects?(input: TabApplyInput): Promise<void>;
  requireCurrentTask?: boolean;
  validateDocument?: boolean;
}

async function applyTabEffectsNow(
  engine: Engine,
  tabId: number,
  input: TabApplyInput,
  verdict: Verdict,
  beforeEffects: () => void = (): void => undefined,
  shouldContinue: () => boolean = (): boolean => true,
  validateDocument: boolean = false,
): Promise<void> {
  const { url, mutedNow, mutedByExtension, documentId }: TabApplyInput = input;
  if (!(await tabStillAt(tabId, url)) || !shouldContinue()) return;
  if (validateDocument && documentId !== null) {
    const liveDocumentId: string | null = await getDocumentId(tabId);
    if (liveDocumentId !== documentId || !shouldContinue()) return;
  }
  beforeEffects();
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
  if (!(await tabStillAt(tabId, url)) || !shouldContinue()) return;
  try {
    if (documentId === null) {
      await chrome.tabs.sendMessage(tabId, command);
    } else {
      await chrome.tabs.sendMessage(tabId, command, { documentId });
    }
  } catch {
    // tabs without the content script (chrome://, the web store) reject, fine
  }
  if (!shouldContinue()) return;
  if (validateDocument && documentId !== null) {
    const liveDocumentId: string | null = await getDocumentId(tabId);
    if (liveDocumentId !== documentId || !shouldContinue()) return;
  }
  if (action.command === 'applyBlock') {
    await applyMute(
      engine,
      tabId,
      url,
      facts,
      mutedNow,
      mutedByExtension,
      documentId,
      shouldContinue,
    );
  } else if (facts.wasMutedByUs) {
    await restoreMute(
      engine,
      tabId,
      url,
      facts.priorMuted,
      mutedNow,
      mutedByExtension,
      documentId,
      shouldContinue,
    );
  }
  if (action.reload) {
    if (documentId === null || !(await tabStillAt(tabId, url)) || !shouldContinue()) return;
    const liveDocumentId: string | null = await getDocumentId(tabId);
    if (liveDocumentId !== documentId || !shouldContinue()) return;
    try {
      await chrome.tabs.reload(tabId);
      engine.noteReloaded(tabId, documentId);
    } catch {
      // the tab may be gone already
    }
  }
}

async function queueResolvedTabApply(
  engine: Engine,
  tabId: number,
  attemptKind: 'navigation' | 'existing',
  resolveInput: (taskVersion: number) => Promise<TabApplyInput | null>,
  options: ResolvedTabApplyOptions = {},
  operationVersion: number = beginTabOperation(tabId),
  operationUrl: string | null = null,
): Promise<void> {
  if (!acceptTabOperation(tabId, operationVersion, operationUrl)) return;
  const operationIsCurrent: () => boolean = (): boolean =>
    tabOperationVersions.get(tabId) === operationVersion;
  let recordedAttemptUrl: string | null = null;
  while (true) {
    const preparation: {
      input: TabApplyInput;
      persistence: Promise<void> | null;
    } | null = await enqueueTabTask(
      tabId,
      async (
        taskVersion: number,
      ): Promise<{ input: TabApplyInput; persistence: Promise<void> | null } | null> => {
        if (!operationIsCurrent()) return null;
        await cancelMuteContinuation(tabId);
        const input: TabApplyInput | null = await resolveInput(taskVersion);
        if (input === null || !operationIsCurrent()) return null;
        if (options.requireCurrentTask && tabTaskVersions.get(tabId) !== taskVersion) return null;
        const verdict: Verdict = engine.verdictFor(input.url);
        if (!verdict.blocked || recordedAttemptUrl === input.url) {
          return { input, persistence: null };
        }
        const persistence: Promise<void> = engine.recordAttempt(input.url, tabId, attemptKind);
        void persistence.catch((): void => undefined);
        return { input, persistence };
      },
    );
    if (preparation === null) return;
    if (preparation.persistence !== null) {
      await preparation.persistence;
      if (!operationIsCurrent()) return;
      recordedAttemptUrl = preparation.input.url;
    }

    const completed: boolean = await enqueueTabTask(
      tabId,
      async (taskVersion: number): Promise<boolean> => {
        if (!operationIsCurrent()) return true;
        await cancelMuteContinuation(tabId);
        const input: TabApplyInput | null = await resolveInput(taskVersion);
        if (input === null || !operationIsCurrent()) return true;
        if (options.requireCurrentTask && tabTaskVersions.get(tabId) !== taskVersion) return true;
        const verdict: Verdict = engine.verdictFor(input.url);
        if (verdict.blocked && recordedAttemptUrl !== input.url) return false;
        let effectsAccepted: boolean = false;
        await applyTabEffectsNow(
          engine,
          tabId,
          input,
          verdict,
          (): void => {
            effectsAccepted = true;
            options.beforeEffects?.(input, taskVersion);
          },
          operationIsCurrent,
          options.validateDocument ?? false,
        );
        if (effectsAccepted && options.afterEffects !== undefined) {
          await options.afterEffects(input);
        }
        return true;
      },
    );
    if (completed) return;
  }
}

function queueTabApply(
  engine: Engine,
  tabId: number,
  url: string,
  mutedNow: boolean,
  attemptKind: 'navigation' | 'existing' = 'existing',
  mutedByExtension: boolean = false,
  documentId: string | null = null,
  operationVersion: number = beginTabOperation(tabId, url),
): Promise<void> {
  return queueResolvedTabApply(
    engine,
    tabId,
    attemptKind,
    async (): Promise<TabApplyInput | null> => {
      if (!(await tabStillAt(tabId, url))) return null;
      return { url, mutedNow, mutedByExtension, documentId };
    },
    {},
    operationVersion,
    url,
  );
}

export function applyToTab(
  engine: Engine,
  tabId: number,
  url: string,
  mutedNow: boolean,
  attemptKind: 'navigation' | 'existing' = 'existing',
  mutedByExtension: boolean = false,
  documentId: string | null = null,
): Promise<void> {
  const releaseOperationLease: () => void = acquireTabOperationLease(tabId);
  const operationVersion: number = beginTabOperation(tabId, url);
  void cancelMuteContinuation(tabId);
  try {
    return queueTabApply(
      engine,
      tabId,
      url,
      mutedNow,
      attemptKind,
      mutedByExtension,
      documentId,
      operationVersion,
    ).finally(releaseOperationLease);
  } catch (error: unknown) {
    releaseOperationLease();
    throw error;
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

const MUTE_CORRECTION_LIMIT: number = 3;

interface MuteContinuation {
  cancelled: boolean;
  cleanupPromise: Promise<void> | null;
  engine: Engine;
  ownedUrl: string;
  timer: ReturnType<typeof setTimeout> | null;
}

const muteContinuations: Map<number, MuteContinuation> = new Map();

interface InheritedMuteClaim {
  cleanupPromise: Promise<void> | null;
  engine: Engine;
  url: string;
}

const inheritedMuteClaims: Map<number, InheritedMuteClaim> = new Map();

function retainInheritedMuteClaim(tabId: number, engine: Engine, url: string): void {
  const inherited: InheritedMuteClaim | undefined = inheritedMuteClaims.get(tabId);
  if (inherited?.engine === engine && inherited.url === url) return;
  inheritedMuteClaims.set(tabId, { cleanupPromise: null, engine, url });
}

function moveInheritedMuteClaim(
  tabId: number,
  engine: Engine,
  fromUrl: string,
  toUrl: string,
): void {
  const inherited: InheritedMuteClaim | undefined = inheritedMuteClaims.get(tabId);
  if (inherited?.engine !== engine || inherited.url !== fromUrl) return;
  inherited.url = toUrl;
  inherited.cleanupPromise = null;
}

function dropInheritedMuteClaim(tabId: number, engine: Engine, url: string): void {
  const inherited: InheritedMuteClaim | undefined = inheritedMuteClaims.get(tabId);
  if (inherited?.engine === engine && inherited.url === url) inheritedMuteClaims.delete(tabId);
}

function releaseInheritedMuteClaim(tabId: number, skipUrl: string | null = null): Promise<void> {
  const inherited: InheritedMuteClaim | undefined = inheritedMuteClaims.get(tabId);
  if (
    inherited === undefined ||
    inherited.url === skipUrl ||
    tabOperationUrls.get(tabId) === inherited.url
  ) {
    return Promise.resolve();
  }
  if (inherited.cleanupPromise === null) {
    inherited.cleanupPromise = inherited.engine
      .releaseMuteClaim(tabId, inherited.url)
      .catch((error: unknown): void => inherited.engine.reportError(error));
  }
  const cleanup: Promise<void> = inherited.cleanupPromise;
  void cleanup.then((): void => {
    if (inheritedMuteClaims.get(tabId) === inherited) inheritedMuteClaims.delete(tabId);
  });
  return cleanup;
}

async function retainOrReleaseStaleMuteClaim(
  engine: Engine,
  tabId: number,
  url: string,
): Promise<void> {
  if (tabOperationUrls.get(tabId) === url) {
    retainInheritedMuteClaim(tabId, engine, url);
    return;
  }
  await engine.releaseMuteClaim(tabId, url);
  dropInheritedMuteClaim(tabId, engine, url);
}

function releaseMuteContinuationClaim(
  tabId: number,
  continuation: MuteContinuation,
): Promise<void> {
  if (tabOperationUrls.get(tabId) === continuation.ownedUrl) {
    retainInheritedMuteClaim(tabId, continuation.engine, continuation.ownedUrl);
    return Promise.resolve();
  }
  if (continuation.cleanupPromise === null) {
    continuation.cleanupPromise = continuation.engine
      .releaseMuteClaim(tabId, continuation.ownedUrl)
      .catch((error: unknown): void => continuation.engine.reportError(error));
  }
  return continuation.cleanupPromise;
}

function cancelMuteContinuation(tabId: number): Promise<void> {
  const continuation: MuteContinuation | undefined = muteContinuations.get(tabId);
  if (continuation === undefined) return releaseInheritedMuteClaim(tabId);
  continuation.cancelled = true;
  if (continuation.timer !== null) {
    clearTimeout(continuation.timer);
    continuation.timer = null;
  }
  const cleanup: Promise<void> = releaseMuteContinuationClaim(tabId, continuation);
  const inheritedCleanup: Promise<void> = releaseInheritedMuteClaim(tabId, continuation.ownedUrl);
  void cleanup.then((): void => {
    if (continuation.cleanupPromise !== null && muteContinuations.get(tabId) === continuation) {
      muteContinuations.delete(tabId);
    }
  });
  return Promise.all([cleanup, inheritedCleanup]).then((): void => undefined);
}

function discardMuteContinuation(tabId: number): void {
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

async function readStableLiveTabIdentity(
  engine: Engine,
  tabId: number,
): Promise<LiveTabIdentity | null> {
  let previous: LiveTabIdentity | null = await readLiveTabIdentity(engine, tabId);
  if (previous === null) return null;
  for (let validation: number = 0; validation < 1; validation += 1) {
    const current: LiveTabIdentity | null = await readLiveTabIdentity(engine, tabId);
    if (current === null) return null;
    if (
      previous.identity.url !== current.identity.url ||
      previous.identity.documentId !== current.identity.documentId
    ) {
      return null;
    }
    previous = current;
  }
  return previous;
}

async function settleMuteUpdate(
  engine: Engine,
  tabId: number,
  sourceIdentity: TabIdentity,
  priorMuted: boolean,
  initiallyBlocked: boolean,
  ownedUrl: string,
  initialLiveTab: LiveTabIdentity | null = null,
  continuation: MuteContinuation | null = null,
  shouldContinue: () => boolean = (): boolean => true,
): Promise<void> {
  const settlementCancelled: () => boolean = (): boolean =>
    muteContinuationCancelled(continuation) || !shouldContinue();
  let ownedClaimUrl: string = ownedUrl;
  const releaseClaimIfCancelled: () => Promise<boolean> = async (): Promise<boolean> => {
    if (!settlementCancelled()) return false;
    if (tabOperationUrls.get(tabId) === ownedClaimUrl) {
      retainInheritedMuteClaim(tabId, engine, ownedClaimUrl);
      return true;
    }
    if (continuation === null) {
      await engine.releaseMuteClaim(tabId, ownedClaimUrl);
      dropInheritedMuteClaim(tabId, engine, ownedClaimUrl);
    } else {
      continuation.ownedUrl = ownedClaimUrl;
      await releaseMuteContinuationClaim(tabId, continuation);
    }
    return true;
  };
  let updateIdentity: TabIdentity = sourceIdentity;
  let desiredBlocked: boolean = initiallyBlocked;
  let desiredMuted: boolean = initiallyBlocked ? true : priorMuted;
  let correctionsRemaining: number = MUTE_CORRECTION_LIMIT;
  let pendingLiveTab: LiveTabIdentity | null = initialLiveTab;
  let lastUpdateRejected: boolean = false;

  while (true) {
    if (await releaseClaimIfCancelled()) return;
    const liveTab: LiveTabIdentity | null =
      pendingLiveTab ?? (await readLiveTabIdentity(engine, tabId));
    pendingLiveTab = null;
    if (await releaseClaimIfCancelled()) return;
    if (liveTab === null) return;
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
      dropInheritedMuteClaim(tabId, engine, ownedClaimUrl);
      return;
    }
    if (lastUpdateRejected && !changedIdentity && liveMute.muted !== desiredMuted) return;
    lastUpdateRejected = false;
    if (liveMute.muted === desiredMuted) {
      if (desiredBlocked && liveMute.owned) {
        const previousOwnedClaimUrl: string = ownedClaimUrl;
        const settlement: Promise<void> = engine.settleMuteClaim(tabId, liveUrl);
        ownedClaimUrl = liveUrl;
        moveInheritedMuteClaim(tabId, engine, previousOwnedClaimUrl, liveUrl);
        if (continuation !== null) {
          continuation.ownedUrl = liveUrl;
          continuation.cleanupPromise = null;
        }
        await settlement;
        await releaseClaimIfCancelled();
      } else {
        await engine.settleMuteClaim(tabId, null);
        dropInheritedMuteClaim(tabId, engine, ownedClaimUrl);
      }
      return;
    }

    if (correctionsRemaining === 0) {
      engine.reportError(muteCorrectionLimitError(tabId));
      scheduleMuteContinuation(
        engine,
        tabId,
        liveIdentity,
        priorMuted,
        desiredBlocked,
        ownedClaimUrl,
      );
      return;
    }

    if (await releaseClaimIfCancelled()) return;
    try {
      await chrome.tabs.update(tabId, { muted: desiredMuted });
    } catch (error: unknown) {
      engine.reportError(error);
      lastUpdateRejected = true;
    }
    if (await releaseClaimIfCancelled()) return;
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
  ownedUrl: string,
): void {
  discardMuteContinuation(tabId);
  const continuation: MuteContinuation = {
    cancelled: false,
    cleanupPromise: null,
    engine,
    ownedUrl,
    timer: null,
  };
  continuation.timer = setTimeout((): void => {
    continuation.timer = null;
    if (continuation.cancelled || muteContinuations.get(tabId) !== continuation) {
      void releaseMuteContinuationClaim(tabId, continuation);
      return;
    }
    const queued: Promise<void> = enqueueTabTask(tabId, async (): Promise<void> => {
      if (continuation.cancelled || muteContinuations.get(tabId) !== continuation) {
        await releaseMuteContinuationClaim(tabId, continuation);
        return;
      }
      await settleMuteUpdate(
        engine,
        tabId,
        sourceIdentity,
        priorMuted,
        initiallyBlocked,
        ownedUrl,
        null,
        continuation,
      );
    });
    void queued
      .catch((error: unknown): void => {
        engine.reportError(error);
      })
      .finally((): void => {
        if (
          muteContinuations.get(tabId) === continuation &&
          (!continuation.cancelled || continuation.cleanupPromise !== null)
        ) {
          muteContinuations.delete(tabId);
        }
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
  shouldContinue: () => boolean,
): Promise<void> {
  let liveTab: chrome.tabs.Tab | null = await getTab(tabId);
  if (liveTab === null) return;
  if (liveTab.url !== url || !shouldContinue()) {
    if (facts.wasMutedByUs) await retainOrReleaseStaleMuteClaim(engine, tabId, url);
    return;
  }
  let liveMute: { muted: boolean; owned: boolean } = muteState(
    liveTab,
    fallbackMuted,
    fallbackOwned,
  );
  if (liveMute.muted && !liveMute.owned) {
    if (facts.wasMutedByUs && shouldContinue()) await engine.releaseMuteClaim(tabId, url);
    return;
  }

  const newClaim: boolean = !facts.wasMutedByUs;
  if (newClaim) {
    if (!shouldContinue() || !(await engine.claimMute(tabId, url, liveMute.muted))) return;
    if (!shouldContinue()) {
      await engine.releaseMuteClaim(tabId, url);
      return;
    }
  }

  liveTab = await getTab(tabId);
  if (liveTab === null) {
    if (newClaim) await engine.releaseMuteClaim(tabId, url);
    return;
  }
  if (liveTab.url !== url || !shouldContinue()) {
    await retainOrReleaseStaleMuteClaim(engine, tabId, url);
    return;
  }
  liveMute = muteState(liveTab, fallbackMuted, fallbackOwned);
  if (liveMute.muted) {
    if (!liveMute.owned && shouldContinue()) await engine.releaseMuteClaim(tabId, url);
    return;
  }

  if (!shouldContinue()) return;
  try {
    await chrome.tabs.update(tabId, { muted: true });
  } catch (error: unknown) {
    engine.reportError(error);
    if (!shouldContinue()) {
      await retainOrReleaseStaleMuteClaim(engine, tabId, url);
      return;
    }
    const failedTab: LiveTabIdentity | null = await readLiveTabIdentity(engine, tabId);
    if (!shouldContinue()) {
      await retainOrReleaseStaleMuteClaim(engine, tabId, url);
      return;
    }
    if (failedTab === null) return;
    const sourceIdentity: TabIdentity = { url, documentId };
    if (identityChanged(sourceIdentity, failedTab.identity)) {
      await settleMuteUpdate(
        engine,
        tabId,
        sourceIdentity,
        facts.priorMuted,
        true,
        url,
        failedTab,
        null,
        shouldContinue,
      );
      return;
    }
    const failedMute: { muted: boolean; owned: boolean } = muteState(failedTab.tab, false, false);
    if (!failedMute.owned) {
      await engine.releaseMuteClaim(tabId, url);
    }
    return;
  }
  if (!shouldContinue()) {
    await retainOrReleaseStaleMuteClaim(engine, tabId, url);
    return;
  }
  await settleMuteUpdate(
    engine,
    tabId,
    { url, documentId },
    facts.priorMuted,
    true,
    url,
    null,
    null,
    shouldContinue,
  );
}

async function restoreMute(
  engine: Engine,
  tabId: number,
  url: string,
  priorMuted: boolean,
  fallbackMuted: boolean,
  fallbackOwned: boolean,
  documentId: string | null,
  shouldContinue: () => boolean,
): Promise<void> {
  const liveTab: chrome.tabs.Tab | null = await getTab(tabId);
  if (liveTab === null) return;
  if (liveTab.url !== url || !shouldContinue()) {
    await retainOrReleaseStaleMuteClaim(engine, tabId, url);
    return;
  }
  const liveMute: { muted: boolean; owned: boolean } = muteState(
    liveTab,
    fallbackMuted,
    fallbackOwned,
  );
  if (!liveMute.owned) {
    if (shouldContinue()) await engine.releaseMuteClaim(tabId, url);
    return;
  }
  if (!shouldContinue()) return;
  try {
    await chrome.tabs.update(tabId, { muted: priorMuted });
  } catch (error: unknown) {
    engine.reportError(error);
    if (!shouldContinue()) {
      await retainOrReleaseStaleMuteClaim(engine, tabId, url);
      return;
    }
    const failedTab: LiveTabIdentity | null = await readLiveTabIdentity(engine, tabId);
    if (!shouldContinue()) {
      await retainOrReleaseStaleMuteClaim(engine, tabId, url);
      return;
    }
    if (failedTab === null) return;
    const sourceIdentity: TabIdentity = { url, documentId };
    if (identityChanged(sourceIdentity, failedTab.identity)) {
      await settleMuteUpdate(
        engine,
        tabId,
        sourceIdentity,
        priorMuted,
        false,
        url,
        failedTab,
        null,
        shouldContinue,
      );
    }
    return;
  }
  if (!shouldContinue()) {
    await retainOrReleaseStaleMuteClaim(engine, tabId, url);
    return;
  }
  await settleMuteUpdate(
    engine,
    tabId,
    { url, documentId },
    priorMuted,
    false,
    url,
    null,
    null,
    shouldContinue,
  );
}

/**
 * Builds EnginePorts.applyBlocking: sweep every tab, block or clear.
 * Reentrancy-guarded because a sweep can advance the engine, whose
 * commit would start a second sweep.
 */
export function applyBlockingFactory(engine: () => Engine): () => Promise<void> {
  let running: boolean = false;
  return async (): Promise<void> => {
    if (running) return;
    const sweepOperationVersion: number = nextTabOperationVersion();
    running = true;
    try {
      const e: Engine = engine();
      const sweepStartTaskSequence: number = tabTaskSequence;
      const activeTabIdsAtStart: Set<number> = new Set(tabTaskTails.keys());
      const activeOperationTabIdsAtStart: Set<number> = new Set(activeTabOperationLeases.keys());
      const tabs: chrome.tabs.Tab[] = await chrome.tabs.query({});
      const queriedTabIds: number[] = [
        ...new Set(
          tabs.flatMap((tab: chrome.tabs.Tab): number[] => (tab.id === undefined ? [] : [tab.id])),
        ),
      ];
      const queriedTabUrls: Map<number, string | null> = new Map(
        tabs.flatMap((tab: chrome.tabs.Tab): [number, string | null][] =>
          tab.id === undefined ? [] : [[tab.id, tab.url ?? null]],
        ),
      );
      const observedTabIds: Set<number> = new Set(queriedTabIds);
      const protectedTabIds: (currentTabId?: number | null) => Set<number> = (
        currentTabId: number | null = null,
      ): Set<number> => {
        const protectedIds: Set<number> = new Set([
          ...activeTabIdsAtStart,
          ...activeOperationTabIdsAtStart,
          ...observedTabIds,
          ...activeTabOperationLeases.keys(),
          ...muteContinuations.keys(),
          ...inheritedMuteClaims.keys(),
        ]);
        for (const [tabId, version] of tabTaskVersions) {
          if (version > sweepStartTaskSequence) protectedIds.add(tabId);
        }
        if (currentTabId !== null) protectedIds.delete(currentTabId);
        return protectedIds;
      };
      e.reconcileTabs(new Map(), protectedTabIds());

      const applyTasks: Promise<void>[] = queriedTabIds.map((tabId: number): Promise<void> => {
        const releaseOperationLease: () => void = acquireTabOperationLease(tabId);
        try {
          return queueResolvedTabApply(
            e,
            tabId,
            'existing',
            async (taskVersion: number): Promise<TabApplyInput | null> => {
              const liveTab: LiveTabIdentity | null = await readStableLiveTabIdentity(e, tabId);
              if (liveTab === null || tabTaskVersions.get(tabId) !== taskVersion) return null;
              return {
                url: liveTab.identity.url,
                mutedNow: liveTab.tab.mutedInfo?.muted ?? false,
                mutedByExtension: liveTab.tab.mutedInfo?.extensionId === chrome.runtime.id,
                documentId: liveTab.identity.documentId,
              };
            },
            {
              beforeEffects: (input: TabApplyInput): void => {
                const liveState: LiveTabState = {
                  url: input.url,
                  mutedByExtension: input.mutedByExtension,
                  documentId: input.documentId,
                };
                e.reconcileTabs(new Map([[tabId, liveState]]), protectedTabIds(tabId));
              },
              requireCurrentTask: true,
              validateDocument: true,
            },
            sweepOperationVersion,
            queriedTabUrls.get(tabId) ?? null,
          ).finally(releaseOperationLease);
        } catch (error: unknown) {
          releaseOperationLease();
          throw error;
        }
      });
      await Promise.all(applyTasks);
      const cleanupVersions: Map<number, number> = new Map(tabTaskVersions);
      await e.flushRuntime();

      for (const [tabId, version] of cleanupVersions) {
        if (!tabTaskTails.has(tabId) && tabTaskVersions.get(tabId) === version) {
          tabTaskVersions.delete(tabId);
        }
      }
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
  const onNav: (
    details: { tabId: number; url: string; frameId: number; documentId?: string },
    attemptKind: 'navigation' | 'existing',
  ) => void = (
    details: { tabId: number; url: string; frameId: number; documentId?: string },
    attemptKind: 'navigation' | 'existing',
  ): void => {
    if (details.frameId !== 0) return;
    const releaseOperationLease: () => void = acquireTabOperationLease(details.tabId);
    const operationVersion: number = beginTabOperation(details.tabId, details.url);
    void cancelMuteContinuation(details.tabId);
    let readiness: Promise<Engine>;
    try {
      readiness = ready();
    } catch (error: unknown) {
      releaseOperationLease();
      reportError(error);
      return;
    }
    void readiness
      .then(async (engine: Engine): Promise<void> => {
        await queueResolvedTabApply(
          engine,
          details.tabId,
          attemptKind,
          async (): Promise<TabApplyInput | null> => {
            const liveTab: LiveTabIdentity | null = await readStableLiveTabIdentity(
              engine,
              details.tabId,
            );
            if (liveTab === null || liveTab.identity.url !== details.url) return null;
            const eventDocumentId: string | null = details.documentId ?? null;
            if (eventDocumentId !== null && liveTab.identity.documentId !== eventDocumentId) {
              return null;
            }
            return {
              url: liveTab.identity.url,
              mutedNow: liveTab.tab.mutedInfo?.muted ?? false,
              mutedByExtension: liveTab.tab.mutedInfo?.extensionId === chrome.runtime.id,
              documentId: liveTab.identity.documentId,
            };
          },
          {
            beforeEffects: (input: TabApplyInput): void => {
              if (input.mutedByExtension) engine.rebindTab(details.tabId, input.url);
            },
            afterEffects: async (): Promise<void> => engine.flushRuntime(),
            validateDocument: true,
          },
          operationVersion,
          details.url,
        );
      })
      .catch(reportError)
      .finally(releaseOperationLease);
  };

  chrome.webNavigation.onCommitted.addListener(
    (details: chrome.webNavigation.WebNavigationTransitionCallbackDetails): void =>
      onNav(details, 'navigation'),
  );
  chrome.webNavigation.onHistoryStateUpdated.addListener(
    (details: chrome.webNavigation.WebNavigationTransitionCallbackDetails): void =>
      onNav(details, 'existing'),
  );
}

function isUnsupportedPageInjectionFailure(error: unknown): boolean {
  const message: string = error instanceof Error ? error.message : String(error);
  return (
    message.includes('The extensions gallery cannot be scripted') ||
    message.includes('Cannot access a chrome:// URL') ||
    message.includes('Cannot access contents of url') ||
    message.includes('Missing host permission')
  );
}

/** Inject the registered content asset into eligible documents already open. */
export async function injectIntoExistingTabs(
  file: string,
  reportError: (error: unknown) => void,
): Promise<void> {
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({
      url: ['http://*/*', 'https://*/*'],
    });
  } catch (error: unknown) {
    reportError(error);
    return;
  }
  const injectedTabIds: Set<number> = new Set<number>();
  for (const tab of tabs) {
    if (tab.id === undefined || injectedTabIds.has(tab.id)) continue;
    injectedTabIds.add(tab.id);
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [file],
      });
    } catch (error: unknown) {
      if (!isUnsupportedPageInjectionFailure(error)) reportError(error);
    }
  }
}

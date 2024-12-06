import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Engine, LiveTabState } from '../../../src/background/engine';
import {
  applyBlockingFactory,
  applyToTab,
  planTabAction,
  registerTabListeners,
} from '../../../src/background/tabs';
import { emptySnapshot } from '../../../src/shared/constants';
import type { Verdict } from '../../../src/shared/types';

const blocked: Verdict = { blocked: true, reason: 'custom', matchedPattern: 'facebook.com' };
const allowed: Verdict = { blocked: false, reason: 'default', matchedPattern: null };

describe('planTabAction', () => {
  it('blocks a fresh tab: applyBlock plus mute, recording the prior state', () => {
    expect(
      planTabAction(blocked, {
        muted: false,
        wasMutedByUs: false,
        priorMuted: false,
        wasStopped: false,
      }),
    ).toEqual({ command: 'applyBlock', mute: true, reload: false });
  });

  it('blocks a tab the user muted themselves: still records and mutes once', () => {
    expect(
      planTabAction(blocked, {
        muted: true,
        wasMutedByUs: false,
        priorMuted: false,
        wasStopped: false,
      }),
    ).toEqual({ command: 'applyBlock', mute: true, reload: false });
  });

  it('does not re-mute a tab already muted by us', () => {
    expect(
      planTabAction(blocked, {
        muted: true,
        mutedByExtension: true,
        wasMutedByUs: true,
        priorMuted: false,
        wasStopped: false,
      }),
    ).toEqual({ command: 'applyBlock', mute: null, reload: false });
  });

  it('re-mutes a persisted worker-muted tab that is live-unmuted', () => {
    expect(
      planTabAction(blocked, {
        muted: false,
        wasMutedByUs: true,
        priorMuted: true,
        wasStopped: false,
      }),
    ).toEqual({ command: 'applyBlock', mute: true, reload: false });
  });

  it('reloads the exact stopped document without requiring mute ownership', () => {
    expect(
      planTabAction(allowed, {
        muted: false,
        mutedByExtension: false,
        wasMutedByUs: false,
        priorMuted: false,
        wasStopped: true,
      }),
    ).toEqual({ command: 'clearBlock', mute: null, reload: true });
  });

  it('clears with mute restore: puts the recorded prior state back', () => {
    expect(
      planTabAction(allowed, {
        muted: true,
        mutedByExtension: true,
        wasMutedByUs: true,
        priorMuted: true,
        wasStopped: false,
      }),
    ).toEqual({ command: 'clearBlock', mute: true, reload: false });
  });

  it('clears a stopped tab with a reload', () => {
    expect(
      planTabAction(allowed, {
        muted: true,
        mutedByExtension: true,
        wasMutedByUs: true,
        priorMuted: false,
        wasStopped: true,
      }),
    ).toEqual({ command: 'clearBlock', mute: false, reload: true });
  });

  it('does not restore mute without attribution but still reloads the stopped document', () => {
    const foreignMutedState = {
      muted: true,
      mutedByExtension: false,
      wasMutedByUs: true,
      priorMuted: false,
      wasStopped: true,
    };

    expect(planTabAction(allowed, foreignMutedState)).toEqual({
      command: 'clearBlock',
      mute: null,
      reload: true,
    });
  });

  it('clears a tab we never touched without side effects', () => {
    expect(
      planTabAction(allowed, {
        muted: false,
        wasMutedByUs: false,
        priorMuted: false,
        wasStopped: false,
      }),
    ).toEqual({ command: 'clearBlock', mute: null, reload: false });
  });
});

describe('applyToTab', () => {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const update = vi.fn().mockResolvedValue(undefined);
  const reload = vi.fn().mockResolvedValue(undefined);
  const get = vi.fn();
  type MutableTabState = {
    url: string;
    mutedInfo: { muted: boolean; extensionId?: string };
  };
  let liveUrl: string;

  beforeEach((): void => {
    sendMessage.mockReset().mockResolvedValue(undefined);
    update.mockReset().mockResolvedValue(undefined);
    reload.mockReset().mockResolvedValue(undefined);
    get.mockReset();
    liveUrl = 'https://facebook.com/feed';
    get.mockImplementation(async (): Promise<{ url: string }> => ({ url: liveUrl }));
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: { sendMessage, update, reload, get },
    });
  });

  afterEach((): void => {
    vi.unstubAllGlobals();
  });

  function engineFor(verdict: Verdict, stopped = false): Engine {
    return {
      verdictFor: vi.fn(() => verdict),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn(() => ({
        wasMutedByUs: !verdict.blocked,
        priorMuted: false,
        wasStopped: stopped,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      noteMuted: vi.fn(),
      claimMute: vi.fn().mockResolvedValue(true),
      releaseMuteClaim: vi.fn().mockResolvedValue(undefined),
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      reportError: vi.fn(),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine;
  }

  function durableEngineFor(
    verdictForUrl: (url: string) => Verdict,
    initialClaim: { url: string; priorMuted: boolean } | null = null,
  ): Engine {
    let claim: { url: string; priorMuted: boolean } | null = initialClaim;
    return {
      verdictFor: vi.fn(verdictForUrl),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn((_tabId: number, url: string) => ({
        wasMutedByUs: claim?.url === url,
        priorMuted: claim?.url === url ? claim.priorMuted : false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute: vi.fn(
        async (_tabId: number, url: string, priorMuted: boolean): Promise<boolean> => {
          claim = { url, priorMuted };
          return true;
        },
      ),
      releaseMuteClaim: vi.fn(async (_tabId: number, url: string): Promise<void> => {
        if (claim?.url === url) claim = null;
      }),
      transferMuteClaim: vi.fn(
        async (_tabId: number, fromUrl: string, toUrl: string): Promise<void> => {
          if (claim?.url === fromUrl) claim = { ...claim, url: toUrl };
        },
      ),
      reportError: vi.fn(),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine;
  }

  function hasDurableMuteClaim(engine: Engine, url: string): boolean {
    return engine.tabFacts(7, url, null).wasMutedByUs;
  }

  it('records a blocked SPA verdict as an existing-tab attempt', async () => {
    const engine: Engine = engineFor(blocked);

    await applyToTab(engine, 7, 'https://facebook.com/feed', false);

    expect(engine.recordAttempt).toHaveBeenCalledWith('https://facebook.com/feed', 7, 'existing');
    expect(engine.tabFacts).toHaveBeenCalledWith(7, 'https://facebook.com/feed', null);
    expect(engine.claimMute).toHaveBeenCalledWith(7, 'https://facebook.com/feed', false);
  });

  it('waits for durable mute ownership before muting the tab', async () => {
    const engine: Engine = engineFor(blocked);
    let releaseClaim: (claimed: boolean) => void = (): void => {};
    let signalClaim: () => void = (): void => {};
    const claimStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalClaim = resolve;
    });
    vi.mocked(engine.claimMute).mockImplementationOnce(
      (): Promise<boolean> =>
        new Promise((resolve: (claimed: boolean) => void): void => {
          releaseClaim = resolve;
          signalClaim();
        }),
    );

    const pending: Promise<void> = applyToTab(engine, 7, 'https://facebook.com/feed', false);
    await claimStarted;

    expect(update).not.toHaveBeenCalled();
    releaseClaim(true);
    await pending;
    expect(update).toHaveBeenCalledWith(7, { muted: true });
  });

  it('durably releases mute ownership when Chrome rejects the mute', async () => {
    const engine: Engine = engineFor(blocked);
    let releaseRollback: () => void = (): void => {};
    let signalRollback: () => void = (): void => {};
    const rollbackStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalRollback = resolve;
    });
    update.mockRejectedValueOnce(new Error('mute failed'));
    vi.mocked(engine.releaseMuteClaim).mockImplementationOnce(
      (): Promise<void> =>
        new Promise((resolve: () => void): void => {
          releaseRollback = resolve;
          signalRollback();
        }),
    );

    const pending: Promise<void> = applyToTab(engine, 7, 'https://facebook.com/feed', false);
    const firstCompletion: 'rollback' | 'done' = await Promise.race([
      rollbackStarted.then((): 'rollback' => 'rollback'),
      pending.then((): 'done' => 'done'),
    ]);

    expect(firstCompletion).toBe('rollback');
    releaseRollback();
    await pending;
    expect(engine.releaseMuteClaim).toHaveBeenCalledWith(7, 'https://facebook.com/feed');
  });

  it('releases new ownership when a foreign mute appears after Chrome rejects the mute', async () => {
    const engine: Engine = engineFor(blocked);
    update.mockImplementationOnce(async (): Promise<void> => {
      get.mockResolvedValue({
        url: liveUrl,
        mutedInfo: { muted: true, extensionId: 'another-extension' },
      });
      throw new Error('mute failed');
    });

    await applyToTab(engine, 7, 'https://facebook.com/feed', false);

    expect(engine.releaseMuteClaim).toHaveBeenCalledWith(7, 'https://facebook.com/feed');
    expect(engine.transferMuteClaim).not.toHaveBeenCalled();
  });

  it('releases new ownership when a successful mute remains foreign-attributed', async () => {
    const engine: Engine = engineFor(blocked);
    update.mockImplementationOnce(async (): Promise<void> => {
      get.mockResolvedValue({
        url: liveUrl,
        mutedInfo: { muted: true, extensionId: 'another-extension' },
      });
    });

    await applyToTab(engine, 7, 'https://facebook.com/feed', false);

    expect(engine.releaseMuteClaim).toHaveBeenCalledWith(7, 'https://facebook.com/feed');
  });

  it('does not overwrite a user mute that appears while ownership is persisted', async () => {
    const engine: Engine = engineFor(blocked);
    vi.mocked(engine.claimMute).mockImplementationOnce(async (): Promise<boolean> => {
      get.mockResolvedValue({ url: liveUrl, mutedInfo: { muted: true } });
      return true;
    });

    await applyToTab(engine, 7, 'https://facebook.com/feed', false);

    expect(update).not.toHaveBeenCalled();
    expect(engine.releaseMuteClaim).toHaveBeenCalledWith(7, 'https://facebook.com/feed');
  });

  it('does not restore over a foreign mute that appears while content clears', async () => {
    const engine: Engine = engineFor(allowed);
    sendMessage.mockImplementationOnce(async (): Promise<void> => {
      get.mockResolvedValue({
        url: liveUrl,
        mutedInfo: { muted: true, extensionId: 'another-extension' },
      });
    });

    await applyToTab(engine, 7, 'https://facebook.com/feed', true, 'existing', true);

    expect(update).not.toHaveBeenCalled();
    expect(engine.releaseMuteClaim).toHaveBeenCalledWith(7, 'https://facebook.com/feed');
  });

  it('does not reload a reused tab id when the replacement has the same URL', async () => {
    const engine: Engine = engineFor(allowed, true);
    vi.mocked(engine.tabFacts).mockReturnValue({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: true,
    });
    let getCalls = 0;
    let currentDocumentId = 'document-one';
    get.mockImplementation(async (): Promise<{ url: string }> => {
      getCalls += 1;
      if (getCalls === 3) currentDocumentId = 'document-two';
      return { url: liveUrl };
    });
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: { sendMessage, update, reload, get },
      webNavigation: {
        getFrame: vi.fn(
          async (): Promise<{ documentId: string }> => ({
            documentId: currentDocumentId,
          }),
        ),
      },
    });

    await applyToTab(
      engine,
      7,
      'https://facebook.com/feed',
      false,
      'existing',
      false,
      'document-one',
    );

    expect(reload).not.toHaveBeenCalled();
  });

  it('preserves a user mute when Chrome does not attribute it to the extension', async () => {
    const engine: Engine = engineFor(blocked);
    get.mockResolvedValue({ url: liveUrl, mutedInfo: { muted: true } });

    await applyToTab(engine, 7, 'https://facebook.com/feed', true);

    expect(engine.claimMute).not.toHaveBeenCalled();
    expect(engine.releaseMuteClaim).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('transfers durable mute ownership when navigation completes during muting', async () => {
    const engine: Engine = engineFor(blocked);
    update.mockImplementationOnce(async (): Promise<void> => {
      liveUrl = 'https://blocked.example/new';
      get.mockResolvedValue({
        url: liveUrl,
        mutedInfo: { muted: true, extensionId: 'focus-lock' },
      });
    });

    await applyToTab(engine, 7, 'https://facebook.com/feed', false);

    expect(engine.transferMuteClaim).toHaveBeenCalledWith(
      7,
      'https://facebook.com/feed',
      'https://blocked.example/new',
    );
  });

  it('restores prior mute after a transient post-mute tab read failure', async () => {
    let currentVerdict: Verdict = blocked;
    let muted = false;
    let rejectPostMuteRead = true;
    const transientError = new Error('transient tab read failure');
    const engine: Engine = durableEngineFor((): Verdict => currentVerdict);
    get.mockImplementation(async (): Promise<MutableTabState> => {
      if (muted && rejectPostMuteRead) {
        rejectPostMuteRead = false;
        throw transientError;
      }
      return {
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      };
    });
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
      },
    );

    await applyToTab(engine, 7, liveUrl, false);
    currentVerdict = allowed;
    await applyToTab(engine, 7, liveUrl, muted, 'existing', true);

    expect(engine.reportError).toHaveBeenCalledOnce();
    expect(engine.reportError).toHaveBeenCalledWith(transientError);
    expect(muted).toBe(false);
    expect(update).toHaveBeenNthCalledWith(2, 7, { muted: false });
    expect(hasDurableMuteClaim(engine, liveUrl)).toBe(false);
  });

  it('preserves ownership when the post-mute tab read has no URL', async () => {
    let muted = false;
    const engine: Engine = durableEngineFor((): Verdict => blocked);
    get.mockImplementation(
      async (): Promise<{ url?: string; mutedInfo: { muted: boolean; extensionId?: string } }> => ({
        ...(muted ? {} : { url: liveUrl }),
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      }),
    );
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
      },
    );

    await applyToTab(engine, 7, liveUrl, false);

    expect(engine.reportError).toHaveBeenCalledOnce();
    expect(engine.releaseMuteClaim).not.toHaveBeenCalled();
  });

  it('restores prior mute when successful muting lands on an allowed URL', async () => {
    const allowedUrl = 'https://example.com/after-mute';
    let muted = false;
    let navigateOnMute = true;
    const engine: Engine = durableEngineFor(
      (url: string): Verdict => (url === allowedUrl ? allowed : blocked),
    );
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      }),
    );
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
        if (properties.muted === true && navigateOnMute) {
          navigateOnMute = false;
          liveUrl = allowedUrl;
        }
      },
    );

    await applyToTab(engine, 7, 'https://facebook.com/feed', false);

    expect(engine.verdictFor).toHaveBeenCalledWith(allowedUrl);
    expect(engine.recordAttempt).toHaveBeenCalledOnce();
    expect(muted).toBe(false);
    expect(hasDurableMuteClaim(engine, allowedUrl)).toBe(false);
  });

  it('reports a rejected corrective mute update without releasing ownership', async () => {
    const allowedUrl = 'https://example.com/correction-fails';
    const correctionError = new Error('corrective update failed');
    let muted = false;
    const engine: Engine = durableEngineFor(
      (url: string): Verdict => (url === allowedUrl ? allowed : blocked),
    );
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      }),
    );
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted === false) throw correctionError;
        if (properties.muted !== undefined) muted = properties.muted;
        liveUrl = allowedUrl;
      },
    );

    await applyToTab(engine, 7, 'https://facebook.com/feed', false);

    expect(engine.reportError).toHaveBeenCalledWith(correctionError);
    expect(engine.releaseMuteClaim).not.toHaveBeenCalled();
  });

  it('corrects an applied mute when the initial update rejects after allowed navigation', async () => {
    const sourceUrl = 'https://facebook.com/before-rejected-mute';
    const allowedUrl = 'https://example.com/after-rejected-mute';
    const updateError = new Error('initial mute update rejected');
    liveUrl = sourceUrl;
    let muted = false;
    const engine: Engine = durableEngineFor(
      (url: string): Verdict => (url === allowedUrl ? allowed : blocked),
    );
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      }),
    );
    update
      .mockImplementationOnce(
        async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
          if (properties.muted !== undefined) muted = properties.muted;
          liveUrl = allowedUrl;
          throw updateError;
        },
      )
      .mockImplementationOnce(
        async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
          if (properties.muted !== undefined) muted = properties.muted;
        },
      );

    await applyToTab(engine, 7, sourceUrl, false);

    expect(engine.reportError).toHaveBeenCalledWith(updateError);
    expect(engine.verdictFor).toHaveBeenCalledWith(allowedUrl);
    expect(update).toHaveBeenNthCalledWith(2, 7, { muted: false });
    expect(muted).toBe(false);
    expect(hasDurableMuteClaim(engine, allowedUrl)).toBe(false);
    expect(engine.recordAttempt).toHaveBeenCalledOnce();
  });

  it('reapplies mute when successful restoration lands on a blocked URL', async () => {
    const allowedUrl = 'https://example.com/before-restore';
    const blockedUrl = 'https://facebook.com/after-restore';
    liveUrl = allowedUrl;
    let muted = true;
    let navigateOnRestore = true;
    const engine: Engine = durableEngineFor(
      (url: string): Verdict => (url === blockedUrl ? blocked : allowed),
      { url: allowedUrl, priorMuted: false },
    );
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      }),
    );
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
        if (properties.muted === false && navigateOnRestore) {
          navigateOnRestore = false;
          liveUrl = blockedUrl;
        }
      },
    );

    await applyToTab(engine, 7, allowedUrl, true, 'existing', true);

    expect(engine.verdictFor).toHaveBeenCalledWith(blockedUrl);
    expect(muted).toBe(true);
    expect(hasDurableMuteClaim(engine, allowedUrl)).toBe(false);
    expect(hasDurableMuteClaim(engine, blockedUrl)).toBe(true);
  });

  it('reapplies mute when the initial restore rejects after blocked navigation', async () => {
    const allowedUrl = 'https://example.com/before-rejected-restore';
    const blockedUrl = 'https://facebook.com/after-rejected-restore';
    const updateError = new Error('initial restore update rejected');
    liveUrl = allowedUrl;
    let muted = true;
    const engine: Engine = durableEngineFor(
      (url: string): Verdict => (url === blockedUrl ? blocked : allowed),
      { url: allowedUrl, priorMuted: false },
    );
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      }),
    );
    update
      .mockImplementationOnce(
        async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
          if (properties.muted !== undefined) muted = properties.muted;
          liveUrl = blockedUrl;
          throw updateError;
        },
      )
      .mockImplementationOnce(
        async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
          if (properties.muted !== undefined) muted = properties.muted;
        },
      );

    await applyToTab(engine, 7, allowedUrl, true, 'existing', true);

    expect(engine.reportError).toHaveBeenCalledWith(updateError);
    expect(engine.verdictFor).toHaveBeenCalledWith(blockedUrl);
    expect(update).toHaveBeenNthCalledWith(2, 7, { muted: true });
    expect(muted).toBe(true);
    expect(hasDurableMuteClaim(engine, allowedUrl)).toBe(false);
    expect(hasDurableMuteClaim(engine, blockedUrl)).toBe(true);
  });

  it('preserves ownership when replacement-document lookup rejects after restore', async () => {
    const allowedUrl = 'https://example.com/same-url-replacement';
    const frameError = new Error('transient frame read failure');
    liveUrl = allowedUrl;
    let muted = true;
    let documentId = 'document-one';
    const engine: Engine = durableEngineFor((): Verdict => allowed, {
      url: allowedUrl,
      priorMuted: false,
    });
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      }),
    );
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
        documentId = 'document-two';
      },
    );
    const getFrame = vi.fn().mockImplementation(async (): Promise<{ documentId: string }> => {
      if (documentId === 'document-two') throw frameError;
      return { documentId };
    });
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: { sendMessage, update, reload, get },
      webNavigation: { getFrame },
    });

    await applyToTab(engine, 7, allowedUrl, true, 'existing', true, 'document-one');

    expect(engine.reportError).toHaveBeenCalledWith(frameError);
    expect(engine.releaseMuteClaim).not.toHaveBeenCalled();
    expect(hasDurableMuteClaim(engine, allowedUrl)).toBe(true);
  });

  it('settles a second identity change during bounded mute correction', async () => {
    const firstAllowedUrl = 'https://example.com/first-race';
    const secondBlockedUrl = 'https://facebook.com/second-race';
    let muted = false;
    let updateCount = 0;
    const engine: Engine = durableEngineFor(
      (url: string): Verdict => (url === firstAllowedUrl ? allowed : blocked),
    );
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      }),
    );
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        updateCount += 1;
        if (properties.muted !== undefined) muted = properties.muted;
        if (updateCount === 1) liveUrl = firstAllowedUrl;
        if (updateCount === 2) liveUrl = secondBlockedUrl;
      },
    );

    await applyToTab(engine, 7, 'https://facebook.com/feed', false);

    expect(muted).toBe(true);
    expect(update).toHaveBeenCalledTimes(3);
    expect(engine.recordAttempt).toHaveBeenCalledOnce();
    expect(hasDurableMuteClaim(engine, secondBlockedUrl)).toBe(true);
  });

  it('reports bounded correction exhaustion without releasing ownership', async () => {
    const racedUrls = [
      'https://example.com/race-one',
      'https://facebook.com/race-two',
      'https://example.com/race-three',
      'https://facebook.com/race-four',
    ];
    let muted = false;
    let updateCount = 0;
    const engine: Engine = durableEngineFor(
      (url: string): Verdict => (url.includes('facebook.com') ? blocked : allowed),
    );
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      }),
    );
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
        const racedUrl: string | undefined = racedUrls[updateCount];
        updateCount += 1;
        if (racedUrl !== undefined) liveUrl = racedUrl;
      },
    );

    await applyToTab(engine, 7, 'https://facebook.com/feed', false);

    expect(engine.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Tab 7 exceeded the mute correction limit' }),
    );
    expect(engine.releaseMuteClaim).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(4);
    expect(hasDurableMuteClaim(engine, 'https://facebook.com/race-four')).toBe(true);
  });

  it('re-evaluates the same URL when muting completes in a replacement document', async () => {
    let muted = false;
    let documentId = 'document-one';
    const engine: Engine = durableEngineFor((): Verdict => blocked);
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      }),
    );
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
        if (properties.muted === true) documentId = 'document-two';
      },
    );
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: { sendMessage, update, reload, get },
      webNavigation: {
        getFrame: vi.fn(
          async (): Promise<{ documentId: string }> => ({
            documentId,
          }),
        ),
      },
    });

    await applyToTab(
      engine,
      7,
      'https://facebook.com/feed',
      false,
      'existing',
      false,
      'document-one',
    );

    expect(engine.verdictFor).toHaveBeenCalledTimes(2);
    expect(engine.recordAttempt).toHaveBeenCalledOnce();
  });

  it('records a committed navigation as fresh and preserves persisted restore state', async () => {
    const engine: Engine = engineFor(blocked);
    vi.mocked(engine.tabFacts).mockReturnValue({
      wasMutedByUs: true,
      priorMuted: true,
      wasStopped: false,
    });

    get.mockResolvedValue({
      url: liveUrl,
      mutedInfo: { muted: true, extensionId: 'focus-lock' },
    });

    await applyToTab(engine, 7, 'https://facebook.com/feed', false, 'navigation', true);

    expect(engine.recordAttempt).toHaveBeenCalledWith('https://facebook.com/feed', 7, 'navigation');
    expect(update).not.toHaveBeenCalled();
    expect(engine.claimMute).not.toHaveBeenCalled();
  });

  it('keeps mute bookkeeping when Chrome fails to restore mute state', async () => {
    const engine: Engine = engineFor(allowed);
    liveUrl = 'https://example.com';
    update.mockRejectedValueOnce(new Error('tab closed'));

    await applyToTab(engine, 7, 'https://example.com', true, 'existing', true);

    expect(engine.noteMuteRestored).not.toHaveBeenCalled();
  });

  it('keeps stopped bookkeeping when Chrome fails to reload the tab', async () => {
    const engine: Engine = engineFor(allowed, true);
    liveUrl = 'https://example.com';
    reload.mockRejectedValueOnce(new Error('tab closed'));

    await applyToTab(engine, 7, 'https://example.com', true, 'existing', true);

    expect(engine.noteReloaded).not.toHaveBeenCalled();
  });

  it('skips mute side effects when the tab navigates during messaging', async () => {
    const engine: Engine = engineFor(blocked);
    sendMessage.mockImplementationOnce(async (): Promise<void> => {
      liveUrl = 'https://allowed.example/new';
    });

    await applyToTab(engine, 7, 'https://facebook.com/feed', false);

    expect(update).not.toHaveBeenCalled();
    expect(engine.claimMute).not.toHaveBeenCalled();
  });

  it('skips the content command when the tab already navigated', async () => {
    const engine: Engine = engineFor(blocked);
    liveUrl = 'https://allowed.example/new';

    await applyToTab(engine, 7, 'https://facebook.com/feed', false);

    expect(engine.recordAttempt).not.toHaveBeenCalled();
    expect(engine.tabFacts).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('skips tab state lookup when the tab navigates during attempt recording', async () => {
    const engine: Engine = engineFor(blocked);
    vi.mocked(engine.recordAttempt).mockImplementationOnce(async (): Promise<void> => {
      liveUrl = 'https://allowed.example/new';
    });

    await applyToTab(engine, 7, 'https://facebook.com/feed', false);

    expect(engine.tabFacts).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('registerTabListeners', () => {
  afterEach((): void => {
    vi.unstubAllGlobals();
  });

  it('reports detached navigation failures', async () => {
    type NavigationDetails = { tabId: number; url: string; frameId: number };
    const error = new Error('local storage unavailable');
    const reportError = vi.fn();
    let committedListener: ((details: NavigationDetails) => void) | undefined;
    vi.stubGlobal('chrome', {
      webNavigation: {
        onCommitted: {
          addListener: vi.fn((listener: (details: NavigationDetails) => void): void => {
            committedListener = listener;
          }),
        },
        onHistoryStateUpdated: { addListener: vi.fn() },
      },
    });
    registerTabListeners((): Promise<Engine> => Promise.reject(error), reportError);
    if (committedListener === undefined) throw new Error('committed listener was not registered');

    committedListener({ tabId: 7, url: 'https://blocked.example', frameId: 0 });
    await Promise.resolve();
    await Promise.resolve();

    expect(reportError).toHaveBeenCalledWith(error);
  });

  it('does not inherit stale ownership when a tab id is reused before ready resolves', async () => {
    type NavigationDetails = { tabId: number; url: string; frameId: number };
    const currentUrl = 'https://unrelated.example/new';
    let committedListener: ((details: NavigationDetails) => void) | undefined;
    let resolveReady: (engine: Engine) => void = (): void => {};
    let signalFlushed: () => void = (): void => {};
    const ready: Promise<Engine> = new Promise((resolve: (engine: Engine) => void): void => {
      resolveReady = resolve;
    });
    const flushed: Promise<void> = new Promise((resolve: () => void): void => {
      signalFlushed = resolve;
    });
    let ownedUrl = 'https://blocked.example/old';
    const rebindTab = vi.fn((_tabId: number, url: string): void => {
      ownedUrl = url;
    });
    const update = vi.fn().mockResolvedValue(undefined);
    const reload = vi.fn().mockResolvedValue(undefined);
    const engine: Engine = {
      rebindTab,
      verdictFor: vi.fn((): Verdict => allowed),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn((_tabId: number, url: string) =>
        ownedUrl === url
          ? { wasMutedByUs: true, priorMuted: false, wasStopped: true }
          : { wasMutedByUs: false, priorMuted: false, wasStopped: false },
      ),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute: vi.fn().mockResolvedValue(true),
      releaseMuteClaim: vi.fn().mockResolvedValue(undefined),
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
      flushRuntime: vi.fn(async (): Promise<void> => {
        signalFlushed();
      }),
    } as unknown as Engine;
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 7,
          url: currentUrl,
          mutedInfo: { muted: false },
        }),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update,
        reload,
      },
      webNavigation: {
        onCommitted: {
          addListener: vi.fn((listener: (details: NavigationDetails) => void): void => {
            committedListener = listener;
          }),
        },
        onHistoryStateUpdated: { addListener: vi.fn() },
      },
    });
    registerTabListeners((): Promise<Engine> => ready, vi.fn());
    if (committedListener === undefined) throw new Error('committed listener was not registered');

    committedListener({ tabId: 7, url: currentUrl, frameId: 0 });
    resolveReady(engine);
    await flushed;

    expect(rebindTab).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('rebinds ownership when the extension mute confirms the navigating tab', async () => {
    type NavigationDetails = { tabId: number; url: string; frameId: number };
    const currentUrl = 'https://blocked.example/new';
    let committedListener: ((details: NavigationDetails) => void) | undefined;
    const rebindTab = vi.fn();
    const flushRuntime = vi.fn().mockResolvedValue(undefined);
    const engine: Engine = {
      rebindTab,
      verdictFor: vi.fn((): Verdict => blocked),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn(() => ({
        wasMutedByUs: true,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute: vi.fn().mockResolvedValue(true),
      releaseMuteClaim: vi.fn().mockResolvedValue(undefined),
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
      flushRuntime,
    } as unknown as Engine;
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 7,
          url: currentUrl,
          mutedInfo: { muted: true, extensionId: 'focus-lock' },
        }),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
      },
      webNavigation: {
        onCommitted: {
          addListener: vi.fn((listener: (details: NavigationDetails) => void): void => {
            committedListener = listener;
          }),
        },
        onHistoryStateUpdated: { addListener: vi.fn() },
      },
    });
    registerTabListeners((): Promise<Engine> => Promise.resolve(engine), vi.fn());
    if (committedListener === undefined) throw new Error('committed listener was not registered');

    committedListener({ tabId: 7, url: currentUrl, frameId: 0 });
    await vi.waitFor((): void => {
      expect(flushRuntime).toHaveBeenCalledTimes(1);
    });

    expect(rebindTab).toHaveBeenCalledWith(7, currentUrl);
  });
});

describe('applyBlockingFactory', () => {
  afterEach((): void => {
    vi.unstubAllGlobals();
  });

  it('reconciles bookkeeping against live tab id and URL identities', async () => {
    const reconcileTabs = vi.fn();
    const flushRuntime = vi.fn().mockResolvedValue(undefined);
    const engine: Engine = {
      reconcileTabs,
      flushRuntime,
      verdictFor: vi.fn((): Verdict => allowed),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn(() => ({
        wasMutedByUs: false,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      noteMuted: vi.fn(),
      claimMute: vi.fn().mockResolvedValue(true),
      releaseMuteClaim: vi.fn().mockResolvedValue(undefined),
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine;
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query: vi
          .fn()
          .mockResolvedValue([
            { id: 7, url: 'https://example.com', mutedInfo: { muted: false } },
            { id: 8 },
            { id: 9, url: '' },
            { url: 'https://missing-id.example' },
          ]),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(async (): Promise<{ url: string }> => ({ url: 'https://example.com' })),
      },
    });

    await applyBlockingFactory((): Engine => engine)();

    expect(reconcileTabs).toHaveBeenCalledTimes(1);
    const reconciled: ReadonlyMap<number, LiveTabState> | undefined =
      vi.mocked(reconcileTabs).mock.calls[0]?.[0];
    expect(reconciled).toBeDefined();
    expect([...(reconciled ?? new Map<number, LiveTabState>())]).toEqual([
      [7, { url: 'https://example.com', mutedByExtension: false, documentId: null }],
    ]);
    expect(flushRuntime).toHaveBeenCalledTimes(1);
  });
});

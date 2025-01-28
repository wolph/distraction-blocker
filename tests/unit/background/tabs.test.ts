import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine, type EnginePorts, type LiveTabState } from '../../../src/background/engine';
import { emptyRuntime } from '../../../src/background/stores';
import {
  applyBlockingFactory,
  applyToTab,
  invalidateRemovedTab,
  planTabAction,
  registerTabListeners,
} from '../../../src/background/tabs';
import { DEFAULT_LISTS, DEFAULT_SETTINGS, emptySnapshot } from '../../../src/shared/constants';
import type { EventRecord, Verdict } from '../../../src/shared/types';

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
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
  }

  function deferred<T>(): Deferred<T> {
    let resolve: (value: T) => void = (): void => {
      throw new Error('deferred resolver was not initialized');
    };
    const promise: Promise<T> = new Promise((done: (value: T) => void): void => {
      resolve = done;
    });
    return { promise, resolve };
  }

  async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout: Promise<never> = new Promise(
      (_resolve: (value: never) => void, reject: (error: Error) => void): void => {
        timer = setTimeout((): void => reject(new Error(`${label} timed out`)), 1_000);
      },
    );
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  function nextMacrotask(): Promise<void> {
    return new Promise((resolve: () => void): void => {
      setTimeout(resolve, 0);
    });
  }

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
      settleMuteClaim: vi.fn().mockResolvedValue(undefined),
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
      settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
        if (finalUrl === null) {
          claim = null;
        } else if (claim !== null) {
          claim = { ...claim, url: finalUrl };
        }
      }),
      rebindTab: vi.fn((_tabId: number, url: string): void => {
        if (claim !== null) claim = { ...claim, url };
      }),
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

  it('does not apply an older same-tab operation after its persistence resolves', async () => {
    const url = 'https://facebook.com/same-tab-intent';
    const persistenceGate: Deferred<void> = deferred();
    const persistenceStarted: Deferred<void> = deferred();
    const engine: Engine = engineFor(blocked);
    vi.mocked(engine.recordAttempt)
      .mockImplementationOnce(async (): Promise<void> => {
        persistenceStarted.resolve(undefined);
        await persistenceGate.promise;
      })
      .mockResolvedValueOnce(undefined);
    liveUrl = url;

    const older: Promise<void> = applyToTab(engine, 7, url, false, 'navigation');
    await withTimeout(persistenceStarted.promise, 'older operation persistence');
    await withTimeout(applyToTab(engine, 7, url, false, 'navigation'), 'newer same-tab operation');
    expect(sendMessage).toHaveBeenCalledTimes(1);

    persistenceGate.resolve(undefined);
    await withTimeout(older, 'older operation completion');

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('does not send an older operation after a newer intent arrives during final validation', async () => {
    const url = 'https://facebook.com/final-validation';
    const finalReadGate: Deferred<{ url: string }> = deferred();
    const finalReadStarted: Deferred<void> = deferred();
    let reads = 0;
    get.mockImplementation(async (): Promise<{ url: string }> => {
      reads += 1;
      if (reads === 4) {
        finalReadStarted.resolve(undefined);
        return finalReadGate.promise;
      }
      return { url };
    });
    const engine: Engine = engineFor(blocked);

    const older: Promise<void> = applyToTab(engine, 7, url, false, 'navigation');
    await withTimeout(finalReadStarted.promise, 'older final URL validation');
    const newer: Promise<void> = applyToTab(engine, 7, url, false, 'navigation');
    finalReadGate.resolve({ url });
    await withTimeout(Promise.all([older, newer]), 'same-tab intent replacement');

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('does not mute from an older operation after a newer intent arrives', async () => {
    const url = 'https://facebook.com/mute-intent';
    const muteReadGate: Deferred<MutableTabState> = deferred();
    const muteReadStarted: Deferred<void> = deferred();
    let reads = 0;
    let currentVerdict: Verdict = blocked;
    get.mockImplementation(async (): Promise<MutableTabState> => {
      reads += 1;
      if (reads === 5) {
        muteReadStarted.resolve(undefined);
        return muteReadGate.promise;
      }
      return { url, mutedInfo: { muted: false } };
    });
    const engine: Engine = durableEngineFor((): Verdict => currentVerdict);

    const older: Promise<void> = applyToTab(engine, 7, url, false, 'navigation');
    await withTimeout(muteReadStarted.promise, 'older mute-state read');
    currentVerdict = allowed;
    const newer: Promise<void> = applyToTab(engine, 7, url, false, 'existing');
    muteReadGate.resolve({ url, mutedInfo: { muted: false } });
    await withTimeout(Promise.all([older, newer]), 'mute intent replacement');

    expect(update).not.toHaveBeenCalled();
  });

  it('stops stale mute settlement when a newer same-document intent arrives', async () => {
    const url = 'https://facebook.com/settlement-intent';
    const settlementReadGate: Deferred<MutableTabState> = deferred();
    const settlementReadStarted: Deferred<void> = deferred();
    let reads = 0;
    let muted = false;
    let currentVerdict: Verdict = blocked;
    get.mockImplementation(async (): Promise<MutableTabState> => {
      reads += 1;
      const state: MutableTabState = {
        url,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      };
      if (reads === 7) {
        settlementReadStarted.resolve(undefined);
        return settlementReadGate.promise;
      }
      return state;
    });
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
      },
    );
    const engine: Engine = durableEngineFor((): Verdict => currentVerdict);

    const older: Promise<void> = applyToTab(engine, 7, url, false, 'navigation');
    await withTimeout(settlementReadStarted.promise, 'older settlement identity read');
    currentVerdict = allowed;
    const newer: Promise<void> = applyToTab(engine, 7, url, true, 'existing', true);
    settlementReadGate.resolve({
      url,
      mutedInfo: { muted: true, extensionId: 'focus-lock' },
    });
    await withTimeout(Promise.all([older, newer]), 'settlement intent replacement');

    expect(engine.settleMuteClaim).toHaveBeenCalledTimes(1);
  });

  it.each(['apply', 'restore'] as const)(
    'releases old ownership when the initial %s tab read resolves on a newer URL',
    async (path: 'apply' | 'restore'): Promise<void> => {
      const oldUrl =
        path === 'apply'
          ? 'https://facebook.com/initial-read-apply-old'
          : 'https://allowed.example/initial-read-restore-old';
      const newUrl = 'https://facebook.com/initial-read-new';
      const initialReadStarted: Deferred<void> = deferred();
      const releaseInitialRead: Deferred<void> = deferred();
      let gateNextRead = false;
      let liveUrl = oldUrl;
      let muted = path === 'restore';
      let claim: { priorMuted: boolean; url: string } | null = { priorMuted: false, url: oldUrl };
      const claimMute = vi.fn(
        async (_tabId: number, inputUrl: string, priorMuted: boolean): Promise<boolean> => {
          if (claim !== null && claim.url !== inputUrl) return false;
          claim = { priorMuted, url: inputUrl };
          return true;
        },
      );
      const releaseMuteClaim = vi.fn(async (_tabId: number, inputUrl: string): Promise<void> => {
        if (claim?.url === inputUrl) claim = null;
      });
      const engine: Engine = {
        verdictFor: vi.fn((inputUrl: string): Verdict => {
          if (inputUrl === oldUrl && path === 'restore') return allowed;
          return blocked;
        }),
        snapshot: vi.fn(() => emptySnapshot(0)),
        tabFacts: vi.fn((_tabId: number, inputUrl: string) => ({
          wasMutedByUs: claim?.url === inputUrl,
          priorMuted: claim?.url === inputUrl ? claim.priorMuted : false,
          wasStopped: false,
        })),
        recordAttempt: vi.fn().mockResolvedValue(undefined),
        claimMute,
        releaseMuteClaim,
        transferMuteClaim: vi.fn().mockResolvedValue(undefined),
        settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
          if (finalUrl === null) {
            claim = null;
          } else if (claim !== null) {
            claim = { ...claim, url: finalUrl };
          }
        }),
        rebindTab: vi.fn(),
        reportError: vi.fn(),
        noteMuteRestored: vi.fn(),
        noteReloaded: vi.fn(),
      } as unknown as Engine;
      sendMessage.mockImplementationOnce(async (): Promise<void> => {
        gateNextRead = true;
      });
      get.mockImplementation(async (): Promise<MutableTabState> => {
        if (gateNextRead) {
          gateNextRead = false;
          initialReadStarted.resolve(undefined);
          await releaseInitialRead.promise;
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

      const older: Promise<void> = applyToTab(engine, 7, oldUrl, muted, 'existing', muted);
      await initialReadStarted.promise;
      liveUrl = newUrl;
      muted = false;
      const newer: Promise<void> = applyToTab(engine, 7, newUrl, false, 'navigation');
      releaseInitialRead.resolve(undefined);
      await Promise.all([older, newer]);

      expect(releaseMuteClaim).toHaveBeenCalledWith(7, oldUrl);
      expect(claimMute).toHaveBeenCalledWith(7, newUrl, false);
      expect(claim).toEqual({ priorMuted: false, url: newUrl });
      expect(muted).toBe(true);
      expect(update).toHaveBeenCalledOnce();
      expect(update).toHaveBeenCalledWith(7, { muted: true });
    },
  );

  it('releases existing ownership when apply second read resolves on newer URL', async () => {
    const oldUrl = 'https://facebook.com/second-read-existing-old';
    const newUrl = 'https://facebook.com/second-read-existing-new';
    const secondReadStarted: Deferred<void> = deferred();
    const releaseSecondRead: Deferred<void> = deferred();
    let liveUrl = oldUrl;
    let muted = false;
    let effectsStarted = false;
    let effectReadCount = 0;
    const engine: Engine = durableEngineFor((): Verdict => blocked, {
      priorMuted: false,
      url: oldUrl,
    });
    sendMessage.mockImplementation(async (): Promise<void> => {
      effectsStarted = true;
    });
    get.mockImplementation(async (): Promise<MutableTabState> => {
      if (effectsStarted) {
        effectReadCount += 1;
        if (effectReadCount === 2) {
          secondReadStarted.resolve(undefined);
          await releaseSecondRead.promise;
        }
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

    const older: Promise<void> = applyToTab(engine, 7, oldUrl, false, 'existing');
    await withTimeout(secondReadStarted.promise, 'existing claim second apply read');
    liveUrl = newUrl;
    const newer: Promise<void> = applyToTab(engine, 7, newUrl, false, 'navigation');
    releaseSecondRead.resolve(undefined);
    await withTimeout(Promise.all([older, newer]), 'existing claim second-read handoff');

    expect(engine.releaseMuteClaim).toHaveBeenCalledWith(7, oldUrl);
    expect(engine.claimMute).toHaveBeenCalledWith(7, newUrl, false);
    expect(hasDurableMuteClaim(engine, oldUrl)).toBe(false);
    expect(hasDurableMuteClaim(engine, newUrl)).toBe(true);
    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith(7, { muted: true });
    expect(muted).toBe(true);
  });

  it('protects old ownership from an omitted sweep during attempt durability', async () => {
    const url = 'https://facebook.com/durability-protection';
    const persistenceStarted: Deferred<void> = deferred();
    const releasePersistence: Deferred<void> = deferred();
    let claimUrl: string | null = url;
    const engine: Engine = {
      verdictFor: vi.fn((): Verdict => blocked),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn((_tabId: number, inputUrl: string) => ({
        wasMutedByUs: claimUrl === inputUrl,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn(async (): Promise<void> => {
        persistenceStarted.resolve(undefined);
        await releasePersistence.promise;
      }),
      claimMute: vi.fn().mockResolvedValue(true),
      releaseMuteClaim: vi.fn(async (_tabId: number, inputUrl: string): Promise<void> => {
        if (claimUrl === inputUrl) claimUrl = null;
      }),
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      settleMuteClaim: vi.fn().mockResolvedValue(undefined),
      rebindTab: vi.fn(),
      reconcileTabs: vi.fn(
        (
          liveTabs: ReadonlyMap<number, LiveTabState>,
          protectedTabIds: ReadonlySet<number> = new Set(),
        ): void => {
          if (!liveTabs.has(7) && !protectedTabIds.has(7)) claimUrl = null;
        },
      ),
      flushRuntime: vi.fn().mockResolvedValue(undefined),
      reportError: vi.fn(),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine;
    get.mockResolvedValue({ url, mutedInfo: { muted: false } });
    Object.assign(chrome.tabs, { query: vi.fn().mockResolvedValue([]) });

    const pending: Promise<void> = applyToTab(engine, 7, url, false, 'navigation');
    await persistenceStarted.promise;
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 0);
    });
    await applyBlockingFactory((): Engine => engine)();

    expect(claimUrl).toBe(url);
    releasePersistence.resolve(undefined);
    await pending;
  });

  it('releases inherited ownership when a same-URL successor is superseded before effects', async () => {
    const oldUrl = 'https://facebook.com/settlement-handoff-old';
    const newUrl = 'https://facebook.com/settlement-handoff-new';
    const oldSettlementReadStarted: Deferred<void> = deferred();
    const releaseOldSettlementRead: Deferred<void> = deferred();
    const successorReadStarted: Deferred<void> = deferred();
    const releaseSuccessorRead: Deferred<void> = deferred();
    let gateOldSettlementRead = false;
    let gateSuccessorRead = false;
    let liveUrl = oldUrl;
    let muted = false;
    let claimUrl: string | null = null;
    const claimMute = vi.fn(async (_tabId: number, url: string): Promise<boolean> => {
      if (claimUrl !== null && claimUrl !== url) return false;
      claimUrl = url;
      return true;
    });
    const releaseMuteClaim = vi.fn(async (_tabId: number, url: string): Promise<void> => {
      if (claimUrl === url) claimUrl = null;
    });
    const engine: Engine = {
      verdictFor: vi.fn((): Verdict => blocked),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn((_tabId: number, url: string) => ({
        wasMutedByUs: claimUrl === url,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute,
      releaseMuteClaim,
      transferMuteClaim: vi.fn(
        async (_tabId: number, fromUrl: string, toUrl: string): Promise<void> => {
          if (claimUrl === fromUrl) claimUrl = toUrl;
        },
      ),
      settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
        if (finalUrl === null) {
          claimUrl = null;
        } else if (claimUrl !== null) {
          claimUrl = finalUrl;
        }
      }),
      rebindTab: vi.fn(),
      reportError: vi.fn(),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine;
    get.mockImplementation(async (): Promise<MutableTabState> => {
      if (gateOldSettlementRead) {
        gateOldSettlementRead = false;
        oldSettlementReadStarted.resolve(undefined);
        await releaseOldSettlementRead.promise;
      } else if (gateSuccessorRead) {
        gateSuccessorRead = false;
        successorReadStarted.resolve(undefined);
        await releaseSuccessorRead.promise;
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
        gateOldSettlementRead = true;
      },
    );

    const oldest: Promise<void> = applyToTab(engine, 7, oldUrl, false, 'navigation');
    await oldSettlementReadStarted.promise;
    gateSuccessorRead = true;
    const sameUrlSuccessor: Promise<void> = applyToTab(engine, 7, oldUrl, true, 'existing', true);
    releaseOldSettlementRead.resolve(undefined);
    await successorReadStarted.promise;
    liveUrl = newUrl;
    muted = false;
    const newest: Promise<void> = applyToTab(engine, 7, newUrl, false, 'navigation');
    releaseSuccessorRead.resolve(undefined);
    await Promise.all([oldest, sameUrlSuccessor, newest]);

    expect(releaseMuteClaim).toHaveBeenCalledWith(7, oldUrl);
    expect(claimMute).toHaveBeenCalledWith(7, newUrl, false);
    expect(claimUrl).toBe(newUrl);
    expect(muted).toBe(true);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('releases stale restore ownership so a newer blocked URL can claim mute', async () => {
    const oldUrl = 'https://allowed.example/restore-old';
    const newUrl = 'https://facebook.com/restore-new';
    const restoreGate: Deferred<void> = deferred();
    const restoreStarted: Deferred<void> = deferred();
    let liveUrl = oldUrl;
    let muted = true;
    let claimUrl: string | null = oldUrl;
    const claimMute = vi.fn(async (_tabId: number, url: string): Promise<boolean> => {
      if (claimUrl !== null && claimUrl !== url) return false;
      claimUrl = url;
      return true;
    });
    const releaseMuteClaim = vi.fn(async (_tabId: number, url: string): Promise<void> => {
      if (claimUrl === url) claimUrl = null;
    });
    const engine: Engine = {
      verdictFor: vi.fn((url: string): Verdict => (url === newUrl ? blocked : allowed)),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn((_tabId: number, url: string) => ({
        wasMutedByUs: claimUrl === url,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute,
      releaseMuteClaim,
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
        claimUrl = finalUrl;
      }),
      rebindTab: vi.fn(),
      reportError: vi.fn(),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine;
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
        if (properties.muted === false) {
          restoreStarted.resolve(undefined);
          await restoreGate.promise;
        }
      },
    );

    const older: Promise<void> = applyToTab(engine, 7, oldUrl, true, 'existing', true);
    await withTimeout(restoreStarted.promise, 'older restore update');
    liveUrl = newUrl;
    const newer: Promise<void> = applyToTab(engine, 7, newUrl, false, 'navigation');
    restoreGate.resolve(undefined);
    await withTimeout(Promise.all([older, newer]), 'restore ownership handoff');

    expect(releaseMuteClaim).toHaveBeenCalledWith(7, oldUrl);
    expect(claimMute).toHaveBeenCalledWith(7, newUrl, false);
    expect(claimUrl).toBe(newUrl);
    expect(muted).toBe(true);
  });

  it('releases stale restore ownership when the old unmute rejects', async () => {
    const oldUrl = 'https://allowed.example/rejected-restore-old';
    const newUrl = 'https://facebook.com/rejected-restore-new';
    const restoreError = new Error('old restore rejected');
    let rejectRestore: (error: unknown) => void = (): void => {
      throw new Error('restore rejection was not initialized');
    };
    const restoreStarted: Deferred<void> = deferred();
    const restoreGate: Promise<void> = new Promise(
      (_resolve: () => void, reject: (error: unknown) => void): void => {
        rejectRestore = reject;
      },
    );
    let liveUrl = oldUrl;
    let muted = true;
    let claimUrl: string | null = oldUrl;
    const reportError = vi.fn();
    const claimMute = vi.fn(async (_tabId: number, url: string): Promise<boolean> => {
      if (claimUrl !== null && claimUrl !== url) return false;
      claimUrl = url;
      return true;
    });
    const releaseMuteClaim = vi.fn(async (_tabId: number, url: string): Promise<void> => {
      if (claimUrl === url) claimUrl = null;
    });
    const engine: Engine = {
      verdictFor: vi.fn((url: string): Verdict => (url === newUrl ? blocked : allowed)),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn((_tabId: number, url: string) => ({
        wasMutedByUs: claimUrl === url,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute,
      releaseMuteClaim,
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
        claimUrl = finalUrl;
      }),
      rebindTab: vi.fn(),
      reportError,
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine;
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
        if (properties.muted === false) {
          restoreStarted.resolve(undefined);
          await restoreGate;
          return;
        }
        if (properties.muted !== undefined) muted = properties.muted;
      },
    );

    const older: Promise<void> = applyToTab(engine, 7, oldUrl, true, 'existing', true);
    await withTimeout(restoreStarted.promise, 'rejected older restore update');
    liveUrl = newUrl;
    const newer: Promise<void> = applyToTab(engine, 7, newUrl, false, 'navigation');
    rejectRestore(restoreError);
    await withTimeout(Promise.all([older, newer]), 'rejected restore ownership handoff');

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(restoreError);
    expect(releaseMuteClaim).toHaveBeenCalledWith(7, oldUrl);
    expect(claimMute).toHaveBeenCalledWith(7, newUrl, true);
    expect(claimUrl).toBe(newUrl);
    expect(muted).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('releases stale mute ownership when the old mute rejects', async () => {
    const oldUrl = 'https://facebook.com/rejected-mute-old';
    const newUrl = 'https://facebook.com/rejected-mute-new';
    const muteError = new Error('old mute rejected');
    let rejectMute: (error: unknown) => void = (): void => {
      throw new Error('mute rejection was not initialized');
    };
    const muteStarted: Deferred<void> = deferred();
    const muteGate: Promise<void> = new Promise(
      (_resolve: () => void, reject: (error: unknown) => void): void => {
        rejectMute = reject;
      },
    );
    let liveUrl = oldUrl;
    let muted = false;
    let claimUrl: string | null = null;
    const reportError = vi.fn();
    const claimMute = vi.fn(async (_tabId: number, url: string): Promise<boolean> => {
      if (claimUrl !== null && claimUrl !== url) return false;
      claimUrl = url;
      return true;
    });
    const releaseMuteClaim = vi.fn(async (_tabId: number, url: string): Promise<void> => {
      if (claimUrl === url) claimUrl = null;
    });
    const engine: Engine = {
      verdictFor: vi.fn((): Verdict => blocked),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn((_tabId: number, url: string) => ({
        wasMutedByUs: claimUrl === url,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute,
      releaseMuteClaim,
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
        claimUrl = finalUrl;
      }),
      rebindTab: vi.fn(),
      reportError,
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine;
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      }),
    );
    let updateCalls = 0;
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        updateCalls += 1;
        if (updateCalls === 1) {
          muteStarted.resolve(undefined);
          await muteGate;
          return;
        }
        if (properties.muted !== undefined) muted = properties.muted;
      },
    );

    const older: Promise<void> = applyToTab(engine, 7, oldUrl, false, 'navigation');
    await withTimeout(muteStarted.promise, 'rejected older mute update');
    liveUrl = newUrl;
    const newer: Promise<void> = applyToTab(engine, 7, newUrl, false, 'navigation');
    rejectMute(muteError);
    await withTimeout(Promise.all([older, newer]), 'rejected mute ownership handoff');

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(muteError);
    expect(releaseMuteClaim).toHaveBeenCalledWith(7, oldUrl);
    expect(claimMute).toHaveBeenCalledWith(7, newUrl, false);
    expect(claimUrl).toBe(newUrl);
    expect(muted).toBe(true);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it.each(['resolves', 'applies-then-rejects'] as const)(
    'preserves prior mute through a same-URL successor when the initial mute %s',
    async (initialOutcome: 'resolves' | 'applies-then-rejects'): Promise<void> => {
      const url = 'https://facebook.com/same-url-initial-mute';
      const updateError = new Error('initial mute rejected after applying');
      const initialUpdateStarted: Deferred<void> = deferred();
      const releaseInitialUpdate: Deferred<void> = deferred();
      let currentVerdict: Verdict = blocked;
      let muted = false;
      let claim: { priorMuted: boolean; url: string } | null = null;
      const reportError = vi.fn();
      const engine: Engine = {
        verdictFor: vi.fn((): Verdict => currentVerdict),
        snapshot: vi.fn(() => emptySnapshot(0)),
        tabFacts: vi.fn((_tabId: number, inputUrl: string) => ({
          wasMutedByUs: claim?.url === inputUrl,
          priorMuted: claim?.url === inputUrl ? claim.priorMuted : false,
          wasStopped: false,
        })),
        recordAttempt: vi.fn().mockResolvedValue(undefined),
        claimMute: vi.fn(
          async (_tabId: number, inputUrl: string, priorMuted: boolean): Promise<boolean> => {
            if (claim !== null && claim.url !== inputUrl) return false;
            claim = { priorMuted, url: inputUrl };
            return true;
          },
        ),
        releaseMuteClaim: vi.fn(async (_tabId: number, inputUrl: string): Promise<void> => {
          if (claim?.url === inputUrl) claim = null;
        }),
        transferMuteClaim: vi.fn().mockResolvedValue(undefined),
        settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
          if (finalUrl === null) {
            claim = null;
          } else if (claim !== null) {
            claim = { ...claim, url: finalUrl };
          }
        }),
        rebindTab: vi.fn(),
        reportError,
        noteMuteRestored: vi.fn(),
        noteReloaded: vi.fn(),
      } as unknown as Engine;
      get.mockImplementation(
        async (): Promise<MutableTabState> => ({
          url,
          mutedInfo: {
            muted,
            extensionId: muted ? 'focus-lock' : undefined,
          },
        }),
      );
      let updateCalls = 0;
      update.mockImplementation(
        async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
          updateCalls += 1;
          if (updateCalls === 1) {
            muted = true;
            initialUpdateStarted.resolve(undefined);
            await releaseInitialUpdate.promise;
            if (initialOutcome === 'applies-then-rejects') throw updateError;
            return;
          }
          if (properties.muted !== undefined) muted = properties.muted;
        },
      );

      const older: Promise<void> = applyToTab(engine, 7, url, false, 'navigation');
      await initialUpdateStarted.promise;
      const newer: Promise<void> = applyToTab(engine, 7, url, false, 'navigation');
      releaseInitialUpdate.resolve(undefined);
      await Promise.all([older, newer]);
      expect(claim).toEqual({ priorMuted: false, url });

      currentVerdict = allowed;
      await applyToTab(engine, 7, url, true, 'existing', true);

      expect(muted).toBe(false);
      expect(claim).toBe(null);
      expect(update).toHaveBeenCalledTimes(2);
      if (initialOutcome === 'applies-then-rejects') {
        expect(reportError).toHaveBeenCalledOnce();
        expect(reportError).toHaveBeenCalledWith(updateError);
      } else {
        expect(reportError).not.toHaveBeenCalled();
      }
    },
  );

  it('restores mute through a same-URL successor when the initial restore rejects', async () => {
    const url = 'https://allowed.example/same-url-initial-restore';
    const restoreError = new Error('initial restore rejected');
    const initialRestoreStarted: Deferred<void> = deferred();
    const releaseInitialRestore: Deferred<void> = deferred();
    let muted = true;
    let claim: { priorMuted: boolean; url: string } | null = { priorMuted: false, url };
    const reportError = vi.fn();
    const engine: Engine = {
      verdictFor: vi.fn((): Verdict => allowed),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn((_tabId: number, inputUrl: string) => ({
        wasMutedByUs: claim?.url === inputUrl,
        priorMuted: claim?.url === inputUrl ? claim.priorMuted : false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute: vi.fn().mockResolvedValue(true),
      releaseMuteClaim: vi.fn(async (_tabId: number, inputUrl: string): Promise<void> => {
        if (claim?.url === inputUrl) claim = null;
      }),
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
        if (finalUrl === null) claim = null;
      }),
      rebindTab: vi.fn(),
      reportError,
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine;
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url,
        mutedInfo: { muted, extensionId: muted ? 'focus-lock' : undefined },
      }),
    );
    let updateCalls = 0;
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        updateCalls += 1;
        if (updateCalls === 1) {
          initialRestoreStarted.resolve(undefined);
          await releaseInitialRestore.promise;
          throw restoreError;
        }
        if (properties.muted !== undefined) muted = properties.muted;
      },
    );

    const older: Promise<void> = applyToTab(engine, 7, url, true, 'existing', true);
    await initialRestoreStarted.promise;
    const newer: Promise<void> = applyToTab(engine, 7, url, true, 'existing', true);
    releaseInitialRestore.resolve(undefined);
    await Promise.all([older, newer]);

    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(restoreError);
    expect(muted).toBe(false);
    expect(claim).toBe(null);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it.each(['correction-update', 'post-rejection-read'] as const)(
    'releases stale restore ownership when a rejected %s is superseded',
    async (staleBoundary: 'correction-update' | 'post-rejection-read'): Promise<void> => {
      const oldUrl = 'https://allowed.example/corrective-restore-old';
      const correctionUrl = 'https://facebook.com/corrective-restore-race';
      const newUrl = 'https://facebook.com/corrective-restore-new';
      const correctionError = new Error('corrective mute rejected');
      let rejectCorrection: (error: unknown) => void = (): void => {
        throw new Error('correction rejection was not initialized');
      };
      const correctionGate: Promise<void> = new Promise(
        (_resolve: () => void, reject: (error: unknown) => void): void => {
          rejectCorrection = reject;
        },
      );
      const correctionStarted: Deferred<void> = deferred();
      const identityReadStarted: Deferred<void> = deferred();
      const releaseIdentityRead: Deferred<void> = deferred();
      let gateIdentityRead = false;
      let liveUrl = oldUrl;
      let muted = true;
      let claimUrl: string | null = oldUrl;
      const reportError = vi.fn();
      const claimMute = vi.fn(async (_tabId: number, url: string): Promise<boolean> => {
        if (claimUrl !== null && claimUrl !== url) return false;
        claimUrl = url;
        return true;
      });
      const releaseMuteClaim = vi.fn(async (_tabId: number, url: string): Promise<void> => {
        if (claimUrl === url) claimUrl = null;
      });
      const transferMuteClaim = vi.fn(
        async (_tabId: number, fromUrl: string, toUrl: string): Promise<void> => {
          if (claimUrl === fromUrl) claimUrl = toUrl;
        },
      );
      const settleMuteClaim = vi.fn(
        async (_tabId: number, finalUrl: string | null): Promise<void> => {
          if (finalUrl === null) {
            claimUrl = null;
          } else if (claimUrl !== null) {
            claimUrl = finalUrl;
          }
        },
      );
      const recordAttempt = vi.fn().mockResolvedValue(undefined);
      const engine: Engine = {
        verdictFor: vi.fn((url: string): Verdict => (url === oldUrl ? allowed : blocked)),
        snapshot: vi.fn(() => emptySnapshot(0)),
        tabFacts: vi.fn((_tabId: number, url: string) => ({
          wasMutedByUs: claimUrl === url,
          priorMuted: false,
          wasStopped: false,
        })),
        recordAttempt,
        claimMute,
        releaseMuteClaim,
        transferMuteClaim,
        settleMuteClaim,
        rebindTab: vi.fn(),
        reportError,
        noteMuteRestored: vi.fn(),
        noteReloaded: vi.fn(),
      } as unknown as Engine;
      get.mockImplementation(async (): Promise<MutableTabState> => {
        if (gateIdentityRead) {
          gateIdentityRead = false;
          identityReadStarted.resolve(undefined);
          await releaseIdentityRead.promise;
        }
        return {
          url: liveUrl,
          mutedInfo: {
            muted,
            extensionId: muted ? 'focus-lock' : undefined,
          },
        };
      });
      let updateCalls = 0;
      update.mockImplementation(
        async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
          updateCalls += 1;
          if (updateCalls === 1) {
            if (properties.muted !== undefined) muted = properties.muted;
            liveUrl = correctionUrl;
            return;
          }
          if (updateCalls === 2) {
            correctionStarted.resolve(undefined);
            if (staleBoundary === 'post-rejection-read') {
              gateIdentityRead = true;
              throw correctionError;
            }
            await correctionGate;
            return;
          }
          if (properties.muted !== undefined) muted = properties.muted;
        },
      );

      const older: Promise<void> = applyToTab(engine, 7, oldUrl, true, 'existing', true);
      await withTimeout(correctionStarted.promise, 'corrective restore update');
      let newer: Promise<void>;
      if (staleBoundary === 'correction-update') {
        liveUrl = newUrl;
        newer = applyToTab(engine, 7, newUrl, false, 'navigation');
        rejectCorrection(correctionError);
      } else {
        await withTimeout(identityReadStarted.promise, 'post-rejection identity read');
        liveUrl = newUrl;
        newer = applyToTab(engine, 7, newUrl, false, 'navigation');
        releaseIdentityRead.resolve(undefined);
      }
      await withTimeout(
        Promise.all([older, newer]),
        `corrective restore ownership handoff at ${staleBoundary}`,
      );

      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(correctionError);
      expect(releaseMuteClaim).toHaveBeenCalledTimes(1);
      expect(releaseMuteClaim).toHaveBeenCalledWith(7, oldUrl);
      expect(claimMute).toHaveBeenCalledWith(7, newUrl, false);
      expect(claimUrl).toBe(newUrl);
      expect(muted).toBe(true);
      expect(recordAttempt).toHaveBeenCalledWith(newUrl, 7, 'navigation');
      expect(update).toHaveBeenCalledTimes(3);
    },
  );

  it.each([
    'direct',
    'after-same-url-handoff',
    'after-same-url-migration',
    'after-rejected-same-url-migration',
    'after-omitted-sweep',
  ] as const)(
    'releases stale ownership when a pending correction continuation is cancelled %s',
    async (handoff:
      | 'direct'
      | 'after-same-url-handoff'
      | 'after-same-url-migration'
      | 'after-rejected-same-url-migration'
      | 'after-omitted-sweep'): Promise<void> => {
      vi.useFakeTimers();
      const oldUrl = 'https://facebook.com/pending-continuation-old';
      const newUrl = 'https://facebook.com/pending-continuation-new';
      const migratedUrl = 'https://facebook.com/pending-continuation-migrated';
      const migrationError = new Error('migrated claim persistence rejected');
      const racedUrls: string[] = [
        'https://example.com/pending-race-one',
        'https://facebook.com/pending-race-two',
        'https://example.com/pending-race-three',
        'https://facebook.com/pending-race-four',
      ];
      let liveUrl = oldUrl;
      let muted = false;
      let claimUrl: string | null = null;
      const claimMute = vi.fn(async (_tabId: number, url: string): Promise<boolean> => {
        if (claimUrl !== null && claimUrl !== url) return false;
        claimUrl = url;
        return true;
      });
      const releaseMuteClaim = vi.fn(async (_tabId: number, url: string): Promise<void> => {
        if (claimUrl === url) claimUrl = null;
      });
      const reportError = vi.fn();
      const engine: Engine = {
        verdictFor: vi.fn(
          (url: string): Verdict => (url.includes('facebook.com') ? blocked : allowed),
        ),
        snapshot: vi.fn(() => emptySnapshot(0)),
        tabFacts: vi.fn((_tabId: number, url: string) => ({
          wasMutedByUs: claimUrl === url,
          priorMuted: false,
          wasStopped: false,
        })),
        recordAttempt: vi.fn().mockResolvedValue(undefined),
        claimMute,
        releaseMuteClaim,
        transferMuteClaim: vi.fn(
          async (_tabId: number, fromUrl: string, toUrl: string): Promise<void> => {
            if (claimUrl === fromUrl) claimUrl = toUrl;
          },
        ),
        settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
          if (finalUrl === null) {
            claimUrl = null;
          } else if (claimUrl !== null) {
            claimUrl = finalUrl;
            if (handoff === 'after-rejected-same-url-migration' && finalUrl === migratedUrl) {
              throw migrationError;
            }
          }
        }),
        rebindTab: vi.fn(),
        reconcileTabs: vi.fn(
          (
            liveTabs: ReadonlyMap<number, LiveTabState>,
            protectedTabIds: ReadonlySet<number> = new Set(),
          ): void => {
            if (!liveTabs.has(7) && !protectedTabIds.has(7)) claimUrl = null;
          },
        ),
        flushRuntime: vi.fn().mockResolvedValue(undefined),
        reportError,
        noteMuteRestored: vi.fn(),
        noteReloaded: vi.fn(),
      } as unknown as Engine;
      const sameUrlReadStarted: Deferred<void> = deferred();
      const releaseSameUrlRead: Deferred<void> = deferred();
      let gateSameUrlRead = false;
      get.mockImplementation(async (): Promise<MutableTabState> => {
        if (gateSameUrlRead) {
          gateSameUrlRead = false;
          sameUrlReadStarted.resolve(undefined);
          await releaseSameUrlRead.promise;
        }
        return {
          url: liveUrl,
          mutedInfo: {
            muted,
            extensionId: muted ? 'focus-lock' : undefined,
          },
        };
      });
      let updateCalls = 0;
      update.mockImplementation(
        async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
          if (properties.muted !== undefined) muted = properties.muted;
          const racedUrl: string | undefined = racedUrls[updateCalls];
          updateCalls += 1;
          if (racedUrl !== undefined) liveUrl = racedUrl;
          if (
            (handoff === 'after-same-url-migration' ||
              handoff === 'after-rejected-same-url-migration') &&
            updateCalls === 5
          ) {
            liveUrl = migratedUrl;
          }
        },
      );

      await applyToTab(engine, 7, oldUrl, false, 'navigation');
      expect(reportError).toHaveBeenCalledOnce();
      if (handoff === 'after-omitted-sweep') {
        Object.assign(chrome.tabs, { query: vi.fn().mockResolvedValue([]) });
        await applyBlockingFactory((): Engine => engine)();
        expect(claimUrl).toBe(oldUrl);
      }
      let sameUrlHandoff: Promise<void> = Promise.resolve();
      if (
        handoff === 'after-same-url-handoff' ||
        handoff === 'after-same-url-migration' ||
        handoff === 'after-rejected-same-url-migration'
      ) {
        liveUrl = oldUrl;
        muted = handoff === 'after-same-url-handoff';
        if (handoff === 'after-same-url-handoff') gateSameUrlRead = true;
        sameUrlHandoff = applyToTab(engine, 7, oldUrl, muted, 'existing', muted);
        if (handoff === 'after-same-url-handoff') {
          await sameUrlReadStarted.promise;
        } else {
          const outcome: { error: unknown; ok: boolean } = await sameUrlHandoff.then(
            (): { error: unknown; ok: boolean } => ({ error: null, ok: true }),
            (error: unknown): { error: unknown; ok: boolean } => ({ error, ok: false }),
          );
          if (handoff === 'after-rejected-same-url-migration') {
            expect(outcome).toEqual({ error: migrationError, ok: false });
          } else {
            expect(outcome.ok).toBe(true);
          }
          sameUrlHandoff = Promise.resolve();
          expect(claimUrl).toBe(migratedUrl);
        }
      }
      liveUrl = newUrl;
      muted = false;
      const newer: Promise<void> = applyToTab(engine, 7, newUrl, false, 'navigation');
      releaseSameUrlRead.resolve(undefined);

      await Promise.all([sameUrlHandoff, newer]);

      expect(releaseMuteClaim).toHaveBeenCalledWith(
        7,
        handoff === 'after-same-url-migration' || handoff === 'after-rejected-same-url-migration'
          ? migratedUrl
          : oldUrl,
      );
      expect(claimMute).toHaveBeenCalledWith(7, newUrl, false);
      expect(claimUrl).toBe(newUrl);
      expect(muted).toBe(true);
      const expectedUpdateCalls =
        handoff === 'after-same-url-migration' || handoff === 'after-rejected-same-url-migration'
          ? 6
          : 5;
      expect(update).toHaveBeenCalledTimes(expectedUpdateCalls);
      await vi.runAllTimersAsync();
      expect(update).toHaveBeenCalledTimes(expectedUpdateCalls);
    },
  );

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

    expect(engine.settleMuteClaim).toHaveBeenCalledWith(7, null);
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

    expect(engine.settleMuteClaim).toHaveBeenCalledWith(7, 'https://blocked.example/new');
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

  it('clears ownership after a concurrent navigation rebind during restoration', async () => {
    const sourceUrl = 'https://facebook.com/rebind-source';
    const allowedUrl = 'https://example.com/rebind-allowed';
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
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
        if (properties.muted === true) {
          liveUrl = allowedUrl;
          engine.rebindTab(7, allowedUrl);
        }
      },
    );

    await applyToTab(engine, 7, sourceUrl, false);

    expect(muted).toBe(false);
    expect(hasDurableMuteClaim(engine, sourceUrl)).toBe(false);
    expect(hasDurableMuteClaim(engine, allowedUrl)).toBe(false);
  });

  it('reports a rejected corrective mute update without releasing ownership', async () => {
    const sourceUrl = 'https://facebook.com/feed';
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

    await applyToTab(engine, 7, sourceUrl, false);

    expect(engine.reportError).toHaveBeenCalledWith(correctionError);
    expect(engine.releaseMuteClaim).not.toHaveBeenCalled();
    expect(hasDurableMuteClaim(engine, sourceUrl)).toBe(true);
  });

  it('continues settlement when corrective unmute rejects after reaching a blocked URL', async () => {
    const sourceUrl = 'https://facebook.com/correction-source';
    const firstAllowedUrl = 'https://example.com/correction-first';
    const finalBlockedUrl = 'https://facebook.com/correction-final';
    const correctionError = new Error('corrective unmute rejected after apply');
    liveUrl = sourceUrl;
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
        if (updateCount === 2) {
          liveUrl = finalBlockedUrl;
          throw correctionError;
        }
      },
    );

    await applyToTab(engine, 7, sourceUrl, false);

    expect(engine.reportError).toHaveBeenCalledWith(correctionError);
    expect(engine.verdictFor).toHaveBeenCalledWith(finalBlockedUrl);
    expect(update).toHaveBeenNthCalledWith(3, 7, { muted: true });
    expect(muted).toBe(true);
    expect(hasDurableMuteClaim(engine, firstAllowedUrl)).toBe(false);
    expect(hasDurableMuteClaim(engine, finalBlockedUrl)).toBe(true);
    expect(engine.recordAttempt).toHaveBeenCalledOnce();
  });

  it('continues settlement when corrective remute rejects after reaching an allowed URL', async () => {
    const sourceUrl = 'https://example.com/restore-source';
    const firstBlockedUrl = 'https://facebook.com/restore-first';
    const finalAllowedUrl = 'https://example.com/restore-final';
    const correctionError = new Error('corrective remute rejected after apply');
    liveUrl = sourceUrl;
    let muted = true;
    let updateCount = 0;
    const engine: Engine = durableEngineFor(
      (url: string): Verdict => (url === firstBlockedUrl ? blocked : allowed),
      { url: sourceUrl, priorMuted: false },
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
        if (updateCount === 1) liveUrl = firstBlockedUrl;
        if (updateCount === 2) {
          liveUrl = finalAllowedUrl;
          throw correctionError;
        }
      },
    );

    await applyToTab(engine, 7, sourceUrl, true, 'existing', true);

    expect(engine.reportError).toHaveBeenCalledWith(correctionError);
    expect(engine.verdictFor).toHaveBeenCalledWith(finalAllowedUrl);
    expect(update).toHaveBeenNthCalledWith(3, 7, { muted: false });
    expect(muted).toBe(false);
    expect(hasDurableMuteClaim(engine, firstBlockedUrl)).toBe(false);
    expect(hasDurableMuteClaim(engine, finalAllowedUrl)).toBe(false);
    expect(engine.recordAttempt).not.toHaveBeenCalled();
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
    vi.useFakeTimers();
    const terminalError = new Error('terminal mute update rejected after apply');
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
        if (updateCount === 5) throw terminalError;
      },
    );

    await applyToTab(engine, 7, 'https://facebook.com/feed', false);

    expect(update).toHaveBeenCalledTimes(4);
    expect(engine.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Tab 7 exceeded the mute correction limit' }),
    );
    expect(engine.reportError).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync();
    expect(engine.reportError).toHaveBeenCalledWith(terminalError);
    expect(engine.reportError).toHaveBeenCalledTimes(2);
    expect(engine.releaseMuteClaim).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(5);
    expect(muted).toBe(true);
    expect(hasDurableMuteClaim(engine, 'https://facebook.com/race-four')).toBe(true);
    expect(engine.recordAttempt).toHaveBeenCalledOnce();
    expect(engine.settleMuteClaim).toHaveBeenCalledTimes(1);
    const settlementOrder: number | undefined = vi
      .mocked(engine.settleMuteClaim)
      .mock.invocationCallOrder.at(-1);
    const finalUpdateOrder: number | undefined = update.mock.invocationCallOrder[4];
    if (settlementOrder === undefined || finalUpdateOrder === undefined) {
      throw new Error('final mute settlement calls were not observed');
    }
    expect(settlementOrder).toBeGreaterThan(finalUpdateOrder);
  });

  it('restores prior mute on an allowed destination observed at correction exhaustion', async () => {
    vi.useFakeTimers();
    const sourceUrl = 'https://example.com/exhaustion-source';
    const racedUrls = [
      'https://facebook.com/exhaustion-one',
      'https://example.com/exhaustion-two',
      'https://facebook.com/exhaustion-three',
      'https://example.com/exhaustion-four',
    ];
    liveUrl = sourceUrl;
    let muted = true;
    let updateCount = 0;
    const engine: Engine = durableEngineFor(
      (url: string): Verdict => (url.includes('facebook.com') ? blocked : allowed),
      { url: sourceUrl, priorMuted: false },
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

    await applyToTab(engine, 7, sourceUrl, true, 'existing', true);

    expect(update).toHaveBeenCalledTimes(4);
    expect(engine.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Tab 7 exceeded the mute correction limit' }),
    );
    expect(engine.reportError).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync();
    expect(update).toHaveBeenCalledTimes(5);
    expect(muted).toBe(false);
    expect(hasDurableMuteClaim(engine, 'https://example.com/exhaustion-four')).toBe(false);
    expect(engine.recordAttempt).not.toHaveBeenCalled();
    expect(engine.transferMuteClaim).not.toHaveBeenCalled();
    expect(engine.settleMuteClaim).toHaveBeenCalledTimes(1);
  });

  it('reschedules endless identity churn without holding the blocking pass open', async () => {
    vi.useFakeTimers();
    try {
      const sourceUrl = 'https://facebook.com/yield-source';
      const racedUrls = [
        'https://example.com/yield-one',
        'https://facebook.com/yield-two',
        'https://example.com/yield-three',
        'https://facebook.com/yield-four',
        'https://example.com/yield-five',
        'https://facebook.com/yield-six',
        'https://example.com/yield-seven',
      ];
      liveUrl = sourceUrl;
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

      await applyToTab(engine, 7, sourceUrl, false);

      expect(updateCount).toBe(4);
      expect(engine.recordAttempt).toHaveBeenCalledOnce();
      await vi.runAllTimersAsync();
      expect(updateCount).toBe(8);
      expect(muted).toBe(false);
      expect(hasDurableMuteClaim(engine, racedUrls.at(-1) ?? '')).toBe(false);
      expect(engine.recordAttempt).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
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

    expect(engine.verdictFor).toHaveBeenCalledTimes(3);
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

  it('serializes same-tab navigation settlement through document identity reads', async () => {
    const oldUrl = 'https://facebook.com/serialized-old';
    const newUrl = 'https://facebook.com/serialized-new';
    const frameGate: Deferred<{ documentId: string }> = deferred();
    const frameStarted: Deferred<void> = deferred();
    const getFrame = vi
      .fn()
      .mockImplementationOnce(async (): Promise<{ documentId: string }> => {
        frameStarted.resolve(undefined);
        return frameGate.promise;
      })
      .mockResolvedValue({ documentId: 'document-new' });
    const engine: Engine = durableEngineFor((): Verdict => blocked);
    liveUrl = oldUrl;
    let muted = false;
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: { muted, extensionId: muted ? 'focus-lock' : undefined },
      }),
    );
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
      },
    );
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: { sendMessage, update, reload, get },
      webNavigation: { getFrame },
    });

    const first: Promise<void> = applyToTab(
      engine,
      7,
      oldUrl,
      false,
      'navigation',
      false,
      'document-old',
    );
    await withTimeout(frameStarted.promise, 'first identity read');
    liveUrl = newUrl;
    muted = false;
    engine.rebindTab(7, newUrl);
    const readsBeforeSecond: number = get.mock.calls.length;
    const frameReadsBeforeSecond: number = getFrame.mock.calls.length;
    const verdictsBeforeSecond: number = vi.mocked(engine.verdictFor).mock.calls.length;
    const settlementsBeforeSecond: number = vi.mocked(engine.settleMuteClaim).mock.calls.length;

    const second: Promise<void> = applyToTab(
      engine,
      7,
      newUrl,
      false,
      'navigation',
      false,
      'document-new',
    );
    await nextMacrotask();
    const readsWhileFirstPending: number = get.mock.calls.length;
    const frameReadsWhileFirstPending: number = getFrame.mock.calls.length;
    const verdictsWhileFirstPending: number = vi.mocked(engine.verdictFor).mock.calls.length;
    const settlementsWhileFirstPending: number = vi.mocked(engine.settleMuteClaim).mock.calls
      .length;

    frameGate.resolve({ documentId: 'document-old' });
    await withTimeout(
      Promise.all([first, second]).then((): void => undefined),
      'same-tab applies',
    );

    expect(readsWhileFirstPending).toBe(readsBeforeSecond);
    expect(frameReadsWhileFirstPending).toBe(frameReadsBeforeSecond);
    expect(verdictsWhileFirstPending).toBe(verdictsBeforeSecond);
    expect(settlementsWhileFirstPending).toBe(settlementsBeforeSecond);
    expect(muted).toBe(true);
    expect(vi.mocked(engine.verdictFor).mock.calls.at(-1)?.[0]).toBe(newUrl);
    expect(hasDurableMuteClaim(engine, oldUrl)).toBe(false);
    expect(hasDurableMuteClaim(engine, newUrl)).toBe(true);
    expect(engine.recordAttempt).toHaveBeenCalledTimes(2);
    expect(engine.recordAttempt).toHaveBeenNthCalledWith(1, oldUrl, 7, 'navigation');
    expect(engine.recordAttempt).toHaveBeenNthCalledWith(2, newUrl, 7, 'navigation');
  });

  it('allows different tab IDs to settle while another tab identity read is pending', async () => {
    const states: Map<number, MutableTabState> = new Map([
      [7, { url: 'https://facebook.com/tab-seven', mutedInfo: { muted: false } }],
      [8, { url: 'https://facebook.com/tab-eight', mutedInfo: { muted: false } }],
    ]);
    const frameGate: Deferred<{ documentId: string }> = deferred();
    const frameStarted: Deferred<void> = deferred();
    const getFrame = vi.fn(async (details: { tabId: number }): Promise<{ documentId: string }> => {
      if (details.tabId === 7) {
        frameStarted.resolve(undefined);
        return frameGate.promise;
      }
      return { documentId: `document-${details.tabId}` };
    });
    const engine: Engine = engineFor(blocked);
    get.mockImplementation(async (tabId: number): Promise<MutableTabState> => {
      const state: MutableTabState | undefined = states.get(tabId);
      if (state === undefined) throw new Error(`missing tab ${tabId}`);
      return { url: state.url, mutedInfo: { ...state.mutedInfo } };
    });
    update.mockImplementation(
      async (tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        const state: MutableTabState | undefined = states.get(tabId);
        if (state === undefined) throw new Error(`missing tab ${tabId}`);
        if (properties.muted !== undefined) {
          state.mutedInfo = {
            muted: properties.muted,
            extensionId: properties.muted ? 'focus-lock' : undefined,
          };
        }
      },
    );
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: { sendMessage, update, reload, get },
      webNavigation: { getFrame },
    });

    let firstFinished = false;
    const first: Promise<void> = applyToTab(
      engine,
      7,
      'https://facebook.com/tab-seven',
      false,
      'navigation',
      false,
      'document-seven',
    ).then((): void => {
      firstFinished = true;
    });
    await withTimeout(frameStarted.promise, 'tab seven identity read');

    await withTimeout(
      applyToTab(
        engine,
        8,
        'https://facebook.com/tab-eight',
        false,
        'navigation',
        false,
        'document-eight',
      ),
      'tab eight apply',
    );

    expect(firstFinished).toBe(false);
    expect(update).toHaveBeenCalledWith(8, { muted: true });
    expect(engine.recordAttempt).toHaveBeenCalledWith(
      'https://facebook.com/tab-eight',
      8,
      'navigation',
    );
    frameGate.resolve({ documentId: 'document-seven' });
    await withTimeout(first, 'tab seven apply');
  });

  it('continues same-tab queued work after an earlier queued apply rejects', async () => {
    const url = 'https://facebook.com/queue-recovery';
    const queuedError = new Error('queued attempt persistence failed');
    let rejectAttempt: (error: unknown) => void = (): void => {
      throw new Error('attempt rejection was not initialized');
    };
    const attemptStarted: Deferred<void> = deferred();
    const engine: Engine = durableEngineFor((): Verdict => blocked);
    vi.mocked(engine.recordAttempt)
      .mockImplementationOnce(
        (): Promise<void> =>
          new Promise((_resolve: () => void, reject: (error: unknown) => void): void => {
            rejectAttempt = reject;
            attemptStarted.resolve(undefined);
          }),
      )
      .mockResolvedValue(undefined);
    liveUrl = url;
    let muted = false;
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: { muted, extensionId: muted ? 'focus-lock' : undefined },
      }),
    );
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
      },
    );
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: { sendMessage, update, reload, get },
    });

    const rejectedOutcome: Promise<{ error: unknown; ok: boolean }> = applyToTab(
      engine,
      7,
      url,
      false,
      'navigation',
    ).then(
      (): { error: unknown; ok: boolean } => ({ error: null, ok: true }),
      (error: unknown): { error: unknown; ok: boolean } => ({ error, ok: false }),
    );
    await withTimeout(attemptStarted.promise, 'rejected queued attempt');
    const newer: Promise<void> = applyToTab(engine, 7, url, false, 'navigation');
    rejectAttempt(queuedError);
    const rejected: { error: unknown; ok: boolean } = await withTimeout(
      rejectedOutcome,
      'rejected queued apply',
    );
    await withTimeout(newer, 'queued apply after rejection');

    expect(rejected).toEqual({ error: queuedError, ok: false });
    expect(vi.mocked(engine.verdictFor).mock.calls.at(-1)?.[0]).toBe(url);
    expect(hasDurableMuteClaim(engine, url)).toBe(true);
    expect(engine.recordAttempt).toHaveBeenCalledTimes(2);
  });

  it('serializes a scheduled no-attempt continuation with newer same-tab work', async () => {
    const sourceUrl = 'https://facebook.com/continuation-source';
    const newUrl = 'https://facebook.com/continuation-new';
    const racedUrls = [
      'https://example.com/continuation-one',
      'https://facebook.com/continuation-two',
      'https://example.com/continuation-three',
      'https://facebook.com/continuation-four',
    ];
    const continuationFrameGate: Deferred<{ documentId: string }> = deferred();
    const continuationFrameStarted: Deferred<void> = deferred();
    let frameReadCount = 0;
    const getFrame = vi.fn(async (): Promise<{ documentId: string }> => {
      frameReadCount += 1;
      if (frameReadCount === 5) {
        continuationFrameStarted.resolve(undefined);
        return continuationFrameGate.promise;
      }
      return { documentId: `document-${frameReadCount}` };
    });
    const engine: Engine = durableEngineFor(
      (url: string): Verdict => (url.includes('facebook.com') ? blocked : allowed),
    );
    liveUrl = sourceUrl;
    let muted = false;
    let updateCount = 0;
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: { muted, extensionId: muted ? 'focus-lock' : undefined },
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
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: { sendMessage, update, reload, get },
      webNavigation: { getFrame },
    });

    await applyToTab(engine, 7, sourceUrl, false, 'navigation', false, 'document-source');
    expect(updateCount).toBe(4);
    await withTimeout(continuationFrameStarted.promise, 'scheduled continuation identity read');
    liveUrl = newUrl;
    muted = false;
    engine.rebindTab(7, newUrl);
    const readsBeforeNewApply: number = get.mock.calls.length;
    const verdictsBeforeNewApply: number = vi.mocked(engine.verdictFor).mock.calls.length;

    const newer: Promise<void> = applyToTab(
      engine,
      7,
      newUrl,
      false,
      'navigation',
      false,
      'document-new',
    );
    await nextMacrotask();
    const readsWhileContinuationPending: number = get.mock.calls.length;
    const verdictsWhileContinuationPending: number = vi.mocked(engine.verdictFor).mock.calls.length;

    continuationFrameGate.resolve({ documentId: 'document-continuation' });
    await withTimeout(newer, 'newer apply after continuation');
    await nextMacrotask();

    expect(readsWhileContinuationPending).toBe(readsBeforeNewApply);
    expect(verdictsWhileContinuationPending).toBe(verdictsBeforeNewApply);
    expect(muted).toBe(true);
    expect(hasDurableMuteClaim(engine, newUrl)).toBe(true);
    expect(engine.recordAttempt).toHaveBeenCalledTimes(2);
    expect(engine.recordAttempt).toHaveBeenNthCalledWith(1, sourceUrl, 7, 'navigation');
    expect(engine.recordAttempt).toHaveBeenNthCalledWith(2, newUrl, 7, 'navigation');
  });

  it('does not revive a stale continuation scheduled after newer work cancels its token', async () => {
    vi.useFakeTimers();
    const sourceUrl = 'https://facebook.com/stale-token-source';
    const finalUrl = 'https://facebook.com/stale-token-final';
    const racedUrls = [
      'https://example.com/stale-token-one',
      'https://facebook.com/stale-token-two',
      'https://example.com/stale-token-three',
      finalUrl,
    ];
    const fourthUpdateGate: Deferred<void> = deferred();
    const fourthUpdateStarted: Deferred<void> = deferred();
    const engine: Engine = durableEngineFor((url: string): Verdict => {
      if (url === finalUrl) return allowed;
      return url.includes('facebook.com') ? blocked : allowed;
    });
    liveUrl = sourceUrl;
    let muted = false;
    let updateCount = 0;
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: { muted, extensionId: muted ? 'focus-lock' : undefined },
      }),
    );
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
        const racedUrl: string | undefined = racedUrls[updateCount];
        updateCount += 1;
        if (racedUrl !== undefined) liveUrl = racedUrl;
        if (updateCount === 4) {
          fourthUpdateStarted.resolve(undefined);
          await fourthUpdateGate.promise;
        }
      },
    );

    const older: Promise<void> = applyToTab(engine, 7, sourceUrl, false, 'navigation');
    await fourthUpdateStarted.promise;
    const newer: Promise<void> = applyToTab(engine, 7, finalUrl, false, 'existing');
    fourthUpdateGate.resolve(undefined);
    await Promise.all([older, newer]);

    expect(muted).toBe(false);
    expect(hasDurableMuteClaim(engine, finalUrl)).toBe(false);
    expect(engine.recordAttempt).toHaveBeenCalledOnce();

    await vi.runAllTimersAsync();

    expect(muted).toBe(false);
    expect(hasDurableMuteClaim(engine, finalUrl)).toBe(false);
    expect(engine.recordAttempt).toHaveBeenCalledOnce();
  });
});

describe('invalidateRemovedTab', () => {
  interface InvalidationDeferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
  }

  function invalidationDeferred<T>(): InvalidationDeferred<T> {
    let resolve: (value: T) => void = (): void => {
      throw new Error('deferred resolver was not initialized');
    };
    const promise: Promise<T> = new Promise((done: (value: T) => void): void => {
      resolve = done;
    });
    return { promise, resolve };
  }

  function invalidationNextMacrotask(): Promise<void> {
    return new Promise((resolve: () => void): void => {
      setTimeout(resolve, 0);
    });
  }

  async function invalidationBounded<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout: Promise<never> = new Promise(
      (_resolve: (value: never) => void, reject: (error: Error) => void): void => {
        timer = setTimeout((): void => reject(new Error(`${label} timed out`)), 1_000);
      },
    );
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  function invalidationEngine(
    verdictFor: (url: string) => Verdict = (): Verdict => allowed,
  ): Engine {
    return {
      verdictFor: vi.fn(verdictFor),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn(() => ({
        wasMutedByUs: false,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute: vi.fn().mockResolvedValue(true),
      releaseMuteClaim: vi.fn().mockResolvedValue(undefined),
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      settleMuteClaim: vi.fn().mockResolvedValue(undefined),
      rebindTab: vi.fn(),
      reconcileTabs: vi.fn(),
      flushRuntime: vi.fn().mockResolvedValue(undefined),
      reportError: vi.fn(),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine;
  }

  afterEach((): void => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('invalidates navigation waiting for engine readiness', async () => {
    type NavigationDetails = {
      tabId: number;
      url: string;
      frameId: number;
      documentId?: string;
    };
    const url = 'https://facebook.com/removed-before-ready';
    const readyGate: InvalidationDeferred<Engine> = invalidationDeferred();
    let committedListener: ((details: NavigationDetails) => void) | undefined;
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const reload = vi.fn().mockResolvedValue(undefined);
    const flushRuntime = vi.fn().mockResolvedValue(undefined);
    const engine: Engine = {
      verdictFor: vi.fn((): Verdict => blocked),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn(() => ({
        wasMutedByUs: false,
        priorMuted: false,
        wasStopped: true,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute: vi.fn().mockResolvedValue(true),
      releaseMuteClaim: vi.fn().mockResolvedValue(undefined),
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      settleMuteClaim: vi.fn().mockResolvedValue(undefined),
      rebindTab: vi.fn(),
      reconcileTabs: vi.fn(),
      flushRuntime,
      reportError: vi.fn(),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine;
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 7,
          url,
          mutedInfo: { muted: false },
        }),
        sendMessage,
        update,
        reload,
      },
      webNavigation: {
        getFrame: vi.fn().mockResolvedValue({ documentId: 'removed-document' }),
        onCommitted: {
          addListener: vi.fn((listener: (details: NavigationDetails) => void): void => {
            committedListener = listener;
          }),
        },
        onHistoryStateUpdated: { addListener: vi.fn() },
      },
    });
    registerTabListeners((): Promise<Engine> => readyGate.promise, vi.fn());
    if (committedListener === undefined) throw new Error('committed listener was not registered');

    committedListener({
      tabId: 7,
      url,
      frameId: 0,
      documentId: 'removed-document',
    });
    await invalidateRemovedTab(7);
    readyGate.resolve(engine);
    await invalidationNextMacrotask();

    expect(engine.recordAttempt).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(flushRuntime).not.toHaveBeenCalled();
  });

  it('detaches removed work so a reused tab id starts immediately', async () => {
    const oldUrl = 'https://allowed.example/removed-queue';
    const replacementUrl = 'https://allowed.example/replacement-queue';
    const oldReadStarted: InvalidationDeferred<void> = invalidationDeferred();
    const oldReadGate: InvalidationDeferred<chrome.tabs.Tab> = invalidationDeferred();
    let readCount = 0;
    const get = vi.fn(async (): Promise<chrome.tabs.Tab> => {
      readCount += 1;
      if (readCount === 1) {
        oldReadStarted.resolve(undefined);
        return oldReadGate.promise;
      }
      return { id: 7, url: replacementUrl, mutedInfo: { muted: false } } as chrome.tabs.Tab;
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const engine: Engine = invalidationEngine();
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        get,
        sendMessage,
        update: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
      },
    });

    const oldApply: Promise<void> = applyToTab(engine, 7, oldUrl, false);
    await invalidationBounded(oldReadStarted.promise, 'old detached read');
    await invalidateRemovedTab(7);
    const replacementApply: Promise<void> = applyToTab(engine, 7, replacementUrl, false);
    await vi.waitFor((): void => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    oldReadGate.resolve({ id: 7, url: oldUrl, mutedInfo: { muted: false } } as chrome.tabs.Tab);
    await invalidationBounded(
      Promise.all([oldApply, replacementApply]),
      'detached and replacement queue completion',
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(engine.recordAttempt).not.toHaveBeenCalled();
  });

  it('keeps replacement tail after detached old tail settles', async () => {
    const oldUrl = 'https://allowed.example/detached-tail';
    const replacementUrl = 'https://allowed.example/replacement-tail';
    const thirdUrl = 'https://allowed.example/third-tail';
    const oldReadStarted: InvalidationDeferred<void> = invalidationDeferred();
    const oldReadGate: InvalidationDeferred<chrome.tabs.Tab> = invalidationDeferred();
    const replacementReadStarted: InvalidationDeferred<void> = invalidationDeferred();
    const replacementReadGate: InvalidationDeferred<chrome.tabs.Tab> = invalidationDeferred();
    let readCount = 0;
    const get = vi.fn(async (): Promise<chrome.tabs.Tab> => {
      readCount += 1;
      if (readCount === 1) {
        oldReadStarted.resolve(undefined);
        return oldReadGate.promise;
      }
      if (readCount === 2) {
        replacementReadStarted.resolve(undefined);
        return replacementReadGate.promise;
      }
      return { id: 7, url: thirdUrl, mutedInfo: { muted: false } } as chrome.tabs.Tab;
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const engine: Engine = invalidationEngine();
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        get,
        sendMessage,
        update: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
      },
    });

    const oldApply: Promise<void> = applyToTab(engine, 7, oldUrl, false);
    await invalidationBounded(oldReadStarted.promise, 'old tail read');
    await invalidateRemovedTab(7);
    const replacementApply: Promise<void> = applyToTab(engine, 7, replacementUrl, false);
    await invalidationBounded(replacementReadStarted.promise, 'replacement tail read');
    oldReadGate.resolve({ id: 7, url: oldUrl, mutedInfo: { muted: false } } as chrome.tabs.Tab);
    await invalidationBounded(oldApply, 'detached old tail completion');

    const thirdApply: Promise<void> = applyToTab(engine, 7, thirdUrl, false);
    await Promise.resolve();
    await Promise.resolve();
    expect(get).toHaveBeenCalledTimes(2);

    replacementReadGate.resolve({
      id: 7,
      url: replacementUrl,
      mutedInfo: { muted: false },
    } as chrome.tabs.Tab);
    await invalidationBounded(
      Promise.all([replacementApply, thirdApply]),
      'replacement and third tail completion',
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending removed-tab continuation and releases its exact claim', async () => {
    vi.useFakeTimers();
    const oldUrl = 'https://facebook.com/removed-continuation';
    const replacementUrl = 'https://allowed.example/reused-after-continuation';
    let currentUrl = oldUrl;
    let muted = false;
    let persistUpdates = false;
    let claimUrl: string | null = null;
    const cleanupError = new Error('removed claim cleanup rejected');
    const releaseMuteClaim = vi.fn(async (): Promise<void> => {
      throw cleanupError;
    });
    const engine: Engine = {
      ...invalidationEngine((url: string): Verdict => (url === oldUrl ? blocked : allowed)),
      tabFacts: vi.fn((_tabId: number, url: string) => ({
        wasMutedByUs: claimUrl === url,
        priorMuted: false,
        wasStopped: false,
      })),
      claimMute: vi.fn(async (_tabId: number, url: string): Promise<boolean> => {
        claimUrl = url;
        return true;
      }),
      releaseMuteClaim,
      settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
        claimUrl = finalUrl;
      }),
    } as unknown as Engine;
    const get = vi.fn(
      async (): Promise<chrome.tabs.Tab> =>
        ({
          id: 7,
          url: currentUrl,
          mutedInfo: {
            muted,
            extensionId: muted ? 'focus-lock' : undefined,
          },
        }) as chrome.tabs.Tab,
    );
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (persistUpdates && properties.muted !== undefined) muted = properties.muted;
      },
    );
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        get,
        sendMessage,
        update,
        reload: vi.fn().mockResolvedValue(undefined),
      },
    });

    await applyToTab(engine, 7, oldUrl, false, 'navigation');
    const readsBeforeRemoval: number = get.mock.calls.length;
    const messagesBeforeRemoval: number = sendMessage.mock.calls.length;
    const updatesBeforeRemoval: number = update.mock.calls.length;

    const supersedingApply: Promise<void> = applyToTab(engine, 7, oldUrl, false, 'existing');
    await invalidateRemovedTab(7);
    await supersedingApply;

    expect(releaseMuteClaim).toHaveBeenCalledTimes(1);
    expect(releaseMuteClaim).toHaveBeenCalledWith(7, oldUrl);
    expect(engine.reportError).toHaveBeenCalledWith(cleanupError);
    expect(
      vi.mocked(engine.reportError).mock.calls.filter(([error]): boolean => error === cleanupError),
    ).toHaveLength(1);
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    expect(get).toHaveBeenCalledTimes(readsBeforeRemoval);
    expect(sendMessage).toHaveBeenCalledTimes(messagesBeforeRemoval);
    expect(update).toHaveBeenCalledTimes(updatesBeforeRemoval);

    currentUrl = replacementUrl;
    persistUpdates = true;
    await applyToTab(engine, 7, replacementUrl, false);

    expect(sendMessage).toHaveBeenCalledTimes(messagesBeforeRemoval + 1);
    expect(releaseMuteClaim).toHaveBeenCalledTimes(1);
  });

  it('shares removed-tab cleanup with an in-flight continuation', async () => {
    vi.useFakeTimers();
    const oldUrl = 'https://facebook.com/removed-in-flight-continuation';
    const cleanupError = new Error('in-flight removed claim cleanup rejected');
    const continuationReadStarted: InvalidationDeferred<void> = invalidationDeferred();
    const continuationReadGate: InvalidationDeferred<void> = invalidationDeferred();
    let gateContinuationRead = false;
    let claimUrl: string | null = null;
    const releaseMuteClaim = vi.fn(async (): Promise<void> => {
      throw cleanupError;
    });
    const engine: Engine = {
      ...invalidationEngine((): Verdict => blocked),
      tabFacts: vi.fn((_tabId: number, url: string) => ({
        wasMutedByUs: claimUrl === url,
        priorMuted: false,
        wasStopped: false,
      })),
      claimMute: vi.fn(async (_tabId: number, url: string): Promise<boolean> => {
        claimUrl = url;
        return true;
      }),
      releaseMuteClaim,
      settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
        claimUrl = finalUrl;
      }),
    } as unknown as Engine;
    const get = vi.fn(async (): Promise<chrome.tabs.Tab> => {
      if (gateContinuationRead) {
        gateContinuationRead = false;
        continuationReadStarted.resolve(undefined);
        await continuationReadGate.promise;
      }
      return {
        id: 7,
        url: oldUrl,
        mutedInfo: { muted: false },
      } as chrome.tabs.Tab;
    });
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        get,
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
      },
    });

    await applyToTab(engine, 7, oldUrl, false, 'navigation');
    gateContinuationRead = true;
    const timerRun: Promise<unknown> = vi.runOnlyPendingTimersAsync();
    await continuationReadStarted.promise;

    await invalidateRemovedTab(7);
    continuationReadGate.resolve(undefined);
    await timerRun;
    await vi.runAllTimersAsync();

    expect(releaseMuteClaim).toHaveBeenCalledTimes(1);
    expect(releaseMuteClaim).toHaveBeenCalledWith(7, oldUrl);
    expect(
      vi.mocked(engine.reportError).mock.calls.filter(([error]): boolean => error === cleanupError),
    ).toHaveLength(1);
  });

  it('keeps a replacement readiness lease when stale removed work releases', async () => {
    type NavigationDetails = { tabId: number; url: string; frameId: number };
    const oldUrl = 'https://allowed.example/removed-readiness-lease';
    const replacementUrl = 'https://allowed.example/replacement-readiness-lease';
    const oldReady: InvalidationDeferred<Engine> = invalidationDeferred();
    const replacementReady: InvalidationDeferred<Engine> = invalidationDeferred();
    let readyCalls = 0;
    let committedListener: ((details: NavigationDetails) => void) | undefined;
    let ownedUrl: string | null = replacementUrl;
    const engine: Engine = {
      ...invalidationEngine(),
      tabFacts: vi.fn((_tabId: number, url: string) => ({
        wasMutedByUs: ownedUrl === url,
        priorMuted: false,
        wasStopped: false,
      })),
      reconcileTabs: vi.fn(
        (
          liveTabs: ReadonlyMap<number, LiveTabState>,
          protectedTabIds: ReadonlySet<number> = new Set(),
        ): void => {
          if (!liveTabs.has(7) && !protectedTabIds.has(7)) ownedUrl = null;
        },
      ),
    } as unknown as Engine;
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue({
          id: 7,
          url: replacementUrl,
          mutedInfo: { muted: false },
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
    registerTabListeners((): Promise<Engine> => {
      readyCalls += 1;
      return readyCalls === 1 ? oldReady.promise : replacementReady.promise;
    }, vi.fn());
    if (committedListener === undefined) throw new Error('committed listener was not registered');

    committedListener({ tabId: 7, url: oldUrl, frameId: 0 });
    await invalidateRemovedTab(7);
    committedListener({ tabId: 7, url: replacementUrl, frameId: 0 });
    oldReady.resolve(engine);
    await invalidationNextMacrotask();

    await applyBlockingFactory((): Engine => engine)();

    expect(ownedUrl).toBe(replacementUrl);
    replacementReady.resolve(engine);
    await invalidationNextMacrotask();
  });
});

describe('registerTabListeners', () => {
  afterEach((): void => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('protects omitted ownership while navigation waits for engine readiness', async () => {
    type NavigationDetails = {
      tabId: number;
      url: string;
      frameId: number;
      documentId?: string;
    };
    const url = 'https://allowed.example/pre-ready-navigation';
    let committedListener: ((details: NavigationDetails) => void) | undefined;
    let resolveReady: (engine: Engine) => void = (): void => {
      throw new Error('ready resolver was not initialized');
    };
    let signalNavigationFlush: () => void = (): void => {
      throw new Error('navigation flush signal was not initialized');
    };
    const ready: Promise<Engine> = new Promise((resolve: (engine: Engine) => void): void => {
      resolveReady = resolve;
    });
    const navigationFlushed: Promise<void> = new Promise((resolve: () => void): void => {
      signalNavigationFlush = resolve;
    });
    let claim: { priorMuted: boolean; url: string } | null = { priorMuted: false, url };
    let muted = true;
    let flushCalls = 0;
    const engine: Engine = {
      verdictFor: vi.fn((): Verdict => allowed),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn((_tabId: number, inputUrl: string) => ({
        wasMutedByUs: claim?.url === inputUrl,
        priorMuted: claim?.url === inputUrl ? claim.priorMuted : false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute: vi.fn().mockResolvedValue(true),
      releaseMuteClaim: vi.fn().mockResolvedValue(undefined),
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
        if (finalUrl === null) claim = null;
      }),
      rebindTab: vi.fn(),
      reconcileTabs: vi.fn(
        (
          liveTabs: ReadonlyMap<number, LiveTabState>,
          protectedTabIds: ReadonlySet<number> = new Set(),
        ): void => {
          if (!liveTabs.has(7) && !protectedTabIds.has(7)) claim = null;
        },
      ),
      flushRuntime: vi.fn(async (): Promise<void> => {
        flushCalls += 1;
        if (flushCalls === 2) signalNavigationFlush();
      }),
      reportError: vi.fn(),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine;
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query: vi.fn().mockResolvedValue([]),
        get: vi.fn(
          async (): Promise<chrome.tabs.Tab> =>
            ({
              id: 7,
              url,
              mutedInfo: { muted, extensionId: muted ? 'focus-lock' : undefined },
            }) as chrome.tabs.Tab,
        ),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: vi.fn(
          async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
            if (properties.muted !== undefined) muted = properties.muted;
          },
        ),
        reload: vi.fn().mockResolvedValue(undefined),
      },
      webNavigation: {
        getFrame: vi.fn().mockResolvedValue({ documentId: 'pre-ready-document' }),
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

    committedListener({ tabId: 7, url, frameId: 0, documentId: 'pre-ready-document' });
    await applyBlockingFactory((): Engine => engine)();

    expect(claim).toEqual({ priorMuted: false, url });
    resolveReady(engine);
    await navigationFlushed;
    expect(muted).toBe(false);
    expect(claim).toBe(null);
  });

  it('releases stale ownership when a queued correction continuation is cancelled', async () => {
    vi.useFakeTimers();
    type NavigationDetails = {
      tabId: number;
      url: string;
      frameId: number;
      documentId?: string;
    };
    const oldUrl = 'https://facebook.com/queued-continuation-old';
    const newUrl = 'https://facebook.com/queued-continuation-new';
    const racedUrls: string[] = [
      'https://example.com/queued-race-one',
      'https://facebook.com/queued-race-two',
      'https://example.com/queued-race-three',
      'https://facebook.com/queued-race-four',
    ];
    let committedListener: ((details: NavigationDetails) => void) | undefined;
    let releaseFirstFlush: () => void = (): void => {
      throw new Error('flush release was not initialized');
    };
    let signalFirstFlush: () => void = (): void => {
      throw new Error('flush signal was not initialized');
    };
    let signalSecondFlush: () => void = (): void => {
      throw new Error('second flush signal was not initialized');
    };
    const firstFlushGate: Promise<void> = new Promise((resolve: () => void): void => {
      releaseFirstFlush = resolve;
    });
    const firstFlushStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalFirstFlush = resolve;
    });
    const secondFlushCompleted: Promise<void> = new Promise((resolve: () => void): void => {
      signalSecondFlush = resolve;
    });
    let liveUrl = oldUrl;
    let muted = false;
    let claimUrl: string | null = null;
    const claimMute = vi.fn(async (_tabId: number, url: string): Promise<boolean> => {
      if (claimUrl !== null && claimUrl !== url) return false;
      claimUrl = url;
      return true;
    });
    const releaseMuteClaim = vi.fn(async (_tabId: number, url: string): Promise<void> => {
      if (claimUrl === url) claimUrl = null;
    });
    const reportError = vi.fn();
    let flushCalls = 0;
    const engine: Engine = {
      verdictFor: vi.fn(
        (url: string): Verdict => (url.includes('facebook.com') ? blocked : allowed),
      ),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn((_tabId: number, url: string) => ({
        wasMutedByUs: claimUrl === url,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute,
      releaseMuteClaim,
      transferMuteClaim: vi.fn(
        async (_tabId: number, fromUrl: string, toUrl: string): Promise<void> => {
          if (claimUrl === fromUrl) claimUrl = toUrl;
        },
      ),
      settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
        if (finalUrl === null) {
          claimUrl = null;
        } else if (claimUrl !== null) {
          claimUrl = finalUrl;
        }
      }),
      rebindTab: vi.fn(),
      flushRuntime: vi.fn(async (): Promise<void> => {
        flushCalls += 1;
        if (flushCalls === 1) {
          signalFirstFlush();
          await firstFlushGate;
          return;
        }
        signalSecondFlush();
      }),
      reportError,
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine;
    const update = vi.fn(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
        const racedUrl: string | undefined = racedUrls[update.mock.calls.length - 1];
        if (racedUrl !== undefined) liveUrl = racedUrl;
      },
    );
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        get: vi.fn(
          async (): Promise<{
            url: string;
            mutedInfo: { muted: boolean; extensionId?: string };
          }> => ({
            url: liveUrl,
            mutedInfo: {
              muted,
              extensionId: muted ? 'focus-lock' : undefined,
            },
          }),
        ),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update,
        reload: vi.fn().mockResolvedValue(undefined),
      },
      webNavigation: {
        getFrame: vi.fn().mockResolvedValue({ documentId: 'queued-document' }),
        onCommitted: {
          addListener: vi.fn((listener: (details: NavigationDetails) => void): void => {
            committedListener = listener;
          }),
        },
        onHistoryStateUpdated: { addListener: vi.fn() },
      },
    });
    registerTabListeners(async (): Promise<Engine> => engine, reportError);
    if (committedListener === undefined) throw new Error('committed listener was not registered');

    committedListener({ tabId: 7, url: oldUrl, frameId: 0, documentId: 'queued-document' });
    await firstFlushStarted;
    await vi.runOnlyPendingTimersAsync();
    liveUrl = newUrl;
    muted = false;
    committedListener({ tabId: 7, url: newUrl, frameId: 0, documentId: 'queued-document' });
    releaseFirstFlush();
    await secondFlushCompleted;

    expect(releaseMuteClaim).toHaveBeenCalledWith(7, oldUrl);
    expect(claimMute).toHaveBeenCalledWith(7, newUrl, false);
    expect(claimUrl).toBe(newUrl);
    expect(muted).toBe(true);
    expect(update).toHaveBeenCalledTimes(5);
    await vi.runAllTimersAsync();
    expect(update).toHaveBeenCalledTimes(5);
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
      reportError: vi.fn(),
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

  it('keeps navigation apply and runtime flush ordered for the same tab', async () => {
    type NavigationDetails = {
      tabId: number;
      url: string;
      frameId: number;
      documentId?: string;
    };
    const currentUrl = 'https://blocked.example/same-url';
    let currentDocumentId = 'document-a';
    let committedListener: ((details: NavigationDetails) => void) | undefined;
    let releaseFirstFlush: () => void = (): void => {
      throw new Error('first flush release was not initialized');
    };
    let signalFirstFlush: () => void = (): void => {
      throw new Error('first flush signal was not initialized');
    };
    const firstFlushGate: Promise<void> = new Promise((resolve: () => void): void => {
      releaseFirstFlush = resolve;
    });
    const firstFlushStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalFirstFlush = resolve;
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const flushRuntime = vi
      .fn()
      .mockImplementationOnce(async (): Promise<void> => {
        signalFirstFlush();
        await firstFlushGate;
      })
      .mockResolvedValue(undefined);
    const engine: Engine = {
      rebindTab: vi.fn(),
      verdictFor: vi.fn((): Verdict => blocked),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn(() => ({
        wasMutedByUs: false,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute: vi.fn().mockResolvedValue(true),
      releaseMuteClaim: vi.fn().mockResolvedValue(undefined),
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      settleMuteClaim: vi.fn().mockResolvedValue(undefined),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
      reportError: vi.fn(),
      flushRuntime,
    } as unknown as Engine;
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 7,
          url: currentUrl,
          mutedInfo: { muted: false },
        }),
        sendMessage,
        update: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
      },
      webNavigation: {
        getFrame: vi.fn(
          async (): Promise<{ documentId: string }> => ({
            documentId: currentDocumentId,
          }),
        ),
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

    committedListener({
      tabId: 7,
      url: currentUrl,
      frameId: 0,
      documentId: 'document-a',
    });
    await firstFlushStarted;
    currentDocumentId = 'document-b';
    committedListener({
      tabId: 7,
      url: currentUrl,
      frameId: 0,
      documentId: 'document-b',
    });
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 0);
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);

    releaseFirstFlush();
    await vi.waitFor((): void => {
      expect(flushRuntime).toHaveBeenCalledTimes(2);
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('keeps an older navigation stale when its readiness resolves last', async () => {
    type NavigationDetails = {
      tabId: number;
      url: string;
      frameId: number;
      documentId?: string;
    };
    const currentUrl = 'https://blocked.example/readiness-order';
    const documentId = 'document-current';
    let committedListener: ((details: NavigationDetails) => void) | undefined;
    let resolveOlderReady: (engine: Engine) => void = (): void => {
      throw new Error('older readiness resolver was not initialized');
    };
    const olderReady: Promise<Engine> = new Promise((resolve: (engine: Engine) => void): void => {
      resolveOlderReady = resolve;
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const flushRuntime = vi.fn().mockResolvedValue(undefined);
    const engine: Engine = {
      rebindTab: vi.fn(),
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
      settleMuteClaim: vi.fn().mockResolvedValue(undefined),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
      reportError: vi.fn(),
      flushRuntime,
    } as unknown as Engine;
    const ready = vi
      .fn()
      .mockImplementationOnce((): Promise<Engine> => olderReady)
      .mockResolvedValue(engine);
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 7,
          url: currentUrl,
          mutedInfo: { muted: true, extensionId: 'focus-lock' },
        }),
        sendMessage,
        update: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
      },
      webNavigation: {
        getFrame: vi.fn().mockResolvedValue({ documentId }),
        onCommitted: {
          addListener: vi.fn((listener: (details: NavigationDetails) => void): void => {
            committedListener = listener;
          }),
        },
        onHistoryStateUpdated: { addListener: vi.fn() },
      },
    });
    registerTabListeners(ready, vi.fn());
    if (committedListener === undefined) throw new Error('committed listener was not registered');

    const details: NavigationDetails = {
      tabId: 7,
      url: currentUrl,
      frameId: 0,
      documentId,
    };
    committedListener(details);
    committedListener(details);
    await vi.waitFor((): void => {
      expect(flushRuntime).toHaveBeenCalledTimes(1);
    });

    resolveOlderReady(engine);
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 0);
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(flushRuntime).toHaveBeenCalledTimes(1);
  });

  it('skips a same-URL navigation event whose document was replaced before effects', async () => {
    type NavigationDetails = {
      tabId: number;
      url: string;
      frameId: number;
      documentId?: string;
    };
    const currentUrl = 'https://blocked.example/same-url';
    let currentDocumentId = 'document-a';
    let tabReads = 0;
    let committedListener: ((details: NavigationDetails) => void) | undefined;
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const rebindTab = vi.fn();
    const flushRuntime = vi.fn().mockResolvedValue(undefined);
    const get = vi.fn(
      async (): Promise<{
        id: number;
        url: string;
        mutedInfo: { muted: boolean; extensionId: string };
      }> => {
        tabReads += 1;
        if (tabReads === 1) currentDocumentId = 'document-b';
        return {
          id: 7,
          url: currentUrl,
          mutedInfo: { muted: true, extensionId: 'focus-lock' },
        };
      },
    );
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
      settleMuteClaim: vi.fn().mockResolvedValue(undefined),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
      reportError: vi.fn(),
      flushRuntime,
    } as unknown as Engine;
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        get,
        sendMessage,
        update: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
      },
      webNavigation: {
        getFrame: vi.fn(
          async (): Promise<{ documentId: string }> => ({
            documentId: currentDocumentId,
          }),
        ),
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

    committedListener({
      tabId: 7,
      url: currentUrl,
      frameId: 0,
      documentId: 'document-a',
    });
    await vi.waitFor((): void => {
      expect(get.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 0);
    });

    expect(rebindTab).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(flushRuntime).not.toHaveBeenCalled();
  });

  it('targets the accepted document and skips tab effects when it is replaced before messaging', async () => {
    type NavigationDetails = {
      tabId: number;
      url: string;
      frameId: number;
      documentId?: string;
    };
    const currentUrl = 'https://blocked.example/message-race';
    let currentDocumentId = 'document-a';
    let tabReads = 0;
    let committedListener: ((details: NavigationDetails) => void) | undefined;
    let releaseFinalUrlRead: (tab: chrome.tabs.Tab) => void = (): void => {
      throw new Error('final URL read resolver was not initialized');
    };
    let signalFinalUrlRead: () => void = (): void => {
      throw new Error('final URL read signal was not initialized');
    };
    const finalUrlReadGate: Promise<chrome.tabs.Tab> = new Promise(
      (resolve: (tab: chrome.tabs.Tab) => void): void => {
        releaseFinalUrlRead = resolve;
      },
    );
    const finalUrlReadStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalFinalUrlRead = resolve;
    });
    const currentTab = (): chrome.tabs.Tab =>
      ({
        id: 7,
        url: currentUrl,
        mutedInfo: { muted: false },
      }) as chrome.tabs.Tab;
    const get = vi.fn(async (): Promise<chrome.tabs.Tab> => {
      tabReads += 1;
      if (tabReads === 6) {
        signalFinalUrlRead();
        return finalUrlReadGate;
      }
      return currentTab();
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const flushRuntime = vi.fn().mockResolvedValue(undefined);
    const engine: Engine = {
      rebindTab: vi.fn(),
      verdictFor: vi.fn((): Verdict => blocked),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn(() => ({
        wasMutedByUs: false,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute: vi.fn().mockResolvedValue(true),
      releaseMuteClaim: vi.fn().mockResolvedValue(undefined),
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      settleMuteClaim: vi.fn().mockResolvedValue(undefined),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
      reportError: vi.fn(),
      flushRuntime,
    } as unknown as Engine;
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        get,
        sendMessage,
        update,
        reload: vi.fn().mockResolvedValue(undefined),
      },
      webNavigation: {
        getFrame: vi.fn(
          async (): Promise<{ documentId: string }> => ({
            documentId: currentDocumentId,
          }),
        ),
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

    committedListener({
      tabId: 7,
      url: currentUrl,
      frameId: 0,
      documentId: 'document-a',
    });
    await finalUrlReadStarted;
    currentDocumentId = 'document-b';
    releaseFinalUrlRead(currentTab());
    await vi.waitFor((): void => {
      expect(flushRuntime).toHaveBeenCalledTimes(1);
    });

    expect(sendMessage).toHaveBeenCalledWith(7, expect.objectContaining({ type: 'applyBlock' }), {
      documentId: 'document-a',
    });
    expect(update).not.toHaveBeenCalled();
  });
});

describe('applyBlockingFactory', () => {
  afterEach((): void => {
    vi.unstubAllGlobals();
  });

  function omittedClaimEngine(claimedUrl: string): {
    claimUrl(): string | null;
    engine: Engine;
    recordAttempt: ReturnType<typeof vi.fn>;
  } {
    let claimUrl: string | null = null;
    const recordAttempt = vi.fn().mockResolvedValue(undefined);
    const engine: Engine = {
      verdictFor: vi.fn((url: string): Verdict => (url === claimedUrl ? blocked : allowed)),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn((_tabId: number, url: string) => ({
        wasMutedByUs: claimUrl === url,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt,
      claimMute: vi.fn(async (_tabId: number, url: string): Promise<boolean> => {
        claimUrl = url;
        return true;
      }),
      releaseMuteClaim: vi.fn(async (_tabId: number, url: string): Promise<void> => {
        if (claimUrl === url) claimUrl = null;
      }),
      transferMuteClaim: vi.fn(
        async (_tabId: number, fromUrl: string, toUrl: string): Promise<void> => {
          if (claimUrl === fromUrl) claimUrl = toUrl;
        },
      ),
      settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
        if (claimUrl !== null) claimUrl = finalUrl;
      }),
      rebindTab: vi.fn((_tabId: number, url: string): void => {
        if (claimUrl !== null) claimUrl = url;
      }),
      reconcileTabs: vi.fn(
        (
          liveTabs: ReadonlyMap<number, LiveTabState>,
          protectedTabIds: ReadonlySet<number> = new Set(),
        ): void => {
          if (!liveTabs.has(7) && !protectedTabIds.has(7)) claimUrl = null;
        },
      ),
      flushRuntime: vi.fn().mockResolvedValue(undefined),
      reportError: vi.fn(),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine;
    return { engine, recordAttempt, claimUrl: (): string | null => claimUrl };
  }

  async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout: Promise<never> = new Promise(
      (_resolve: (value: never) => void, reject: (error: Error) => void): void => {
        timer = setTimeout((): void => reject(new Error(`${label} timed out`)), 1_000);
      },
    );
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  it('reconciles bookkeeping against live tab id and URL identities', async () => {
    const reconcileTabs = vi.fn();
    const flushRuntime = vi.fn().mockResolvedValue(undefined);
    const engine: Engine = {
      reconcileTabs,
      flushRuntime,
      reportError: vi.fn(),
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
        get: vi.fn(async (tabId: number): Promise<{ url?: string }> => {
          if (tabId === 7) return { url: 'https://example.com' };
          if (tabId === 8) return {};
          return { url: '' };
        }),
      },
    });

    await applyBlockingFactory((): Engine => engine)();

    const reconciled: ReadonlyMap<number, LiveTabState> | undefined = vi
      .mocked(reconcileTabs)
      .mock.calls.find(([liveTabs]) => liveTabs.has(7))?.[0];
    expect(reconciled).toBeDefined();
    expect([...(reconciled ?? new Map<number, LiveTabState>())]).toEqual([
      [7, { url: 'https://example.com', mutedByExtension: false, documentId: null }],
    ]);
    expect(flushRuntime).toHaveBeenCalledTimes(1);
  });

  it('preserves omitted-tab work completed while the sweep query is pending', async () => {
    const claimedUrl = 'https://facebook.com/query-pending-claim';
    const harness = omittedClaimEngine(claimedUrl);
    let muted = false;
    let resolveQuery: (tabs: chrome.tabs.Tab[]) => void = (): void => {
      throw new Error('query resolver was not initialized');
    };
    let signalQuery: () => void = (): void => {
      throw new Error('query signal was not initialized');
    };
    const queryGate: Promise<chrome.tabs.Tab[]> = new Promise(
      (resolve: (tabs: chrome.tabs.Tab[]) => void): void => {
        resolveQuery = resolve;
      },
    );
    const queryStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalQuery = resolve;
    });
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query: vi.fn(async (): Promise<chrome.tabs.Tab[]> => {
          signalQuery();
          return queryGate;
        }),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: vi.fn(
          async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
            if (properties.muted !== undefined) muted = properties.muted;
          },
        ),
        reload: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(
          async (): Promise<{
            id: number;
            mutedInfo: { extensionId: string | undefined; muted: boolean };
            url: string;
          }> => ({
            id: 7,
            url: claimedUrl,
            mutedInfo: { muted, extensionId: muted ? 'focus-lock' : undefined },
          }),
        ),
      },
    });

    const sweep: Promise<void> = applyBlockingFactory((): Engine => harness.engine)();
    await bounded(queryStarted, 'pending sweep query');
    await bounded(
      applyToTab(harness.engine, 7, claimedUrl, false, 'navigation'),
      'claim during pending query',
    );
    expect(harness.claimUrl()).toBe(claimedUrl);

    resolveQuery([]);
    await bounded(sweep, 'sweep after pending query');

    expect(harness.claimUrl()).toBe(claimedUrl);
    expect(harness.recordAttempt).toHaveBeenCalledOnce();
  });

  it('does not let a sweep gated on query supersede newer same-tab work', async () => {
    const url = 'https://facebook.com/query-intent-order';
    const harness = omittedClaimEngine(url);
    let muted = false;
    let releaseQuery: (tabs: chrome.tabs.Tab[]) => void = (): void => {
      throw new Error('query resolver was not initialized');
    };
    let signalQuery: () => void = (): void => {
      throw new Error('query signal was not initialized');
    };
    const queryGate: Promise<chrome.tabs.Tab[]> = new Promise(
      (resolve: (tabs: chrome.tabs.Tab[]) => void): void => {
        releaseQuery = resolve;
      },
    );
    const queryStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalQuery = resolve;
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query: vi.fn(async (): Promise<chrome.tabs.Tab[]> => {
          signalQuery();
          return queryGate;
        }),
        get: vi.fn(
          async (): Promise<{
            id: number;
            url: string;
            mutedInfo: { muted: boolean; extensionId: string | undefined };
          }> => ({
            id: 7,
            url,
            mutedInfo: { muted, extensionId: muted ? 'focus-lock' : undefined },
          }),
        ),
        sendMessage,
        update: vi.fn(
          async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
            if (properties.muted !== undefined) muted = properties.muted;
          },
        ),
        reload: vi.fn().mockResolvedValue(undefined),
      },
      webNavigation: {
        getFrame: vi.fn().mockResolvedValue({ documentId: 'document-current' }),
      },
    });

    const sweep: Promise<void> = applyBlockingFactory((): Engine => harness.engine)();
    await bounded(queryStarted, 'gated sweep query');
    await bounded(
      applyToTab(harness.engine, 7, url, false, 'navigation', false, 'document-current'),
      'newer public operation during query',
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);

    releaseQuery([
      { id: 7, url, mutedInfo: { muted: true, extensionId: 'focus-lock' } } as chrome.tabs.Tab,
    ]);
    await bounded(sweep, 'older query-gated sweep');

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('preserves omitted-tab work active before the sweep begins', async () => {
    const claimedUrl = 'https://facebook.com/preexisting-active-claim';
    const harness = omittedClaimEngine(claimedUrl);
    let muted = false;
    let releaseUpdate: () => void = (): void => {
      throw new Error('update resolver was not initialized');
    };
    let signalUpdate: () => void = (): void => {
      throw new Error('update signal was not initialized');
    };
    const updateGate: Promise<void> = new Promise((resolve: () => void): void => {
      releaseUpdate = resolve;
    });
    const updateStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalUpdate = resolve;
    });
    let resolveQuery: (tabs: chrome.tabs.Tab[]) => void = (): void => {
      throw new Error('query resolver was not initialized');
    };
    let signalQuery: () => void = (): void => {
      throw new Error('query signal was not initialized');
    };
    const queryGate: Promise<chrome.tabs.Tab[]> = new Promise(
      (resolve: (tabs: chrome.tabs.Tab[]) => void): void => {
        resolveQuery = resolve;
      },
    );
    const queryStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalQuery = resolve;
    });
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query: vi.fn(async (): Promise<chrome.tabs.Tab[]> => {
          signalQuery();
          return queryGate;
        }),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: vi.fn(
          async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
            if (properties.muted !== undefined) muted = properties.muted;
            signalUpdate();
            await updateGate;
          },
        ),
        reload: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(
          async (): Promise<{
            id: number;
            mutedInfo: { extensionId: string | undefined; muted: boolean };
            url: string;
          }> => ({
            id: 7,
            url: claimedUrl,
            mutedInfo: { muted, extensionId: muted ? 'focus-lock' : undefined },
          }),
        ),
      },
    });

    const activeApply: Promise<void> = applyToTab(
      harness.engine,
      7,
      claimedUrl,
      false,
      'navigation',
    );
    await bounded(updateStarted, 'active pre-sweep apply');
    const sweep: Promise<void> = applyBlockingFactory((): Engine => harness.engine)();
    await bounded(queryStarted, 'preexisting work sweep query');
    releaseUpdate();
    await bounded(activeApply, 'preexisting work completion');
    expect(harness.claimUrl()).toBe(claimedUrl);

    resolveQuery([]);
    await bounded(sweep, 'sweep after preexisting work');

    expect(harness.claimUrl()).toBe(claimedUrl);
    expect(harness.recordAttempt).toHaveBeenCalledOnce();
  });

  it('does not reconcile or apply a stale document replaced after the final identity read', async () => {
    type SweepState = {
      mutedInfo: { extensionId?: string; muted: boolean };
      url: string;
    };
    const tabBUrl = 'https://facebook.com/query-current';
    const tabAUrl = 'https://example.com/slow-tab-a';
    const oldDocumentId = 'document-b-old';
    const newDocumentId = 'document-b-current';
    const harness = omittedClaimEngine(tabBUrl);
    const states: Map<number, SweepState> = new Map([
      [7, { url: tabAUrl, mutedInfo: { muted: false } }],
      [8, { url: tabBUrl, mutedInfo: { muted: false } }],
    ]);
    let liveTabBDocumentId = oldDocumentId;
    let tabBFrameReads = 0;
    let releaseTabAFrame: (frame: { documentId: string }) => void = (): void => {
      throw new Error('tab A frame resolver was not initialized');
    };
    let signalTabAFrame: () => void = (): void => {
      throw new Error('tab A frame signal was not initialized');
    };
    let signalTabBFrame: () => void = (): void => {
      throw new Error('tab B frame signal was not initialized');
    };
    const tabAFrameGate: Promise<{ documentId: string }> = new Promise(
      (resolve: (frame: { documentId: string }) => void): void => {
        releaseTabAFrame = resolve;
      },
    );
    const tabAFrameStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalTabAFrame = resolve;
    });
    const tabBFrameRead: Promise<void> = new Promise((resolve: () => void): void => {
      signalTabBFrame = resolve;
    });
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query: vi.fn().mockResolvedValue([
          { id: 7, url: tabAUrl, mutedInfo: { muted: false } },
          { id: 8, url: tabBUrl, mutedInfo: { muted: false } },
        ]),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(async (tabId: number): Promise<SweepState> => {
          const state: SweepState | undefined = states.get(tabId);
          if (state === undefined) throw new Error(`missing tab ${tabId}`);
          return { url: state.url, mutedInfo: { ...state.mutedInfo } };
        }),
      },
      webNavigation: {
        getFrame: vi.fn(async (details: { tabId: number }): Promise<{ documentId: string }> => {
          if (details.tabId === 7) {
            signalTabAFrame();
            return tabAFrameGate;
          }
          signalTabBFrame();
          tabBFrameReads += 1;
          const observedDocumentId: string = liveTabBDocumentId;
          if (tabBFrameReads === 4) liveTabBDocumentId = newDocumentId;
          return { documentId: observedDocumentId };
        }),
      },
    });

    const sweep: Promise<void> = applyBlockingFactory((): Engine => harness.engine)();
    await bounded(Promise.all([tabAFrameStarted, tabBFrameRead]), 'initial sweep identities');
    releaseTabAFrame({ documentId: 'document-a' });
    await bounded(sweep, 'sweep with replaced tab B document');

    const reconciledStates: Array<LiveTabState | undefined> = vi
      .mocked(harness.engine.reconcileTabs)
      .mock.calls.map(
        (
          call: [
            liveTabs: ReadonlyMap<number, LiveTabState>,
            protectedTabIds?: ReadonlySet<number>,
          ],
        ): LiveTabState | undefined => call[0].get(8),
      );
    expect(liveTabBDocumentId).toBe(newDocumentId);
    expect(reconciledStates).not.toContainEqual({
      url: tabBUrl,
      mutedByExtension: false,
      documentId: oldDocumentId,
    });
    expect(harness.engine.tabFacts).not.toHaveBeenCalledWith(8, tabBUrl, oldDocumentId);
  });

  it('does not hold a ready tab queue behind another tab slow document identity', async () => {
    type SweepState = {
      mutedInfo: { extensionId?: string; muted: boolean };
      url: string;
    };
    const tabAUrl = 'https://example.com/barrier-tab-a';
    const tabBUrl = 'https://facebook.com/barrier-tab-b';
    const harness = omittedClaimEngine(tabBUrl);
    const states: Map<number, SweepState> = new Map([
      [7, { url: tabAUrl, mutedInfo: { muted: false } }],
      [8, { url: tabBUrl, mutedInfo: { muted: false } }],
    ]);
    let releaseTabAFrame: (frame: { documentId: string }) => void = (): void => {
      throw new Error('barrier frame resolver was not initialized');
    };
    let signalTabAFrame: () => void = (): void => {
      throw new Error('barrier tab A signal was not initialized');
    };
    let signalTabBFrame: () => void = (): void => {
      throw new Error('barrier tab B signal was not initialized');
    };
    let signalTabBEffect: () => void = (): void => {
      throw new Error('barrier tab B effect signal was not initialized');
    };
    const tabAFrameGate: Promise<{ documentId: string }> = new Promise(
      (resolve: (frame: { documentId: string }) => void): void => {
        releaseTabAFrame = resolve;
      },
    );
    const tabAFrameStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalTabAFrame = resolve;
    });
    const tabBFrameRead: Promise<void> = new Promise((resolve: () => void): void => {
      signalTabBFrame = resolve;
    });
    const tabBEffectCompleted: Promise<void> = new Promise((resolve: () => void): void => {
      signalTabBEffect = resolve;
    });
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query: vi.fn().mockResolvedValue([
          { id: 7, url: tabAUrl, mutedInfo: { muted: false } },
          { id: 8, url: tabBUrl, mutedInfo: { muted: false } },
        ]),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: vi.fn(
          async (tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
            const state: SweepState | undefined = states.get(tabId);
            if (state === undefined) throw new Error(`missing tab ${tabId}`);
            if (properties.muted !== undefined) {
              state.mutedInfo = {
                muted: properties.muted,
                extensionId: properties.muted ? 'focus-lock' : undefined,
              };
            }
            if (tabId === 8) signalTabBEffect();
          },
        ),
        reload: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(async (tabId: number): Promise<SweepState> => {
          const state: SweepState | undefined = states.get(tabId);
          if (state === undefined) throw new Error(`missing tab ${tabId}`);
          return { url: state.url, mutedInfo: { ...state.mutedInfo } };
        }),
      },
      webNavigation: {
        getFrame: vi.fn(async (details: { tabId: number }): Promise<{ documentId: string }> => {
          if (details.tabId === 7) {
            signalTabAFrame();
            return tabAFrameGate;
          }
          signalTabBFrame();
          return { documentId: 'document-b' };
        }),
      },
    });

    const sweep: Promise<void> = applyBlockingFactory((): Engine => harness.engine)();
    await bounded(Promise.all([tabAFrameStarted, tabBFrameRead]), 'barrier sweep identities');
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const beforeTabARelease: 'completed' | 'blocked' = await Promise.race([
      tabBEffectCompleted.then((): 'completed' => 'completed'),
      new Promise((resolve: (result: 'blocked') => void): void => {
        timeout = setTimeout((): void => resolve('blocked'), 25);
      }),
    ]);
    if (timeout !== null) clearTimeout(timeout);

    releaseTabAFrame({ documentId: 'document-a' });
    await bounded(sweep, 'barrier cleanup');

    expect(beforeTabARelease).toBe('completed');
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      8,
      expect.objectContaining({ type: 'applyBlock' }),
      { documentId: 'document-b' },
    );
    expect(chrome.tabs.update).toHaveBeenCalledWith(8, { muted: true });
    expect(harness.recordAttempt).toHaveBeenCalledWith(tabBUrl, 8, 'existing');
  });

  it('protects omitted-tab work queued after the sweep protection scan', async () => {
    type SweepTabState = {
      mutedInfo: { extensionId?: string; muted: boolean };
      url: string;
    };
    const claimedUrl = 'https://facebook.com/new-during-sweep';
    const sweepUrl = 'https://example.com/sweep-snapshot';
    let claimUrl: string | null = null;
    const recordAttempt = vi.fn().mockResolvedValue(undefined);
    const engine: Engine = {
      verdictFor: vi.fn((url: string): Verdict => (url === claimedUrl ? blocked : allowed)),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn((_tabId: number, url: string) => ({
        wasMutedByUs: claimUrl === url,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt,
      claimMute: vi.fn(async (_tabId: number, url: string): Promise<boolean> => {
        claimUrl = url;
        return true;
      }),
      releaseMuteClaim: vi.fn(async (_tabId: number, url: string): Promise<void> => {
        if (claimUrl === url) claimUrl = null;
      }),
      transferMuteClaim: vi.fn(
        async (_tabId: number, fromUrl: string, toUrl: string): Promise<void> => {
          if (claimUrl === fromUrl) claimUrl = toUrl;
        },
      ),
      settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
        claimUrl = finalUrl;
      }),
      rebindTab: vi.fn((_tabId: number, url: string): void => {
        if (claimUrl !== null) claimUrl = url;
      }),
      reconcileTabs: vi.fn(
        (
          liveTabs: ReadonlyMap<number, LiveTabState>,
          protectedTabIds: ReadonlySet<number> = new Set(),
        ): void => {
          if (!liveTabs.has(7) && !protectedTabIds.has(7)) claimUrl = null;
        },
      ),
      flushRuntime: vi.fn().mockResolvedValue(undefined),
      reportError: vi.fn(),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine;
    let releaseSweepFrame: (frame: { documentId: string }) => void = (): void => {
      throw new Error('sweep frame resolver was not initialized');
    };
    const frameGate: Promise<{ documentId: string }> = new Promise(
      (resolve: (frame: { documentId: string }) => void): void => {
        releaseSweepFrame = resolve;
      },
    );
    let signalSweepFrame: () => void = (): void => {
      throw new Error('sweep frame signal was not initialized');
    };
    const sweepFrameStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalSweepFrame = resolve;
    });
    let tabEightFrameReads = 0;
    const states: Map<number, SweepTabState> = new Map([
      [7, { url: claimedUrl, mutedInfo: { muted: false } }],
      [8, { url: sweepUrl, mutedInfo: { muted: false } }],
    ]);
    const tabsGet = vi.fn(async (tabId: number): Promise<SweepTabState> => {
      const state: SweepTabState | undefined = states.get(tabId);
      if (state === undefined) throw new Error(`missing tab ${tabId}`);
      return { url: state.url, mutedInfo: { ...state.mutedInfo } };
    });
    const tabsUpdate = vi.fn(
      async (tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        const state: SweepTabState | undefined = states.get(tabId);
        if (state === undefined) throw new Error(`missing tab ${tabId}`);
        if (properties.muted !== undefined) {
          state.mutedInfo = {
            muted: properties.muted,
            extensionId: properties.muted ? 'focus-lock' : undefined,
          };
        }
      },
    );
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 8, url: sweepUrl, mutedInfo: { muted: false } }]),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: tabsUpdate,
        reload: vi.fn().mockResolvedValue(undefined),
        get: tabsGet,
      },
      webNavigation: {
        getFrame: vi.fn(async (details: { tabId: number }): Promise<{ documentId: string }> => {
          if (details.tabId === 8) {
            tabEightFrameReads += 1;
            if (tabEightFrameReads === 2) {
              signalSweepFrame();
              return frameGate;
            }
            return { documentId: 'document-eight' };
          }
          return { documentId: 'document-seven' };
        }),
      },
    });
    const bounded = async <T>(promise: Promise<T>, label: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout: Promise<never> = new Promise(
        (_resolve: (value: never) => void, reject: (error: Error) => void): void => {
          timer = setTimeout((): void => reject(new Error(`${label} timed out`)), 1_000);
        },
      );
      try {
        return await Promise.race([promise, timeout]);
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    };

    const runSweep: () => Promise<void> = applyBlockingFactory((): Engine => engine);
    const sweep: Promise<void> = runSweep();
    await bounded(sweepFrameStarted, 'sweep apply identity read after protection scan');
    await bounded(
      applyToTab(engine, 7, claimedUrl, false, 'navigation', false, 'document-seven'),
      'new tab apply during sweep',
    );
    expect(claimUrl).toBe(claimedUrl);

    releaseSweepFrame({ documentId: 'document-eight' });
    await bounded(sweep, 'sweep with post-protection-scan work');

    expect(claimUrl).toBe(claimedUrl);
    expect(recordAttempt).toHaveBeenCalledOnce();

    await bounded(runSweep(), 'second unchanged sweep');

    expect(claimUrl).toBe(null);
    expect(recordAttempt).toHaveBeenCalledOnce();
  });

  it('does not resume a stale sweep operation after newer same-tab work completes', async () => {
    const url = 'https://facebook.com/sweep-intent';
    const harness = omittedClaimEngine(url);
    let muted = false;
    let releasePersistence: () => void = (): void => {
      throw new Error('persistence release was not initialized');
    };
    let signalPersistence: () => void = (): void => {
      throw new Error('persistence signal was not initialized');
    };
    const persistenceGate: Promise<void> = new Promise((resolve: () => void): void => {
      releasePersistence = resolve;
    });
    const persistenceStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalPersistence = resolve;
    });
    harness.recordAttempt
      .mockImplementationOnce(async (): Promise<void> => {
        signalPersistence();
        await persistenceGate;
      })
      .mockResolvedValueOnce(undefined);
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 7, url, mutedInfo: { muted: false } }]),
        get: vi.fn(
          async (): Promise<{
            id: number;
            url: string;
            mutedInfo: { muted: boolean; extensionId: string | undefined };
          }> => ({
            id: 7,
            url,
            mutedInfo: { muted, extensionId: muted ? 'focus-lock' : undefined },
          }),
        ),
        sendMessage,
        update: vi.fn(
          async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
            if (properties.muted !== undefined) muted = properties.muted;
          },
        ),
        reload: vi.fn().mockResolvedValue(undefined),
      },
      webNavigation: {
        getFrame: vi.fn().mockResolvedValue({ documentId: 'document-sweep' }),
      },
    });

    const sweep: Promise<void> = applyBlockingFactory((): Engine => harness.engine)();
    await bounded(persistenceStarted, 'sweep attempt persistence');
    await bounded(
      applyToTab(harness.engine, 7, url, false, 'navigation', false, 'document-sweep'),
      'newer public tab operation',
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);

    releasePersistence();
    await bounded(sweep, 'stale sweep completion');

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('does not deadlock when attempt persistence starts a nested same-tab sweep', async () => {
    let now = new Date(2026, 7, 29, 12, 0).getTime();
    const appendEvents = vi.fn().mockResolvedValue(undefined);
    const applyBlocking = vi.fn().mockResolvedValue(undefined);
    const reportError = vi.fn();
    const ports: EnginePorts = {
      now: vi.fn((): number => now),
      newId: vi.fn((): string => 'deadlock-session'),
      saveRuntime: vi.fn().mockResolvedValue(undefined),
      saveMatcherCache: vi.fn().mockResolvedValue(undefined),
      hasPendingSync: vi.fn((): boolean => false),
      queueSync: vi.fn(),
      supersedeSync: vi.fn(),
      removeSync: vi.fn(),
      persistSyncJournal: vi.fn().mockResolvedValue(undefined),
      appendEvents,
      broadcast: vi.fn(),
      applyBlocking,
      playSound: vi.fn(),
      notify: vi.fn(),
      updateIcon: vi.fn(),
      scheduleWake: vi.fn(),
      prune: vi.fn().mockResolvedValue(undefined),
      reportError,
    };
    const engine = new Engine(
      ports,
      DEFAULT_SETTINGS,
      {
        ...DEFAULT_LISTS,
        custom: [...DEFAULT_LISTS.custom, { kind: 'host', pattern: 'facebook.com' }],
      },
      { balanceMs: 0 },
      null,
      emptyRuntime(now),
      'deadlock-device',
    );
    await engine.startSession({
      mode: 'blacklist',
      strictness: 'friction',
      durationMin: 25,
      cycling: { focusMin: 5, shortBreakMin: 5, longBreakMin: 5, longEvery: 4 },
      intention: 'test nested sweep',
      source: 'manual',
      scheduleEntryId: null,
    });
    now += 5 * 60_000 + 1;
    await engine.tick();
    now += 5 * 60_000 + 1;
    appendEvents.mockClear();
    applyBlocking.mockClear();
    reportError.mockClear();
    const url = 'https://facebook.com/nested-sweep';
    let muted = false;
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 7, url, mutedInfo: { muted: false } }]),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: vi.fn(
          async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
            if (properties.muted !== undefined) muted = properties.muted;
          },
        ),
        reload: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(
          async (): Promise<{
            id: number;
            mutedInfo: { extensionId: string | undefined; muted: boolean };
            url: string;
          }> => ({
            id: 7,
            url,
            mutedInfo: { muted, extensionId: muted ? 'focus-lock' : undefined },
          }),
        ),
      },
    });
    const runSweep: () => Promise<void> = applyBlockingFactory((): Engine => engine);
    applyBlocking.mockImplementation(runSweep);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const outcome: 'completed' | 'deadlocked' = await Promise.race([
      applyToTab(engine, 7, url, false, 'navigation').then((): 'completed' => 'completed'),
      new Promise((resolve: (result: 'deadlocked') => void): void => {
        timer = setTimeout((): void => resolve('deadlocked'), 50);
      }),
    ]);
    if (timer !== null) clearTimeout(timer);
    const attemptEvents: EventRecord[] = appendEvents.mock.calls
      .flatMap((call: unknown[]): EventRecord[] => call[0] as EventRecord[])
      .filter((event: EventRecord): boolean => event.t === 'attempt');

    expect(attemptEvents).toHaveLength(1);
    expect(reportError).not.toHaveBeenCalled();
    expect(outcome).toBe('completed');
  });

  it('releases the tab queue after persistence starts a nested same-tab sweep', async () => {
    const url = 'https://facebook.com/deterministic-nested-sweep';
    const persistenceOrder: string[] = [];
    const persistAttempt = vi.fn(async (): Promise<void> => {
      persistenceOrder.push('persisted');
    });
    let signalNestedSweepStarted: () => void = (): void => {
      throw new Error('nested sweep signal was not initialized');
    };
    const nestedSweepStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalNestedSweepStarted = resolve;
    });
    let runSweep: () => Promise<void> = async (): Promise<void> => {
      throw new Error('nested sweep was not initialized');
    };
    let verdictCalls = 0;
    let muted = false;
    const reportError = vi.fn();
    const recordAttempt = vi.fn(async (): Promise<void> => {
      await persistAttempt();
      const nestedSweep: Promise<void> = runSweep();
      persistenceOrder.push('nested-sweep-started');
      signalNestedSweepStarted();
      await nestedSweep;
    });
    const engine: Engine = {
      verdictFor: vi.fn((): Verdict => {
        verdictCalls += 1;
        return verdictCalls === 1 ? blocked : allowed;
      }),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn(() => ({
        wasMutedByUs: false,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt,
      claimMute: vi.fn().mockResolvedValue(true),
      releaseMuteClaim: vi.fn().mockResolvedValue(undefined),
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      settleMuteClaim: vi.fn().mockResolvedValue(undefined),
      rebindTab: vi.fn(),
      reconcileTabs: vi.fn(),
      flushRuntime: vi.fn().mockResolvedValue(undefined),
      reportError,
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine;
    const query = vi.fn(
      async (): Promise<chrome.tabs.Tab[]> => [
        { id: 7, url, mutedInfo: { muted } } as chrome.tabs.Tab,
      ],
    );
    const sendMessage = vi.fn(async (): Promise<void> => {
      persistenceOrder.push('effect');
    });
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query,
        sendMessage,
        update: vi.fn(
          async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
            if (properties.muted !== undefined) muted = properties.muted;
          },
        ),
        reload: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(
          async (): Promise<{
            id: number;
            mutedInfo: { extensionId: string | undefined; muted: boolean };
            url: string;
          }> => ({
            id: 7,
            url,
            mutedInfo: { muted, extensionId: muted ? 'focus-lock' : undefined },
          }),
        ),
      },
    });
    runSweep = applyBlockingFactory((): Engine => engine);

    const outerApply: Promise<void> = applyToTab(engine, 7, url, false, 'navigation');
    await bounded(nestedSweepStarted, 'nested same-tab sweep start');
    let timer: ReturnType<typeof setTimeout> | null = null;
    const outcome: 'completed' | 'deadlocked' = await Promise.race([
      outerApply.then((): 'completed' => 'completed'),
      new Promise((resolve: (result: 'deadlocked') => void): void => {
        timer = setTimeout((): void => resolve('deadlocked'), 50);
      }),
    ]);
    if (timer !== null) clearTimeout(timer);

    expect(persistAttempt).toHaveBeenCalledOnce();
    expect(recordAttempt).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledOnce();
    expect(persistenceOrder[0]).toBe('persisted');
    expect(persistenceOrder.indexOf('nested-sweep-started')).toBeLessThan(
      persistenceOrder.indexOf('effect'),
    );
    expect(reportError).not.toHaveBeenCalled();
    expect(outcome).toBe('completed');
  });
});

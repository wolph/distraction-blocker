import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Engine } from '../../../src/background/engine';
import { applyBlockingFactory, applyToTab, planTabAction } from '../../../src/background/tabs';
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

  it('clears with mute restore: puts the recorded prior state back', () => {
    expect(
      planTabAction(allowed, {
        muted: true,
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
        wasMutedByUs: true,
        priorMuted: false,
        wasStopped: true,
      }),
    ).toEqual({ command: 'clearBlock', mute: false, reload: true });
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
  let liveUrl: string;

  beforeEach((): void => {
    vi.clearAllMocks();
    liveUrl = 'https://facebook.com/feed';
    get.mockImplementation(async (): Promise<{ url: string }> => ({ url: liveUrl }));
    vi.stubGlobal('chrome', { tabs: { sendMessage, update, reload, get } });
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
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine;
  }

  it('records a blocked SPA verdict as an existing-tab attempt', async () => {
    const engine: Engine = engineFor(blocked);

    await applyToTab(engine, 7, 'https://facebook.com/feed', false);

    expect(engine.recordAttempt).toHaveBeenCalledWith('https://facebook.com/feed', 7, 'existing');
    expect(engine.tabFacts).toHaveBeenCalledWith(7, 'https://facebook.com/feed');
    expect(engine.noteMuted).toHaveBeenCalledWith(7, 'https://facebook.com/feed', false);
  });

  it('records a committed navigation as fresh and preserves persisted restore state', async () => {
    const engine: Engine = engineFor(blocked);
    vi.mocked(engine.tabFacts).mockReturnValue({
      wasMutedByUs: true,
      priorMuted: true,
      wasStopped: false,
    });

    await applyToTab(engine, 7, 'https://facebook.com/feed', false, 'navigation');

    expect(engine.recordAttempt).toHaveBeenCalledWith('https://facebook.com/feed', 7, 'navigation');
    expect(update).toHaveBeenCalledWith(7, { muted: true });
    expect(engine.noteMuted).not.toHaveBeenCalled();
  });

  it('keeps mute bookkeeping when Chrome fails to restore mute state', async () => {
    const engine: Engine = engineFor(allowed);
    liveUrl = 'https://example.com';
    update.mockRejectedValueOnce(new Error('tab closed'));

    await applyToTab(engine, 7, 'https://example.com', true);

    expect(engine.noteMuteRestored).not.toHaveBeenCalled();
  });

  it('keeps stopped bookkeeping when Chrome fails to reload the tab', async () => {
    const engine: Engine = engineFor(allowed, true);
    liveUrl = 'https://example.com';
    reload.mockRejectedValueOnce(new Error('tab closed'));

    await applyToTab(engine, 7, 'https://example.com', true);

    expect(engine.noteReloaded).not.toHaveBeenCalled();
  });

  it('skips mute side effects when the tab navigates during messaging', async () => {
    const engine: Engine = engineFor(blocked);
    sendMessage.mockImplementationOnce(async (): Promise<void> => {
      liveUrl = 'https://allowed.example/new';
    });

    await applyToTab(engine, 7, 'https://facebook.com/feed', false);

    expect(update).not.toHaveBeenCalled();
    expect(engine.noteMuted).not.toHaveBeenCalled();
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
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine;
    vi.stubGlobal('chrome', {
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
    const reconciled: ReadonlyMap<number, string> | undefined =
      vi.mocked(reconcileTabs).mock.calls[0]?.[0];
    expect(reconciled).toBeDefined();
    expect([...(reconciled ?? new Map<number, string>())]).toEqual([[7, 'https://example.com']]);
    expect(flushRuntime).toHaveBeenCalledTimes(1);
  });
});

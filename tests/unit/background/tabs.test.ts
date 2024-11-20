import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Engine } from '../../../src/background/engine';
import { applyToTab, planTabAction } from '../../../src/background/tabs';
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

  beforeEach((): void => {
    vi.clearAllMocks();
    vi.stubGlobal('chrome', { tabs: { sendMessage, update, reload } });
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
  });

  it('keeps mute bookkeeping when Chrome fails to restore mute state', async () => {
    const engine: Engine = engineFor(allowed);
    update.mockRejectedValueOnce(new Error('tab closed'));

    await applyToTab(engine, 7, 'https://example.com', true);

    expect(engine.noteMuteRestored).not.toHaveBeenCalled();
  });

  it('keeps stopped bookkeeping when Chrome fails to reload the tab', async () => {
    const engine: Engine = engineFor(allowed, true);
    reload.mockRejectedValueOnce(new Error('tab closed'));

    await applyToTab(engine, 7, 'https://example.com', true);

    expect(engine.noteReloaded).not.toHaveBeenCalled();
  });
});

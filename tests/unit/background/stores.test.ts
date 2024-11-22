import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadRuntime, mergeLists, mergeSettings } from '../../../src/background/stores';
import { DEFAULT_LISTS, DEFAULT_SETTINGS } from '../../../src/shared/constants';
import { LOCAL_RUNTIME } from '../../../src/shared/storage-keys';

afterEach((): void => {
  vi.unstubAllGlobals();
});

describe('storage default merging', () => {
  it('preserves nested settings defaults when stored objects are partial', () => {
    const settings = mergeSettings({
      pause: { earnRatio: 0.25 },
      gate: { delayMs: 30_000 },
      sounds: { masterVolume: 0.2 },
    });

    expect(settings.pause).toEqual({ ...DEFAULT_SETTINGS.pause, earnRatio: 0.25 });
    expect(settings.gate).toEqual({ ...DEFAULT_SETTINGS.gate, delayMs: 30_000 });
    expect(settings.sounds).toEqual({ ...DEFAULT_SETTINGS.sounds, masterVolume: 0.2 });
  });

  it('preserves category and exclusion defaults when stored lists are partial', () => {
    const lists = mergeLists({
      categories: { social: true },
      exclusions: { social: ['facebook.com'] },
    });

    expect(lists.categories).toEqual({ ...DEFAULT_LISTS.categories, social: true });
    expect(lists.exclusions).toEqual({ ...DEFAULT_LISTS.exclusions, social: ['facebook.com'] });
    expect(lists.custom).toEqual(DEFAULT_LISTS.custom);
  });
});

describe('runtime storage migration', () => {
  it('drops legacy tab-id-only mute and stopped records', async () => {
    const now: number = new Date(2026, 7, 29, 12, 0).getTime();
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({
            [LOCAL_RUNTIME]: {
              stoppedTabIds: [7],
              mutedTabs: { 7: false },
            },
          }),
        },
      },
    });

    const runtime = await loadRuntime(now);

    expect(runtime).toHaveProperty('tabStates', {});
    expect(runtime).not.toHaveProperty('stoppedTabIds');
    expect(runtime).not.toHaveProperty('mutedTabs');
  });

  it('preserves URL-bound tab state', async () => {
    const now: number = new Date(2026, 7, 29, 12, 0).getTime();
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({
            [LOCAL_RUNTIME]: {
              tabStates: {
                7: {
                  url: 'https://blocked.example/page',
                  priorMuted: false,
                  stopped: true,
                },
              },
            },
          }),
        },
      },
    });

    const runtime = await loadRuntime(now);

    expect(runtime.tabStates).toEqual({
      7: {
        url: 'https://blocked.example/page',
        priorMuted: false,
        stopped: true,
      },
    });
  });
});

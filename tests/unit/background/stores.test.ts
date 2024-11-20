import { describe, expect, it } from 'vitest';
import { mergeLists, mergeSettings } from '../../../src/background/stores';
import { DEFAULT_LISTS, DEFAULT_SETTINGS } from '../../../src/shared/constants';

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

import { describe, expect, it } from 'vitest';
import {
  decodeListsSyncSnapshot,
  encodeListsForSync,
  LIST_SYNC_SHARD_KEYS,
  LISTS_SPLIT_THRESHOLD_BYTES,
} from '../../../src/background/list-sync-codec';
import { syncItemBytes } from '../../../src/background/sync-quota';
import { CATEGORY_IDS, DEFAULT_LISTS } from '../../../src/shared/constants';
import { SYNC_LISTS } from '../../../src/shared/storage-keys';
import type { ListsConfig } from '../../../src/shared/types';

function listsAtCanonicalBytes(bytes: number): ListsConfig {
  const template: ListsConfig = {
    ...DEFAULT_LISTS,
    custom: [{ kind: 'regex', pattern: '' }],
  };
  const fixedBytes: number = syncItemBytes(SYNC_LISTS, template);
  return {
    ...template,
    custom: [{ kind: 'regex', pattern: 'x'.repeat(bytes - fixedBytes) }],
  };
}

function listsWithExclusions(
  count: number,
  width = 40,
  categoryIds: readonly (typeof CATEGORY_IDS)[number][] = CATEGORY_IDS,
): ListsConfig {
  const exclusions: ListsConfig['exclusions'] = {};
  for (const categoryId of categoryIds) {
    exclusions[categoryId] = Array.from(
      { length: count },
      (_value: unknown, index: number): string =>
        `${categoryId}-${index}-${'x'.repeat(Math.max(1, width - String(index).length))}.example`,
    );
  }
  return {
    ...DEFAULT_LISTS,
    categories: { ...DEFAULT_LISTS.categories, social: true },
    exclusions,
  };
}

describe('list Sync codec', () => {
  it('keeps canonical lists unsplit at the safety threshold', async () => {
    const lists: ListsConfig = listsAtCanonicalBytes(LISTS_SPLIT_THRESHOLD_BYTES);

    const encoded = await encodeListsForSync(lists);

    expect(syncItemBytes(SYNC_LISTS, lists)).toBe(LISTS_SPLIT_THRESHOLD_BYTES);
    expect(encoded.split).toBe(false);
    expect(encoded.sets).toEqual({ [SYNC_LISTS]: lists });
    expect(encoded.removes).toEqual(LIST_SYNC_SHARD_KEYS);
  });

  it('splits category state and exclusions above the safety threshold deterministically', async () => {
    const lists: ListsConfig = listsWithExclusions(30);
    expect(syncItemBytes(SYNC_LISTS, lists)).toBeGreaterThan(LISTS_SPLIT_THRESHOLD_BYTES);

    const first = await encodeListsForSync(lists);
    const second = await encodeListsForSync(structuredClone(lists));

    expect(first.split).toBe(true);
    expect(first).toEqual(second);
    expect(Object.keys(first.sets)).toHaveLength(1 + LIST_SYNC_SHARD_KEYS.length);
    for (const [key, value] of Object.entries(first.sets)) {
      expect(syncItemBytes(key, value), key).toBeLessThanOrEqual(8_192);
    }
    expect(decodeListsSyncSnapshot(first.sets)).toEqual({ kind: 'complete', lists });
  });

  it('does not reassemble missing or mixed shard revisions', async () => {
    const first = await encodeListsForSync(listsWithExclusions(30));
    const second = await encodeListsForSync(listsWithExclusions(31));
    const missing: Record<string, unknown> = { ...first.sets };
    delete missing[LIST_SYNC_SHARD_KEYS[0] as string];
    const mixed: Record<string, unknown> = {
      ...first.sets,
      [LIST_SYNC_SHARD_KEYS[0] as string]: second.sets[LIST_SYNC_SHARD_KEYS[0] as string],
    };

    expect(decodeListsSyncSnapshot(missing)).toEqual({ kind: 'incomplete' });
    expect(decodeListsSyncSnapshot(mixed)).toEqual({ kind: 'incomplete' });
  });

  it('rejects an oversized encoded base or category shard', async () => {
    const oversizedBase: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'regex', pattern: 'x'.repeat(8_192) }],
    };
    const oversizedShard: ListsConfig = listsWithExclusions(220, 55, ['social']);

    await expect(encodeListsForSync(oversizedBase)).rejects.toThrow(/lists/i);
    await expect(encodeListsForSync(oversizedShard)).rejects.toThrow(/social/i);
  });
});

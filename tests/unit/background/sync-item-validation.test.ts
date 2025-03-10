import { describe, expect, it } from 'vitest';
import { encodeListsForSync, LIST_SYNC_SHARD_KEYS } from '../../../src/background/list-sync-codec';
import {
  isAuthoritativeSyncItem,
  isSupportedSyncItemKey,
} from '../../../src/background/sync-item-validation';
import { CATEGORY_IDS, DEFAULT_LISTS } from '../../../src/shared/constants';
import { SYNC_LISTS, syncListCategoryKey } from '../../../src/shared/storage-keys';
import type { ListsConfig } from '../../../src/shared/types';

function shardedLists(): ListsConfig {
  const exclusions: ListsConfig['exclusions'] = {};
  for (const categoryId of CATEGORY_IDS) {
    exclusions[categoryId] = Array.from(
      { length: 60 },
      (_value: unknown, index: number): string => `${categoryId}-${index}.example`,
    );
  }
  return { ...DEFAULT_LISTS, exclusions };
}

describe('list Sync item validation', () => {
  it('accepts only the fixed list base and category shard keys', () => {
    expect(isSupportedSyncItemKey(SYNC_LISTS)).toBe(true);
    for (const key of LIST_SYNC_SHARD_KEYS) expect(isSupportedSyncItemKey(key)).toBe(true);
    expect(isSupportedSyncItemKey(syncListCategoryKey('unknown'))).toBe(false);
  });

  it('accepts a valid split base and every matching category shard', async () => {
    const encoding = await encodeListsForSync(shardedLists());

    for (const [key, value] of Object.entries(encoding.sets)) {
      expect(isAuthoritativeSyncItem(key, value)).toBe(true);
    }
  });

  it('rejects a category shard stored under a different category key', async () => {
    const encoding = await encodeListsForSync(shardedLists());
    const firstKey: string = LIST_SYNC_SHARD_KEYS[0] as string;
    const secondKey: string = LIST_SYNC_SHARD_KEYS[1] as string;

    expect(isAuthoritativeSyncItem(secondKey, encoding.sets[firstKey])).toBe(false);
  });
});

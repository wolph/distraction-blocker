import { CATEGORY_IDS, DEFAULT_LISTS } from '../shared/constants';
import { isListsConfig } from '../shared/runtime-validation';
import { SYNC_LISTS, syncListCategoryKey } from '../shared/storage-keys';
import type { CategoryId, ListsConfig, Rule } from '../shared/types';
import { SYNC_QUOTA_BYTES_PER_ITEM, SyncQuotaError } from './sync-quota-shared';

export const LISTS_SPLIT_THRESHOLD_BYTES: number = 7_500;
const LISTS_SYNC_FORMAT: string = 'category-shards-v1';
const REVISION_RE: RegExp = /^[0-9a-f]{64}$/;

export const LIST_SYNC_SHARD_KEYS: readonly string[] = CATEGORY_IDS.map(
  (categoryId: CategoryId): string => syncListCategoryKey(categoryId),
);
export const LIST_SYNC_KEYS: readonly string[] = [SYNC_LISTS, ...LIST_SYNC_SHARD_KEYS];

interface SplitListsBase {
  format: typeof LISTS_SYNC_FORMAT;
  revision: string;
  custom: Rule[];
  whitelist: Rule[];
}

interface ListsCategoryShard {
  format: typeof LISTS_SYNC_FORMAT;
  revision: string;
  category: CategoryId;
  enabled: boolean;
  exclusions: string[];
}

export interface ListsSyncEncoding {
  split: boolean;
  sets: Record<string, unknown>;
  removes: string[];
}

function listSyncItemBytes(key: string, value: unknown): number {
  const serialized: string | undefined = JSON.stringify(value);
  if (serialized === undefined) {
    throw new SyncQuotaError(
      `Cannot sync item ${JSON.stringify(key)}: value cannot be serialized as JSON.`,
    );
  }
  const encoder: TextEncoder = new TextEncoder();
  return encoder.encode(key).byteLength + encoder.encode(serialized).byteLength;
}

function assertListSyncItemWithinQuota(key: string, value: unknown): void {
  const bytes: number = listSyncItemBytes(key, value);
  if (bytes <= SYNC_QUOTA_BYTES_PER_ITEM) return;
  throw new SyncQuotaError(
    `Cannot sync item ${JSON.stringify(key)}: ${bytes} bytes exceeds ${SYNC_QUOTA_BYTES_PER_ITEM}-byte limit.`,
  );
}

export type DecodedListsSyncSnapshot =
  | { kind: 'complete'; lists: ListsConfig }
  | { kind: 'legacy'; value: unknown }
  | { kind: 'incomplete' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys: string[] = Object.keys(value).sort();
  const expected: string[] = [...keys].sort();
  return (
    ownKeys.length === expected.length &&
    ownKeys.every((key: string, index: number): boolean => key === expected[index])
  );
}

function canonicalRules(rules: Rule[]): Rule[] {
  return rules.map((rule: Rule): Rule => ({ kind: rule.kind, pattern: rule.pattern }));
}

export function canonicalListsConfig(lists: ListsConfig): ListsConfig {
  const categories: ListsConfig['categories'] = { ...DEFAULT_LISTS.categories };
  const exclusions: ListsConfig['exclusions'] = {};
  for (const categoryId of CATEGORY_IDS) {
    categories[categoryId] = lists.categories[categoryId];
    const categoryExclusions: string[] = lists.exclusions[categoryId] ?? [];
    if (categoryExclusions.length > 0) exclusions[categoryId] = [...categoryExclusions];
  }
  return {
    custom: canonicalRules(lists.custom),
    whitelist: canonicalRules(lists.whitelist),
    categories,
    exclusions,
  };
}

function splitBase(lists: ListsConfig, revision: string): SplitListsBase {
  return {
    format: LISTS_SYNC_FORMAT,
    revision,
    custom: canonicalRules(lists.custom),
    whitelist: canonicalRules(lists.whitelist),
  };
}

function categoryShard(
  lists: ListsConfig,
  categoryId: CategoryId,
  revision: string,
): ListsCategoryShard {
  return {
    format: LISTS_SYNC_FORMAT,
    revision,
    category: categoryId,
    enabled: lists.categories[categoryId],
    exclusions: [...(lists.exclusions[categoryId] ?? [])],
  };
}

function encodingWithRevision(lists: ListsConfig, revision: string): ListsSyncEncoding {
  const canonical: ListsConfig = canonicalListsConfig(lists);
  if (listSyncItemBytes(SYNC_LISTS, canonical) <= LISTS_SPLIT_THRESHOLD_BYTES) {
    assertListSyncItemWithinQuota(SYNC_LISTS, canonical);
    return {
      split: false,
      sets: { [SYNC_LISTS]: canonical },
      removes: [...LIST_SYNC_SHARD_KEYS],
    };
  }
  const sets: Record<string, unknown> = {
    [SYNC_LISTS]: splitBase(canonical, revision),
  };
  for (const categoryId of CATEGORY_IDS) {
    sets[syncListCategoryKey(categoryId)] = categoryShard(canonical, categoryId, revision);
  }
  for (const [key, value] of Object.entries(sets)) assertListSyncItemWithinQuota(key, value);
  return { split: true, sets, removes: [] };
}

async function revisionFor(lists: ListsConfig): Promise<string> {
  const serialized: string = JSON.stringify(canonicalListsConfig(lists));
  const digest: ArrayBuffer = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(serialized),
  );
  return Array.from(new Uint8Array(digest), (byte: number): string =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export async function encodeListsForSync(lists: ListsConfig): Promise<ListsSyncEncoding> {
  const revision: string = await revisionFor(lists);
  return encodingWithRevision(lists, revision);
}

export function assertListsSyncEncodable(lists: ListsConfig): void {
  encodingWithRevision(lists, '0'.repeat(64));
}

export function canEncodeListsForSync(lists: ListsConfig): boolean {
  try {
    assertListsSyncEncodable(lists);
    return true;
  } catch (error: unknown) {
    if (error instanceof SyncQuotaError) return false;
    throw error;
  }
}

export function isListSyncKey(key: string): boolean {
  return LIST_SYNC_KEYS.includes(key);
}

function parseSplitBase(value: unknown): SplitListsBase | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['format', 'revision', 'custom', 'whitelist']) ||
    value.format !== LISTS_SYNC_FORMAT ||
    typeof value.revision !== 'string' ||
    !REVISION_RE.test(value.revision)
  ) {
    return null;
  }
  const candidate: ListsConfig = {
    ...DEFAULT_LISTS,
    custom: value.custom as Rule[],
    whitelist: value.whitelist as Rule[],
  };
  if (!isListsConfig(candidate)) return null;
  return {
    format: LISTS_SYNC_FORMAT,
    revision: value.revision,
    custom: canonicalRules(candidate.custom),
    whitelist: canonicalRules(candidate.whitelist),
  };
}

function parseCategoryShard(
  key: string,
  value: unknown,
  revision: string,
): ListsCategoryShard | null {
  const categoryId: CategoryId | undefined = CATEGORY_IDS.find(
    (candidate: CategoryId): boolean => syncListCategoryKey(candidate) === key,
  );
  if (
    categoryId === undefined ||
    !isRecord(value) ||
    !hasExactKeys(value, ['format', 'revision', 'category', 'enabled', 'exclusions']) ||
    value.format !== LISTS_SYNC_FORMAT ||
    value.revision !== revision ||
    value.category !== categoryId ||
    typeof value.enabled !== 'boolean' ||
    !Array.isArray(value.exclusions) ||
    !value.exclusions.every((host: unknown): host is string => typeof host === 'string')
  ) {
    return null;
  }
  return {
    format: LISTS_SYNC_FORMAT,
    revision,
    category: categoryId,
    enabled: value.enabled,
    exclusions: [...value.exclusions],
  };
}

export function isSplitListsBaseValue(value: unknown): boolean {
  return parseSplitBase(value) !== null;
}

export function isListsCategoryShardValue(key: string, value: unknown): boolean {
  if (!isRecord(value) || typeof value.revision !== 'string') return false;
  return parseCategoryShard(key, value, value.revision) !== null;
}

export function decodeListsSyncSnapshot(
  snapshot: Readonly<Record<string, unknown>>,
): DecodedListsSyncSnapshot {
  if (!Object.hasOwn(snapshot, SYNC_LISTS)) {
    return LIST_SYNC_SHARD_KEYS.some((key: string): boolean => Object.hasOwn(snapshot, key))
      ? { kind: 'incomplete' }
      : { kind: 'legacy', value: undefined };
  }
  const baseValue: unknown = snapshot[SYNC_LISTS];
  const base: SplitListsBase | null = parseSplitBase(baseValue);
  if (base === null) {
    return isListsConfig(baseValue)
      ? { kind: 'complete', lists: canonicalListsConfig(baseValue) }
      : { kind: 'legacy', value: baseValue };
  }
  const categories: ListsConfig['categories'] = { ...DEFAULT_LISTS.categories };
  const exclusions: ListsConfig['exclusions'] = {};
  for (const categoryId of CATEGORY_IDS) {
    const key: string = syncListCategoryKey(categoryId);
    const shard: ListsCategoryShard | null = parseCategoryShard(key, snapshot[key], base.revision);
    if (shard === null) return { kind: 'incomplete' };
    categories[categoryId] = shard.enabled;
    if (shard.exclusions.length > 0) exclusions[categoryId] = shard.exclusions;
  }
  const lists: ListsConfig = {
    custom: base.custom,
    whitelist: base.whitelist,
    categories,
    exclusions,
  };
  return isListsConfig(lists)
    ? { kind: 'complete', lists: canonicalListsConfig(lists) }
    : { kind: 'incomplete' };
}

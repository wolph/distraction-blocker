import { capAttempts } from '../core/stats';
import {
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  DEFAULT_SETUP,
  TOP_SITES_DAILY,
} from '../shared/constants';
import { isListsConfig, isSettings, isSetupState } from '../shared/runtime-validation';
import {
  LOCAL_AGGREGATE_PRUNE,
  LOCAL_AGGREGATE_TOMBSTONES,
  LOCAL_BANK,
  LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS,
  LOCAL_CACHES,
  LOCAL_DATA_CLEAR_JOURNAL,
  LOCAL_DEVICE_ID,
  LOCAL_EVENTS,
  LOCAL_INSTALL_MARKER,
  LOCAL_LISTS,
  LOCAL_LISTS_SNAPSHOT,
  LOCAL_ONBOARDING_DRAFT,
  LOCAL_POLICY_COMMIT,
  LOCAL_POLICY_GENERATION_PREFIX,
  LOCAL_RUNTIME,
  LOCAL_SETTINGS,
  LOCAL_SETUP,
  LOCAL_STREAK,
  LOCAL_SYNC_JOURNAL,
  LOCAL_SYNC_QUOTA_EVICTION,
  SYNC_BANK,
  SYNC_SETTINGS,
  SYNC_STREAK,
} from '../shared/storage-keys';
import type {
  BankState,
  DailyAgg,
  ListsConfig,
  Settings,
  SetupState,
  StorageMode,
  StreakState,
} from '../shared/types';
import { encodeListsForSync, LIST_SYNC_KEYS, type ListsSyncEncoding } from './list-sync-codec';
import {
  type AggregateStorage,
  type LocalAggregatePruneCheckpoint,
  pruneAndRollup,
} from './stats-service';
import {
  mergeRuntime,
  migrateRuntimeRules,
  parseBank,
  parseStreak,
  type RuntimeState,
} from './stores';
import { assertSyncItemWithinQuota } from './sync-item-size';
import {
  aggregateHistoryDeviceId,
  isAggregateHistoryKey,
  isAuthoritativeSyncItem,
  isFocusLockDeletionKey,
  isFocusLockSyncKey,
} from './sync-item-validation';
import {
  removeSyncItems,
  removeSyncItemsUntilClear,
  sanitizeSyncJournal,
  setSyncItemsWithinQuota,
} from './sync-quota';
import { SyncQuotaError } from './sync-quota-shared';
import { SyncEchoes, type SyncJournal, SyncWriter } from './sync-writer';

const SYNC_FLUSH_MS: number = 10_000;
const POLICY_LOCAL_KEYS: readonly string[] = [
  LOCAL_SETTINGS,
  LOCAL_LISTS,
  LOCAL_BANK,
  LOCAL_STREAK,
];
const POLICY_SYNC_KEYS: readonly string[] = [
  SYNC_SETTINGS,
  ...LIST_SYNC_KEYS,
  SYNC_BANK,
  SYNC_STREAK,
];

export interface PolicySnapshot {
  settings: Settings;
  lists: ListsConfig;
  bank: BankState;
  streak: StreakState | null;
}

export interface PolicyValueByKey {
  settings: Settings;
  lists: ListsConfig;
  bank: BankState;
  streak: StreakState | null;
}

export type SetupUpdate = Pick<
  SetupState,
  'websiteAccess' | 'blockingRegistration' | 'websiteAccessNotice'
>;

export interface FirstSyncCheckpointSource {
  loadAggregateItems(): Promise<Record<string, unknown>>;
  runExclusive?<T>(operation: () => Promise<T>): Promise<T>;
}

export interface AllDataClearBarrier {
  runExclusive<T>(operation: () => Promise<T>, retainQuiescence: () => boolean): Promise<T>;
}

export interface PolicyStorage {
  initialize(): Promise<void>;
  loadSetup(): Promise<SetupState>;
  updateSetup(next: Partial<SetupUpdate>): Promise<void>;
  markSetupCompleted(): Promise<void>;
  loadSnapshot(): Promise<PolicySnapshot>;
  setPolicy<K extends keyof PolicyValueByKey>(key: K, value: PolicyValueByKey[K]): Promise<void>;
  selectLocalMode(): Promise<void>;
  enableSync(): Promise<void>;
  disableSync(): Promise<void>;
  mirrorAcceptedRemotePolicy(
    changes: Record<string, unknown>,
    pendingRemoteKeys?: readonly string[],
  ): Promise<void>;
  queueVerifiedRemoteCorrections(keys: readonly (keyof PolicyValueByKey)[]): Promise<void>;
  deleteRemoteData(scope: 'synced-policy' | 'all'): Promise<void>;
  /** Returns true when local aggregate history was cleared with detailed events. */
  clearLocalHistory(): Promise<boolean>;
  finishLocalHistoryClear(): Promise<void>;
  pendingLocalHistoryClear(): Promise<{ clearAggregates: boolean } | null>;
  allDataClearCompleted(): boolean;
  storageMode(): Promise<StorageMode | null>;
  inboundSyncAllowed(): Promise<boolean>;
  consumeRemoteEcho(key: string, value: unknown): boolean;
  hasPendingRemote(key: string): boolean;
  publishRemoteItem(key: string, value: unknown): Promise<void>;
  removeRemoteItem(key: string): Promise<void>;
  remoteJournalDurable(): Promise<void>;
  pruneRemoteHistory(deviceId: string, retentionDays: number, now: number): Promise<void>;
  saveAggregate(key: string, value: unknown): Promise<void>;
  removeAggregate(key: string): Promise<void>;
  withAggregateStorage<T>(operation: (storage: AggregateStorage) => Promise<T>): Promise<T>;
  markLegacyMigrationFailed(): Promise<void>;
  importLegacy(
    snapshot: PolicySnapshot,
    runtime: RuntimeState,
    journal: SyncJournal,
    storedSync?: Record<string, unknown>,
  ): Promise<void>;
}

interface PreviousValues {
  existing: Record<string, unknown>;
  missing: string[];
}

type DataClearJournal =
  | {
      scope: 'synced-policy' | 'all';
      phase: 'remote' | 'local';
      inventory: string[];
    }
  | {
      scope: 'local-history';
      phase: 'local' | 'runtime';
      inventory: string[];
      clearAggregates: boolean;
    };

type LocalHistoryClearJournal = Extract<DataClearJournal, { scope: 'local-history' }>;

interface PolicyGenerationRecord {
  id: string;
  revision: string;
  policy: PolicySnapshot;
  runtime: RuntimeState;
  journal: SyncJournal;
  aggregates: Record<string, unknown>;
  aggregateTombstones: string[];
}

type PolicyCommit =
  | { source: 'generation'; id: string; revision: string }
  | { source: 'direct'; revision: string };

const FOCUS_LOCK_LOCAL_EXACT_KEYS: readonly string[] = [
  LOCAL_RUNTIME,
  LOCAL_CACHES,
  LOCAL_DEVICE_ID,
  LOCAL_EVENTS,
  LOCAL_LISTS_SNAPSHOT,
  LOCAL_SYNC_JOURNAL,
  LOCAL_SYNC_QUOTA_EVICTION,
  LOCAL_AGGREGATE_TOMBSTONES,
  LOCAL_AGGREGATE_PRUNE,
  LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS,
  LOCAL_INSTALL_MARKER,
  LOCAL_ONBOARDING_DRAFT,
  LOCAL_POLICY_COMMIT,
  LOCAL_SETTINGS,
  LOCAL_LISTS,
  LOCAL_BANK,
  LOCAL_STREAK,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual: string[] = Object.keys(value).sort();
  const sortedExpected: string[] = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key: string, index: number): boolean => key === sortedExpected[index])
  );
}

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return serialized(left) === serialized(right);
}

function parseAggregateTombstones(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string' || !isAggregateHistoryKey(candidate)) continue;
    if (!keys.includes(candidate)) keys.push(candidate);
  }
  return keys;
}

function isDailyAggregateHistoryKey(key: string): boolean {
  return (
    /^agg:[^:]+:\d{4}-\d{2}-\d{2}$/.test(key) ||
    /^archive:clock-rebase:[^:]+:\d{4}-\d{2}-\d{2}:\d+:[^:]+$/.test(key)
  );
}

function normalizeAggregateItem(key: string, value: unknown): unknown {
  if (!isAggregateHistoryKey(key) || !isAuthoritativeSyncItem(key, value)) {
    throw new Error('invalid aggregate item');
  }
  return isDailyAggregateHistoryKey(key)
    ? capAttempts(value as DailyAgg, TOP_SITES_DAILY)
    : structuredClone(value);
}

function normalizedAggregateItems(items: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(items)) {
    if (!isAggregateHistoryKey(key)) continue;
    normalized[key] = normalizeAggregateItem(key, value);
  }
  return normalized;
}

interface LegacyAggregateAuthority {
  aggregates: Record<string, unknown>;
  tombstones: string[];
  journal: SyncJournal;
}

interface BlockedAggregatePublications {
  version: 1;
  items: Record<string, unknown>;
}

function emptyBlockedAggregatePublications(): BlockedAggregatePublications {
  return { version: 1, items: {} };
}

function parseBlockedAggregatePublications(value: unknown): BlockedAggregatePublications {
  if (value === undefined) return emptyBlockedAggregatePublications();
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'items']) ||
    value.version !== 1 ||
    !isRecord(value.items)
  ) {
    throw new Error('invalid blocked aggregate publication registry');
  }
  const items: Record<string, unknown> = {};
  for (const [key, candidate] of Object.entries(value.items)) {
    try {
      const normalized: unknown = normalizeAggregateItem(key, candidate);
      if (!valuesEqual(normalized, candidate)) {
        throw new Error('blocked aggregate publication is not normalized');
      }
      items[key] = normalized;
    } catch (_error: unknown) {
      throw new Error('invalid blocked aggregate publication registry');
    }
  }
  return { version: 1, items };
}

function blockedAggregatePublicationsEmpty(registry: BlockedAggregatePublications): boolean {
  return Object.keys(registry.items).length === 0;
}

function effectiveLegacyAggregateAuthority(
  storedSync: Record<string, unknown>,
  journal: SyncJournal,
): LegacyAggregateAuthority {
  const aggregates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(storedSync)) {
    if (!isAggregateHistoryKey(key) || !isAuthoritativeSyncItem(key, value)) continue;
    aggregates[key] = normalizeAggregateItem(key, value);
  }
  const normalizedJournal: SyncJournal = structuredClone(journal);
  for (const [key, value] of Object.entries(journal.sets)) {
    if (!isAggregateHistoryKey(key)) continue;
    if (!isAuthoritativeSyncItem(key, value)) {
      delete normalizedJournal.sets[key];
      continue;
    }
    const normalized: unknown = normalizeAggregateItem(key, value);
    assertSyncItemWithinQuota(key, normalized);
    normalizedJournal.sets[key] = normalized;
    aggregates[key] = normalized;
  }
  const tombstones: string[] = [];
  for (const key of journal.removes) {
    if (!isAggregateHistoryKey(key)) continue;
    delete aggregates[key];
    if (!tombstones.includes(key)) tombstones.push(key);
  }
  return { aggregates, tombstones, journal: normalizedJournal };
}

function parseAggregatePrune(value: unknown): LocalAggregatePruneCheckpoint | null {
  if (!isRecord(value) || !isRecord(value.set) || !Array.isArray(value.remove)) return null;
  if (
    !Object.entries(value.set).every(
      ([key, candidate]: [string, unknown]): boolean =>
        isAggregateHistoryKey(key) && isAuthoritativeSyncItem(key, candidate),
    )
  ) {
    return null;
  }
  if (
    !value.remove.every(
      (key: unknown): key is string => typeof key === 'string' && isAggregateHistoryKey(key),
    )
  ) {
    return null;
  }
  return { set: structuredClone(value.set), remove: [...value.remove] };
}

function isPolicyKey(value: unknown): value is keyof PolicyValueByKey {
  return value === 'settings' || value === 'lists' || value === 'bank' || value === 'streak';
}

function localKey(key: keyof PolicyValueByKey): string {
  if (key === 'settings') return LOCAL_SETTINGS;
  if (key === 'lists') return LOCAL_LISTS;
  if (key === 'bank') return LOCAL_BANK;
  return LOCAL_STREAK;
}

function syncKey(key: Exclude<keyof PolicyValueByKey, 'lists'>): string {
  if (key === 'settings') return SYNC_SETTINGS;
  if (key === 'bank') return SYNC_BANK;
  return SYNC_STREAK;
}

function assertPolicyValue(key: keyof PolicyValueByKey, value: unknown): void {
  const valid: boolean =
    key === 'settings'
      ? isSettings(value)
      : key === 'lists'
        ? isListsConfig(value)
        : key === 'bank'
          ? isRecord(value) && hasExactKeys(value, ['balanceMs']) && parseBank(value) !== null
          : value === null ||
            (isRecord(value) &&
              hasExactKeys(value, [
                'current',
                'freezeTokens',
                'lastCountedDate',
                'lastFreezeGrantDate',
                'activeDays',
                'activeMonth',
              ]) &&
              parseStreak(value) !== null);
  if (!valid) throw new Error(`invalid ${key} policy`);
}

function parsePolicySnapshot(value: unknown): PolicySnapshot {
  if (!isRecord(value) || !hasExactKeys(value, ['settings', 'lists', 'bank', 'streak'])) {
    throw new Error('invalid policy snapshot');
  }
  const settings: unknown = value.settings;
  const lists: unknown = value.lists;
  const rawBank: unknown = value.bank;
  const rawStreak: unknown = value.streak;
  if (!isSettings(settings) || !isListsConfig(lists)) throw new Error('invalid policy snapshot');
  const bank: BankState | null = parseBank(rawBank);
  if (!isRecord(rawBank) || !hasExactKeys(rawBank, ['balanceMs']) || bank === null) {
    throw new Error('invalid policy snapshot');
  }
  const streak: StreakState | null = rawStreak === null ? null : parseStreak(rawStreak);
  if (
    rawStreak !== null &&
    (!isRecord(rawStreak) ||
      !hasExactKeys(rawStreak, [
        'current',
        'freezeTokens',
        'lastCountedDate',
        'lastFreezeGrantDate',
        'activeDays',
        'activeMonth',
      ]) ||
      streak === null)
  ) {
    throw new Error('invalid policy snapshot');
  }
  return {
    settings: structuredClone(settings),
    lists: structuredClone(lists),
    bank: structuredClone(bank),
    streak: structuredClone(streak),
  };
}

function parseJournal(value: unknown, removalOnly: boolean): SyncJournal {
  if (value === undefined) return { sets: {}, removes: [] };
  if (!isRecord(value) || !hasExactKeys(value, ['sets', 'removes'])) {
    throw new Error('invalid local sync journal');
  }
  if (!isRecord(value.sets) || !Array.isArray(value.removes)) {
    throw new Error('invalid local sync journal');
  }
  if (!value.removes.every((key: unknown): key is string => typeof key === 'string')) {
    throw new Error('invalid local sync journal');
  }
  if (removalOnly && Object.keys(value.sets).length > 0) {
    throw new Error('invalid removal-only sync journal');
  }
  return { sets: structuredClone(value.sets), removes: [...value.removes] };
}

function journalEmpty(journal: SyncJournal): boolean {
  return Object.keys(journal.sets).length === 0 && journal.removes.length === 0;
}

function parseDataClearJournal(value: unknown): DataClearJournal | null {
  if (value === undefined) return null;
  if (
    isRecord(value) &&
    hasExactKeys(value, ['scope', 'phase', 'inventory', 'clearAggregates']) &&
    value.scope === 'local-history' &&
    (value.phase === 'local' || value.phase === 'runtime') &&
    Array.isArray(value.inventory) &&
    value.inventory.every((key: unknown): key is string => typeof key === 'string') &&
    typeof value.clearAggregates === 'boolean'
  ) {
    return {
      scope: value.scope,
      phase: value.phase,
      inventory: [...new Set(value.inventory)],
      clearAggregates: value.clearAggregates,
    };
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['scope', 'phase', 'inventory']) ||
    (value.scope !== 'synced-policy' && value.scope !== 'all') ||
    (value.phase !== 'remote' && value.phase !== 'local') ||
    !Array.isArray(value.inventory) ||
    !value.inventory.every((key: unknown): key is string => typeof key === 'string')
  ) {
    throw new Error('invalid data clear journal');
  }
  return { scope: value.scope, phase: value.phase, inventory: [...new Set(value.inventory)] };
}

function setupDataClearState(
  journal: DataClearJournal,
  status: 'pending' | 'error',
): SetupState['dataClear'] {
  if (journal.scope === 'local-history') {
    return { status, scope: journal.scope, phase: journal.phase };
  }
  return { status, scope: journal.scope, phase: journal.phase };
}

function parsePolicyCommit(value: unknown): PolicyCommit | null {
  if (!isRecord(value) || typeof value.revision !== 'string') return null;
  if (value.source === 'direct' && hasExactKeys(value, ['source', 'revision'])) {
    return { source: 'direct', revision: value.revision };
  }
  if (
    value.source === 'generation' &&
    hasExactKeys(value, ['source', 'id', 'revision']) &&
    typeof value.id === 'string'
  ) {
    return { source: 'generation', id: value.id, revision: value.revision };
  }
  return null;
}

function policyRevision(snapshot: PolicySnapshot): string {
  return `policy-v1:${serialized(snapshot)}`;
}

export function createPolicyStorage(
  local: chrome.storage.StorageArea,
  sync: chrome.storage.SyncStorageArea,
  firstSyncCheckpoint: FirstSyncCheckpointSource,
  allDataClearBarrier: AllDataClearBarrier,
): PolicyStorage {
  let initialized: boolean = false;
  let mode: StorageMode | null = null;
  let operationQueue: Promise<void> = Promise.resolve();
  let publisher: SyncWriter | null = null;
  let firstCheckpointComplete: boolean = false;
  let setupCache: SetupState | null = null;
  let allDataClearBarrierHeld = false;
  let allDataClearQuiescenceRequired = false;
  let completedAllDataClear = false;
  const echoes: SyncEchoes = new SyncEchoes();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const requested: Promise<T> = operationQueue.then(operation);
    operationQueue = requested.then(
      (): void => undefined,
      (): void => undefined,
    );
    return requested;
  }

  function runAllDataClearExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const requested: Promise<T> = allDataClearBarrier.runExclusive(
      async (): Promise<T> => {
        allDataClearBarrierHeld = true;
        try {
          return await operation();
        } finally {
          allDataClearBarrierHeld = false;
        }
      },
      (): boolean => allDataClearQuiescenceRequired,
    );
    return requested.finally((): void => {
      allDataClearQuiescenceRequired = false;
    });
  }

  async function previousValues(keys: readonly string[]): Promise<PreviousValues> {
    const existing: Record<string, unknown> = await local.get([...keys]);
    return {
      existing,
      missing: keys.filter((key: string): boolean => !Object.hasOwn(existing, key)),
    };
  }

  async function restore(previous: PreviousValues): Promise<void> {
    if (previous.missing.length > 0) await local.remove(previous.missing);
    if (Object.keys(previous.existing).length > 0) await local.set(previous.existing);
  }

  async function verifiedWrite(items: Record<string, unknown>, label: string): Promise<void> {
    const nextSetup: unknown = items[LOCAL_SETUP];
    if (Object.hasOwn(items, LOCAL_SETUP) && !isSetupState(nextSetup)) {
      throw new Error('invalid setup state write');
    }
    const keys: string[] = Object.keys(items);
    const previous: PreviousValues = await previousValues(keys);
    try {
      await local.set(structuredClone(items));
      const verified: Record<string, unknown> = await local.get(keys);
      if (!valuesEqual(verified, items)) throw new Error(`could not verify local ${label}`);
      if (isSetupState(nextSetup)) setupCache = structuredClone(nextSetup);
    } catch (error: unknown) {
      try {
        await restore(previous);
      } catch (rollbackError: unknown) {
        throw new AggregateError([error, rollbackError], `could not roll back local ${label}`);
      }
      throw error;
    }
  }

  async function verifiedRemove(keys: readonly string[], label: string): Promise<void> {
    if (keys.length === 0) return;
    const previous: PreviousValues = await previousValues(keys);
    try {
      await local.remove([...keys]);
      const verified: Record<string, unknown> = await local.get([...keys]);
      if (Object.keys(verified).length > 0) throw new Error(`could not verify local ${label}`);
    } catch (error: unknown) {
      try {
        await restore(previous);
      } catch (rollbackError: unknown) {
        throw new AggregateError([error, rollbackError], `could not roll back local ${label}`);
      }
      throw error;
    }
  }

  async function loadSetupInternal(): Promise<SetupState> {
    const stored: Record<string, unknown> = await local.get(LOCAL_SETUP);
    if (!Object.hasOwn(stored, LOCAL_SETUP)) {
      setupCache = structuredClone(DEFAULT_SETUP);
      return structuredClone(setupCache);
    }
    const value: unknown = stored[LOCAL_SETUP];
    if (!isSetupState(value)) throw new Error('invalid local setup state');
    setupCache = structuredClone(value);
    return structuredClone(setupCache);
  }

  async function saveSetupInternal(next: SetupState): Promise<void> {
    if (!isSetupState(next)) throw new Error('invalid setup state');
    await verifiedWrite({ [LOCAL_SETUP]: next }, 'setup state');
    mode = next.storageMode;
  }

  async function loadBlockedAggregatePublications(): Promise<BlockedAggregatePublications> {
    const stored: Record<string, unknown> = await local.get(LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS);
    return parseBlockedAggregatePublications(stored[LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]);
  }

  async function persistPublicationJournal(journal: SyncJournal): Promise<void> {
    const setup: SetupState = await loadSetupInternal();
    const blocked: BlockedAggregatePublications = await loadBlockedAggregatePublications();
    const hasBlocked: boolean = !blockedAggregatePublicationsEmpty(blocked);
    const empty: boolean = journalEmpty(journal);
    await verifiedWrite(
      {
        [LOCAL_SYNC_JOURNAL]: journal,
        ...(empty && mode === 'sync' ? { [LOCAL_AGGREGATE_TOMBSTONES]: [] } : {}),
        [LOCAL_SETUP]: {
          ...setup,
          syncWriteStatus: hasBlocked ? 'error' : empty ? 'idle' : 'pending',
          storageError: hasBlocked
            ? 'sync-publish-failed'
            : empty && setup.storageError === 'sync-publish-failed'
              ? null
              : setup.storageError,
        },
      },
      'sync publication journal',
    );
  }

  async function persistDataClearJournal(
    journal: DataClearJournal,
    status: 'pending' | 'error',
    storageError: SetupState['storageError'],
  ): Promise<void> {
    const setup: SetupState = await loadSetupInternal();
    const dataClear: SetupState['dataClear'] = setupDataClearState(journal, status);
    await verifiedWrite(
      {
        [LOCAL_DATA_CLEAR_JOURNAL]: journal,
        [LOCAL_SETUP]: {
          ...setup,
          syncWriteStatus:
            status === 'error' && journal.scope !== 'local-history'
              ? 'error'
              : setup.syncWriteStatus,
          storageError,
          dataClear,
        },
      },
      'data clear journal',
    );
  }

  async function loadSnapshotInternal(): Promise<PolicySnapshot> {
    const pointerStored: Record<string, unknown> = await local.get(LOCAL_POLICY_COMMIT);
    const pointer: PolicyCommit | null = parsePolicyCommit(pointerStored[LOCAL_POLICY_COMMIT]);
    if (pointer?.source === 'generation') {
      const generationKey: string = `${LOCAL_POLICY_GENERATION_PREFIX}${pointer.id}`;
      const generationStored: Record<string, unknown> = await local.get(generationKey);
      const generation: unknown = generationStored[generationKey];
      if (
        !isRecord(generation) ||
        generation.id !== pointer.id ||
        generation.revision !== pointer.revision ||
        !isRecord(generation.policy)
      ) {
        throw new Error('committed policy generation is missing or invalid');
      }
      return parsePolicySnapshot(generation.policy);
    }
    const stored: Record<string, unknown> = await local.get([...POLICY_LOCAL_KEYS]);
    const settings: unknown = stored[LOCAL_SETTINGS];
    const lists: unknown = stored[LOCAL_LISTS];
    const bank: unknown = stored[LOCAL_BANK];
    const streak: unknown = stored[LOCAL_STREAK];
    if (settings !== undefined) assertPolicyValue('settings', settings);
    if (lists !== undefined) assertPolicyValue('lists', lists);
    if (bank !== undefined) assertPolicyValue('bank', bank);
    if (streak !== undefined) assertPolicyValue('streak', streak);
    return parsePolicySnapshot({
      settings: settings === undefined ? DEFAULT_SETTINGS : settings,
      lists: lists === undefined ? DEFAULT_LISTS : lists,
      bank: bank === undefined ? { balanceMs: 0 } : bank,
      streak: streak === undefined ? null : streak,
    });
  }

  async function fullPublication(
    snapshot: PolicySnapshot,
    aggregateItems: Record<string, unknown> = {},
  ): Promise<SyncJournal> {
    assertSyncItemWithinQuota(SYNC_SETTINGS, snapshot.settings);
    assertSyncItemWithinQuota(SYNC_BANK, snapshot.bank);
    if (snapshot.streak !== null) assertSyncItemWithinQuota(SYNC_STREAK, snapshot.streak);
    const lists: ListsSyncEncoding = await encodeListsForSync(snapshot.lists);
    const normalizedAggregates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(aggregateItems)) {
      if (POLICY_SYNC_KEYS.includes(key)) {
        throw new Error(`first sync checkpoint item ${JSON.stringify(key)} collides with policy`);
      }
      if (!isAuthoritativeSyncItem(key, value)) {
        throw new Error(`invalid first sync checkpoint item ${JSON.stringify(key)}`);
      }
      const normalized: unknown = isAggregateHistoryKey(key)
        ? normalizeAggregateItem(key, value)
        : structuredClone(value);
      assertSyncItemWithinQuota(key, normalized);
      normalizedAggregates[key] = normalized;
    }
    const tombstoneStored: Record<string, unknown> = await local.get(LOCAL_AGGREGATE_TOMBSTONES);
    const aggregateRemoves: string[] = parseAggregateTombstones(
      tombstoneStored[LOCAL_AGGREGATE_TOMBSTONES],
    );
    for (const key of aggregateRemoves) delete normalizedAggregates[key];
    return {
      sets: {
        [SYNC_SETTINGS]: snapshot.settings,
        ...lists.sets,
        [SYNC_BANK]: snapshot.bank,
        ...(snapshot.streak === null ? {} : { [SYNC_STREAK]: snapshot.streak }),
        ...normalizedAggregates,
      },
      removes: [
        ...lists.removes,
        ...(snapshot.streak === null ? [SYNC_STREAK] : []),
        ...aggregateRemoves,
      ],
    };
  }

  async function loadedJournal(key: string, removalOnly: boolean): Promise<SyncJournal> {
    const stored: Record<string, unknown> = await local.get(key);
    return parseJournal(stored[key], removalOnly);
  }

  async function createPublisher(initial: SyncJournal): Promise<SyncWriter> {
    const writer: SyncWriter = new SyncWriter(
      SYNC_FLUSH_MS,
      (items: Record<string, unknown>): Promise<void> =>
        setSyncItemsWithinQuota(
          Object.fromEntries(
            Object.entries(items).map(([key, value]: [string, unknown]): [string, unknown] => {
              echoes.remember(key, value);
              return [key, value];
            }),
          ),
          sync,
          local,
        ),
      (keys: string[]): Promise<void> => {
        for (const key of keys) echoes.rememberRemoval(key);
        return removeSyncItems(keys, sync, local);
      },
      {
        initial,
        persist: persistPublicationJournal,
        onFlushError: async (): Promise<void> => {
          const setup: SetupState = await loadSetupInternal();
          await saveSetupInternal({
            ...setup,
            syncWriteStatus: 'error',
            storageError: 'sync-publish-failed',
          });
        },
      },
    );
    if (mode !== 'sync') await writer.pause();
    return writer;
  }

  async function ensurePublisher(initial?: SyncJournal): Promise<SyncWriter> {
    if (publisher !== null) return publisher;
    const journal: SyncJournal = initial ?? (await loadedJournal(LOCAL_SYNC_JOURNAL, false));
    publisher = await createPublisher(journal);
    return publisher;
  }

  async function reconstructPendingOutbox(setup: SetupState): Promise<void> {
    if (setup.syncWriteStatus === 'idle') return;
    try {
      const persisted: SyncJournal = sanitizeSyncJournal(
        await loadedJournal(LOCAL_SYNC_JOURNAL, false),
      ).journal;
      const blocked: BlockedAggregatePublications = await loadBlockedAggregatePublications();
      const aggregateItems: Record<string, unknown> =
        await firstSyncCheckpoint.loadAggregateItems();
      let blockedChanged: boolean = false;
      for (const key of Object.keys(blocked.items)) {
        if (!Object.hasOwn(aggregateItems, key)) {
          delete blocked.items[key];
          blockedChanged = true;
          continue;
        }
        const current: unknown = normalizeAggregateItem(key, aggregateItems[key]);
        if (!valuesEqual(current, blocked.items[key])) {
          delete blocked.items[key];
          blockedChanged = true;
          continue;
        }
        try {
          assertSyncItemWithinQuota(key, current);
          delete blocked.items[key];
          blockedChanged = true;
        } catch (error: unknown) {
          if (!(error instanceof SyncQuotaError)) throw error;
          delete aggregateItems[key];
        }
      }
      for (const [key, value] of Object.entries(aggregateItems)) {
        if (!isAggregateHistoryKey(key)) continue;
        const normalized: unknown = normalizeAggregateItem(key, value);
        try {
          assertSyncItemWithinQuota(key, normalized);
        } catch (error: unknown) {
          if (!(error instanceof SyncQuotaError)) throw error;
          blocked.items[key] = normalized;
          delete aggregateItems[key];
          blockedChanged = true;
        }
      }
      if (blockedChanged) {
        const current: SetupState = await loadSetupInternal();
        const hasBlocked: boolean = !blockedAggregatePublicationsEmpty(blocked);
        await verifiedWrite(
          {
            [LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]: blocked,
            ...(hasBlocked
              ? {
                  [LOCAL_SETUP]: {
                    ...current,
                    syncWriteStatus: 'error',
                    storageError: 'sync-publish-failed',
                  },
                }
              : {}),
          },
          'reconstructed blocked aggregate publications',
        );
      }
      const complete: SyncJournal = await fullPublication(
        await loadSnapshotInternal(),
        aggregateItems,
      );
      for (const [key, value] of Object.entries(persisted.sets)) {
        if (Object.hasOwn(blocked.items, key)) continue;
        if (!POLICY_SYNC_KEYS.includes(key) && isAuthoritativeSyncItem(key, value)) {
          const normalized: unknown = isAggregateHistoryKey(key)
            ? normalizeAggregateItem(key, value)
            : structuredClone(value);
          assertSyncItemWithinQuota(key, normalized);
          complete.sets[key] = normalized;
        }
      }
      for (const key of persisted.removes) {
        if (Object.hasOwn(blocked.items, key)) continue;
        if (!POLICY_SYNC_KEYS.includes(key) && isFocusLockSyncKey(key)) {
          complete.removes.push(key);
          delete complete.sets[key];
        }
      }
      for (const key of Object.keys(blocked.items)) delete complete.sets[key];
      complete.removes = [...new Set(complete.removes)].filter(
        (key: string): boolean => !Object.hasOwn(blocked.items, key),
      );
      const normalizedLocal: Record<string, unknown> = normalizedAggregateItems(complete.sets);
      if (Object.keys(normalizedLocal).length > 0) {
        await verifiedWrite(normalizedLocal, 'normalized pending aggregate authority');
      }
      await persistPublicationJournal(complete);
      const writer: SyncWriter = await ensurePublisher(complete);
      if (setup.storageMode === 'sync') writer.resume();
    } catch (error: unknown) {
      const current: SetupState = await loadSetupInternal();
      await saveSetupInternal({
        ...current,
        syncWriteStatus: 'error',
        storageError: 'sync-publish-failed',
      });
      if (setup.storageMode === 'sync' && !(error instanceof SyncQuotaError)) throw error;
    }
  }

  async function loadDataClearJournal(): Promise<DataClearJournal | null> {
    const stored: Record<string, unknown> = await local.get(LOCAL_DATA_CLEAR_JOURNAL);
    return parseDataClearJournal(stored[LOCAL_DATA_CLEAR_JOURNAL]);
  }

  async function recoverLocalAggregatePrune(): Promise<void> {
    const stored: Record<string, unknown> = await local.get(LOCAL_AGGREGATE_PRUNE);
    if (!Object.hasOwn(stored, LOCAL_AGGREGATE_PRUNE)) return;
    const checkpoint: LocalAggregatePruneCheckpoint | null = parseAggregatePrune(
      stored[LOCAL_AGGREGATE_PRUNE],
    );
    if (checkpoint === null) throw new Error('invalid local aggregate prune checkpoint');
    if (Object.keys(checkpoint.set).length > 0) {
      await verifiedWrite(checkpoint.set, 'aggregate prune rollup');
    }
    await verifiedRemove(checkpoint.remove, 'aggregate prune removals');
    await verifiedRemove([LOCAL_AGGREGATE_PRUNE], 'aggregate prune checkpoint cleanup');
  }

  async function recoverAggregateTombstones(): Promise<void> {
    const stored: Record<string, unknown> = await local.get(LOCAL_AGGREGATE_TOMBSTONES);
    const tombstones: string[] = parseAggregateTombstones(stored[LOCAL_AGGREGATE_TOMBSTONES]);
    await verifiedRemove(tombstones, 'aggregate tombstones');
  }

  async function localAggregateHistoryItems(): Promise<Record<string, unknown>> {
    const stored: Record<string, unknown> = await local.get(null);
    const projected: Record<string, unknown> = Object.fromEntries(
      Object.entries(stored).filter(([key]: [string, unknown]): boolean =>
        isAggregateHistoryKey(key),
      ),
    );
    const checkpoint: LocalAggregatePruneCheckpoint | null = parseAggregatePrune(
      stored[LOCAL_AGGREGATE_PRUNE],
    );
    if (checkpoint !== null) {
      for (const key of checkpoint.remove) delete projected[key];
      Object.assign(projected, checkpoint.set);
    }
    for (const key of parseAggregateTombstones(stored[LOCAL_AGGREGATE_TOMBSTONES])) {
      delete projected[key];
    }
    return projected;
  }

  async function initializeInternal(): Promise<void> {
    if (initialized) return;
    await recoverLocalAggregatePrune();
    await recoverAggregateTombstones();
    const blocked: BlockedAggregatePublications = await loadBlockedAggregatePublications();
    let setup: SetupState = await loadSetupInternal();
    mode = setup.storageMode;
    const dataClearJournal: DataClearJournal | null = await loadDataClearJournal();
    if (dataClearJournal !== null) {
      if (dataClearJournal.scope === 'all') {
        if (!allDataClearBarrierHeld) {
          throw new Error('all-data clear recovery requires the runtime mutation barrier');
        }
        allDataClearQuiescenceRequired = true;
      }
      try {
        await resumeDataClear(dataClearJournal);
      } catch (_error: unknown) {
        const currentJournal: DataClearJournal = (await loadDataClearJournal()) ?? dataClearJournal;
        const failedSetup: SetupState = await loadSetupInternal();
        const failedDataClear: SetupState['dataClear'] = setupDataClearState(
          currentJournal,
          'error',
        );
        await saveSetupInternal({
          ...failedSetup,
          dataClear: failedDataClear,
          storageError:
            currentJournal.phase === 'remote' ? 'remote-deletion-failed' : 'local-clear-failed',
        });
        initialized = true;
        mode = (await loadSetupInternal()).storageMode;
        return;
      }
      initialized = true;
      return;
    }
    if (
      setup.storageMode === 'sync' &&
      setup.syncWriteStatus === 'idle' &&
      !blockedAggregatePublicationsEmpty(blocked)
    ) {
      setup = {
        ...setup,
        syncWriteStatus: 'error',
        storageError: 'sync-publish-failed',
      };
      await saveSetupInternal(setup);
    }
    const pointerStored: Record<string, unknown> = await local.get(LOCAL_POLICY_COMMIT);
    const pointer: PolicyCommit | null = parsePolicyCommit(pointerStored[LOCAL_POLICY_COMMIT]);
    if (pointer?.source === 'generation') {
      const record: PolicyGenerationRecord = await generationRecord(pointer);
      if (!setup.legacyImported) {
        setup = {
          ...setup,
          storageMode: null,
          syncWriteStatus: journalEmpty(record.journal) ? 'idle' : 'pending',
          legacyImported: true,
          storageError: null,
        };
        await verifiedWrite(
          {
            [LOCAL_SYNC_JOURNAL]: record.journal,
            [LOCAL_SETUP]: setup,
          },
          'repaired committed legacy migration',
        );
        mode = null;
      }
      await cleanupGeneration(record);
      await cleanupStaleGenerations();
    } else if (pointer?.source === 'direct' && setup.legacyImported) {
      await cleanupStaleGenerations();
    }
    if (setup.storageMode === 'sync') {
      firstCheckpointComplete = true;
      if (setup.syncWriteStatus === 'idle') await ensurePublisher();
      else await reconstructPendingOutbox(setup);
      initialized = true;
      return;
    }
    if (setup.syncWriteStatus !== 'idle') await reconstructPendingOutbox(setup);
    initialized = true;
  }

  async function ensureInitialized(): Promise<void> {
    if (!initialized) await initializeInternal();
  }

  async function queuePolicyInternal(key: keyof PolicyValueByKey, value: unknown): Promise<void> {
    if (key === 'lists') {
      if (!isListsConfig(value)) throw new Error('invalid lists policy');
      const encoding: ListsSyncEncoding = await encodeListsForSync(value);
      const writer: SyncWriter = await ensurePublisher();
      for (const [listKey, listValue] of Object.entries(encoding.sets)) {
        writer.queue(listKey, listValue);
      }
      for (const listKey of encoding.removes) writer.remove(listKey);
      await writer.whenJournalDurable();
      return;
    }
    const writer: SyncWriter = await ensurePublisher();
    const remoteKey: string = syncKey(key);
    if (value === null) writer.remove(remoteKey);
    else writer.queue(remoteKey, value);
    await writer.whenJournalDurable();
  }

  async function queueVerifiedRemoteCorrectionsInternal(
    keys: readonly (keyof PolicyValueByKey)[],
  ): Promise<void> {
    await ensureInitialized();
    const setup: SetupState = await loadSetupInternal();
    if (mode !== 'sync' || setup.dataClear.status !== 'idle') return;
    const unique: Set<keyof PolicyValueByKey> = new Set();
    for (const key of keys) {
      if (!isPolicyKey(key)) throw new Error('invalid corrective policy key');
      unique.add(key);
    }
    if (unique.size === 0) return;
    const snapshot: PolicySnapshot = await loadSnapshotInternal();
    try {
      await saveSetupInternal({ ...setup, syncWriteStatus: 'pending' });
      for (const key of unique) await queuePolicyInternal(key, snapshot[key]);
    } catch (error: unknown) {
      const current: SetupState = await loadSetupInternal();
      await saveSetupInternal({
        ...current,
        syncWriteStatus: 'error',
        storageError: 'sync-publish-failed',
      });
      throw error;
    }
  }

  async function setPolicyInternal(key: unknown, value: unknown): Promise<void> {
    await ensureInitialized();
    if (!isPolicyKey(key)) throw new Error('invalid policy key');
    assertPolicyValue(key, value);
    if (mode !== 'sync') {
      await verifiedWrite({ [localKey(key)]: value }, `${key} policy`);
      return;
    }
    const setup: SetupState = await loadSetupInternal();
    await verifiedWrite(
      {
        [localKey(key)]: value,
        [LOCAL_SETUP]: { ...setup, syncWriteStatus: 'pending' },
      },
      `${key} policy and pending sync status`,
    );
    try {
      await queuePolicyInternal(key, value);
    } catch (error: unknown) {
      const current: SetupState = await loadSetupInternal();
      await saveSetupInternal({
        ...current,
        syncWriteStatus: 'error',
        storageError: 'sync-publish-failed',
      });
      throw error;
    }
  }

  async function enableSyncInternal(): Promise<void> {
    await ensureInitialized();
    const setupBeforeEnable: SetupState = await loadSetupInternal();
    if (setupBeforeEnable.dataClear.status !== 'idle') {
      throw new Error('finish the pending data deletion before enabling Sync');
    }
    if (mode === 'sync') return;
    const priorMode: StorageMode | null = mode;
    let complete: SyncJournal;
    try {
      const aggregateItems: Record<string, unknown> =
        await firstSyncCheckpoint.loadAggregateItems();
      complete = await fullPublication(await loadSnapshotInternal(), aggregateItems);
      const deviceStored: Record<string, unknown> = await local.get(LOCAL_DEVICE_ID);
      const deviceId: unknown = deviceStored[LOCAL_DEVICE_ID];
      if (typeof deviceId === 'string' && deviceId !== '') {
        const remote: Record<string, unknown> = await sync.get(null);
        for (const key of Object.keys(remote)) {
          if (
            aggregateHistoryDeviceId(key) === deviceId &&
            !Object.hasOwn(complete.sets, key) &&
            !complete.removes.includes(key)
          ) {
            complete.removes.push(key);
          }
        }
      }
      const normalizedLocal: Record<string, unknown> = normalizedAggregateItems(complete.sets);
      if (Object.keys(normalizedLocal).length > 0) {
        await verifiedWrite(normalizedLocal, 'normalized first sync aggregate authority');
      }
    } catch (error: unknown) {
      const current: SetupState = await loadSetupInternal();
      await saveSetupInternal({
        ...current,
        syncWriteStatus: 'error',
        storageError: 'sync-publish-failed',
      });
      throw error;
    }
    const setup: SetupState = await loadSetupInternal();
    try {
      await saveSetupInternal({ ...setup, syncWriteStatus: 'pending' });
      await verifiedWrite({ [LOCAL_SYNC_JOURNAL]: complete }, 'complete sync publication outbox');
    } catch (error: unknown) {
      const current: SetupState = await loadSetupInternal();
      await saveSetupInternal({
        ...current,
        syncWriteStatus: 'error',
        storageError: 'sync-publish-failed',
      });
      throw error;
    }
    try {
      const writer: SyncWriter = await ensurePublisher(complete);
      await writer.pause();
      await writer.transformPending(
        (): Promise<void> => Promise.resolve(),
        (): SyncJournal => complete,
      );
      writer.resume();
      await writer.flushNow();
      const completedSetup: SetupState = await loadSetupInternal();
      const syncedSetup: SetupState = {
        ...completedSetup,
        storageMode: 'sync',
        syncWriteStatus: 'idle',
        storageError: null,
      };
      if (!isSetupState(syncedSetup)) throw new Error('invalid setup state');
      await verifiedWrite(
        {
          [LOCAL_SETUP]: syncedSetup,
          [LOCAL_AGGREGATE_TOMBSTONES]: [],
        },
        'sync mode and published aggregate tombstones',
      );
      mode = 'sync';
      firstCheckpointComplete = true;
      publisher = writer;
    } catch (error: unknown) {
      mode = priorMode;
      if (publisher !== null) await publisher.pause();
      const current: SetupState = await loadSetupInternal();
      await saveSetupInternal({
        ...current,
        syncWriteStatus: 'error',
        storageError: 'sync-publish-failed',
      });
      throw error;
    }
  }

  async function disableSyncInternal(): Promise<void> {
    await ensureInitialized();
    if (mode !== 'sync' && publisher === null) {
      const blocked: BlockedAggregatePublications = await loadBlockedAggregatePublications();
      if (blockedAggregatePublicationsEmpty(blocked)) return;
      const setup: SetupState = await loadSetupInternal();
      await verifiedWrite(
        {
          [LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]: emptyBlockedAggregatePublications(),
          [LOCAL_SETUP]: {
            ...setup,
            storageMode: 'local',
            syncWriteStatus: 'idle',
            storageError: setup.storageError === 'sync-publish-failed' ? null : setup.storageError,
          },
        },
        'abandoned local aggregate publications',
      );
      mode = 'local';
      return;
    }
    const setup: SetupState = await loadSetupInternal();
    try {
      if (publisher !== null) {
        await publisher.pause();
        await publisher.drain();
      }
      const localSetup: SetupState = {
        ...setup,
        storageMode: 'local',
        syncWriteStatus: 'idle',
        storageError: null,
      };
      await verifiedWrite(
        {
          [LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]: emptyBlockedAggregatePublications(),
          [LOCAL_SYNC_JOURNAL]: { sets: {}, removes: [] },
          [LOCAL_SETUP]: localSetup,
        },
        'local mode and abandoned aggregate publications',
      );
      publisher?.discardPendingAfterDurableJournalCommit();
      mode = 'local';
    } catch (error: unknown) {
      if (mode === 'sync' && publisher !== null) publisher.resume();
      throw error;
    }
    firstCheckpointComplete = false;
  }

  async function selectLocalModeInternal(): Promise<void> {
    await ensureInitialized();
    const setup: SetupState = await loadSetupInternal();
    if (setup.dataClear.status !== 'idle') {
      throw new Error('finish or retry the pending data deletion before selecting Local storage');
    }
    const blocked: BlockedAggregatePublications = await loadBlockedAggregatePublications();
    let hasPublicationIntent: boolean = true;
    try {
      hasPublicationIntent = !journalEmpty(await loadedJournal(LOCAL_SYNC_JOURNAL, false));
    } catch (_error: unknown) {
      // Explicit local selection also abandons a malformed failed-publish journal.
    }
    if (
      mode === 'local' &&
      setup.syncWriteStatus === 'idle' &&
      setup.storageError !== 'sync-publish-failed' &&
      blockedAggregatePublicationsEmpty(blocked) &&
      !hasPublicationIntent
    ) {
      return;
    }
    await disableSyncInternal();
    const current: SetupState = await loadSetupInternal();
    await verifiedWrite(
      {
        [LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]: emptyBlockedAggregatePublications(),
        [LOCAL_SYNC_JOURNAL]: { sets: {}, removes: [] },
        [LOCAL_SETUP]: {
          ...current,
          storageMode: 'local',
          syncWriteStatus: 'idle',
          storageError:
            current.storageError === 'sync-publish-failed' ? null : current.storageError,
        },
      },
      'local storage selection',
    );
    mode = 'local';
    firstCheckpointComplete = false;
  }

  async function updateSetupInternal(next: Partial<SetupUpdate>): Promise<void> {
    await ensureInitialized();
    const allowed: readonly string[] = [
      'websiteAccess',
      'blockingRegistration',
      'websiteAccessNotice',
    ];
    if (Object.keys(next).some((key: string): boolean => !allowed.includes(key))) {
      throw new Error('invalid setup update');
    }
    const current: SetupState = await loadSetupInternal();
    const updated: SetupState = { ...current, ...next };
    if (!isSetupState(updated)) throw new Error('invalid setup update');
    await saveSetupInternal(updated);
  }

  async function markSetupCompletedInternal(): Promise<void> {
    await ensureInitialized();
    const setup: SetupState = await loadSetupInternal();
    if (
      setup.storageMode === null ||
      setup.dataClear.status !== 'idle' ||
      (setup.storageMode === 'sync' && !firstCheckpointComplete)
    ) {
      throw new Error('cannot complete setup before storage is ready');
    }
    await saveSetupInternal({ ...setup, completed: true });
  }

  async function mirrorAcceptedRemotePolicyInternal(
    changes: Record<string, unknown>,
    pendingRemoteKeys: readonly string[],
  ): Promise<void> {
    await ensureInitialized();
    const setup: SetupState = await loadSetupInternal();
    if (mode !== 'sync' || setup.dataClear.status !== 'idle') {
      throw new Error('inbound sync policy is not accepted in the current storage mode');
    }
    const items: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(changes)) {
      if (!isPolicyKey(key)) throw new Error(`invalid inbound policy key ${JSON.stringify(key)}`);
      assertPolicyValue(key, value);
      items[localKey(key)] = value;
    }
    if (Object.keys(items).length === 0) return;
    const writer: SyncWriter = await ensurePublisher();
    const reconcileKeys: Set<string> = new Set(pendingRemoteKeys);
    const reconcileSettings: boolean =
      changes.settings !== undefined &&
      (reconcileKeys.has(SYNC_SETTINGS) || writer.hasPending(SYNC_SETTINGS));
    const reconcileLists: boolean =
      changes.lists !== undefined &&
      LIST_SYNC_KEYS.some(
        (key: string): boolean => reconcileKeys.has(key) || writer.hasPending(key),
      );
    const reconcileBank: boolean =
      changes.bank !== undefined && (reconcileKeys.has(SYNC_BANK) || writer.hasPending(SYNC_BANK));
    const reconcileStreak: boolean =
      changes.streak !== undefined &&
      (reconcileKeys.has(SYNC_STREAK) || writer.hasPending(SYNC_STREAK));
    if (!reconcileSettings && !reconcileLists && !reconcileBank && !reconcileStreak) {
      await verifiedWrite(items, 'accepted remote policy');
      return;
    }
    const listsForReconciliation: ListsConfig | null = isListsConfig(changes.lists)
      ? changes.lists
      : null;
    if (reconcileLists && listsForReconciliation === null) {
      throw new Error('invalid lists policy reconciliation');
    }
    const listEncoding: ListsSyncEncoding | null =
      reconcileLists && listsForReconciliation !== null
        ? await encodeListsForSync(listsForReconciliation)
        : null;
    await writer.pause();
    const previous: PreviousValues = await previousValues(Object.keys(items));
    try {
      await verifiedWrite(items, 'accepted remote policy');
      await writer.transformPending(
        (): Promise<undefined> => Promise.resolve(undefined),
        (_prepared: undefined, pending: SyncJournal): SyncJournal => {
          const sets: Record<string, unknown> = { ...pending.sets };
          const removes: Set<string> = new Set(pending.removes);
          const replace = (key: string, value: unknown): void => {
            delete sets[key];
            removes.delete(key);
            if (value === null) removes.add(key);
            else sets[key] = value;
          };
          if (reconcileSettings) replace(SYNC_SETTINGS, changes.settings);
          if (reconcileBank) replace(SYNC_BANK, changes.bank);
          if (reconcileStreak) replace(SYNC_STREAK, changes.streak);
          if (reconcileLists && listEncoding !== null) {
            for (const key of LIST_SYNC_KEYS) {
              delete sets[key];
              removes.delete(key);
            }
            Object.assign(sets, listEncoding.sets);
            for (const key of listEncoding.removes) removes.add(key);
          }
          return { sets, removes: [...removes] };
        },
      );
    } catch (error: unknown) {
      try {
        await restore(previous);
      } catch (rollbackError: unknown) {
        throw new AggregateError(
          [error, rollbackError],
          'could not roll back accepted remote policy',
        );
      }
      throw error;
    } finally {
      if (mode === 'sync') writer.resume();
    }
  }

  async function generationRecord(
    pointer: Extract<PolicyCommit, { source: 'generation' }>,
  ): Promise<PolicyGenerationRecord> {
    const key: string = `${LOCAL_POLICY_GENERATION_PREFIX}${pointer.id}`;
    const stored: Record<string, unknown> = await local.get(key);
    const value: unknown = stored[key];
    const oldRecordKeys: readonly string[] = ['id', 'revision', 'policy', 'runtime', 'journal'];
    const aggregateRecordKeys: readonly string[] = [
      ...oldRecordKeys,
      'aggregates',
      'aggregateTombstones',
    ];
    if (
      !isRecord(value) ||
      (!hasExactKeys(value, oldRecordKeys) && !hasExactKeys(value, aggregateRecordKeys)) ||
      value.id !== pointer.id ||
      value.revision !== pointer.revision ||
      !isRecord(value.runtime)
    ) {
      throw new Error('committed policy generation is missing or invalid');
    }
    const policy: PolicySnapshot = parsePolicySnapshot(value.policy);
    if (policyRevision(policy) !== pointer.revision) {
      throw new Error('committed policy generation revision does not match');
    }
    const runtimeDate: unknown = value.runtime.date;
    if (typeof runtimeDate !== 'string') {
      throw new Error('committed runtime generation is invalid');
    }
    const runtimeNow: number = new Date(`${runtimeDate}T12:00:00`).getTime();
    if (!Number.isFinite(runtimeNow)) throw new Error('committed runtime generation is invalid');
    const runtime: RuntimeState = migrateRuntimeRules(
      mergeRuntime(value.runtime, runtimeNow),
      policy.lists,
    );
    if (!valuesEqual(runtime, value.runtime)) {
      throw new Error('committed runtime generation is invalid');
    }
    const journal: SyncJournal = parseJournal(value.journal, false);
    const hasAggregateAuthority: boolean = value.aggregates !== undefined;
    if (hasAggregateAuthority !== (value.aggregateTombstones !== undefined)) {
      throw new Error('committed aggregate generation is invalid');
    }
    if (hasAggregateAuthority && !isRecord(value.aggregates)) {
      throw new Error('committed aggregate generation is invalid');
    }
    const rawAggregates: Record<string, unknown> = isRecord(value.aggregates)
      ? value.aggregates
      : {};
    const aggregates: Record<string, unknown> = normalizedAggregateItems(rawAggregates);
    if (Object.keys(aggregates).length !== Object.keys(rawAggregates).length) {
      throw new Error('committed aggregate generation is invalid');
    }
    const aggregateTombstones: string[] =
      value.aggregateTombstones === undefined
        ? []
        : parseAggregateTombstones(value.aggregateTombstones);
    if (
      value.aggregateTombstones !== undefined &&
      (!Array.isArray(value.aggregateTombstones) ||
        aggregateTombstones.length !== value.aggregateTombstones.length)
    ) {
      throw new Error('committed aggregate generation is invalid');
    }
    return {
      id: pointer.id,
      revision: pointer.revision,
      policy,
      runtime,
      journal,
      aggregates,
      aggregateTombstones,
    };
  }

  async function cleanupGeneration(record: PolicyGenerationRecord): Promise<void> {
    await verifiedWrite(
      {
        [LOCAL_SETTINGS]: record.policy.settings,
        [LOCAL_LISTS]: record.policy.lists,
        [LOCAL_BANK]: record.policy.bank,
        [LOCAL_STREAK]: record.policy.streak,
        [LOCAL_RUNTIME]: record.runtime,
        ...record.aggregates,
        [LOCAL_AGGREGATE_TOMBSTONES]: record.aggregateTombstones,
      },
      'materialized policy and aggregate generation',
    );
    await verifiedRemove(record.aggregateTombstones, 'legacy aggregate removals');
    const direct: PolicyCommit = { source: 'direct', revision: record.revision };
    await verifiedWrite({ [LOCAL_POLICY_COMMIT]: direct }, 'direct policy authority');
    await local.remove(`${LOCAL_POLICY_GENERATION_PREFIX}${record.id}`);
  }

  async function cleanupStaleGenerations(): Promise<void> {
    const stored: Record<string, unknown> = await local.get(null);
    const keys: string[] = Object.keys(stored).filter((key: string): boolean =>
      key.startsWith(LOCAL_POLICY_GENERATION_PREFIX),
    );
    if (keys.length > 0) await local.remove(keys);
  }

  async function importLegacyInternal(
    snapshot: PolicySnapshot,
    runtime: RuntimeState,
    journal: SyncJournal,
    storedSync: Record<string, unknown>,
  ): Promise<void> {
    await ensureInitialized();
    const pointerStored: Record<string, unknown> = await local.get(LOCAL_POLICY_COMMIT);
    const existingPointer: PolicyCommit | null = parsePolicyCommit(
      pointerStored[LOCAL_POLICY_COMMIT],
    );
    let record: PolicyGenerationRecord;
    let authorityCommitted: boolean = existingPointer !== null;
    try {
      if (existingPointer?.source === 'generation') {
        record = await generationRecord(existingPointer);
      } else if (existingPointer?.source === 'direct') {
        const setup: SetupState = await loadSetupInternal();
        if (!setup.legacyImported || setup.storageError !== null) {
          const repairedSetup: SetupState = {
            ...setup,
            storageMode: null,
            syncWriteStatus: journalEmpty(journal) ? 'idle' : 'pending',
            legacyImported: true,
            storageError: null,
          };
          await verifiedWrite(
            {
              [LOCAL_SYNC_JOURNAL]: journal,
              [LOCAL_SETUP]: repairedSetup,
            },
            'repaired legacy setup and publication journal',
          );
          mode = null;
        }
        await cleanupStaleGenerations();
        return;
      } else {
        assertPolicyValue('settings', snapshot.settings);
        assertPolicyValue('lists', snapshot.lists);
        assertPolicyValue('bank', snapshot.bank);
        assertPolicyValue('streak', snapshot.streak);
        const aggregateAuthority: LegacyAggregateAuthority = effectiveLegacyAggregateAuthority(
          storedSync,
          journal,
        );
        const id: string = crypto.randomUUID();
        const revision: string = policyRevision(snapshot);
        record = {
          id,
          revision,
          policy: structuredClone(snapshot),
          runtime: structuredClone(runtime),
          journal: aggregateAuthority.journal,
          aggregates: aggregateAuthority.aggregates,
          aggregateTombstones: aggregateAuthority.tombstones,
        };
        const generationKey: string = `${LOCAL_POLICY_GENERATION_PREFIX}${id}`;
        await verifiedWrite({ [generationKey]: record }, 'legacy policy generation');
        const pointer: PolicyCommit = { source: 'generation', id, revision };
        await verifiedWrite({ [LOCAL_POLICY_COMMIT]: pointer }, 'generation policy authority');
        authorityCommitted = true;
      }
      const setup: SetupState = await loadSetupInternal();
      if (!setup.legacyImported || setup.storageError !== null) {
        const committedJournal: SyncJournal = record.journal;
        const migratedSetup: SetupState = {
          ...setup,
          storageMode: null,
          syncWriteStatus: journalEmpty(committedJournal) ? 'idle' : 'pending',
          legacyImported: true,
          storageError: null,
        };
        await verifiedWrite(
          {
            [LOCAL_SYNC_JOURNAL]: committedJournal,
            [LOCAL_SETUP]: migratedSetup,
          },
          'legacy setup and publication journal',
        );
        mode = null;
      }
      await cleanupGeneration(record);
      await cleanupStaleGenerations();
    } catch (error: unknown) {
      if (!authorityCommitted) {
        const setup: SetupState = await loadSetupInternal();
        await saveSetupInternal({
          ...setup,
          legacyImported: false,
          storageError: 'legacy-migration-failed',
        });
      }
      throw error;
    }
  }

  async function markLegacyMigrationFailedInternal(): Promise<void> {
    await ensureInitialized();
    const pointerStored: Record<string, unknown> = await local.get(LOCAL_POLICY_COMMIT);
    if (parsePolicyCommit(pointerStored[LOCAL_POLICY_COMMIT]) !== null) return;
    const setup: SetupState = await loadSetupInternal();
    await saveSetupInternal({
      ...setup,
      legacyImported: false,
      storageError: 'legacy-migration-failed',
    });
  }

  async function clearRemotePhase(journal: DataClearJournal): Promise<DataClearJournal> {
    const publication: SyncJournal = await loadedJournal(LOCAL_SYNC_JOURNAL, false);
    const initialKeys: string[] = [
      ...new Set(
        [...journal.inventory, ...Object.keys(publication.sets), ...publication.removes].filter(
          isFocusLockDeletionKey,
        ),
      ),
    ].sort();
    journal = { ...journal, inventory: initialKeys };
    await persistDataClearJournal(journal, 'pending', null);
    if (publisher !== null) {
      await publisher.pause();
      await publisher.drain();
      await publisher.transformPending(
        (): Promise<void> => Promise.resolve(),
        (): SyncJournal => ({ sets: {}, removes: [] }),
      );
    } else {
      await persistPublicationJournal({ sets: {}, removes: [] });
    }
    await removeSyncItemsUntilClear(
      {
        initialKeys,
        matches: isFocusLockDeletionKey,
        persistInventory: async (inventory: string[]): Promise<void> => {
          const pending: DataClearJournal = { ...journal, inventory };
          await persistDataClearJournal(pending, 'pending', null);
        },
      },
      sync,
      local,
    );
    return { ...journal, inventory: [] };
  }

  function isFocusLockLocalKey(key: string): boolean {
    return (
      FOCUS_LOCK_LOCAL_EXACT_KEYS.includes(key) ||
      key.startsWith(LOCAL_POLICY_GENERATION_PREFIX) ||
      key.startsWith('agg:') ||
      key.startsWith('aggm:') ||
      key.startsWith('archive:clock-rebase:')
    );
  }

  async function finishDataClear(journal: DataClearJournal): Promise<void> {
    const setup: SetupState = await loadSetupInternal();
    await saveSetupInternal({
      ...setup,
      syncWriteStatus: journal.scope === 'local-history' ? setup.syncWriteStatus : 'idle',
      storageError:
        journal.scope === 'local-history' && setup.storageError !== 'local-clear-failed'
          ? setup.storageError
          : null,
      dataClear: { status: 'idle', scope: null, phase: null },
    });
    try {
      await local.remove(LOCAL_DATA_CLEAR_JOURNAL);
      const verified: Record<string, unknown> = await local.get(LOCAL_DATA_CLEAR_JOURNAL);
      if (Object.hasOwn(verified, LOCAL_DATA_CLEAR_JOURNAL)) {
        throw new Error(`could not finish ${journal.scope} data clear`);
      }
    } catch (error: unknown) {
      const storageError: SetupState['storageError'] =
        journal.phase === 'remote' ? 'remote-deletion-failed' : 'local-clear-failed';
      try {
        await persistDataClearJournal(journal, 'error', storageError);
      } catch (stateError: unknown) {
        throw new AggregateError(
          [error, stateError],
          `could not restore pending ${journal.scope} data clear`,
        );
      }
      throw error;
    }
    if (journal.scope === 'all') {
      allDataClearQuiescenceRequired = true;
      completedAllDataClear = true;
    }
  }

  async function clearLocalPhase(journal: DataClearJournal): Promise<void> {
    let previousRemainingSignature: string | null = null;
    while (true) {
      const allLocal: Record<string, unknown> = await local.get(null);
      const keys: string[] = Object.keys(allLocal).filter(
        (key: string): boolean =>
          key !== LOCAL_SETUP && key !== LOCAL_DATA_CLEAR_JOURNAL && isFocusLockLocalKey(key),
      );
      if (keys.length === 0) break;
      await local.remove(keys);
      const remaining: Record<string, unknown> = await local.get(null);
      const remainingFocusLockKeys: string[] = Object.keys(remaining).filter(
        (key: string): boolean =>
          key !== LOCAL_SETUP && key !== LOCAL_DATA_CLEAR_JOURNAL && isFocusLockLocalKey(key),
      );
      if (remainingFocusLockKeys.length === 0) break;
      const remainingValues: Record<string, unknown> = Object.fromEntries(
        remainingFocusLockKeys.map((key: string): [string, unknown] => [key, remaining[key]]),
      );
      const signature: string = serialized(remainingValues);
      if (signature === previousRemainingSignature) {
        throw new Error('could not verify local data clear');
      }
      previousRemainingSignature = signature;
    }
    const incomplete: SetupState = {
      ...DEFAULT_SETUP,
      dataClear: { status: 'pending', scope: 'all', phase: 'local' },
    };
    await verifiedWrite({ [LOCAL_SETUP]: incomplete }, 'incomplete setup after local clear');
    mode = null;
    await finishDataClear(journal);
  }

  async function assertStoppedRuntimeForAllDataClear(): Promise<void> {
    const stored: Record<string, unknown> = await local.get(LOCAL_RUNTIME);
    if (!Object.hasOwn(stored, LOCAL_RUNTIME)) return;
    const value: unknown = stored[LOCAL_RUNTIME];
    if (!isRecord(value) || typeof value.date !== 'string') {
      throw new Error('persisted runtime is not valid for all-data deletion');
    }
    if (
      value.session !== null ||
      value.gate !== null ||
      (Array.isArray(value.unlocks) && value.unlocks.length > 0) ||
      (isRecord(value.tabStates) && Object.keys(value.tabStates).length > 0)
    ) {
      throw new Error('stop the active session and blocking state before deleting all data');
    }
    const runtimeNow: number = new Date(`${value.date}T12:00:00`).getTime();
    if (!Number.isFinite(runtimeNow)) {
      throw new Error('persisted runtime is not valid for all-data deletion');
    }
    const snapshot: PolicySnapshot = await loadSnapshotInternal();
    const runtime: RuntimeState = migrateRuntimeRules(
      mergeRuntime(value, runtimeNow),
      snapshot.lists,
    );
    if (!valuesEqual(runtime, value)) {
      throw new Error('persisted runtime is not valid for all-data deletion');
    }
    if (
      runtime.session !== null ||
      runtime.gate !== null ||
      runtime.unlocks.length > 0 ||
      Object.keys(runtime.tabStates).length > 0
    ) {
      throw new Error('stop the active session and blocking state before deleting all data');
    }
  }

  function localHistoryRemovalKeys(
    stored: Record<string, unknown>,
    clearAggregates: boolean,
  ): string[] {
    const keys: string[] = [LOCAL_EVENTS];
    if (clearAggregates) {
      keys.push(
        ...Object.keys(stored).filter(
          (key: string): boolean =>
            key.startsWith('agg:') ||
            key.startsWith('aggm:') ||
            key.startsWith('archive:clock-rebase:'),
        ),
        LOCAL_SYNC_QUOTA_EVICTION,
        LOCAL_AGGREGATE_PRUNE,
        LOCAL_AGGREGATE_TOMBSTONES,
        LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS,
      );
    }
    return [...new Set(keys)];
  }

  function withoutAggregateHistory(journal: SyncJournal): SyncJournal {
    return {
      sets: Object.fromEntries(
        Object.entries(journal.sets).filter(
          ([key]: [string, unknown]): boolean => !isAggregateHistoryKey(key),
        ),
      ),
      removes: journal.removes.filter((key: string): boolean => !isAggregateHistoryKey(key)),
    };
  }

  async function clearPendingAggregatePublications(): Promise<void> {
    if (publisher !== null) {
      await publisher.pause();
      await publisher.drain();
      await publisher.transformPending(
        (): Promise<undefined> => Promise.resolve(undefined),
        (_prepared: undefined, pending: SyncJournal): SyncJournal =>
          withoutAggregateHistory(pending),
      );
      return;
    }
    const pending: SyncJournal = await loadedJournal(LOCAL_SYNC_JOURNAL, false);
    await persistPublicationJournal(withoutAggregateHistory(pending));
  }

  async function clearLocalHistoryStoragePhase(
    journal: LocalHistoryClearJournal,
  ): Promise<LocalHistoryClearJournal> {
    const stored: Record<string, unknown> = await local.get(null);
    const keys: string[] = localHistoryRemovalKeys(stored, journal.clearAggregates);
    const removing: LocalHistoryClearJournal = { ...journal, inventory: keys };
    await persistDataClearJournal(removing, 'pending', null);
    if (journal.clearAggregates) await clearPendingAggregatePublications();
    const previous: PreviousValues = await previousValues(keys);
    await verifiedRemove(keys, 'local history');
    const runtimePending: LocalHistoryClearJournal = {
      ...removing,
      phase: 'runtime',
      inventory: [],
    };
    try {
      await persistDataClearJournal(runtimePending, 'pending', null);
    } catch (error: unknown) {
      try {
        await restore(previous);
      } catch (rollbackError: unknown) {
        throw new AggregateError(
          [error, rollbackError],
          'could not roll back local history transaction',
        );
      }
      throw error;
    }
    return runtimePending;
  }

  async function resumeDataClear(journal: DataClearJournal): Promise<void> {
    if (journal.scope === 'all') await assertStoppedRuntimeForAllDataClear();
    try {
      if (journal.scope === 'local-history') {
        await clearLocalHistoryStoragePhase(journal);
        return;
      }
      let current: DataClearJournal = journal;
      if (current.phase === 'remote') {
        current = await clearRemotePhase(current);
        if (current.scope === 'synced-policy') {
          await finishDataClear(current);
          return;
        }
        current = { ...current, phase: 'local' };
        await persistDataClearJournal(current, 'pending', null);
      }
      await clearLocalPhase(current);
    } catch (error: unknown) {
      const current: DataClearJournal = (await loadDataClearJournal()) ?? journal;
      const storageError: SetupState['storageError'] =
        current.phase === 'remote' ? 'remote-deletion-failed' : 'local-clear-failed';
      await persistDataClearJournal(current, 'error', storageError);
      throw error;
    }
  }

  async function deleteRemoteDataInternal(scope: 'synced-policy' | 'all'): Promise<void> {
    await ensureInitialized();
    if (scope !== 'synced-policy' && scope !== 'all') throw new Error('invalid data clear scope');
    if (mode === 'sync') throw new Error('disable sync before deleting remote data');
    const existing: DataClearJournal | null = await loadDataClearJournal();
    if (existing !== null && existing.scope !== scope) {
      throw new Error('another data clear operation is pending');
    }
    const journal: DataClearJournal =
      existing ?? ({ scope, phase: 'remote', inventory: [] } satisfies DataClearJournal);
    if (scope === 'all' && existing !== null) allDataClearQuiescenceRequired = true;
    if (scope === 'all') await assertStoppedRuntimeForAllDataClear();
    await persistDataClearJournal(journal, 'pending', null);
    if (scope === 'all') allDataClearQuiescenceRequired = true;
    await resumeDataClear(journal);
  }

  async function clearLocalHistoryInternal(): Promise<boolean> {
    await ensureInitialized();
    const existing: DataClearJournal | null = await loadDataClearJournal();
    if (existing !== null && existing.scope !== 'local-history') {
      throw new Error('another data clear operation is pending');
    }
    const journal: LocalHistoryClearJournal = existing ?? {
      scope: 'local-history',
      phase: 'local',
      inventory: [],
      clearAggregates: mode !== 'sync',
    };
    await persistDataClearJournal(journal, 'pending', null);
    await resumeDataClear(journal);
    return journal.clearAggregates;
  }

  async function finishLocalHistoryClearInternal(): Promise<void> {
    await ensureInitialized();
    const journal: DataClearJournal | null = await loadDataClearJournal();
    if (journal === null) return;
    if (journal.scope !== 'local-history' || journal.phase !== 'runtime') {
      throw new Error('local history removal is not ready to finish');
    }
    await finishDataClear(journal);
  }

  async function pendingLocalHistoryClearInternal(): Promise<{
    clearAggregates: boolean;
  } | null> {
    await ensureInitialized();
    const journal: DataClearJournal | null = await loadDataClearJournal();
    if (journal?.scope !== 'local-history' || journal.phase !== 'runtime') return null;
    return { clearAggregates: journal.clearAggregates };
  }

  async function saveAggregateInternal(key: string, value: unknown): Promise<void> {
    await ensureInitialized();
    const normalized: unknown = normalizeAggregateItem(key, value);
    if (mode !== 'sync') {
      const blocked: BlockedAggregatePublications = await loadBlockedAggregatePublications();
      delete blocked.items[key];
      const tombstoneStored: Record<string, unknown> = await local.get(LOCAL_AGGREGATE_TOMBSTONES);
      const tombstones: string[] = parseAggregateTombstones(
        tombstoneStored[LOCAL_AGGREGATE_TOMBSTONES],
      ).filter((candidate: string): boolean => candidate !== key);
      await verifiedWrite(
        {
          [key]: normalized,
          [LOCAL_AGGREGATE_TOMBSTONES]: tombstones,
          [LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]: blocked,
        },
        'aggregate item',
      );
      return;
    }
    const writer: SyncWriter = await ensurePublisher();
    try {
      await writer.pause();
      const setup: SetupState = await loadSetupInternal();
      const blocked: BlockedAggregatePublications = await loadBlockedAggregatePublications();
      const tombstoneStored: Record<string, unknown> = await local.get(LOCAL_AGGREGATE_TOMBSTONES);
      const tombstones: string[] = parseAggregateTombstones(
        tombstoneStored[LOCAL_AGGREGATE_TOMBSTONES],
      ).filter((candidate: string): boolean => candidate !== key);
      await verifiedWrite(
        {
          [key]: normalized,
          [LOCAL_AGGREGATE_TOMBSTONES]: tombstones,
          [LOCAL_SETUP]: { ...setup, syncWriteStatus: 'pending' },
        },
        'aggregate item and pending sync status',
      );
      try {
        assertSyncItemWithinQuota(key, normalized);
      } catch (error: unknown) {
        if (!(error instanceof SyncQuotaError)) throw error;
        blocked.items[key] = normalized;
        await verifiedWrite(
          {
            [LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]: blocked,
            [LOCAL_SETUP]: {
              ...setup,
              syncWriteStatus: 'error',
              storageError: 'sync-publish-failed',
            },
          },
          'blocked aggregate publication',
        );
        writer.cancelPending(key);
        await writer.whenJournalDurable();
        return;
      }
      delete blocked.items[key];
      const hasBlocked: boolean = !blockedAggregatePublicationsEmpty(blocked);
      await verifiedWrite(
        {
          [LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]: blocked,
          [LOCAL_SETUP]: {
            ...setup,
            syncWriteStatus: hasBlocked ? 'error' : 'pending',
            storageError: hasBlocked ? 'sync-publish-failed' : setup.storageError,
          },
        },
        'superseded blocked aggregate publication',
      );
      writer.queue(key, normalized);
      await writer.whenJournalDurable();
    } catch (error: unknown) {
      const current: SetupState = await loadSetupInternal();
      await saveSetupInternal({
        ...current,
        syncWriteStatus: 'error',
        storageError: 'sync-publish-failed',
      });
      throw error;
    } finally {
      writer.resume();
    }
  }

  async function removeAggregateInternal(key: string): Promise<void> {
    await ensureInitialized();
    if (!isAggregateHistoryKey(key)) throw new Error('invalid aggregate key');
    if (mode !== 'sync') {
      const blocked: BlockedAggregatePublications = await loadBlockedAggregatePublications();
      delete blocked.items[key];
      await verifiedWrite(
        { [LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]: blocked },
        'superseded local blocked aggregate publication',
      );
      await verifiedRemove([key], 'aggregate item');
      return;
    }
    const writer: SyncWriter = await ensurePublisher();
    try {
      await writer.pause();
      const setup: SetupState = await loadSetupInternal();
      const blocked: BlockedAggregatePublications = await loadBlockedAggregatePublications();
      delete blocked.items[key];
      const hasBlocked: boolean = !blockedAggregatePublicationsEmpty(blocked);
      const tombstoneStored: Record<string, unknown> = await local.get(LOCAL_AGGREGATE_TOMBSTONES);
      const tombstones: string[] = [
        ...new Set([...parseAggregateTombstones(tombstoneStored[LOCAL_AGGREGATE_TOMBSTONES]), key]),
      ];
      await verifiedWrite(
        {
          [LOCAL_AGGREGATE_TOMBSTONES]: tombstones,
          [LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]: blocked,
          [LOCAL_SETUP]: {
            ...setup,
            syncWriteStatus: hasBlocked ? 'error' : 'pending',
            storageError: hasBlocked ? 'sync-publish-failed' : setup.storageError,
          },
        },
        'aggregate tombstone and pending sync status',
      );
      await verifiedRemove([key], 'aggregate item');
      writer.remove(key);
      await writer.whenJournalDurable();
    } catch (error: unknown) {
      const current: SetupState = await loadSetupInternal();
      await saveSetupInternal({
        ...current,
        syncWriteStatus: 'error',
        storageError: 'sync-publish-failed',
      });
      throw error;
    } finally {
      writer.resume();
    }
  }

  async function publishRemoteItemInternal(key: string, value: unknown): Promise<void> {
    await ensureInitialized();
    if (isAggregateHistoryKey(key)) {
      await saveAggregateInternal(key, value);
      return;
    }
    if (mode !== 'sync') return;
    if (POLICY_SYNC_KEYS.includes(key)) throw new Error('policy items require typed setPolicy');
    if (!isAuthoritativeSyncItem(key, value)) throw new Error('invalid remote publication item');
    const writer: SyncWriter = await ensurePublisher();
    writer.queue(key, value);
    await writer.whenJournalDurable();
  }

  async function removeRemoteItemInternal(key: string): Promise<void> {
    await ensureInitialized();
    if (isAggregateHistoryKey(key)) {
      await removeAggregateInternal(key);
      return;
    }
    if (mode !== 'sync') return;
    if (POLICY_SYNC_KEYS.includes(key)) throw new Error('policy items require typed setPolicy');
    if (!isFocusLockSyncKey(key)) throw new Error('invalid remote removal key');
    const writer: SyncWriter = await ensurePublisher();
    writer.remove(key);
    await writer.whenJournalDurable();
  }

  async function pruneRemoteHistoryInternal(
    deviceId: string,
    retentionDays: number,
    now: number,
  ): Promise<void> {
    await ensureInitialized();
    const plan: ReturnType<typeof pruneAndRollup> = pruneAndRollup(
      deviceId,
      await localAggregateHistoryItems(),
      retentionDays,
      now,
    );
    if (Object.keys(plan.set).length === 0 && plan.remove.length === 0) return;
    const checkpoint: LocalAggregatePruneCheckpoint = {
      set: structuredClone(plan.set),
      remove: [...plan.remove],
    };
    const writer: SyncWriter | null = mode === 'sync' ? await ensurePublisher() : null;
    try {
      if (writer !== null) await writer.pause();
      const setup: SetupState = await loadSetupInternal();
      const tombstoneStored: Record<string, unknown> = await local.get(LOCAL_AGGREGATE_TOMBSTONES);
      const tombstones: string[] =
        writer === null
          ? parseAggregateTombstones(tombstoneStored[LOCAL_AGGREGATE_TOMBSTONES])
          : [
              ...new Set([
                ...parseAggregateTombstones(tombstoneStored[LOCAL_AGGREGATE_TOMBSTONES]),
                ...plan.remove,
              ]),
            ];
      await verifiedWrite(
        {
          [LOCAL_AGGREGATE_PRUNE]: checkpoint,
          ...(writer === null
            ? {}
            : {
                [LOCAL_AGGREGATE_TOMBSTONES]: tombstones,
                [LOCAL_SETUP]: { ...setup, syncWriteStatus: 'pending' },
              }),
        },
        'aggregate prune checkpoint',
      );
      if (Object.keys(plan.set).length > 0) {
        await verifiedWrite(plan.set, 'aggregate prune rollup');
      }
      await verifiedRemove(plan.remove, 'aggregate prune removals');
      await verifiedRemove([LOCAL_AGGREGATE_PRUNE], 'aggregate prune checkpoint cleanup');
      if (writer === null) return;
      const blocked: BlockedAggregatePublications = await loadBlockedAggregatePublications();
      const publishableSets: Record<string, unknown> = {};
      const blockedKeys: string[] = [];
      for (const [key, value] of Object.entries(plan.set)) {
        try {
          assertSyncItemWithinQuota(key, value);
          delete blocked.items[key];
          publishableSets[key] = value;
        } catch (error: unknown) {
          if (!(error instanceof SyncQuotaError)) throw error;
          blocked.items[key] = value;
          blockedKeys.push(key);
        }
      }
      for (const key of plan.remove) delete blocked.items[key];
      const hasBlocked: boolean = !blockedAggregatePublicationsEmpty(blocked);
      await verifiedWrite(
        {
          [LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]: blocked,
          [LOCAL_SETUP]: {
            ...setup,
            syncWriteStatus: hasBlocked ? 'error' : 'pending',
            storageError: hasBlocked ? 'sync-publish-failed' : setup.storageError,
          },
        },
        'aggregate prune publication state',
      );
      for (const key of blockedKeys) writer.cancelPending(key);
      for (const [key, value] of Object.entries(publishableSets)) writer.queue(key, value);
      for (const key of plan.remove) writer.remove(key);
      await writer.whenJournalDurable();
    } catch (error: unknown) {
      if (writer !== null) {
        const current: SetupState = await loadSetupInternal();
        await saveSetupInternal({
          ...current,
          syncWriteStatus: 'error',
          storageError: 'sync-publish-failed',
        });
      }
      throw error;
    } finally {
      writer?.resume();
    }
  }

  return {
    initialize: async (): Promise<void> => {
      const stored: Record<string, unknown> = await local.get(LOCAL_DATA_CLEAR_JOURNAL);
      const journal: DataClearJournal | null = parseDataClearJournal(
        stored[LOCAL_DATA_CLEAR_JOURNAL],
      );
      if (journal?.scope !== 'all') return enqueue(initializeInternal);
      allDataClearQuiescenceRequired = true;
      return runAllDataClearExclusive((): Promise<void> => enqueue(initializeInternal));
    },
    loadSetup: (): Promise<SetupState> => {
      if (initialized && setupCache !== null) return Promise.resolve(structuredClone(setupCache));
      return enqueue(async (): Promise<SetupState> => {
        await ensureInitialized();
        return loadSetupInternal();
      });
    },
    updateSetup: (next: Partial<SetupUpdate>): Promise<void> =>
      enqueue((): Promise<void> => updateSetupInternal(next)),
    markSetupCompleted: (): Promise<void> => enqueue(markSetupCompletedInternal),
    loadSnapshot: (): Promise<PolicySnapshot> =>
      enqueue(async (): Promise<PolicySnapshot> => {
        await ensureInitialized();
        return loadSnapshotInternal();
      }),
    setPolicy: <K extends keyof PolicyValueByKey>(
      key: K,
      value: PolicyValueByKey[K],
    ): Promise<void> => enqueue((): Promise<void> => setPolicyInternal(key, value)),
    selectLocalMode: (): Promise<void> =>
      firstSyncCheckpoint.runExclusive === undefined
        ? enqueue(selectLocalModeInternal)
        : firstSyncCheckpoint.runExclusive((): Promise<void> => enqueue(selectLocalModeInternal)),
    enableSync: (): Promise<void> =>
      firstSyncCheckpoint.runExclusive === undefined
        ? enqueue(enableSyncInternal)
        : firstSyncCheckpoint.runExclusive((): Promise<void> => enqueue(enableSyncInternal)),
    disableSync: (): Promise<void> =>
      firstSyncCheckpoint.runExclusive === undefined
        ? enqueue(disableSyncInternal)
        : firstSyncCheckpoint.runExclusive((): Promise<void> => enqueue(disableSyncInternal)),
    mirrorAcceptedRemotePolicy: (
      changes: Record<string, unknown>,
      pendingRemoteKeys: readonly string[] = [],
    ): Promise<void> =>
      enqueue((): Promise<void> => mirrorAcceptedRemotePolicyInternal(changes, pendingRemoteKeys)),
    queueVerifiedRemoteCorrections: (keys: readonly (keyof PolicyValueByKey)[]): Promise<void> =>
      enqueue((): Promise<void> => queueVerifiedRemoteCorrectionsInternal(keys)),
    deleteRemoteData: (scope: 'synced-policy' | 'all'): Promise<void> =>
      scope === 'all'
        ? runAllDataClearExclusive(
            (): Promise<void> => enqueue((): Promise<void> => deleteRemoteDataInternal(scope)),
          )
        : enqueue((): Promise<void> => deleteRemoteDataInternal(scope)),
    clearLocalHistory: (): Promise<boolean> => enqueue(clearLocalHistoryInternal),
    finishLocalHistoryClear: (): Promise<void> => enqueue(finishLocalHistoryClearInternal),
    pendingLocalHistoryClear: (): Promise<{ clearAggregates: boolean } | null> =>
      enqueue(pendingLocalHistoryClearInternal),
    allDataClearCompleted: (): boolean => completedAllDataClear,
    storageMode: (): Promise<StorageMode | null> =>
      enqueue(async (): Promise<StorageMode | null> => {
        await ensureInitialized();
        return mode;
      }),
    inboundSyncAllowed: (): Promise<boolean> =>
      enqueue(async (): Promise<boolean> => {
        await ensureInitialized();
        const setup: SetupState = await loadSetupInternal();
        return mode === 'sync' && setup.dataClear.status === 'idle';
      }),
    consumeRemoteEcho: (key: string, value: unknown): boolean => echoes.consume(key, value),
    hasPendingRemote: (key: string): boolean => publisher?.hasPending(key) ?? false,
    publishRemoteItem: (key: string, value: unknown): Promise<void> =>
      enqueue((): Promise<void> => publishRemoteItemInternal(key, value)),
    removeRemoteItem: (key: string): Promise<void> =>
      enqueue((): Promise<void> => removeRemoteItemInternal(key)),
    remoteJournalDurable: (): Promise<void> =>
      enqueue(async (): Promise<void> => {
        await ensureInitialized();
        if (publisher !== null) await publisher.whenJournalDurable();
      }),
    pruneRemoteHistory: (deviceId: string, retentionDays: number, now: number): Promise<void> =>
      enqueue((): Promise<void> => pruneRemoteHistoryInternal(deviceId, retentionDays, now)),
    saveAggregate: (key: string, value: unknown): Promise<void> =>
      enqueue((): Promise<void> => saveAggregateInternal(key, value)),
    removeAggregate: (key: string): Promise<void> =>
      enqueue((): Promise<void> => removeAggregateInternal(key)),
    withAggregateStorage: <T>(operation: (storage: AggregateStorage) => Promise<T>): Promise<T> =>
      enqueue(async (): Promise<T> => {
        await ensureInitialized();
        return operation({ local, sync: mode === 'sync' ? sync : null });
      }),
    markLegacyMigrationFailed: (): Promise<void> => enqueue(markLegacyMigrationFailedInternal),
    importLegacy: (
      snapshot: PolicySnapshot,
      runtime: RuntimeState,
      journal: SyncJournal,
      storedSync: Record<string, unknown> = {},
    ): Promise<void> =>
      enqueue((): Promise<void> => importLegacyInternal(snapshot, runtime, journal, storedSync)),
  };
}

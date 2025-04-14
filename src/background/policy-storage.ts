import { DEFAULT_LISTS, DEFAULT_SETTINGS, DEFAULT_SETUP } from '../shared/constants';
import { isListsConfig, isSettings, isSetupState } from '../shared/runtime-validation';
import {
  LOCAL_BANK,
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
  ListsConfig,
  Settings,
  SetupState,
  StorageMode,
  StreakState,
} from '../shared/types';
import { encodeListsForSync, LIST_SYNC_KEYS, type ListsSyncEncoding } from './list-sync-codec';
import {
  mergeRuntime,
  migrateRuntimeRules,
  parseBank,
  parseStreak,
  type RuntimeState,
} from './stores';
import { assertSyncItemWithinQuota } from './sync-item-size';
import {
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
import { compactPendingSyncRetention } from './sync-retention';
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
  storageMode(): Promise<StorageMode | null>;
  inboundSyncAllowed(): Promise<boolean>;
  consumeRemoteEcho(key: string, value: unknown): boolean;
  hasPendingRemote(key: string): boolean;
  publishRemoteItem(key: string, value: unknown): Promise<void>;
  removeRemoteItem(key: string): Promise<void>;
  remoteJournalDurable(): Promise<void>;
  pruneRemoteHistory(deviceId: string, retentionDays: number, now: number): Promise<void>;
  markLegacyMigrationFailed(): Promise<void>;
  importLegacy(
    snapshot: PolicySnapshot,
    runtime: RuntimeState,
    journal: SyncJournal,
  ): Promise<void>;
}

interface PreviousValues {
  existing: Record<string, unknown>;
  missing: string[];
}

interface DataClearJournal {
  scope: 'synced-policy' | 'all';
  phase: 'remote' | 'local';
  inventory: string[];
}

interface PolicyGenerationRecord {
  id: string;
  revision: string;
  policy: PolicySnapshot;
  runtime: RuntimeState;
  journal: SyncJournal;
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
): PolicyStorage {
  let initialized: boolean = false;
  let mode: StorageMode | null = null;
  let operationQueue: Promise<void> = Promise.resolve();
  let publisher: SyncWriter | null = null;
  let firstCheckpointComplete: boolean = false;
  const echoes: SyncEchoes = new SyncEchoes();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const requested: Promise<T> = operationQueue.then(operation);
    operationQueue = requested.then(
      (): void => undefined,
      (): void => undefined,
    );
    return requested;
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
    const keys: string[] = Object.keys(items);
    const previous: PreviousValues = await previousValues(keys);
    try {
      await local.set(structuredClone(items));
      const verified: Record<string, unknown> = await local.get(keys);
      if (!valuesEqual(verified, items)) throw new Error(`could not verify local ${label}`);
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
    if (!Object.hasOwn(stored, LOCAL_SETUP)) return structuredClone(DEFAULT_SETUP);
    const value: unknown = stored[LOCAL_SETUP];
    if (!isSetupState(value)) throw new Error('invalid local setup state');
    return structuredClone(value);
  }

  async function saveSetupInternal(next: SetupState): Promise<void> {
    if (!isSetupState(next)) throw new Error('invalid setup state');
    await verifiedWrite({ [LOCAL_SETUP]: next }, 'setup state');
    mode = next.storageMode;
  }

  async function persistPublicationJournal(journal: SyncJournal): Promise<void> {
    const setup: SetupState = await loadSetupInternal();
    const empty: boolean = journalEmpty(journal);
    await verifiedWrite(
      {
        [LOCAL_SYNC_JOURNAL]: journal,
        [LOCAL_SETUP]: {
          ...setup,
          syncWriteStatus: empty ? 'idle' : 'pending',
          storageError:
            empty && setup.storageError === 'sync-publish-failed' ? null : setup.storageError,
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
    await verifiedWrite(
      {
        [LOCAL_DATA_CLEAR_JOURNAL]: journal,
        [LOCAL_SETUP]: {
          ...setup,
          syncWriteStatus: status === 'error' ? 'error' : setup.syncWriteStatus,
          storageError,
          dataClear: { status, scope: journal.scope, phase: journal.phase },
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
    for (const [key, value] of Object.entries(aggregateItems)) {
      if (POLICY_SYNC_KEYS.includes(key)) {
        throw new Error(`first sync checkpoint item ${JSON.stringify(key)} collides with policy`);
      }
      if (!isAuthoritativeSyncItem(key, value)) {
        throw new Error(`invalid first sync checkpoint item ${JSON.stringify(key)}`);
      }
      assertSyncItemWithinQuota(key, value);
    }
    return {
      sets: {
        [SYNC_SETTINGS]: snapshot.settings,
        ...lists.sets,
        [SYNC_BANK]: snapshot.bank,
        ...(snapshot.streak === null ? {} : { [SYNC_STREAK]: snapshot.streak }),
        ...aggregateItems,
      },
      removes: [...lists.removes, ...(snapshot.streak === null ? [SYNC_STREAK] : [])],
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
      const complete: SyncJournal = await fullPublication(await loadSnapshotInternal());
      for (const [key, value] of Object.entries(persisted.sets)) {
        if (!POLICY_SYNC_KEYS.includes(key) && isAuthoritativeSyncItem(key, value)) {
          complete.sets[key] = value;
        }
      }
      for (const key of persisted.removes) {
        if (!POLICY_SYNC_KEYS.includes(key) && isFocusLockSyncKey(key)) {
          complete.removes.push(key);
          delete complete.sets[key];
        }
      }
      complete.removes = [...new Set(complete.removes)];
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
      if (setup.storageMode === 'sync') throw error;
    }
  }

  async function loadDataClearJournal(): Promise<DataClearJournal | null> {
    const stored: Record<string, unknown> = await local.get(LOCAL_DATA_CLEAR_JOURNAL);
    return parseDataClearJournal(stored[LOCAL_DATA_CLEAR_JOURNAL]);
  }

  async function initializeInternal(): Promise<void> {
    if (initialized) return;
    let setup: SetupState = await loadSetupInternal();
    mode = setup.storageMode;
    const dataClearJournal: DataClearJournal | null = await loadDataClearJournal();
    if (dataClearJournal !== null) {
      await resumeDataClear(dataClearJournal);
      initialized = true;
      return;
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
    if (mode === 'sync') return;
    const priorMode: StorageMode | null = mode;
    let complete: SyncJournal;
    try {
      const aggregateItems: Record<string, unknown> =
        await firstSyncCheckpoint.loadAggregateItems();
      complete = await fullPublication(await loadSnapshotInternal(), aggregateItems);
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
      await saveSetupInternal({
        ...completedSetup,
        storageMode: 'sync',
        syncWriteStatus: 'idle',
        storageError: null,
      });
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
    if (mode !== 'sync' && publisher === null) return;
    const setup: SetupState = await loadSetupInternal();
    try {
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
      await saveSetupInternal({
        ...setup,
        storageMode: 'local',
        syncWriteStatus: 'idle',
        storageError: null,
      });
    } catch (error: unknown) {
      if (mode === 'sync' && publisher !== null) publisher.resume();
      throw error;
    }
    firstCheckpointComplete = false;
  }

  async function selectLocalModeInternal(): Promise<void> {
    await ensureInitialized();
    const setup: SetupState = await loadSetupInternal();
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
      !hasPublicationIntent
    ) {
      return;
    }
    await disableSyncInternal();
    const current: SetupState = await loadSetupInternal();
    await verifiedWrite(
      {
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
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['id', 'revision', 'policy', 'runtime', 'journal']) ||
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
    return {
      id: pointer.id,
      revision: pointer.revision,
      policy,
      runtime,
      journal,
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
      },
      'materialized policy generation',
    );
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
        const id: string = crypto.randomUUID();
        const revision: string = policyRevision(snapshot);
        record = {
          id,
          revision,
          policy: structuredClone(snapshot),
          runtime: structuredClone(runtime),
          journal: structuredClone(journal),
        };
        const generationKey: string = `${LOCAL_POLICY_GENERATION_PREFIX}${id}`;
        await verifiedWrite({ [generationKey]: record }, 'legacy policy generation');
        const pointer: PolicyCommit = { source: 'generation', id, revision };
        await verifiedWrite({ [LOCAL_POLICY_COMMIT]: pointer }, 'generation policy authority');
        authorityCommitted = true;
      }
      const setup: SetupState = await loadSetupInternal();
      if (!setup.legacyImported || setup.storageError !== null) {
        const migratedSetup: SetupState = {
          ...setup,
          storageMode: null,
          syncWriteStatus: journalEmpty(journal) ? 'idle' : 'pending',
          legacyImported: true,
          storageError: null,
        };
        await verifiedWrite(
          {
            [LOCAL_SYNC_JOURNAL]: journal,
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
      FOCUS_LOCK_LOCAL_EXACT_KEYS.includes(key) || key.startsWith(LOCAL_POLICY_GENERATION_PREFIX)
    );
  }

  async function finishDataClear(journal: DataClearJournal): Promise<void> {
    const setup: SetupState = await loadSetupInternal();
    await saveSetupInternal({
      ...setup,
      syncWriteStatus: 'idle',
      storageError: null,
      dataClear: { status: 'idle', scope: null, phase: null },
    });
    await local.remove(LOCAL_DATA_CLEAR_JOURNAL);
    const verified: Record<string, unknown> = await local.get(LOCAL_DATA_CLEAR_JOURNAL);
    if (Object.hasOwn(verified, LOCAL_DATA_CLEAR_JOURNAL)) {
      throw new Error(`could not finish ${journal.scope} data clear`);
    }
  }

  async function clearLocalPhase(journal: DataClearJournal): Promise<void> {
    const allLocal: Record<string, unknown> = await local.get(null);
    const keys: string[] = Object.keys(allLocal).filter(
      (key: string): boolean =>
        key !== LOCAL_SETUP && key !== LOCAL_DATA_CLEAR_JOURNAL && isFocusLockLocalKey(key),
    );
    if (keys.length > 0) await local.remove(keys);
    const remaining: Record<string, unknown> = await local.get(keys);
    if (Object.keys(remaining).length > 0) throw new Error('could not verify local data clear');
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

  async function resumeDataClear(journal: DataClearJournal): Promise<void> {
    if (journal.scope === 'all') await assertStoppedRuntimeForAllDataClear();
    try {
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
    if (scope === 'all') await assertStoppedRuntimeForAllDataClear();
    await persistDataClearJournal(journal, 'pending', null);
    await resumeDataClear(journal);
  }

  async function publishRemoteItemInternal(key: string, value: unknown): Promise<void> {
    await ensureInitialized();
    if (mode !== 'sync') return;
    if (POLICY_SYNC_KEYS.includes(key)) throw new Error('policy items require typed setPolicy');
    if (!isAuthoritativeSyncItem(key, value)) throw new Error('invalid remote publication item');
    const writer: SyncWriter = await ensurePublisher();
    writer.queue(key, value);
    await writer.whenJournalDurable();
  }

  async function removeRemoteItemInternal(key: string): Promise<void> {
    await ensureInitialized();
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
    if (mode !== 'sync') return;
    const writer: SyncWriter = await ensurePublisher();
    await compactPendingSyncRetention(
      writer,
      deviceId,
      retentionDays,
      now,
      (): Promise<Record<string, unknown>> => sync.get(null),
    );
  }

  return {
    initialize: (): Promise<void> => enqueue(initializeInternal),
    loadSetup: (): Promise<SetupState> =>
      enqueue(async (): Promise<SetupState> => {
        await ensureInitialized();
        return loadSetupInternal();
      }),
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
    selectLocalMode: (): Promise<void> => enqueue(selectLocalModeInternal),
    enableSync: (): Promise<void> => enqueue(enableSyncInternal),
    disableSync: (): Promise<void> => enqueue(disableSyncInternal),
    mirrorAcceptedRemotePolicy: (
      changes: Record<string, unknown>,
      pendingRemoteKeys: readonly string[] = [],
    ): Promise<void> =>
      enqueue((): Promise<void> => mirrorAcceptedRemotePolicyInternal(changes, pendingRemoteKeys)),
    queueVerifiedRemoteCorrections: (keys: readonly (keyof PolicyValueByKey)[]): Promise<void> =>
      enqueue((): Promise<void> => queueVerifiedRemoteCorrectionsInternal(keys)),
    deleteRemoteData: (scope: 'synced-policy' | 'all'): Promise<void> =>
      enqueue((): Promise<void> => deleteRemoteDataInternal(scope)),
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
    markLegacyMigrationFailed: (): Promise<void> => enqueue(markLegacyMigrationFailedInternal),
    importLegacy: (
      snapshot: PolicySnapshot,
      runtime: RuntimeState,
      journal: SyncJournal,
    ): Promise<void> =>
      enqueue((): Promise<void> => importLegacyInternal(snapshot, runtime, journal)),
  };
}

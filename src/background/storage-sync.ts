import type { Ack } from '../shared/messages';
import { SYNC_BANK, SYNC_LISTS, SYNC_SETTINGS, SYNC_STREAK } from '../shared/storage-keys';
import type { BankState, ListsConfig, Settings, StreakState } from '../shared/types';
import {
  type DecodedListsSyncSnapshot,
  decodeListsSyncSnapshot,
  isListSyncKey,
} from './list-sync-codec';
import type { PolicySnapshot, PolicyValueByKey } from './policy-storage';
import { hasScheduleIntentions, settingsWithLocalIntentions } from './settings-sync';
import {
  parseBank,
  parseLiveLists,
  parseLiveSettings,
  parseStoredSettings,
  parseStreak,
  type StoredSettingsParseResult,
} from './stores';
import { isAuthoritativeSyncItem } from './sync-item-validation';
export interface SyncEchoConsumer {
  consume(key: string, value: unknown): boolean;
}

export interface SyncChangeEngine {
  applySyncedSettings(settings: Settings): Promise<Ack>;
  applySyncedLists(lists: ListsConfig, reconcilePendingSync?: boolean): Promise<Ack>;
  applySyncedBank(bank: BankState): Promise<Ack>;
  applySyncedStreak(streak: StreakState): Promise<void>;
  getSettings(): Settings;
  getLists(): ListsConfig;
  transactSyncedPolicy?(
    changes: Partial<PolicyValueByKey>,
    reconcilePendingLists: boolean,
    mirror: (accepted: Partial<PolicyValueByKey>) => Promise<void>,
  ): Promise<Ack>;
}

export interface SyncPolicyTransaction {
  inboundSyncAllowed(): Promise<boolean>;
  loadSnapshot(): Promise<PolicySnapshot>;
  queueVerifiedRemoteCorrections?(keys: readonly (keyof PolicyValueByKey)[]): Promise<void>;
  mirrorAcceptedRemotePolicy(
    changes: Record<string, unknown>,
    pendingRemoteKeys?: readonly string[],
  ): Promise<void>;
}

export interface SyncStorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

export type SyncStorageChanges = Record<string, SyncStorageChange | undefined>;
export type SyncStorageQueue = (key: string, value: unknown) => void | Promise<void>;
export type SyncListSnapshotLoader = () => Promise<Readonly<Record<string, unknown>>>;

async function correctRemotePolicyRemovals(
  changes: SyncStorageChanges,
  echoes: SyncEchoConsumer,
  transaction: SyncPolicyTransaction,
): Promise<SyncStorageChanges> {
  const corrections: Set<keyof PolicyValueByKey> = new Set();
  const remaining: SyncStorageChanges = { ...changes };
  for (const [key, change] of Object.entries(changes)) {
    if (change === undefined || change.newValue !== undefined) continue;
    if (echoes.consume(key, undefined)) {
      delete remaining[key];
      continue;
    }
    if (key === SYNC_SETTINGS) corrections.add('settings');
    else if (isListSyncKey(key)) corrections.add('lists');
    else if (key === SYNC_BANK) corrections.add('bank');
    else if (key === SYNC_STREAK) corrections.add('streak');
    if (isListSyncKey(key)) delete remaining[key];
  }
  if (corrections.size === 0) return remaining;
  await queueVerifiedPolicyCorrections(corrections, transaction);
  return remaining;
}

async function transactionalPolicyChanges(
  engine: SyncChangeEngine,
  changes: SyncStorageChanges,
  echoes: SyncEchoConsumer,
  reconcilePendingLists: boolean,
  listSnapshot: Readonly<Record<string, unknown>> | undefined,
  loadListSnapshot: SyncListSnapshotLoader | undefined,
): Promise<{
  candidate: Partial<PolicyValueByKey>;
  malformed: Set<keyof PolicyValueByKey>;
}> {
  const candidate: Partial<PolicyValueByKey> = {};
  const malformed: Set<keyof PolicyValueByKey> = new Set();
  const settingsValue: unknown = changes[SYNC_SETTINGS]?.newValue;
  if (settingsValue !== undefined && !echoes.consume(SYNC_SETTINGS, settingsValue)) {
    const parsedSettings: StoredSettingsParseResult = parseStoredSettings(
      settingsValue,
      engine.getSettings(),
    );
    if (!parsedSettings.valid) {
      malformed.add('settings');
    } else if (parsedSettings.changed || parsedSettings.legacy) {
      candidate.settings = settingsWithLocalIntentions(
        parsedSettings.settings,
        engine.getSettings(),
      );
    }
  }

  const changedListEntries: Array<[string, SyncStorageChange]> = Object.entries(changes).flatMap(
    ([key, change]: [string, SyncStorageChange | undefined]): Array<[string, SyncStorageChange]> =>
      isListSyncKey(key) && change !== undefined ? [[key, change]] : [],
  );
  if (changedListEntries.length > 0) {
    let allEchoes: boolean = true;
    const changedSnapshot: Record<string, unknown> = {};
    for (const [key, change] of changedListEntries) {
      if (change.newValue === undefined) {
        allEchoes = false;
      } else {
        changedSnapshot[key] = change.newValue;
        if (!echoes.consume(key, change.newValue)) allEchoes = false;
      }
    }
    if (!allEchoes) {
      const completeSnapshot: Readonly<Record<string, unknown>> =
        listSnapshot ??
        (loadListSnapshot === undefined ? changedSnapshot : await loadListSnapshot());
      const decoded: DecodedListsSyncSnapshot = decodeListsSyncSnapshot(completeSnapshot);
      if (decoded.kind === 'incomplete') {
        malformed.add('lists');
      } else {
        const value: unknown = decoded.kind === 'complete' ? decoded.lists : decoded.value;
        if (decoded.kind === 'complete' || isAuthoritativeSyncItem(SYNC_LISTS, value)) {
          const lists: ListsConfig | null = parseLiveLists(value, engine.getLists());
          if (lists !== null) candidate.lists = lists;
          else malformed.add('lists');
        } else {
          malformed.add('lists');
        }
      }
    }
  }

  const bankValue: unknown = changes[SYNC_BANK]?.newValue;
  if (bankValue !== undefined && !echoes.consume(SYNC_BANK, bankValue)) {
    if (isAuthoritativeSyncItem(SYNC_BANK, bankValue)) {
      const bank: BankState | null = parseBank(bankValue);
      if (bank !== null) candidate.bank = bank;
    } else {
      malformed.add('bank');
    }
  }
  const streakValue: unknown = changes[SYNC_STREAK]?.newValue;
  if (streakValue !== undefined && !echoes.consume(SYNC_STREAK, streakValue)) {
    if (isAuthoritativeSyncItem(SYNC_STREAK, streakValue)) {
      const streak: StreakState | null = parseStreak(streakValue);
      if (streak !== null) candidate.streak = streak;
    } else {
      malformed.add('streak');
    }
  }
  void reconcilePendingLists;
  return { candidate, malformed };
}

async function queueVerifiedPolicyCorrections(
  keys: ReadonlySet<keyof PolicyValueByKey>,
  transaction: SyncPolicyTransaction,
): Promise<void> {
  if (keys.size === 0) return;
  if (transaction.queueVerifiedRemoteCorrections === undefined) {
    throw new Error('serialized corrective policy operation is unavailable');
  }
  await transaction.queueVerifiedRemoteCorrections([...keys]);
}

async function handleTransactionalSyncChanges(
  engine: SyncChangeEngine,
  changes: SyncStorageChanges,
  echoes: SyncEchoConsumer,
  reconcilePendingLists: boolean,
  listSnapshot: Readonly<Record<string, unknown>> | undefined,
  transaction: SyncPolicyTransaction,
  loadListSnapshot: SyncListSnapshotLoader | undefined,
  pendingRemoteKeys: readonly string[],
): Promise<void> {
  if (!(await transaction.inboundSyncAllowed())) return;
  const candidateChanges: SyncStorageChanges = await correctRemotePolicyRemovals(
    changes,
    echoes,
    transaction,
  );
  const parsed: {
    candidate: Partial<PolicyValueByKey>;
    malformed: Set<keyof PolicyValueByKey>;
  } = await transactionalPolicyChanges(
    engine,
    candidateChanges,
    echoes,
    reconcilePendingLists,
    listSnapshot,
    loadListSnapshot,
  );
  await queueVerifiedPolicyCorrections(parsed.malformed, transaction);
  const candidate: Partial<PolicyValueByKey> = parsed.candidate;
  const candidateKeys: Array<keyof PolicyValueByKey> = [];
  if (candidate.settings !== undefined) candidateKeys.push('settings');
  if (candidate.lists !== undefined) candidateKeys.push('lists');
  if (candidate.bank !== undefined) candidateKeys.push('bank');
  if (candidate.streak !== undefined) candidateKeys.push('streak');
  const needsIntentionCleanup: boolean =
    !parsed.malformed.has('settings') && hasScheduleIntentions(changes[SYNC_SETTINGS]?.newValue);
  if (candidateKeys.length === 0) {
    if (needsIntentionCleanup)
      await queueVerifiedPolicyCorrections(new Set(['settings']), transaction);
    return;
  }
  if (engine.transactSyncedPolicy !== undefined) {
    const result: Ack = await engine.transactSyncedPolicy(
      candidate,
      reconcilePendingLists,
      async (accepted: Partial<PolicyValueByKey>): Promise<void> => {
        const mirrored: Record<string, unknown> = {};
        if (accepted.settings !== undefined) mirrored.settings = accepted.settings;
        if (accepted.lists !== undefined) mirrored.lists = accepted.lists;
        if (accepted.bank !== undefined) mirrored.bank = accepted.bank;
        if (accepted.streak !== undefined) mirrored.streak = accepted.streak;
        await transaction.mirrorAcceptedRemotePolicy(mirrored, pendingRemoteKeys);
      },
    );
    if (!result.ok) {
      await queueVerifiedPolicyCorrections(new Set(candidateKeys), transaction);
    } else if (needsIntentionCleanup) {
      // The accepted settings are now local authority, including edits that waited for admission.
      await queueVerifiedPolicyCorrections(new Set(['settings']), transaction);
    }
    return;
  }
  throw new Error('transactional sync engine method is unavailable');
}

export function missingSyncDefaults(
  stored: Record<string, unknown>,
  defaults: {
    settings: Settings;
    lists: ListsConfig;
    bank: BankState;
    streak: StreakState;
  },
): Record<string, unknown> {
  const missing: Record<string, unknown> = {};
  if (!(SYNC_SETTINGS in stored)) missing[SYNC_SETTINGS] = defaults.settings;
  if (!(SYNC_LISTS in stored)) missing[SYNC_LISTS] = defaults.lists;
  if (!(SYNC_BANK in stored)) missing[SYNC_BANK] = defaults.bank;
  if (!(SYNC_STREAK in stored)) missing[SYNC_STREAK] = defaults.streak;
  return missing;
}

async function correctRejectedChange<T>(
  key: string,
  incoming: T,
  apply: (value: T) => Promise<Ack>,
  current: () => T,
  queueSync: SyncStorageQueue,
): Promise<void> {
  const result: Ack = await apply(incoming);
  if (result.ok) return;

  const correctiveValue: T = current();
  await queueSync(key, correctiveValue);
}

async function captureSyncError(
  errors: unknown[],
  applyChange: () => Promise<void>,
): Promise<void> {
  try {
    await applyChange();
  } catch (error: unknown) {
    errors.push(error);
  }
}

async function applySettingsChange(
  engine: SyncChangeEngine,
  changes: SyncStorageChanges,
  echoes: SyncEchoConsumer,
  queueSync: SyncStorageQueue,
): Promise<void> {
  const value: unknown = changes[SYNC_SETTINGS]?.newValue;
  if (value === undefined || echoes.consume(SYNC_SETTINGS, value)) return;
  const settings: Settings | null = parseLiveSettings(value, engine.getSettings());
  if (settings === null) return;
  await correctRejectedChange(
    SYNC_SETTINGS,
    settings,
    (incoming: Settings): Promise<Ack> =>
      engine.applySyncedSettings(settingsWithLocalIntentions(incoming, engine.getSettings())),
    (): Settings => engine.getSettings(),
    queueSync,
  );
}

async function applyListsChange(
  engine: SyncChangeEngine,
  changes: SyncStorageChanges,
  echoes: SyncEchoConsumer,
  queueSync: SyncStorageQueue,
  reconcilePendingSync: boolean | undefined,
  listSnapshot: Readonly<Record<string, unknown>> | undefined,
): Promise<void> {
  const changedEntries: Array<[string, SyncStorageChange]> = Object.entries(changes).flatMap(
    ([key, change]: [string, SyncStorageChange | undefined]): Array<[string, SyncStorageChange]> =>
      isListSyncKey(key) && change !== undefined ? [[key, change]] : [],
  );
  if (changedEntries.length === 0) return;
  let allEchoes: boolean = true;
  const changedSnapshot: Record<string, unknown> = {};
  for (const [key, change] of changedEntries) {
    if (change.newValue === undefined) {
      allEchoes = false;
      continue;
    }
    changedSnapshot[key] = change.newValue;
    if (!echoes.consume(key, change.newValue)) allEchoes = false;
  }
  if (allEchoes) return;
  const decoded: DecodedListsSyncSnapshot = decodeListsSyncSnapshot(
    listSnapshot ?? changedSnapshot,
  );
  if (decoded.kind === 'incomplete') return;
  const value: unknown = decoded.kind === 'complete' ? decoded.lists : decoded.value;
  const lists: ListsConfig | null = parseLiveLists(value, engine.getLists());
  if (lists === null) return;
  await correctRejectedChange(
    SYNC_LISTS,
    lists,
    (incoming: ListsConfig): Promise<Ack> =>
      reconcilePendingSync === undefined
        ? engine.applySyncedLists(incoming)
        : engine.applySyncedLists(incoming, reconcilePendingSync),
    (): ListsConfig => engine.getLists(),
    queueSync,
  );
}

async function applyBankChange(
  engine: SyncChangeEngine,
  changes: SyncStorageChanges,
  echoes: SyncEchoConsumer,
): Promise<void> {
  const value: unknown = changes[SYNC_BANK]?.newValue;
  if (value === undefined || echoes.consume(SYNC_BANK, value)) return;
  const bank: BankState | null = parseBank(value);
  if (bank !== null) await engine.applySyncedBank(bank);
}

async function applyStreakChange(
  engine: SyncChangeEngine,
  changes: SyncStorageChanges,
  echoes: SyncEchoConsumer,
): Promise<void> {
  const value: unknown = changes[SYNC_STREAK]?.newValue;
  if (value === undefined || echoes.consume(SYNC_STREAK, value)) return;
  const streak: StreakState | null = parseStreak(value);
  if (streak !== null) await engine.applySyncedStreak(streak);
}

export async function handleSyncChanges(
  engine: SyncChangeEngine,
  changes: SyncStorageChanges,
  echoes: SyncEchoConsumer,
  queueSync: SyncStorageQueue,
  reconcilePendingLists?: boolean,
  listSnapshot?: Readonly<Record<string, unknown>>,
  transaction?: SyncPolicyTransaction,
  loadListSnapshot?: SyncListSnapshotLoader,
  pendingRemoteKeys: readonly string[] = [],
): Promise<void> {
  if (transaction !== undefined) {
    await handleTransactionalSyncChanges(
      engine,
      changes,
      echoes,
      reconcilePendingLists ?? false,
      listSnapshot,
      transaction,
      loadListSnapshot,
      pendingRemoteKeys,
    );
    return;
  }
  const errors: unknown[] = [];
  await captureSyncError(
    errors,
    (): Promise<void> => applySettingsChange(engine, changes, echoes, queueSync),
  );
  await captureSyncError(
    errors,
    (): Promise<void> =>
      applyListsChange(engine, changes, echoes, queueSync, reconcilePendingLists, listSnapshot),
  );
  await captureSyncError(errors, (): Promise<void> => applyBankChange(engine, changes, echoes));
  await captureSyncError(errors, (): Promise<void> => applyStreakChange(engine, changes, echoes));
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Failed to apply sync storage changes');
  }
}

import type { Ack } from '../shared/messages';
import { SYNC_BANK, SYNC_LISTS, SYNC_SETTINGS, SYNC_STREAK } from '../shared/storage-keys';
import type { BankState, ListsConfig, Settings, StreakState } from '../shared/types';
import {
  type DecodedListsSyncSnapshot,
  decodeListsSyncSnapshot,
  isListSyncKey,
} from './list-sync-codec';
import { parseBank, parseLiveLists, parseLiveSettings, parseStreak } from './stores';
import type { SyncEchoes } from './sync-writer';

export interface SyncChangeEngine {
  applySyncedSettings(settings: Settings): Promise<Ack>;
  applySyncedLists(lists: ListsConfig, reconcilePendingSync?: boolean): Promise<Ack>;
  applySyncedBank(bank: BankState): Promise<Ack>;
  applySyncedStreak(streak: StreakState): Promise<void>;
  getSettings(): Settings;
  getLists(): ListsConfig;
}

export interface SyncStorageChange {
  newValue?: unknown;
}

export type SyncStorageChanges = Record<string, SyncStorageChange | undefined>;
export type SyncStorageQueue = (key: string, value: unknown) => void | Promise<void>;

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
  echoes: SyncEchoes,
  queueSync: SyncStorageQueue,
): Promise<void> {
  const value: unknown = changes[SYNC_SETTINGS]?.newValue;
  if (value === undefined || echoes.consume(SYNC_SETTINGS, value)) return;
  const settings: Settings | null = parseLiveSettings(value, engine.getSettings());
  if (settings === null) return;
  await correctRejectedChange(
    SYNC_SETTINGS,
    settings,
    (incoming: Settings): Promise<Ack> => engine.applySyncedSettings(incoming),
    (): Settings => engine.getSettings(),
    queueSync,
  );
}

async function applyListsChange(
  engine: SyncChangeEngine,
  changes: SyncStorageChanges,
  echoes: SyncEchoes,
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
  echoes: SyncEchoes,
): Promise<void> {
  const value: unknown = changes[SYNC_BANK]?.newValue;
  if (value === undefined || echoes.consume(SYNC_BANK, value)) return;
  const bank: BankState | null = parseBank(value);
  if (bank !== null) await engine.applySyncedBank(bank);
}

async function applyStreakChange(
  engine: SyncChangeEngine,
  changes: SyncStorageChanges,
  echoes: SyncEchoes,
): Promise<void> {
  const value: unknown = changes[SYNC_STREAK]?.newValue;
  if (value === undefined || echoes.consume(SYNC_STREAK, value)) return;
  const streak: StreakState | null = parseStreak(value);
  if (streak !== null) await engine.applySyncedStreak(streak);
}

export async function handleSyncChanges(
  engine: SyncChangeEngine,
  changes: SyncStorageChanges,
  echoes: SyncEchoes,
  queueSync: SyncStorageQueue,
  reconcilePendingLists?: boolean,
  listSnapshot?: Readonly<Record<string, unknown>>,
): Promise<void> {
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

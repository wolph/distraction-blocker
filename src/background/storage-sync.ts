import type { Ack } from '../shared/messages';
import { SYNC_BANK, SYNC_LISTS, SYNC_SETTINGS, SYNC_STREAK } from '../shared/storage-keys';
import type { BankState, ListsConfig, Settings, StreakState } from '../shared/types';
import { mergeLists, mergeSettings } from './stores';
import type { SyncEchoes } from './sync-writer';

export interface SyncChangeEngine {
  applySyncedSettings(settings: Settings): Promise<Ack>;
  applySyncedLists(lists: ListsConfig): Promise<Ack>;
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

export async function handleSyncChanges(
  engine: SyncChangeEngine,
  changes: SyncStorageChanges,
  echoes: SyncEchoes,
  queueSync: SyncStorageQueue,
): Promise<void> {
  const settingsValue: unknown = changes[SYNC_SETTINGS]?.newValue;
  if (settingsValue !== undefined && !echoes.consume(SYNC_SETTINGS, settingsValue)) {
    await correctRejectedChange(
      SYNC_SETTINGS,
      mergeSettings(settingsValue as Parameters<typeof mergeSettings>[0]),
      (settings: Settings): Promise<Ack> => engine.applySyncedSettings(settings),
      (): Settings => engine.getSettings(),
      queueSync,
    );
  }

  const listsValue: unknown = changes[SYNC_LISTS]?.newValue;
  if (listsValue !== undefined && !echoes.consume(SYNC_LISTS, listsValue)) {
    await correctRejectedChange(
      SYNC_LISTS,
      mergeLists(listsValue as Parameters<typeof mergeLists>[0]),
      (lists: ListsConfig): Promise<Ack> => engine.applySyncedLists(lists),
      (): ListsConfig => engine.getLists(),
      queueSync,
    );
  }

  const bankValue: unknown = changes[SYNC_BANK]?.newValue;
  if (bankValue !== undefined && !echoes.consume(SYNC_BANK, bankValue)) {
    await engine.applySyncedBank(bankValue as BankState);
  }

  const streakValue: unknown = changes[SYNC_STREAK]?.newValue;
  if (streakValue !== undefined && !echoes.consume(SYNC_STREAK, streakValue)) {
    await engine.applySyncedStreak(streakValue as StreakState);
  }
}

import { parseDailyAgg, parseMonthlyAgg } from '../core/stats';
import { emptyStreak } from '../core/streak';
import type { Request, SoundId } from '../shared/messages';
import {
  LOCAL_LISTS_SNAPSHOT,
  SYNC_BANK,
  SYNC_LISTS,
  SYNC_SETTINGS,
  SYNC_STREAK,
} from '../shared/storage-keys';
import { localDateStr, localMonthStr } from '../shared/time';
import type {
  BankState,
  DailyAgg,
  ListsConfig,
  MonthlyAgg,
  SessionSnapshot,
  Settings,
  StreakState,
} from '../shared/types';
import { notify, playSound } from './audio';
import { Engine, type EnginePorts } from './engine';
import { updateIcon } from './icon';
import {
  canonicalListsConfig,
  decodeListsSyncSnapshot,
  encodeListsForSync,
  isListSyncKey,
  LIST_SYNC_KEYS,
  type ListsSyncEncoding,
} from './list-sync-codec';
import { parseRequest } from './request-validation';
import { routeMessage } from './router';
import { handleSyncChanges, missingSyncDefaults } from './storage-sync';
import {
  appendEvents,
  getDeviceId,
  loadBank,
  loadLists,
  loadRuntime,
  loadSettings,
  loadStreak,
  loadSyncJournal,
  mergeSettings,
  migrateRuntimeRules,
  type ParsedRuntimeState,
  parseBank,
  parseLiveSettings,
  parseStreak,
  type RuntimeState,
  saveMatcherCache,
  saveRuntime,
  saveSyncJournal,
} from './stores';
import { chooseNewerStreak, rebaseStreakForDate, streaksEqual } from './streak-sync';
import {
  removeSyncItems,
  replaySyncQuotaEvictionCheckpoint,
  type SanitizedSyncJournal,
  sanitizeSyncJournal,
  setSyncItemsWithinQuota,
} from './sync-quota';
import { compactPendingSyncRetention } from './sync-retention';
import { SyncEchoes, type SyncJournal, SyncWriter } from './sync-writer';
import {
  applyBlockingFactory,
  injectIntoExistingTabs,
  invalidateRemovedTab,
  registerTabListeners,
} from './tabs';

const SYNC_FLUSH_MS: number = 10_000;
const TICK_ALARM: string = 'tick';
const PHASE_ALARM: string = 'phase';
const DAILY_AGG_KEY_RE: RegExp = /^agg:[^:]+:(\d{4}-\d{2}-\d{2})$/;
const MONTHLY_AGG_KEY_RE: RegExp = /^aggm:[^:]+:(\d{4}-\d{2})$/;

type AggregateKeyIdentity = { kind: 'daily'; period: string } | { kind: 'monthly'; period: string };
type StoredAggregate = DailyAgg | MonthlyAgg;

let engineInstance: Engine | null = null;
let syncWriterInstance: SyncWriter | null = null;
const syncEchoes: SyncEchoes = new SyncEchoes();

function currentEngine(): Engine {
  if (engineInstance === null) throw new Error('engine used before boot finished');
  return engineInstance;
}

function currentSyncWriter(): SyncWriter {
  if (syncWriterInstance === null) throw new Error('sync writer used before boot finished');
  return syncWriterInstance;
}

function reportBackgroundError(error: unknown): void {
  console.error('focus-lock background error', error);
}

function hasPendingSet(journal: SyncJournal, key: string): boolean {
  return !journal.removes.includes(key) && Object.hasOwn(journal.sets, key);
}

function hasPendingLists(journal: SyncJournal): boolean {
  return (
    Object.keys(journal.sets).some((key: string): boolean => isListSyncKey(key)) ||
    journal.removes.some((key: string): boolean => isListSyncKey(key))
  );
}

function replacePendingLists(journal: SyncJournal, encoding: ListsSyncEncoding): void {
  for (const key of LIST_SYNC_KEYS) delete journal.sets[key];
  journal.removes = journal.removes.filter((key: string): boolean => !isListSyncKey(key));
  Object.assign(journal.sets, encoding.sets);
  journal.removes.push(...encoding.removes);
}

function queueListsEncoding(writer: SyncWriter, encoding: ListsSyncEncoding): void {
  for (const [key, value] of Object.entries(encoding.sets)) writer.queue(key, value);
  for (const key of encoding.removes) writer.remove(key);
}

function effectiveListsSnapshot(
  storedSync: Readonly<Record<string, unknown>>,
  journal: SyncJournal,
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = Object.fromEntries(
    Object.entries(storedSync).filter(([key]: [string, unknown]): boolean => isListSyncKey(key)),
  );
  for (const key of journal.removes) {
    if (isListSyncKey(key)) delete snapshot[key];
  }
  for (const [key, value] of Object.entries(journal.sets)) {
    if (isListSyncKey(key) && !journal.removes.includes(key)) snapshot[key] = value;
  }
  return snapshot;
}

function aggregateKeyIdentity(key: string): AggregateKeyIdentity | null {
  const dailyDate: string | undefined = DAILY_AGG_KEY_RE.exec(key)?.[1];
  if (dailyDate !== undefined) return { kind: 'daily', period: dailyDate };
  const month: string | undefined = MONTHLY_AGG_KEY_RE.exec(key)?.[1];
  return month === undefined ? null : { kind: 'monthly', period: month };
}

function parseAggregateForKey(
  value: unknown,
  identity: AggregateKeyIdentity,
): StoredAggregate | null {
  return identity.kind === 'daily'
    ? parseDailyAgg(value, identity.period)
    : parseMonthlyAgg(value, identity.period);
}

function validatePendingAggregates(
  journal: SyncJournal,
  storedSync: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(journal.sets)) {
    if (!hasPendingSet(journal, key)) continue;
    const identity: AggregateKeyIdentity | null = aggregateKeyIdentity(key);
    if (identity === null) continue;
    const pending: StoredAggregate | null = parseAggregateForKey(value, identity);
    const corrected: StoredAggregate | null =
      pending ?? parseAggregateForKey(storedSync[key], identity);
    if (corrected !== null) journal.sets[key] = corrected;
    else delete journal.sets[key];
  }
}

function validatedPendingJournal(
  rawJournal: SyncJournal,
  storedSync: Record<string, unknown>,
  now: number,
): SyncJournal {
  const journal: SyncJournal = {
    sets: { ...rawJournal.sets },
    removes: [...rawJournal.removes],
  };
  if (hasPendingSet(journal, SYNC_SETTINGS)) {
    const synced: Settings = mergeSettings(storedSync[SYNC_SETTINGS]);
    journal.sets[SYNC_SETTINGS] = parseLiveSettings(journal.sets[SYNC_SETTINGS], synced) ?? synced;
  }
  if (hasPendingSet(journal, SYNC_BANK)) {
    const synced: BankState = parseBank(storedSync[SYNC_BANK]) ?? { balanceMs: 0 };
    journal.sets[SYNC_BANK] = parseBank(journal.sets[SYNC_BANK]) ?? synced;
  }
  if (hasPendingSet(journal, SYNC_STREAK)) {
    const synced: StreakState =
      parseStreak(storedSync[SYNC_STREAK]) ?? emptyStreak(localMonthStr(now));
    journal.sets[SYNC_STREAK] = parseStreak(journal.sets[SYNC_STREAK]) ?? synced;
  }
  validatePendingAggregates(journal, storedSync);
  return journal;
}

async function boot(onSyncWriterReady: (writer: SyncWriter) => void): Promise<Engine> {
  const now: number = Date.now();
  const rawJournal: SyncJournal = await loadSyncJournal();
  try {
    await replaySyncQuotaEvictionCheckpoint(undefined, undefined, rawJournal.removes);
  } catch (error: unknown) {
    reportBackgroundError(error);
  }
  const pendingAggregateKeys: string[] = Object.keys(rawJournal.sets).filter(
    (key: string): boolean => aggregateKeyIdentity(key) !== null,
  );
  const storedSync: Record<string, unknown> = await chrome.storage.sync.get([
    SYNC_SETTINGS,
    ...LIST_SYNC_KEYS,
    SYNC_BANK,
    SYNC_STREAK,
    ...pendingAggregateKeys,
  ]);
  const sanitized: SanitizedSyncJournal = sanitizeSyncJournal(rawJournal);
  const journal: SyncJournal = validatedPendingJournal(sanitized.journal, storedSync, now);
  const journalHadLists: boolean = hasPendingLists(journal);
  if (sanitized.rejected.length > 0) await saveSyncJournal(journal);
  const [storedLists, journalFallbackLists]: [ListsConfig, ListsConfig] = await Promise.all([
    loadLists(undefined, storedSync),
    loadLists(journal, storedSync),
  ]);
  const decodedLists = decodeListsSyncSnapshot(effectiveListsSnapshot(storedSync, journal));
  const lists: ListsConfig =
    !journalHadLists || decodedLists.kind === 'legacy'
      ? storedLists
      : decodedLists.kind === 'complete'
        ? decodedLists.lists
        : journalFallbackLists;
  const [settings, bank, syncedStreak, loadedRuntime, deviceId]: [
    Settings,
    BankState,
    StreakState | null,
    ParsedRuntimeState,
    string,
  ] = await Promise.all([
    loadSettings(journal),
    loadBank(journal),
    loadStreak(),
    loadRuntime(now),
    getDeviceId(),
  ]);
  const runtime: RuntimeState = migrateRuntimeRules(loadedRuntime, lists);
  if (runtime !== loadedRuntime) await saveRuntime(runtime);
  if (journalHadLists) replacePendingLists(journal, await encodeListsForSync(lists));
  await chrome.storage.local.set({ [LOCAL_LISTS_SNAPSHOT]: canonicalListsConfig(lists) });
  const journalValue: unknown = journal.sets[SYNC_STREAK];
  const journalHasStreak: boolean =
    !journal.removes.includes(SYNC_STREAK) && Object.hasOwn(journal.sets, SYNC_STREAK);
  const journaledStreak: StreakState | null = journalHasStreak ? parseStreak(journalValue) : null;
  const today: string = localDateStr(now);
  const rebasedSyncedStreak: StreakState | null =
    syncedStreak === null ? null : rebaseStreakForDate(syncedStreak, today);
  const rebasedJournaledStreak: StreakState | null =
    journaledStreak === null ? null : rebaseStreakForDate(journaledStreak, today);
  const streak: StreakState | null = chooseNewerStreak(rebasedSyncedStreak, rebasedJournaledStreak);
  const persistedStreak: StreakState = streak ?? emptyStreak(localMonthStr(now));
  const journalNeedsStreak: boolean =
    (journalHasStreak && journaledStreak === null) ||
    (streak !== null &&
      ((syncedStreak !== null && !streaksEqual(streak, syncedStreak)) ||
        (journaledStreak !== null && !streaksEqual(streak, journaledStreak))));
  const initialJournal: SyncJournal = {
    sets: { ...journal.sets },
    removes: [...journal.removes],
  };
  if (journalNeedsStreak) {
    initialJournal.sets[SYNC_STREAK] = persistedStreak;
    initialJournal.removes = initialJournal.removes.filter(
      (key: string): boolean => key !== SYNC_STREAK,
    );
  }
  const syncWriter: SyncWriter = new SyncWriter(
    SYNC_FLUSH_MS,
    async (items: Record<string, unknown>): Promise<void> => {
      for (const [key, value] of Object.entries(items)) {
        if (
          key === SYNC_SETTINGS ||
          isListSyncKey(key) ||
          key === SYNC_BANK ||
          key === SYNC_STREAK
        ) {
          syncEchoes.remember(key, value);
        }
      }
      await setSyncItemsWithinQuota(items);
    },
    (keys: string[]): Promise<void> => removeSyncItems(keys),
    { initial: initialJournal, persist: saveSyncJournal },
  );
  syncWriterInstance = syncWriter;
  if (journalNeedsStreak) syncWriter.queue(SYNC_STREAK, persistedStreak);
  const effectiveStoredSync: Record<string, unknown> = { ...storedSync, ...initialJournal.sets };
  for (const key of initialJournal.removes) delete effectiveStoredSync[key];
  const missingDefaults: Record<string, unknown> = missingSyncDefaults(effectiveStoredSync, {
    settings,
    lists,
    bank,
    streak: persistedStreak,
  });
  const listsWereMissing: boolean = Object.hasOwn(missingDefaults, SYNC_LISTS);
  delete missingDefaults[SYNC_LISTS];
  for (const [key, value] of Object.entries(missingDefaults)) syncWriter.queue(key, value);
  if (listsWereMissing) {
    queueListsEncoding(syncWriter, await encodeListsForSync(lists));
  }
  onSyncWriterReady(syncWriter);
  await syncWriter.whenJournalDurable();
  const ports: EnginePorts = {
    now: (): number => Date.now(),
    newId: (): string => crypto.randomUUID(),
    saveRuntime,
    saveMatcherCache,
    hasPendingSync: (key: string): boolean => syncWriter.hasPending(key),
    queueSync: (key: string, value: unknown): void => syncWriter.queue(key, value),
    supersedeSync: (key: string, value: unknown): void => syncWriter.supersede(key, value),
    removeSync: (key: string): void => syncWriter.remove(key),
    persistSyncJournal: (): Promise<void> => syncWriter.whenJournalDurable(),
    appendEvents,
    broadcast: (snapshot: SessionSnapshot): void => {
      // Rejects when no extension page is open to hear it, which is fine.
      chrome.runtime.sendMessage({ type: 'stateChanged', snapshot }).catch((): undefined => {
        return undefined;
      });
    },
    applyBlocking: applyBlockingFactory(currentEngine),
    playSound: (sound: SoundId): void => {
      void playSound(sound, currentEngine().getSettings().sounds);
    },
    notify,
    updateIcon: (snapshot: SessionSnapshot): void => {
      updateIcon(snapshot, currentEngine().getSettings().badgeCountdown);
    },
    scheduleWake: (atMs: number | null): void => {
      if (atMs === null) void chrome.alarms.clear(PHASE_ALARM);
      else void chrome.alarms.create(PHASE_ALARM, { when: atMs });
    },
    prune: (retentionDays: number, pruneNow: number): Promise<void> =>
      compactPendingSyncRetention(
        syncWriter,
        deviceId,
        retentionDays,
        pruneNow,
        (): Promise<Record<string, unknown>> =>
          chrome.storage.sync.get(null) as Promise<Record<string, unknown>>,
      ),
    reportError: reportBackgroundError,
  };
  const engine: Engine = new Engine(ports, settings, lists, bank, streak, runtime, deviceId);
  engineInstance = engine;
  await engine.tick();
  await ports.applyBlocking();
  return engine;
}

/**
 * Worker entry. Listener registration happens synchronously at the top
 * level (MV3 requirement), state loading hides behind the ready promise
 * every listener awaits.
 */
export function main(): void {
  engineInstance = null;
  syncWriterInstance = null;
  let resolveSyncWriterReady: (writer: SyncWriter) => void = (): void => undefined;
  const syncWriterReady: Promise<SyncWriter> = new Promise(
    (resolve: (writer: SyncWriter) => void): void => {
      resolveSyncWriterReady = resolve;
    },
  );
  let listenerSyncWriter: SyncWriter | null = null;
  let listChangeApplyQueue: Promise<void> = Promise.resolve();
  const ready: Promise<Engine> = boot((writer: SyncWriter): void => {
    listenerSyncWriter = writer;
    resolveSyncWriterReady(writer);
  });

  chrome.runtime.onMessage.addListener(
    (
      msg: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response: unknown) => void,
    ): boolean => {
      const request: Request | null = parseRequest(msg);
      if (request === null) {
        sendResponse({ ok: false, error: 'invalid request' });
        return true;
      }
      ready
        .then((engine: Engine): Promise<unknown> => routeMessage(engine, request, sender))
        .then((response: unknown): void => sendResponse(response))
        .catch((err: unknown): void => sendResponse({ ok: false, error: String(err) }));
      return true;
    },
  );

  chrome.storage.onChanged.addListener(
    (changes: Record<string, chrome.storage.StorageChange>, areaName: string): void => {
      if (areaName !== 'sync') return;
      const hasListsChange: boolean = Object.keys(changes).some((key: string): boolean =>
        isListSyncKey(key),
      );
      const reconcilePendingLists: Promise<boolean> = hasListsChange
        ? listenerSyncWriter === null
          ? syncWriterReady.then((writer: SyncWriter): boolean =>
              LIST_SYNC_KEYS.some((key: string): boolean => writer.hasPending(key)),
            )
          : Promise.resolve(
              LIST_SYNC_KEYS.some((key: string): boolean =>
                (listenerSyncWriter as SyncWriter).hasPending(key),
              ),
            )
        : Promise.resolve(false);
      const listSnapshot: Promise<Record<string, unknown> | undefined> = hasListsChange
        ? chrome.storage.sync.get([...LIST_SYNC_KEYS])
        : Promise.resolve(undefined);
      const applyChanges = async (): Promise<void> => {
        const [engine, shouldReconcile, snapshot] = await Promise.all([
          ready,
          reconcilePendingLists,
          listSnapshot,
        ]);
        await handleSyncChanges(
          engine,
          changes,
          syncEchoes,
          async (key: string, value: unknown): Promise<void> => {
            const writer: SyncWriter = currentSyncWriter();
            if (key === SYNC_LISTS) {
              queueListsEncoding(writer, await encodeListsForSync(value as ListsConfig));
            } else {
              writer.queue(key, value);
            }
            await writer.whenJournalDurable();
          },
          shouldReconcile,
          snapshot,
        );
      };
      if (hasListsChange) {
        const requested: Promise<void> = listChangeApplyQueue.then(applyChanges);
        listChangeApplyQueue = requested.catch((): void => {});
        void requested.catch(reportBackgroundError);
      } else {
        void applyChanges().catch(reportBackgroundError);
      }
    },
  );

  chrome.alarms.onAlarm.addListener((): void => {
    void ready.then((engine: Engine): Promise<void> => engine.tick()).catch(reportBackgroundError);
  });

  registerTabListeners((): Promise<Engine> => ready, reportBackgroundError);

  chrome.runtime.onInstalled.addListener((): void => {
    void chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 }).catch(reportBackgroundError);
    void injectIntoExistingTabs().catch(reportBackgroundError);
  });

  chrome.tabs.onRemoved.addListener((tabId: number): void => {
    const invalidationCleanup: Promise<void> = invalidateRemovedTab(tabId);
    void Promise.all([
      invalidationCleanup.catch(reportBackgroundError),
      ready
        .then((engine: Engine): Promise<void> => engine.dropTab(tabId))
        .catch(reportBackgroundError),
    ]);
  });

  // Reloads of an already-installed extension skip onInstalled, and
  // alarm creation is idempotent, so ensure the tick exists every boot.
  void chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 }).catch(reportBackgroundError);
}

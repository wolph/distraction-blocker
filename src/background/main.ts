import { ALL_CATEGORIES } from '../core/categories';
import {
  buildMatcherCache,
  type CompiledMatcherSet,
  type MatcherCacheBundle,
  restoreMatcherCache,
} from '../core/matcher';
import { parseDailyAgg, parseMonthlyAgg } from '../core/stats';
import { emptyStreak } from '../core/streak';
import type { Request, SoundId } from '../shared/messages';
import { SYNC_BANK, SYNC_LISTS, SYNC_SETTINGS, SYNC_STREAK } from '../shared/storage-keys';
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
import { parseRequest } from './request-validation';
import { routeMessage } from './router';
import { handleSyncChanges, missingSyncDefaults } from './storage-sync';
import {
  appendEvents,
  getDeviceId,
  loadBank,
  loadLists,
  loadMatcherCache,
  loadRuntime,
  loadSettings,
  loadStreak,
  loadSyncJournal,
  mergeLists,
  mergeSettings,
  parseBank,
  parseLiveLists,
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
  if (hasPendingSet(journal, SYNC_LISTS)) {
    const synced: ListsConfig = mergeLists(storedSync[SYNC_LISTS]);
    journal.sets[SYNC_LISTS] = parseLiveLists(journal.sets[SYNC_LISTS], synced) ?? synced;
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
  await replaySyncQuotaEvictionCheckpoint();
  const rawJournal: SyncJournal = await loadSyncJournal();
  const pendingAggregateKeys: string[] = Object.keys(rawJournal.sets).filter(
    (key: string): boolean => aggregateKeyIdentity(key) !== null,
  );
  const storedSync: Record<string, unknown> = await chrome.storage.sync.get([
    SYNC_SETTINGS,
    SYNC_LISTS,
    SYNC_BANK,
    SYNC_STREAK,
    ...pendingAggregateKeys,
  ]);
  const sanitized: SanitizedSyncJournal = sanitizeSyncJournal(rawJournal);
  const journal: SyncJournal = validatedPendingJournal(sanitized.journal, storedSync, now);
  if (sanitized.rejected.length > 0) await saveSyncJournal(journal);
  const [settings, lists, bank, syncedStreak, runtime, rawMatcherCache, deviceId]: [
    Settings,
    ListsConfig,
    BankState,
    StreakState | null,
    RuntimeState,
    unknown,
    string,
  ] = await Promise.all([
    loadSettings(journal),
    loadLists(journal),
    loadBank(journal),
    loadStreak(),
    loadRuntime(now),
    loadMatcherCache(),
    getDeviceId(),
  ]);
  let matchers: CompiledMatcherSet | null = restoreMatcherCache(
    rawMatcherCache,
    lists,
    ALL_CATEGORIES,
  );
  if (matchers === null) {
    const rebuilt: MatcherCacheBundle = buildMatcherCache(lists, ALL_CATEGORIES);
    matchers = rebuilt.compiled;
    try {
      await saveMatcherCache(rebuilt.stored);
    } catch (error: unknown) {
      reportBackgroundError(error);
    }
  }
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
          key === SYNC_LISTS ||
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
  for (const [key, value] of Object.entries(missingDefaults)) syncWriter.queue(key, value);
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
  const engine: Engine = new Engine(
    ports,
    settings,
    lists,
    bank,
    streak,
    runtime,
    deviceId,
    matchers,
  );
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
  let syncWriterInitialized: boolean = false;
  let resolveSyncWriterReady: (writer: SyncWriter) => void = (): void => undefined;
  const syncWriterReady: Promise<SyncWriter> = new Promise(
    (resolve: (writer: SyncWriter) => void): void => {
      resolveSyncWriterReady = resolve;
    },
  );
  const ready: Promise<Engine> = boot((writer: SyncWriter): void => {
    syncWriterInitialized = true;
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
      const hasListsChange: boolean = changes[SYNC_LISTS]?.newValue !== undefined;
      const reconcilePendingLists: Promise<boolean> = hasListsChange
        ? !syncWriterInitialized || syncWriterInstance === null
          ? syncWriterReady.then((writer: SyncWriter): boolean => writer.hasPending(SYNC_LISTS))
          : Promise.resolve(syncWriterInstance.hasPending(SYNC_LISTS))
        : Promise.resolve(false);
      void Promise.all([ready, reconcilePendingLists])
        .then(async ([engine, shouldReconcile]: [Engine, boolean]): Promise<void> => {
          await handleSyncChanges(
            engine,
            changes,
            syncEchoes,
            async (key: string, value: unknown): Promise<void> => {
              const writer: SyncWriter = currentSyncWriter();
              writer.queue(key, value);
              await writer.whenJournalDurable();
            },
            shouldReconcile,
          );
        })
        .catch(reportBackgroundError);
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

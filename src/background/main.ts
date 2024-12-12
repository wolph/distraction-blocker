import { emptyStreak } from '../core/streak';
import type { Request } from '../shared/messages';
import { SYNC_BANK, SYNC_LISTS, SYNC_SETTINGS, SYNC_STREAK } from '../shared/storage-keys';
import { localDateStr, localMonthStr } from '../shared/time';
import type { SessionSnapshot, StreakState } from '../shared/types';
import { notify, playSound } from './audio';
import { Engine, type EnginePorts } from './engine';
import { updateIcon } from './icon';
import { routeMessage } from './router';
import { runPrune } from './stats-service';
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
  saveRuntime,
  saveSyncJournal,
} from './stores';
import { chooseNewerStreak, rebaseStreakForDate, streaksEqual } from './streak-sync';
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

async function boot(): Promise<Engine> {
  const now: number = Date.now();
  const journal: SyncJournal = await loadSyncJournal();
  const [settings, lists, bank, syncedStreak, runtime, deviceId, storedSync] = await Promise.all([
    loadSettings(journal),
    loadLists(journal),
    loadBank(journal),
    loadStreak(),
    loadRuntime(now),
    getDeviceId(),
    chrome.storage.sync.get([SYNC_SETTINGS, SYNC_LISTS, SYNC_BANK, SYNC_STREAK]),
  ]);
  const journalValue: unknown = journal.sets[SYNC_STREAK];
  const journaledStreak: StreakState | null =
    !journal.removes.includes(SYNC_STREAK) &&
    typeof journalValue === 'object' &&
    journalValue !== null
      ? (journalValue as StreakState)
      : null;
  const today: string = localDateStr(now);
  const rebasedSyncedStreak: StreakState | null =
    syncedStreak === null ? null : rebaseStreakForDate(syncedStreak, today);
  const rebasedJournaledStreak: StreakState | null =
    journaledStreak === null ? null : rebaseStreakForDate(journaledStreak, today);
  const streak: StreakState | null = chooseNewerStreak(rebasedSyncedStreak, rebasedJournaledStreak);
  const journalNeedsStreak: boolean =
    streak !== null &&
    ((syncedStreak !== null && !streaksEqual(streak, syncedStreak)) ||
      (journaledStreak !== null && !streaksEqual(streak, journaledStreak)));
  const initialJournal: SyncJournal = {
    sets: { ...journal.sets },
    removes: [...journal.removes],
  };
  if (journalNeedsStreak) {
    initialJournal.sets[SYNC_STREAK] = streak;
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
      await chrome.storage.sync.set(items);
    },
    (keys: string[]): Promise<void> => chrome.storage.sync.remove(keys),
    { initial: initialJournal, persist: saveSyncJournal },
  );
  syncWriterInstance = syncWriter;
  if (journalNeedsStreak) syncWriter.queue(SYNC_STREAK, streak);
  const effectiveStoredSync: Record<string, unknown> = { ...storedSync, ...initialJournal.sets };
  for (const key of initialJournal.removes) delete effectiveStoredSync[key];
  const missingDefaults: Record<string, unknown> = missingSyncDefaults(effectiveStoredSync, {
    settings,
    lists,
    bank,
    streak: streak ?? emptyStreak(localMonthStr(now)),
  });
  for (const [key, value] of Object.entries(missingDefaults)) syncWriter.queue(key, value);
  await syncWriter.whenJournalDurable();
  const ports: EnginePorts = {
    now: (): number => Date.now(),
    newId: (): string => crypto.randomUUID(),
    saveRuntime,
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
    playSound: (sound): void => {
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
    prune: runPrune,
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
  const ready: Promise<Engine> = boot();

  chrome.runtime.onMessage.addListener(
    (
      msg: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response: unknown) => void,
    ): boolean => {
      ready
        .then((engine: Engine): Promise<unknown> => routeMessage(engine, msg as Request, sender))
        .then((response: unknown): void => sendResponse(response))
        .catch((err: unknown): void => sendResponse({ ok: false, error: String(err) }));
      return true;
    },
  );

  chrome.storage.onChanged.addListener(
    (changes: Record<string, chrome.storage.StorageChange>, areaName: string): void => {
      if (areaName !== 'sync') return;
      void ready
        .then(async (engine: Engine): Promise<void> => {
          await handleSyncChanges(
            engine,
            changes,
            syncEchoes,
            async (key: string, value: unknown): Promise<void> => {
              const writer: SyncWriter = currentSyncWriter();
              writer.queue(key, value);
              await writer.whenJournalDurable();
            },
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

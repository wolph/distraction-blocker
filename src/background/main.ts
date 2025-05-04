import { parseDailyAgg, parseMonthlyAgg } from '../core/stats';
import { emptyStreak } from '../core/streak';
import { DEFAULT_SETTINGS } from '../shared/constants';
import type { Request, SoundId } from '../shared/messages';
import { WEBSITE_ORIGINS } from '../shared/permissions';
import { isInstallMarker, isListsConfig, isSettings } from '../shared/runtime-validation';
import {
  LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS,
  LOCAL_CACHES,
  LOCAL_DEVICE_ID,
  LOCAL_EVENTS,
  LOCAL_INSTALL_MARKER,
  LOCAL_LISTS_SNAPSHOT,
  LOCAL_ONBOARDING_DRAFT,
  LOCAL_RUNTIME,
  LOCAL_SYNC_JOURNAL,
  LOCAL_SYNC_QUOTA_EVICTION,
  SYNC_BANK,
  SYNC_LISTS,
  SYNC_SETTINGS,
  SYNC_STREAK,
} from '../shared/storage-keys';
import { localDateStr, localMonthStr } from '../shared/time';
import type {
  BankState,
  DailyAgg,
  InstallMarker,
  ListsConfig,
  MonthlyAgg,
  SessionSnapshot,
  Settings,
  SetupState,
  StreakState,
} from '../shared/types';
import { notify, playSound } from './audio';
import {
  type ContentRegistrationState,
  contentScriptFile,
  reconcileContentRegistrationState,
} from './content-registration';
import { Engine, type EnginePorts } from './engine';
import { updateIcon } from './icon';
import {
  decodeListsSyncSnapshot,
  encodeListsForSync,
  isListSyncKey,
  LIST_SYNC_KEYS,
  type ListsSyncEncoding,
} from './list-sync-codec';
import { createPolicyStorage, type PolicySnapshot, type PolicyStorage } from './policy-storage';
import { parseRequest } from './request-validation';
import { routeMessage } from './router';
import { handleSyncChanges, missingSyncDefaults } from './storage-sync';
import {
  appendEvents,
  emptyRuntime,
  getDeviceId,
  loadLists,
  loadRuntime,
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
} from './stores';
import { chooseNewerStreak, rebaseStreakForDate, streaksEqual } from './streak-sync';
import {
  aggregateHistoryDeviceId,
  isAggregateHistoryKey,
  isAuthoritativeSyncItem,
  isFocusLockSyncKey,
} from './sync-item-validation';
import { type SanitizedSyncJournal, sanitizeSyncJournal } from './sync-quota';
import type { SyncJournal } from './sync-writer';
import {
  applyBlockingFactory,
  injectIntoExistingTabs,
  invalidateRemovedTab,
  registerTabListeners,
} from './tabs';

const TICK_ALARM: string = 'tick';
const PHASE_ALARM: string = 'phase';
const DAILY_AGG_KEY_RE: RegExp = /^agg:[^:]+:(\d{4}-\d{2}-\d{2})$/;
const MONTHLY_AGG_KEY_RE: RegExp = /^aggm:[^:]+:(\d{4}-\d{2})$/;

type AggregateKeyIdentity = { kind: 'daily'; period: string } | { kind: 'monthly'; period: string };
type StoredAggregate = DailyAgg | MonthlyAgg;

let engineInstance: Engine | null = null;

type WebsiteCapabilityCause = 'boot' | 'explicit' | 'permission-added' | 'permission-removed';
type WebsiteReconciliation = {
  capability: ContentRegistrationState;
  generation: number;
};
type WebsiteAccessNotice = Exclude<SetupState['websiteAccessNotice'], null>;
type PendingWebsiteAccessNotice = { value: WebsiteAccessNotice | null };

function recordWebsiteAccessNotice(
  pending: PendingWebsiteAccessNotice,
  notice: WebsiteAccessNotice,
): void {
  if (pending.value === 'revoked-during-session') return;
  pending.value = notice;
}

async function endActiveSessionForWebsiteCapabilityLoss(
  engine: Engine,
  capability: ContentRegistrationState,
  cause: WebsiteCapabilityCause,
  pendingNotice: PendingWebsiteAccessNotice,
): Promise<boolean> {
  if (!engine.hasActiveSession()) return false;
  const notice: WebsiteAccessNotice =
    capability.permission === 'denied' || cause === 'permission-removed'
      ? 'revoked-during-session'
      : 'registration-failed-during-session';
  try {
    await engine.endSessionForWebsiteBlockingLoss();
  } catch (error: unknown) {
    reportBackgroundError(error);
  }
  recordWebsiteAccessNotice(pendingNotice, notice);
  return true;
}

function isWebsitePermissionEvent(permissions: chrome.permissions.Permissions): boolean {
  return (permissions.origins ?? []).some(
    (origin: string): boolean => origin === '<all_urls>' || WEBSITE_ORIGINS.includes(origin),
  );
}

async function applyWebsiteCapability(
  storage: PolicyStorage,
  engine: Engine,
  capability: ContentRegistrationState,
  cause: WebsiteCapabilityCause,
  pendingNotice: PendingWebsiteAccessNotice,
  isCurrent: () => boolean = (): boolean => true,
): Promise<ContentRegistrationState | null> {
  if (!isCurrent()) return null;
  let effectiveCapability: ContentRegistrationState = capability;
  if (capability.status === 'ready') {
    const injectionComplete: boolean = await injectIntoExistingTabs(
      contentScriptFile,
      reportBackgroundError,
    );
    if (!isCurrent()) return null;
    if (!injectionComplete) {
      effectiveCapability = { permission: capability.permission, status: 'error' };
    }
  }
  if (effectiveCapability.status !== 'ready') {
    await endActiveSessionForWebsiteCapabilityLoss(
      engine,
      effectiveCapability,
      cause,
      pendingNotice,
    );
    if (!isCurrent()) return null;
  }
  const setup: SetupState = await storage.loadSetup();
  if (!isCurrent()) return null;
  const websiteAccess: typeof setup.websiteAccess =
    effectiveCapability.permission === 'granted'
      ? 'granted'
      : effectiveCapability.permission === 'denied' || cause === 'permission-removed'
        ? 'denied'
        : setup.websiteAccess;
  const websiteAccessNotice: typeof setup.websiteAccessNotice =
    effectiveCapability.status === 'ready'
      ? null
      : (pendingNotice.value ?? setup.websiteAccessNotice);
  await storage.updateSetup({
    websiteAccess,
    blockingRegistration: effectiveCapability.status,
    websiteAccessNotice,
  });
  if (!isCurrent()) return null;
  return effectiveCapability;
}

function currentEngine(): Engine {
  if (engineInstance === null) throw new Error('engine used before boot finished');
  return engineInstance;
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
  // The journal is replay transport, not independent policy authority. A malformed
  // pending value may fall back only to validated remote or default policy here.
  // The complete resolved snapshot is validated again by PolicyStorage.importLegacy.
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

function assertValidAuthoritativeRemotePolicy(
  storedSync: Record<string, unknown>,
  journal: SyncJournal,
): void {
  const pendingSettings: Settings | null = hasPendingSet(journal, SYNC_SETTINGS)
    ? isSettings(journal.sets[SYNC_SETTINGS])
      ? journal.sets[SYNC_SETTINGS]
      : parseLiveSettings(journal.sets[SYNC_SETTINGS], DEFAULT_SETTINGS)
    : null;
  if (
    pendingSettings === null &&
    Object.hasOwn(storedSync, SYNC_SETTINGS) &&
    !isSettings(storedSync[SYNC_SETTINGS]) &&
    parseLiveSettings(storedSync[SYNC_SETTINGS], DEFAULT_SETTINGS) === null
  ) {
    throw new Error('invalid authoritative legacy settings');
  }
  const pendingBank: BankState | null = hasPendingSet(journal, SYNC_BANK)
    ? parseBank(journal.sets[SYNC_BANK])
    : null;
  if (
    pendingBank === null &&
    Object.hasOwn(storedSync, SYNC_BANK) &&
    parseBank(storedSync[SYNC_BANK]) === null
  ) {
    throw new Error('invalid authoritative legacy bank');
  }
  const pendingStreak: StreakState | null = hasPendingSet(journal, SYNC_STREAK)
    ? parseStreak(journal.sets[SYNC_STREAK])
    : null;
  if (
    pendingStreak === null &&
    Object.hasOwn(storedSync, SYNC_STREAK) &&
    parseStreak(storedSync[SYNC_STREAK]) === null
  ) {
    throw new Error('invalid authoritative legacy streak');
  }
  const remoteHasLists: boolean = Object.keys(storedSync).some(isListSyncKey);
  const journalHasLists: boolean = hasPendingLists(journal);
  // The pending journal is replay transport. It is repaired from validated remote
  // or local compatibility authority later. Remote list authority must be coherent.
  if (!remoteHasLists || journalHasLists) return;
  const decoded = decodeListsSyncSnapshot(storedSync);
  if (decoded.kind === 'incomplete') {
    throw new Error('incomplete authoritative legacy lists');
  }
  if (decoded.kind === 'legacy' && !isListsConfig(decoded.value)) {
    throw new Error('invalid authoritative legacy lists');
  }
}

function assertValidResolvedLegacyPolicy(snapshot: PolicySnapshot): void {
  if (!isSettings(snapshot.settings)) throw new Error('invalid resolved legacy settings');
  if (!isListsConfig(snapshot.lists)) throw new Error('invalid resolved legacy lists');
  if (parseBank(snapshot.bank) === null) throw new Error('invalid resolved legacy bank');
  if (snapshot.streak !== null && parseStreak(snapshot.streak) === null) {
    throw new Error('invalid resolved legacy streak');
  }
}

const LEGACY_EVIDENCE_KEYS: readonly string[] = [
  LOCAL_RUNTIME,
  LOCAL_LISTS_SNAPSHOT,
  LOCAL_EVENTS,
  LOCAL_DEVICE_ID,
  LOCAL_SYNC_JOURNAL,
  LOCAL_SYNC_QUOTA_EVICTION,
  LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS,
  LOCAL_CACHES,
];

async function classifyInstallProfile(): Promise<InstallMarker> {
  const keys: string[] = [LOCAL_INSTALL_MARKER, ...LEGACY_EVIDENCE_KEYS];
  const stored: Record<string, unknown> = await chrome.storage.local.get(keys);
  const existing: unknown = stored[LOCAL_INSTALL_MARKER];
  if (isInstallMarker(existing)) return existing;
  const profile: InstallMarker['profile'] = LEGACY_EVIDENCE_KEYS.some((key: string): boolean =>
    Object.hasOwn(stored, key),
  )
    ? 'legacy'
    : 'clean';
  const marker: InstallMarker = {
    version: 1,
    profile,
    latestReason: 'install',
    extensionVersion: chrome.runtime.getManifest?.().version ?? 'unknown',
  };
  await chrome.storage.local.set({ [LOCAL_INSTALL_MARKER]: marker });
  const verified: unknown = (await chrome.storage.local.get(LOCAL_INSTALL_MARKER))[
    LOCAL_INSTALL_MARKER
  ];
  if (!isInstallMarker(verified) || verified.profile !== profile) {
    throw new Error('could not persist install profile classification');
  }
  return verified;
}

async function persistCleanInstallMarker(): Promise<void> {
  const marker: InstallMarker = {
    version: 1,
    profile: 'clean',
    latestReason: 'install',
    extensionVersion: chrome.runtime.getManifest?.().version ?? 'unknown',
  };
  await chrome.storage.local.set({ [LOCAL_INSTALL_MARKER]: marker });
  const verified: unknown = (await chrome.storage.local.get(LOCAL_INSTALL_MARKER))[
    LOCAL_INSTALL_MARKER
  ];
  if (!isInstallMarker(verified) || verified.profile !== 'clean') {
    throw new Error('could not persist clean install profile after data reset');
  }
}

async function updateInstallMarker(details: chrome.runtime.InstalledDetails): Promise<void> {
  const marker: InstallMarker = await classifyInstallProfile();
  const next: InstallMarker = {
    ...marker,
    latestReason: details.reason === 'update' ? 'update' : 'install',
    extensionVersion: chrome.runtime.getManifest?.().version ?? marker.extensionVersion,
  };
  await chrome.storage.local.set({ [LOCAL_INSTALL_MARKER]: next });
}

function effectiveLegacyValue(
  journal: SyncJournal,
  stored: Record<string, unknown>,
  key: string,
): unknown {
  if (journal.removes.includes(key)) return undefined;
  return Object.hasOwn(journal.sets, key) ? journal.sets[key] : stored[key];
}

async function preparePolicyStorage(): Promise<PolicyStorage> {
  const marker: InstallMarker = await classifyInstallProfile();
  const storage: PolicyStorage = createPolicyStorage(
    chrome.storage.local,
    chrome.storage.sync,
    {
      runExclusive: <T>(operation: () => Promise<T>): Promise<T> =>
        engineInstance === null
          ? operation()
          : engineInstance.runWithAggregateStorageBarrier(operation),
      loadAggregateItems: async (): Promise<Record<string, unknown>> => {
        const deviceId: string = await getDeviceId();
        const stored: Record<string, unknown> = await chrome.storage.local.get(null);
        const aggregates: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(stored)) {
          const looksOwned: boolean =
            key.startsWith(`agg:${deviceId}:`) ||
            key.startsWith(`aggm:${deviceId}:`) ||
            key.startsWith(`archive:clock-rebase:${deviceId}:`);
          if (!looksOwned) continue;
          if (
            aggregateHistoryDeviceId(key) !== deviceId ||
            !isAggregateHistoryKey(key) ||
            !isAuthoritativeSyncItem(key, value)
          ) {
            throw new Error(`invalid local aggregate checkpoint item ${JSON.stringify(key)}`);
          }
          aggregates[key] = value;
        }
        return aggregates;
      },
    },
    {
      runExclusive: <T>(
        operation: () => Promise<T>,
        retainQuiescence: () => boolean,
      ): Promise<T> =>
        engineInstance === null
          ? operation()
          : engineInstance.runWithDataClearBarrier(operation, retainQuiescence),
    },
  );
  await storage.initialize();
  const recoveredSetup: SetupState = await storage.loadSetup();
  if (recoveredSetup.dataClear.status !== 'idle') return storage;
  if (marker.profile === 'clean') {
    return storage;
  }
  const markerAfterRecovery: InstallMarker = await classifyInstallProfile();
  if (markerAfterRecovery.profile === 'clean') return storage;
  const currentSetup = await storage.loadSetup();
  if (currentSetup.legacyImported) {
    return storage;
  }
  try {
    const now: number = Date.now();
    const rawJournal: SyncJournal = await loadSyncJournal();
    const sanitized: SanitizedSyncJournal = sanitizeSyncJournal(rawJournal);
    const storedSync: Record<string, unknown> = await chrome.storage.sync.get(null);
    assertValidAuthoritativeRemotePolicy(storedSync, sanitized.journal);
    const journal: SyncJournal = validatedPendingJournal(sanitized.journal, storedSync, now);
    const hasRemotePolicy: boolean = Object.keys(storedSync).some((key: string): boolean =>
      isFocusLockSyncKey(key),
    );
    const hasLegacySyncIntent: boolean =
      hasRemotePolicy || Object.keys(journal.sets).length > 0 || journal.removes.length > 0;
    const journalHadLists: boolean = hasPendingLists(journal);
    const [storedLists, journalFallbackLists]: [ListsConfig, ListsConfig] = await Promise.all([
      loadLists(undefined, storedSync),
      loadLists(journal, storedSync),
    ]);
    const remoteListsIncomplete: boolean =
      Object.keys(storedSync).some(isListSyncKey) &&
      decodeListsSyncSnapshot(storedSync).kind === 'incomplete';
    const decodedLists = decodeListsSyncSnapshot(effectiveListsSnapshot(storedSync, journal));
    const lists: ListsConfig =
      !journalHadLists || decodedLists.kind === 'legacy'
        ? storedLists
        : decodedLists.kind === 'complete'
          ? decodedLists.lists
          : journalFallbackLists;
    if (journalHadLists || remoteListsIncomplete) {
      replacePendingLists(journal, await encodeListsForSync(lists));
    }
    const settings: Settings = mergeSettings(
      effectiveLegacyValue(journal, storedSync, SYNC_SETTINGS),
      DEFAULT_SETTINGS,
    );
    const bank: BankState = parseBank(effectiveLegacyValue(journal, storedSync, SYNC_BANK)) ?? {
      balanceMs: 0,
    };
    const syncedStreak: StreakState | null = parseStreak(storedSync[SYNC_STREAK]);
    const journalHasStreak: boolean = hasPendingSet(journal, SYNC_STREAK);
    const journaledStreak: StreakState | null = journalHasStreak
      ? parseStreak(journal.sets[SYNC_STREAK])
      : null;
    const today: string = localDateStr(now);
    const rebasedSyncedStreak: StreakState | null =
      syncedStreak === null ? null : rebaseStreakForDate(syncedStreak, today);
    const rebasedJournaledStreak: StreakState | null =
      journaledStreak === null ? null : rebaseStreakForDate(journaledStreak, today);
    const streak: StreakState | null = chooseNewerStreak(
      rebasedSyncedStreak,
      rebasedJournaledStreak,
    );
    const persistedStreak: StreakState = streak ?? emptyStreak(localMonthStr(now));
    if (
      journalHasStreak &&
      (journaledStreak === null ||
        (streak !== null &&
          (!streaksEqual(streak, journaledStreak) ||
            (syncedStreak !== null && !streaksEqual(streak, syncedStreak)))))
    ) {
      journal.sets[SYNC_STREAK] = persistedStreak;
      journal.removes = journal.removes.filter((key: string): boolean => key !== SYNC_STREAK);
    }
    if (hasLegacySyncIntent) {
      const effectiveStoredSync: Record<string, unknown> = { ...storedSync, ...journal.sets };
      for (const key of journal.removes) delete effectiveStoredSync[key];
      const missingDefaults: Record<string, unknown> = missingSyncDefaults(effectiveStoredSync, {
        settings,
        lists,
        bank,
        streak: persistedStreak,
      });
      const listsWereMissing: boolean = Object.hasOwn(missingDefaults, SYNC_LISTS);
      delete missingDefaults[SYNC_LISTS];
      Object.assign(journal.sets, missingDefaults);
      if (listsWereMissing) replacePendingLists(journal, await encodeListsForSync(lists));
    }
    const loadedRuntime: ParsedRuntimeState = await loadRuntime(now);
    const runtime: RuntimeState = migrateRuntimeRules(loadedRuntime, lists);
    const snapshot: PolicySnapshot = { settings, lists, bank, streak: persistedStreak };
    assertValidResolvedLegacyPolicy(snapshot);
    await storage.importLegacy(snapshot, runtime, journal, storedSync);
    return storage;
  } catch (error: unknown) {
    await storage.markLegacyMigrationFailed();
    throw error;
  }
}

async function boot(
  policyStorage: PolicyStorage,
  initialWebsiteCapability: WebsiteReconciliation,
  websiteCapability: () => ContentRegistrationState,
  initialCapabilityIsCurrent: () => boolean,
  publishWebsiteCapability: (capability: ContentRegistrationState) => void,
  pendingWebsiteAccessNotice: PendingWebsiteAccessNotice,
  setupCompleted: () => boolean,
  publishSetupCompleted: (completed: boolean) => void,
): Promise<Engine> {
  const now: number = Date.now();
  await policyStorage.initialize();
  const snapshot: PolicySnapshot = await policyStorage.loadSnapshot();
  const completedAllDataClear: boolean = policyStorage.allDataClearCompleted();
  const [loadedRuntime, initialDeviceId]: [ParsedRuntimeState, string] = completedAllDataClear
    ? [emptyRuntime(now), await getDeviceId()]
    : await Promise.all([loadRuntime(now), getDeviceId()]);
  let deviceId: string = initialDeviceId;
  const setup: SetupState = await policyStorage.loadSetup();
  if (setup.completed) {
    try {
      await chrome.storage.local.remove(LOCAL_ONBOARDING_DRAFT);
    } catch (error: unknown) {
      reportBackgroundError(error);
    }
  }
  const pendingAllDataClear: boolean =
    setup.dataClear.status !== 'idle' && setup.dataClear.scope === 'all';
  publishSetupCompleted(setup.completed && !pendingAllDataClear);
  const runtime: RuntimeState = migrateRuntimeRules(loadedRuntime, snapshot.lists);
  if (!completedAllDataClear && runtime !== loadedRuntime) await saveRuntime(runtime);
  const streak: StreakState = snapshot.streak ?? emptyStreak(localMonthStr(now));
  const ports: EnginePorts = {
    now: (): number => Date.now(),
    newId: (): string => crypto.randomUUID(),
    rehydrateAfterDataClear: async (): Promise<string> => {
      await persistCleanInstallMarker();
      deviceId = await getDeviceId();
      return deviceId;
    },
    saveRuntime,
    saveMatcherCache,
    savePolicy: (key, value): Promise<void> => policyStorage.setPolicy(key, value),
    saveAggregate: (key: string, value: DailyAgg): Promise<void> =>
      policyStorage.saveAggregate(key, value),
    removeAggregate: (key: string): Promise<void> => policyStorage.removeAggregate(key),
    hasPendingSync: (key: string): boolean => policyStorage.hasPendingRemote(key),
    queueSync: (key: string, value: unknown): void => {
      void policyStorage.publishRemoteItem(key, value).catch(reportBackgroundError);
    },
    supersedeSync: (key: string, value: unknown): void => {
      void policyStorage.publishRemoteItem(key, value).catch(reportBackgroundError);
    },
    removeSync: (key: string): void => {
      void policyStorage.removeRemoteItem(key).catch(reportBackgroundError);
    },
    persistSyncJournal: (): Promise<void> => policyStorage.remoteJournalDurable(),
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
      policyStorage.pruneRemoteHistory(deviceId, retentionDays, pruneNow),
    reportError: reportBackgroundError,
    websiteBlockingReady: (): boolean => setupCompleted() && websiteCapability().status === 'ready',
  };
  const engine: Engine = new Engine(
    ports,
    snapshot.settings,
    snapshot.lists,
    snapshot.bank,
    streak,
    runtime,
    deviceId,
  );
  engineInstance = engine;
  let appliedCapability: ContentRegistrationState | null = null;
  try {
    appliedCapability = await applyWebsiteCapability(
      policyStorage,
      engine,
      initialWebsiteCapability.capability,
      'boot',
      pendingWebsiteAccessNotice,
      initialCapabilityIsCurrent,
    );
  } catch (error: unknown) {
    reportBackgroundError(error);
  }
  if (appliedCapability === null || !initialCapabilityIsCurrent()) {
    const failClosedCapability: ContentRegistrationState = websiteCapability();
    await endActiveSessionForWebsiteCapabilityLoss(
      engine,
      failClosedCapability.status === 'ready'
        ? { permission: failClosedCapability.permission, status: 'error' }
        : failClosedCapability,
      'boot',
      pendingWebsiteAccessNotice,
    );
  } else {
    pendingWebsiteAccessNotice.value = null;
    publishWebsiteCapability(appliedCapability);
  }
  if (pendingAllDataClear) {
    await engine.retainDataClearQuiescence();
    return engine;
  }
  if (completedAllDataClear) return engine;
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
  let listChangeApplyQueue: Promise<void> = Promise.resolve();
  let policyStorageReady: Promise<PolicyStorage>;
  let ready: Promise<Engine>;
  let websiteCapability: ContentRegistrationState = {
    permission: 'unknown',
    status: 'unavailable',
  };
  let websiteReconciliationGeneration: number = 0;
  let websiteReconciliationTail: Promise<void> = Promise.resolve();
  let workerControlTail: Promise<void> = Promise.resolve();
  let setupCompleted: boolean = false;
  const pendingWebsiteAccessNotice: PendingWebsiteAccessNotice = { value: null };

  const reconcileWebsiteCapability = (
    cause: WebsiteCapabilityCause,
    applyToEngine: boolean,
    propagateErrors: boolean = false,
  ): Promise<WebsiteReconciliation> => {
    websiteReconciliationGeneration += 1;
    const generation: number = websiteReconciliationGeneration;
    if (cause === 'permission-removed') {
      websiteCapability = { permission: 'denied', status: 'unavailable' };
    } else if (cause === 'permission-added') {
      websiteCapability = {
        permission: websiteCapability.permission,
        status: websiteCapability.permission === 'denied' ? 'unavailable' : 'error',
      };
    }
    const isCurrent: () => boolean = (): boolean => generation === websiteReconciliationGeneration;
    const reconcile: () => Promise<WebsiteReconciliation> =
      async (): Promise<WebsiteReconciliation> => {
        if (cause === 'permission-removed' && applyToEngine) {
          // Permission loss is a fail-closed safety event. A later permission
          // generation may suppress stale setup writes, but never this cleanup.
          const engine: Engine = await ready;
          await endActiveSessionForWebsiteCapabilityLoss(
            engine,
            { permission: 'denied', status: 'unavailable' },
            'permission-removed',
            pendingWebsiteAccessNotice,
          );
        }
        const reconciled: ContentRegistrationState =
          await reconcileContentRegistrationState(reportBackgroundError);
        if (!isCurrent()) return { capability: websiteCapability, generation };
        const candidateCapability: ContentRegistrationState =
          cause === 'permission-removed' && reconciled.permission === 'unknown'
            ? { ...reconciled, permission: 'denied' }
            : reconciled;
        if (!applyToEngine) return { capability: candidateCapability, generation };
        const storage: PolicyStorage = await policyStorageReady;
        if (!isCurrent()) return { capability: websiteCapability, generation };
        const engine: Engine = await ready;
        if (!isCurrent()) return { capability: websiteCapability, generation };
        const appliedCapability: ContentRegistrationState | null = await applyWebsiteCapability(
          storage,
          engine,
          candidateCapability,
          cause,
          pendingWebsiteAccessNotice,
          isCurrent,
        );
        if (!isCurrent() || appliedCapability === null) {
          return { capability: websiteCapability, generation };
        }
        websiteCapability = appliedCapability;
        pendingWebsiteAccessNotice.value = null;
        return { capability: websiteCapability, generation };
      };
    const requested: Promise<WebsiteReconciliation> = websiteReconciliationTail.then(
      reconcile,
      reconcile,
    );
    const settled: Promise<WebsiteReconciliation> = requested.catch(
      (error: unknown): WebsiteReconciliation => {
        reportBackgroundError(error);
        return { capability: websiteCapability, generation };
      },
    );
    websiteReconciliationTail = settled.then((): void => undefined);
    return propagateErrors ? requested : settled;
  };

  const runWorkerControl = <T>(operation: () => Promise<T>): Promise<T> => {
    const requested: Promise<T> = workerControlTail.then(operation, operation);
    workerControlTail = requested.then(
      (): void => undefined,
      (): void => undefined,
    );
    return requested;
  };

  const dismissWebsiteAccessNotice = (): Promise<void> => {
    const dismiss = async (): Promise<void> => {
      const storage: PolicyStorage = await policyStorageReady;
      await storage.updateSetup({ websiteAccessNotice: null });
    };
    const requested: Promise<void> = websiteReconciliationTail.then(dismiss, dismiss);
    websiteReconciliationTail = requested.catch((error: unknown): void => {
      reportBackgroundError(error);
    });
    return requested;
  };

  const reconcileAfterPermissionEvent = (cause: WebsiteCapabilityCause): void => {
    void reconcileWebsiteCapability(cause, true).catch(reportBackgroundError);
  };

  chrome.runtime.onInstalled.addListener((details: chrome.runtime.InstalledDetails): void => {
    void updateInstallMarker(details).catch(reportBackgroundError);
    void chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 }).catch(reportBackgroundError);
  });
  chrome.permissions.onAdded.addListener((permissions: chrome.permissions.Permissions): void => {
    if (isWebsitePermissionEvent(permissions)) reconcileAfterPermissionEvent('permission-added');
  });
  chrome.permissions.onRemoved.addListener((permissions: chrome.permissions.Permissions): void => {
    if (isWebsitePermissionEvent(permissions)) reconcileAfterPermissionEvent('permission-removed');
  });
  policyStorageReady = preparePolicyStorage();
  const initialWebsiteCapability: Promise<WebsiteReconciliation> = reconcileWebsiteCapability(
    'boot',
    false,
  );
  ready = Promise.all([policyStorageReady, initialWebsiteCapability]).then(
    ([storage, initialCapability]: [PolicyStorage, WebsiteReconciliation]): Promise<Engine> =>
      boot(
        storage,
        initialCapability,
        (): ContentRegistrationState => websiteCapability,
        (): boolean => initialCapability.generation === websiteReconciliationGeneration,
        (capability: ContentRegistrationState): void => {
          websiteCapability = capability;
        },
        pendingWebsiteAccessNotice,
        (): boolean => setupCompleted,
        (completed: boolean): void => {
          setupCompleted = completed;
        },
      ),
  );

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
        .then(
          async (engine: Engine): Promise<unknown> =>
            runWorkerControl(
              async (): Promise<unknown> =>
                routeMessage(engine, request, sender, await policyStorageReady, {
                  reconcileWebsiteAccess: async (): Promise<ContentRegistrationState> =>
                    (await reconcileWebsiteCapability('explicit', true, true)).capability,
                  dismissWebsiteAccessNotice,
                  removeOnboardingDraft: async (): Promise<void> => {
                    await chrome.storage.local.remove(LOCAL_ONBOARDING_DRAFT);
                  },
                  reportError: reportBackgroundError,
                  setupCompleted: (completed: boolean): void => {
                    setupCompleted = completed;
                  },
                }),
            ),
        )
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
      const prepared: Promise<{
        pendingRemoteKeys: string[];
        storage: PolicyStorage;
        shouldReconcile: boolean;
        snapshot: Record<string, unknown> | undefined;
      } | null> = policyStorageReady.then(
        async (
          storage: PolicyStorage,
        ): Promise<{
          pendingRemoteKeys: string[];
          storage: PolicyStorage;
          shouldReconcile: boolean;
          snapshot: Record<string, unknown> | undefined;
        } | null> => {
          if (!(await storage.inboundSyncAllowed())) return null;
          const shouldReconcile: boolean = hasListsChange
            ? LIST_SYNC_KEYS.some((key: string): boolean => storage.hasPendingRemote(key))
            : false;
          const eventKeys: string[] = [
            ...Object.keys(changes),
            ...(hasListsChange ? LIST_SYNC_KEYS : []),
          ];
          const pendingRemoteKeys: string[] = [
            ...new Set(eventKeys.filter((key: string): boolean => storage.hasPendingRemote(key))),
          ];
          const snapshot: Record<string, unknown> | undefined = hasListsChange
            ? await chrome.storage.sync.get([...LIST_SYNC_KEYS])
            : undefined;
          return { pendingRemoteKeys, storage, shouldReconcile, snapshot };
        },
      );
      const applyChanges = async (): Promise<void> => {
        const inbound = await prepared;
        if (inbound === null) return;
        const engine: Engine = await ready;
        const { pendingRemoteKeys, storage, shouldReconcile, snapshot } = inbound;
        await handleSyncChanges(
          engine,
          changes,
          {
            consume: (key: string, value: unknown): boolean =>
              storage.consumeRemoteEcho(key, value),
          },
          async (key: string, value: unknown): Promise<void> => {
            if (key === SYNC_LISTS) {
              if (!isListsConfig(value)) throw new Error('invalid corrective lists policy');
              await storage.setPolicy('lists', value);
            } else if (key === SYNC_SETTINGS) {
              if (!isSettings(value)) throw new Error('invalid corrective settings policy');
              await storage.setPolicy('settings', value);
            } else if (key === SYNC_BANK) {
              const bank: BankState | null = parseBank(value);
              if (bank === null) throw new Error('invalid corrective bank policy');
              await storage.setPolicy('bank', bank);
            } else if (key === SYNC_STREAK) {
              const streak: StreakState | null = value === null ? null : parseStreak(value);
              if (value !== null && streak === null) {
                throw new Error('invalid corrective streak policy');
              }
              await storage.setPolicy('streak', streak);
            } else {
              await storage.publishRemoteItem(key, value);
            }
          },
          shouldReconcile,
          snapshot,
          storage,
          undefined,
          pendingRemoteKeys,
        );
      };
      const requested: Promise<void> = listChangeApplyQueue.then(applyChanges);
      listChangeApplyQueue = requested.catch((): void => {});
      void requested.catch(reportBackgroundError);
    },
  );

  chrome.alarms.onAlarm.addListener((): void => {
    void ready.then((engine: Engine): Promise<void> => engine.tick()).catch(reportBackgroundError);
  });

  registerTabListeners((): Promise<Engine> => ready, reportBackgroundError);

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

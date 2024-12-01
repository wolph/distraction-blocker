import { DEFAULT_LISTS, DEFAULT_SETTINGS, EVENT_LOG_CAP } from '../shared/constants';
import {
  LOCAL_DEVICE_ID,
  LOCAL_EVENTS,
  LOCAL_RUNTIME,
  LOCAL_SYNC_JOURNAL,
  SYNC_BANK,
  SYNC_LISTS,
  SYNC_SETTINGS,
  SYNC_STREAK,
} from '../shared/storage-keys';
import { localDateStr } from '../shared/time';
import type {
  BankState,
  DailyAgg,
  EventRecord,
  GateState,
  ListsConfig,
  SessionState,
  Settings,
  SiteUnlock,
  StreakState,
} from '../shared/types';
import type { SyncJournal } from './sync-writer';

/**
 * Background-internal persisted state. Not part of the shared contract:
 * only the worker reads or writes it.
 *
 * todayAgg stays null until the first event of the day folds in. Minting
 * an empty DailyAgg is core's job, so the boot path does not depend on it.
 */
export interface RuntimeState {
  session: SessionState | null;
  gate: GateState | null;
  unlocks: SiteUnlock[];
  tabStates: Record<number, RuntimeTabState>;
  /** focus ms of the current session already credited to the pause bank */
  accruedFocusMs: number;
  /** "tabId:url" -> last attempt timestamp, for the 30 s attempt debounce */
  attemptDebounce: Record<string, number>;
  scheduleActiveEntryId: string | null;
  /** local date todayAgg belongs to, watermark for the midnight rollover */
  date: string;
  todayAgg: DailyAgg | null;
  /** last date the weekly sync prune ran, null before the first run */
  lastPruneDate: string | null;
}

export interface RuntimeTabState {
  muteUrl: string | null;
  priorMuted: boolean | null;
  stoppedDocumentId: string | null;
}

type StoredSettings = Partial<Omit<Settings, 'pause' | 'gate' | 'sounds'>> & {
  pause?: Partial<Settings['pause']>;
  gate?: Partial<Settings['gate']>;
  sounds?: Partial<Settings['sounds']>;
};

type StoredLists = Partial<Omit<ListsConfig, 'categories' | 'exclusions'>> & {
  categories?: Partial<ListsConfig['categories']>;
  exclusions?: ListsConfig['exclusions'];
};

export function emptyRuntime(now: number): RuntimeState {
  return {
    session: null,
    gate: null,
    unlocks: [],
    tabStates: {},
    accruedFocusMs: 0,
    attemptDebounce: {},
    scheduleActiveEntryId: null,
    date: localDateStr(now),
    todayAgg: null,
    lastPruneDate: null,
  };
}

export async function loadSettings(journal?: SyncJournal): Promise<Settings> {
  const raw: unknown = (await chrome.storage.sync.get(SYNC_SETTINGS))[SYNC_SETTINGS];
  return mergeSettings(journalValue(journal, SYNC_SETTINGS, raw) as StoredSettings | undefined);
}

export async function loadLists(journal?: SyncJournal): Promise<ListsConfig> {
  const raw: unknown = (await chrome.storage.sync.get(SYNC_LISTS))[SYNC_LISTS];
  return mergeLists(journalValue(journal, SYNC_LISTS, raw) as StoredLists | undefined);
}

export function mergeSettings(raw: StoredSettings | undefined): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    pause: { ...DEFAULT_SETTINGS.pause, ...raw?.pause },
    gate: { ...DEFAULT_SETTINGS.gate, ...raw?.gate },
    sounds: { ...DEFAULT_SETTINGS.sounds, ...raw?.sounds },
  };
}

export function mergeLists(raw: StoredLists | undefined): ListsConfig {
  return {
    ...DEFAULT_LISTS,
    ...raw,
    categories: { ...DEFAULT_LISTS.categories, ...raw?.categories },
    exclusions: { ...DEFAULT_LISTS.exclusions, ...raw?.exclusions },
  };
}

export async function loadBank(journal?: SyncJournal): Promise<BankState> {
  const raw: unknown = (await chrome.storage.sync.get(SYNC_BANK))[SYNC_BANK];
  return {
    balanceMs: 0,
    ...(journalValue(journal, SYNC_BANK, raw) as Partial<BankState> | undefined),
  };
}

/** Null when no streak has been persisted yet: minting one needs core's emptyStreak. */
export async function loadStreak(journal?: SyncJournal): Promise<StreakState | null> {
  const raw: unknown = (await chrome.storage.sync.get(SYNC_STREAK))[SYNC_STREAK];
  return (journalValue(journal, SYNC_STREAK, raw) as StreakState | undefined) ?? null;
}

export async function loadSyncJournal(): Promise<SyncJournal> {
  const raw: unknown = (await chrome.storage.local.get(LOCAL_SYNC_JOURNAL))[LOCAL_SYNC_JOURNAL];
  if (typeof raw !== 'object' || raw === null) return { sets: {}, removes: [] };
  const candidate: Record<string, unknown> = raw as Record<string, unknown>;
  const sets: Record<string, unknown> =
    typeof candidate.sets === 'object' && candidate.sets !== null
      ? (candidate.sets as Record<string, unknown>)
      : {};
  const removes: string[] = Array.isArray(candidate.removes)
    ? candidate.removes.filter((key: unknown): key is string => typeof key === 'string')
    : [];
  return { sets, removes };
}

export async function saveSyncJournal(journal: SyncJournal): Promise<void> {
  await chrome.storage.local.set({ [LOCAL_SYNC_JOURNAL]: journal });
}

function journalValue(journal: SyncJournal | undefined, key: string, stored: unknown): unknown {
  if (journal === undefined) return stored;
  if (journal.removes.includes(key)) return undefined;
  return Object.hasOwn(journal.sets, key) ? journal.sets[key] : stored;
}

export async function loadRuntime(now: number): Promise<RuntimeState> {
  const raw: unknown = (await chrome.storage.local.get(LOCAL_RUNTIME))[LOCAL_RUNTIME];
  return mergeRuntime(raw, now);
}

export function mergeRuntime(raw: unknown, now: number): RuntimeState {
  if (typeof raw !== 'object' || raw === null) return emptyRuntime(now);
  const stored: Record<string, unknown> = raw as Record<string, unknown>;
  const {
    mutedTabs: _legacyMutedTabs,
    stoppedTabIds: _legacyStoppedTabIds,
    tabStates,
    ...rest
  } = stored;
  return {
    ...emptyRuntime(now),
    ...(rest as Partial<RuntimeState>),
    tabStates: parseTabStates(tabStates),
  };
}

function parseTabStates(value: unknown): Record<number, RuntimeTabState> {
  if (typeof value !== 'object' || value === null) return {};
  const parsed: Record<number, RuntimeTabState> = {};
  for (const [tabIdText, candidate] of Object.entries(value)) {
    const tabId: number = Number(tabIdText);
    if (!Number.isInteger(tabId) || tabId < 0) continue;
    if (typeof candidate !== 'object' || candidate === null) continue;
    const state: Record<string, unknown> = candidate as Record<string, unknown>;
    const priorMuted: boolean | null =
      state.priorMuted === null || typeof state.priorMuted === 'boolean' ? state.priorMuted : null;
    if (state.priorMuted !== null && typeof state.priorMuted !== 'boolean') continue;

    const legacyUrl: string | null =
      typeof state.url === 'string' && state.url !== '' ? state.url : null;
    const muteUrl: string | null =
      priorMuted === null
        ? null
        : typeof state.muteUrl === 'string' && state.muteUrl !== ''
          ? state.muteUrl
          : legacyUrl;
    if (priorMuted !== null && muteUrl === null) continue;

    const stoppedDocumentId: string | null =
      state.stoppedDocumentId === null || state.stoppedDocumentId === undefined
        ? null
        : typeof state.stoppedDocumentId === 'string' && state.stoppedDocumentId !== ''
          ? state.stoppedDocumentId
          : null;
    if (
      state.stoppedDocumentId !== null &&
      state.stoppedDocumentId !== undefined &&
      stoppedDocumentId === null
    ) {
      continue;
    }
    if (muteUrl === null && stoppedDocumentId === null) continue;
    parsed[tabId] = { muteUrl, priorMuted, stoppedDocumentId };
  }
  return parsed;
}

export async function saveRuntime(r: RuntimeState): Promise<void> {
  await chrome.storage.local.set({ [LOCAL_RUNTIME]: r });
}

export async function getDeviceId(): Promise<string> {
  const existing: string | undefined = (await chrome.storage.local.get(LOCAL_DEVICE_ID))[
    LOCAL_DEVICE_ID
  ] as string | undefined;
  if (existing !== undefined) return existing;
  const id: string = crypto.randomUUID();
  await chrome.storage.local.set({ [LOCAL_DEVICE_ID]: id });
  return id;
}

export async function appendEvents(evs: EventRecord[]): Promise<void> {
  if (evs.length === 0) return;
  const log: EventRecord[] = ((await chrome.storage.local.get(LOCAL_EVENTS))[LOCAL_EVENTS] ??
    []) as EventRecord[];
  const next: EventRecord[] = [...log, ...evs].slice(-EVENT_LOG_CAP);
  await chrome.storage.local.set({ [LOCAL_EVENTS]: next });
}

export async function readEvents(): Promise<EventRecord[]> {
  return ((await chrome.storage.local.get(LOCAL_EVENTS))[LOCAL_EVENTS] ?? []) as EventRecord[];
}

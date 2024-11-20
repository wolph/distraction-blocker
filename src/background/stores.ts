import { DEFAULT_LISTS, DEFAULT_SETTINGS, EVENT_LOG_CAP } from '../shared/constants';
import {
  LOCAL_DEVICE_ID,
  LOCAL_EVENTS,
  LOCAL_RUNTIME,
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
  stoppedTabIds: number[];
  /** tabId -> mute state the tab had before the worker muted it */
  mutedTabs: Record<number, boolean>;
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
    stoppedTabIds: [],
    mutedTabs: {},
    accruedFocusMs: 0,
    attemptDebounce: {},
    scheduleActiveEntryId: null,
    date: localDateStr(now),
    todayAgg: null,
    lastPruneDate: null,
  };
}

export async function loadSettings(): Promise<Settings> {
  const raw: unknown = (await chrome.storage.sync.get(SYNC_SETTINGS))[SYNC_SETTINGS];
  return mergeSettings(raw as StoredSettings | undefined);
}

export async function loadLists(): Promise<ListsConfig> {
  const raw: unknown = (await chrome.storage.sync.get(SYNC_LISTS))[SYNC_LISTS];
  return mergeLists(raw as StoredLists | undefined);
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

export async function loadBank(): Promise<BankState> {
  const raw: unknown = (await chrome.storage.sync.get(SYNC_BANK))[SYNC_BANK];
  return { balanceMs: 0, ...(raw as Partial<BankState> | undefined) };
}

/** Null when no streak has been persisted yet: minting one needs core's emptyStreak. */
export async function loadStreak(): Promise<StreakState | null> {
  const raw: unknown = (await chrome.storage.sync.get(SYNC_STREAK))[SYNC_STREAK];
  return (raw as StreakState | undefined) ?? null;
}

export async function loadRuntime(now: number): Promise<RuntimeState> {
  const raw: unknown = (await chrome.storage.local.get(LOCAL_RUNTIME))[LOCAL_RUNTIME];
  return { ...emptyRuntime(now), ...(raw as Partial<RuntimeState> | undefined) };
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

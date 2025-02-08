import { type Dispatch, type StateUpdater, useEffect, useState } from 'preact/hooks';
import { CATEGORY_IDS } from '../shared/constants';
import type { Ack, Broadcast } from '../shared/messages';
import { sendRequest } from '../shared/messages';
import type {
  CategoryId,
  CycleConfig,
  ListsConfig,
  Rule,
  ScheduleEntry,
  SessionSnapshot,
  Settings,
} from '../shared/types';

const LOAD_ERROR: string = 'Could not load settings. Reload the page to try again.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRule(value: unknown): value is Rule {
  return (
    isRecord(value) &&
    (value.kind === 'host' || value.kind === 'regex') &&
    typeof value.pattern === 'string'
  );
}

function isCycleConfig(value: unknown): value is CycleConfig {
  return (
    isRecord(value) &&
    isFiniteNumber(value.focusMin) &&
    isFiniteNumber(value.shortBreakMin) &&
    isFiniteNumber(value.longBreakMin) &&
    isFiniteNumber(value.longEvery)
  );
}

function isScheduleEntry(value: unknown): value is ScheduleEntry {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    Array.isArray(value.days) &&
    value.days.every(isFiniteNumber) &&
    typeof value.start === 'string' &&
    typeof value.end === 'string' &&
    (value.mode === 'blacklist' || value.mode === 'whitelist') &&
    (value.strictness === 'hard' || value.strictness === 'friction') &&
    (value.cycling === null || isCycleConfig(value.cycling)) &&
    typeof value.intention === 'string' &&
    typeof value.enabled === 'boolean'
  );
}

function isSettings(value: unknown): value is Settings {
  if (!isRecord(value)) return false;
  const pause: unknown = value.pause;
  const gate: unknown = value.gate;
  const sounds: unknown = value.sounds;
  return (
    Array.isArray(value.presetsMin) &&
    value.presetsMin.length === 3 &&
    value.presetsMin.every(isFiniteNumber) &&
    (value.defaultMode === 'blacklist' || value.defaultMode === 'whitelist') &&
    (value.defaultStrictness === 'hard' || value.defaultStrictness === 'friction') &&
    isCycleConfig(value.defaultCycling) &&
    typeof value.cyclingOnByDefault === 'boolean' &&
    isRecord(pause) &&
    isFiniteNumber(pause.earnRatio) &&
    isFiniteNumber(pause.capMs) &&
    isFiniteNumber(pause.pauseMs) &&
    isFiniteNumber(pause.unlockMs) &&
    isRecord(gate) &&
    isFiniteNumber(gate.delayMs) &&
    typeof gate.requireTypedPhrase === 'boolean' &&
    typeof value.badgeCountdown === 'boolean' &&
    typeof value.sessionCompleteNotification === 'boolean' &&
    isRecord(sounds) &&
    isFiniteNumber(sounds.masterVolume) &&
    typeof sounds.sessionComplete === 'boolean' &&
    typeof sounds.breakStart === 'boolean' &&
    typeof sounds.breakEnd === 'boolean' &&
    typeof sounds.scheduleStart === 'boolean' &&
    Array.isArray(value.schedule) &&
    value.schedule.every(isScheduleEntry) &&
    isFiniteNumber(value.streakGoalMin) &&
    isPositiveInteger(value.streakFreezeIntervalDays) &&
    isFiniteNumber(value.retentionDays)
  );
}

function isListsConfig(value: unknown): value is ListsConfig {
  if (!isRecord(value)) return false;
  const categories: unknown = value.categories;
  const exclusions: unknown = value.exclusions;
  if (!isRecord(categories) || !isRecord(exclusions)) return false;
  return (
    Array.isArray(value.custom) &&
    value.custom.every(isRule) &&
    Array.isArray(value.whitelist) &&
    value.whitelist.every(isRule) &&
    CATEGORY_IDS.every((id: CategoryId): boolean => typeof categories[id] === 'boolean') &&
    CATEGORY_IDS.every((id: CategoryId): boolean => {
      const excluded: unknown = exclusions[id];
      return (
        excluded === undefined ||
        (Array.isArray(excluded) &&
          excluded.every((host: unknown): host is string => typeof host === 'string'))
      );
    })
  );
}

export interface SettingsStore {
  /** null until the initial load resolves */
  settings: Settings | null;
  lists: ListsConfig | null;
  snapshot: SessionSnapshot | null;
  loadError: string | null;
  /** resolves null on success, the worker's rejection string verbatim otherwise */
  saveSettings(next: Settings): Promise<string | null>;
  saveLists(next: ListsConfig): Promise<string | null>;
}

/**
 * Loads settings, lists, and the session snapshot once, keeps the snapshot
 * live via the stateChanged broadcast, and exposes save calls that only
 * update the store after the worker accepts the write.
 */
export function useSettingsStore(): SettingsStore {
  const [settings, setSettings]: [Settings | null, Dispatch<StateUpdater<Settings | null>>] =
    useState<Settings | null>(null);
  const [lists, setLists]: [ListsConfig | null, Dispatch<StateUpdater<ListsConfig | null>>] =
    useState<ListsConfig | null>(null);
  const [snapshot, setSnapshot]: [
    SessionSnapshot | null,
    Dispatch<StateUpdater<SessionSnapshot | null>>,
  ] = useState<SessionSnapshot | null>(null);
  const [loadError, setLoadError]: [string | null, Dispatch<StateUpdater<string | null>>] =
    useState<string | null>(null);

  useEffect((): (() => void) => {
    let alive: boolean = true;
    const load: () => Promise<void> = async (): Promise<void> => {
      try {
        const [loadedSettings, loadedLists, loadedSnapshot]: [unknown, unknown, SessionSnapshot] =
          await Promise.all([
            sendRequest({ type: 'getSettings' }),
            sendRequest({ type: 'getLists' }),
            sendRequest({ type: 'getSnapshot' }),
          ]);
        if (!alive) return;
        if (!isSettings(loadedSettings) || !isListsConfig(loadedLists)) {
          setLoadError(LOAD_ERROR);
          return;
        }
        setSettings(loadedSettings);
        setLists(loadedLists);
        setSnapshot(loadedSnapshot);
        setLoadError(null);
      } catch {
        if (alive) setLoadError(LOAD_ERROR);
      }
    };
    void load();
    const onBroadcast: (message: Broadcast) => void = (message: Broadcast): void => {
      if (message.type === 'stateChanged') setSnapshot(message.snapshot);
    };
    chrome.runtime.onMessage.addListener(onBroadcast);
    return (): void => {
      alive = false;
      chrome.runtime.onMessage.removeListener(onBroadcast);
    };
  }, []);

  const saveSettings: (next: Settings) => Promise<string | null> = async (
    next: Settings,
  ): Promise<string | null> => {
    const ack: Ack = await sendRequest({ type: 'updateSettings', settings: next });
    if (!ack.ok) return ack.error;
    setSettings(next);
    return null;
  };

  const saveLists: (next: ListsConfig) => Promise<string | null> = async (
    next: ListsConfig,
  ): Promise<string | null> => {
    const ack: Ack = await sendRequest({ type: 'updateLists', lists: next });
    if (!ack.ok) return ack.error;
    setLists(next);
    return null;
  };

  return { settings, lists, snapshot, loadError, saveSettings, saveLists };
}

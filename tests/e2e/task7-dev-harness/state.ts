import {
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  DEFAULT_SETUP,
  emptySnapshot,
  rulesFromLists,
} from '../../../src/shared/constants';
import type { StatsBundle } from '../../../src/shared/messages';
import type { SessionSnapshot, ThemeMode } from '../../../src/shared/types';

type Listener = (message: unknown) => void;

function requestedTheme(): ThemeMode {
  const theme: string = new URLSearchParams(location.search).get('theme') ?? 'auto';
  return theme === 'light' || theme === 'dark' ? theme : 'auto';
}

function dateFor(now: number, daysAgo: number): string {
  const date: Date = new Date(now);
  date.setDate(date.getDate() - daysAgo);
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function currentStats(now: number): StatsBundle {
  return {
    days: [
      {
        attempts: { 'archive.example.net': 2 },
        attemptsOther: 0,
        date: dateFor(now, 13),
        focusMs: 18 * 60_000,
        pauseMsEarned: 4 * 60_000,
        pauseMsSpent: 0,
        pausesTaken: 0,
        resisted: 1,
        sessionsCompleted: 1,
        sessionsStarted: 1,
        unlockMsSpent: 0,
        unlocksTaken: 0,
      },
      {
        attempts: { 'blocked.example': 7, 'research.example.org': 3 },
        attemptsOther: 1,
        date: dateFor(now, 1),
        focusMs: 42 * 60_000,
        pauseMsEarned: 8 * 60_000,
        pauseMsSpent: 2 * 60_000,
        pausesTaken: 1,
        resisted: 2,
        sessionsCompleted: 1,
        sessionsStarted: 1,
        unlockMsSpent: 60_000,
        unlocksTaken: 1,
      },
    ],
    months: [],
    recentSessions: [
      {
        at: now - 20 * 60_000,
        focusedMs: 25 * 60_000,
        sessionId: 'task7-dev-stats',
        t: 'sessionCompleted',
      },
      {
        at: now - 45 * 60_000,
        durationMin: 25,
        intention: 'Review example.com release notes',
        mode: 'blacklist',
        sessionId: 'task7-dev-stats',
        source: 'manual',
        strictness: 'friction',
        t: 'sessionStarted',
      },
    ],
    streak: {
      activeDays: [1, 2],
      activeMonth: dateFor(now, 1).slice(0, 7),
      current: 2,
      freezeTokens: 1,
      lastCountedDate: dateFor(now, 1),
      lastFreezeGrantDate: null,
    },
    totals: {
      attemptsToday: 0,
      focusMsLast7Days: 42 * 60_000,
      focusMsToday: 0,
      resistedToday: 0,
    },
  };
}

function currentSnapshot(now: number, theme: ThemeMode): SessionSnapshot {
  const state: string = new URLSearchParams(location.search).get('state') ?? 'typed-gate';
  if (state === 'idle') return { ...emptySnapshot(now), theme };
  const requiredPhrase: string | null =
    state === 'typed-gate' ? 'I am ending this session before: Task 7 development QA' : null;
  return {
    ...emptySnapshot(now),
    at: now,
    attemptsToday: 1,
    bankAccrualPerMs: 5 / 30,
    config: {
      cycling: null,
      durationMin: 25,
      intention: 'Task 7 development QA',
      mode: 'blacklist',
      rules: rulesFromLists(DEFAULT_LISTS),
      scheduleEntryId: null,
      source: 'manual',
      strictness: 'friction',
    },
    gate:
      state === 'unsupported'
        ? null
        : {
            host: null,
            kind: 'cancel',
            openedAt: now,
            readyAt: now + 30_000,
            requiredPhrase,
          },
    phase: 'focus',
    phaseEndsAt: now + 24 * 60_000,
    phaseStartedAt: now - 60_000,
    sessionEndsAt: now + 24 * 60_000,
    startedAt: now - 60_000,
    theme,
  };
}

const now: number = Date.now();
let theme: ThemeMode = requestedTheme();
let snapshot: SessionSnapshot = currentSnapshot(now, theme);
const settings = { ...DEFAULT_SETTINGS, theme };
let lists = {
  ...DEFAULT_LISTS,
  categories: Object.fromEntries(
    Object.keys(DEFAULT_LISTS.categories).map((id: string): [string, boolean] => [id, true]),
  ) as typeof DEFAULT_LISTS.categories,
  custom: Array.from({ length: 18 }, (_unused: unknown, index: number) => ({
    kind: 'host' as const,
    pattern: `blocked-${String(index).padStart(2, '0')}.example`,
  })),
  whitelist: Array.from({ length: 18 }, (_unused: unknown, index: number) => ({
    kind: 'host' as const,
    pattern: `allowed-${String(index).padStart(2, '0')}.example.org`,
  })),
};
const setup = {
  ...DEFAULT_SETUP,
  blockingRegistration: 'ready' as const,
  completed: true,
  storageMode: 'local' as const,
  websiteAccess: 'granted' as const,
};
const stats: StatsBundle = currentStats(now);
const listeners: Set<Listener> = new Set<Listener>();

globalThis.chrome = {
  runtime: {
    getURL: (value: string): string => value,
    id: 'focus-lock-task7-source-harness',
    onMessage: {
      addListener: (listener: Listener): void => {
        listeners.add(listener);
      },
      removeListener: (listener: Listener): void => {
        listeners.delete(listener);
      },
    },
    openOptionsPage: async (): Promise<void> => undefined,
    sendMessage: async (request: { theme?: ThemeMode; type?: string }): Promise<unknown> => {
      if (request.type === 'getSettings') return structuredClone(settings);
      if (request.type === 'getLists') return structuredClone(lists);
      if (request.type === 'getSnapshot') return structuredClone(snapshot);
      if (request.type === 'getSetupState') return structuredClone(setup);
      if (request.type === 'getStats') return structuredClone(stats);
      if (request.type === 'exportEvents') {
        return {
          json: JSON.stringify([
            {
              at: now - 10 * 60_000,
              domain: 'blocked.example',
              t: 'attempt',
            },
          ]),
        };
      }
      if (request.type === 'updateTheme' && request.theme !== undefined) {
        theme = request.theme;
        settings.theme = theme;
        snapshot = { ...snapshot, theme };
        for (const listener of listeners) {
          listener({ snapshot: structuredClone(snapshot), type: 'stateChanged' });
        }
        return { ok: true };
      }
      if (request.type === 'updateLists' && 'lists' in request) {
        lists = structuredClone(request.lists as typeof lists);
        return { ok: true };
      }
      return { ok: true };
    },
  },
  storage: { local: { get: async (): Promise<unknown> => ({ deviceId: 'task7-dev-device' }) } },
  tabs: {
    create: async (): Promise<unknown> => ({ id: 1 }),
    query: async (): Promise<unknown> => [
      {
        id: 1,
        url:
          new URLSearchParams(location.search).get('state') === 'unsupported'
            ? 'chrome://extensions'
            : 'https://blocked.example/research',
      },
    ],
  },
} as unknown as typeof chrome;

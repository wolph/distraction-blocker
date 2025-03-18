import type { CategoryId, ListsConfig, SessionSnapshot, Settings } from './types';

export const CATEGORY_IDS: readonly CategoryId[] = [
  'social',
  'video',
  'news',
  'mail',
  'shopping',
  'gaming',
  'forums',
];

export const DEFAULT_SETTINGS: Settings = {
  theme: 'auto',
  presetsMin: [15, 25, 50],
  defaultMode: 'blacklist',
  defaultStrictness: 'friction',
  defaultCycling: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 },
  cyclingOnByDefault: true,
  pause: {
    earnRatio: 5 / 30,
    capMs: 30 * 60_000,
    pauseMs: 5 * 60_000,
    unlockMs: 5 * 60_000,
  },
  gate: { delayMs: 10_000, requireTypedPhrase: false },
  badgeCountdown: true,
  sessionCompleteNotification: true,
  sounds: {
    masterVolume: 0.6,
    sessionComplete: true,
    breakStart: true,
    breakEnd: true,
    scheduleStart: true,
  },
  schedule: [],
  streakGoalMin: 25,
  streakFreezeIntervalDays: 7,
  retentionDays: 90,
};

export const DEFAULT_LISTS: ListsConfig = {
  custom: [],
  whitelist: [],
  categories: {
    social: false,
    video: false,
    news: false,
    mail: false,
    shopping: false,
    gaming: false,
    forums: false,
  },
  exclusions: {},
};

export const ALWAYS_ALLOW_SCHEMES: readonly string[] = [
  'chrome:',
  'chrome-extension:',
  'about:',
  'edge:',
  'devtools:',
  'file:',
];

export const ALWAYS_ALLOW_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

export const ALWAYS_ALLOW_HOST_SUFFIXES: readonly string[] = ['.localhost', '.local', '.test'];

export const GATE_EXPIRY_MS: number = 60_000;
export const MIN_BREAK_BEFORE_EARLY_MS: number = 2 * 60_000;
export const ATTEMPT_DEBOUNCE_MS: number = 30_000;
export const EVENT_LOG_CAP: number = 50_000;
export const TOP_SITES_DAILY: number = 20;
export const TOP_SITES_MONTHLY: number = 10;
export const MAX_FREEZE_TOKENS: number = 2;

export function cancelPhrase(intention: string): string {
  const goal: string = intention.trim() === '' ? 'my focus session' : intention.trim();
  return `I choose distraction over: ${goal}`;
}

export function emptySnapshot(at: number): SessionSnapshot {
  return {
    at,
    theme: DEFAULT_SETTINGS.theme,
    phase: 'idle',
    config: null,
    startedAt: null,
    phaseStartedAt: null,
    phaseEndsAt: null,
    sessionEndsAt: null,
    cycleIndex: 0,
    bankMs: 0,
    bankAccrualPerMs: 0,
    bankCapMs: DEFAULT_SETTINGS.pause.capMs,
    pauseCostMs: DEFAULT_SETTINGS.pause.pauseMs,
    unlockCostMs: DEFAULT_SETTINGS.pause.unlockMs,
    activeUnlocks: [],
    gate: null,
    attemptsToday: 0,
    scheduleActive: false,
    nextSchedule: null,
  };
}

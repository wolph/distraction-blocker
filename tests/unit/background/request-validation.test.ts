import { describe, expect, it } from 'vitest';
import { LISTS_SPLIT_THRESHOLD_BYTES } from '../../../src/background/list-sync-codec';
import { parseRequest } from '../../../src/background/request-validation';
import { syncItemBytes } from '../../../src/background/sync-quota';
import { CATEGORY_IDS, DEFAULT_LISTS, DEFAULT_SETTINGS } from '../../../src/shared/constants';
import type { Request } from '../../../src/shared/messages';
import { SYNC_LISTS } from '../../../src/shared/storage-keys';
import type { ListsConfig, SessionConfig, Settings } from '../../../src/shared/types';

type RequestByType = {
  [Type in Request['type']]: Extract<Request, { type: Type }>;
};

const SESSION_CONFIG: SessionConfig = {
  mode: 'blacklist',
  strictness: 'friction',
  durationMin: 25,
  cycling: {
    focusMin: 25,
    shortBreakMin: 5,
    longBreakMin: 15,
    longEvery: 4,
  },
  intention: 'Ship the parser',
  source: 'manual',
  scheduleEntryId: null,
};

const SETTINGS: Settings = structuredClone(DEFAULT_SETTINGS);
const LISTS: ListsConfig = structuredClone(DEFAULT_LISTS);
const DAY_MS: number = 86_400_000;
const DATE_MAX_MS: number = 8_640_000_000_000_000;
const MINUTE_MS: number = 60_000;
const MAX_RELATIVE_DURATION_MS: number = DATE_MAX_MS / 2;

const VALID_REQUESTS: RequestByType = {
  getSnapshot: { type: 'getSnapshot' },
  getWorkTabIcon: { type: 'getWorkTabIcon', sessionId: 'session', tabId: 1 },
  getWorkTabs: { type: 'getWorkTabs', mode: 'blacklist', windowId: 1 },
  getWorkTarget: { type: 'getWorkTarget' },
  setWorkTarget: { type: 'setWorkTarget', sessionId: 'session', tabId: 1, windowId: 1 },
  returnToWork: { type: 'returnToWork', sessionId: 'session' },
  getBlockState: {
    type: 'getBlockState',
    url: 'https://news.example/story',
    docState: 'fresh',
  },
  startSession: { type: 'startSession', config: SESSION_CONFIG },
  openGate: { type: 'openGate', gate: 'unlockSite', host: 'news.example' },
  confirmGate: { type: 'confirmGate', typedPhrase: null },
  forceEndGate: { type: 'forceEndGate' },
  abandonGate: { type: 'abandonGate' },
  resumeFromPause: { type: 'resumeFromPause' },
  startNextFocusEarly: { type: 'startNextFocusEarly' },
  updateSettings: { type: 'updateSettings', settings: SETTINGS },
  updateTheme: { type: 'updateTheme', theme: 'auto' },
  updateLists: { type: 'updateLists', lists: LISTS },
  getSettings: { type: 'getSettings' },
  getLists: { type: 'getLists' },
  getStats: { type: 'getStats', days: 30 },
  exportEvents: { type: 'exportEvents' },
  previewSound: { type: 'previewSound', sound: 'breakStart' },
};

function replaceNested(
  request: Record<string, unknown>,
  key: string,
  update: Record<string, unknown>,
): Record<string, unknown> {
  const nested: unknown = request[key];
  if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) {
    throw new TypeError(`${key} is not a record`);
  }
  return { ...request, [key]: { ...nested, ...update } };
}

describe('parseRequest', (): void => {
  it.each(['auto', 'light', 'dark'])('accepts the %s theme mode', (theme: string): void => {
    expect(parseRequest({ type: 'updateTheme', theme })).toEqual({
      type: 'updateTheme',
      theme,
    });
  });

  it('rejects an unknown theme mode', (): void => {
    expect(parseRequest({ type: 'updateTheme', theme: 'sepia' })).toBeNull();
  });

  it('accepts lists above the unsplit threshold when category sharding fits', (): void => {
    const exclusions: ListsConfig['exclusions'] = {};
    for (const categoryId of CATEGORY_IDS) {
      exclusions[categoryId] = Array.from(
        { length: 60 },
        (_value: unknown, index: number): string => `${categoryId}-${index}.example`,
      );
    }
    const lists: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, social: true },
      exclusions,
    };

    expect(syncItemBytes(SYNC_LISTS, lists)).toBeGreaterThan(LISTS_SPLIT_THRESHOLD_BYTES);
    expect(parseRequest({ type: 'updateLists', lists })).toEqual({ type: 'updateLists', lists });
  });

  it.each(Object.entries(VALID_REQUESTS))(
    'accepts the %s request',
    (_type: string, request: Request): void => {
      expect(parseRequest(request)).toEqual(request);
    },
  );

  it.each([null, undefined, true, 1, 'getSnapshot', [], { type: 'unknown' }, {}])(
    'rejects a non-request root value %#',
    (value: unknown): void => {
      expect(parseRequest(value)).toBeNull();
    },
  );

  it.each(Object.values(VALID_REQUESTS))(
    'rejects extra top-level fields from $type',
    (request: Request): void => {
      expect(parseRequest({ ...request, extra: true })).toBeNull();
    },
  );

  it.each([
    { type: 'getBlockState', url: '', docState: 'fresh' },
    { type: 'getBlockState', url: 'not a URL', docState: 'fresh' },
    { type: 'getBlockState', url: 'https://example.com', docState: 'stale' },
    { type: 'getBlockState', url: 'https://example.com' },
    { type: 'getStats', days: 0 },
    { type: 'getStats', days: -1 },
    { type: 'getStats', days: 1.5 },
    { type: 'getStats', days: Number.NaN },
    { type: 'getStats', days: Number.POSITIVE_INFINITY },
    { type: 'previewSound', sound: 'other' },
    { type: 'confirmGate', typedPhrase: 1 },
  ])('rejects malformed scalar payloads %#', (request: unknown): void => {
    expect(parseRequest(request)).toBeNull();
  });

  it.each([
    { type: 'openGate', gate: 'unlockSite', host: null },
    { type: 'openGate', gate: 'unlockSite', host: '' },
    { type: 'openGate', gate: 'unlockSite', host: 'not a host' },
    { type: 'openGate', gate: 'pause', host: 'example.com' },
    { type: 'openGate', gate: 'cancel', host: 'example.com' },
    { type: 'openGate', gate: 'pause', host: undefined },
    { type: 'openGate', gate: 'other', host: null },
  ])('rejects malformed gate and host combinations %#', (request: unknown): void => {
    expect(parseRequest(request)).toBeNull();
  });

  it('accepts null hosts for gates that do not target a site', (): void => {
    expect(parseRequest({ type: 'openGate', gate: 'pause', host: null })).not.toBeNull();
    expect(parseRequest({ type: 'openGate', gate: 'cancel', host: null })).not.toBeNull();
  });

  it.each(['localhost', 'intranet', '[::1]', '[2001:db8::1]'])(
    'accepts the browser hostname %s for a site unlock',
    (host: string): void => {
      expect(parseRequest({ type: 'openGate', gate: 'unlockSite', host })).toEqual({
        type: 'openGate',
        gate: 'unlockSite',
        host,
      });
    },
  );

  it.each([
    'example.com:443',
    'example.com/path',
    ' example.com',
    'example.com ',
    'example .com',
    '[::1',
    '::1',
  ])('rejects the non-hostname site unlock value %s', (host: string): void => {
    expect(parseRequest({ type: 'openGate', gate: 'unlockSite', host })).toBeNull();
  });

  it.each([
    replaceNested(VALID_REQUESTS.startSession, 'config', { mode: 'other' }),
    replaceNested(VALID_REQUESTS.startSession, 'config', { strictness: 'other' }),
    replaceNested(VALID_REQUESTS.startSession, 'config', { durationMin: -1 }),
    replaceNested(VALID_REQUESTS.startSession, 'config', { durationMin: Number.NaN }),
    replaceNested(VALID_REQUESTS.startSession, 'config', { durationMin: Number.POSITIVE_INFINITY }),
    replaceNested(VALID_REQUESTS.startSession, 'config', {
      source: 'manual',
      scheduleEntryId: 'entry',
    }),
    replaceNested(VALID_REQUESTS.startSession, 'config', {
      source: 'schedule',
      scheduleEntryId: null,
    }),
    replaceNested(VALID_REQUESTS.startSession, 'config', {
      source: 'schedule',
      scheduleEntryId: '   ',
    }),
    replaceNested(VALID_REQUESTS.startSession, 'config', { cycling: [] }),
    replaceNested(VALID_REQUESTS.startSession, 'config', { extra: true }),
  ])('rejects malformed session configurations %#', (request: unknown): void => {
    expect(parseRequest(request)).toBeNull();
  });

  it('accepts a scheduled session with a nonblank entry ID', (): void => {
    const config: SessionConfig = {
      ...SESSION_CONFIG,
      source: 'schedule',
      scheduleEntryId: 'weekday-morning',
    };
    expect(parseRequest({ type: 'startSession', config })).toEqual({
      type: 'startSession',
      config,
    });
  });

  it.each([
    { focusMin: -1 },
    { shortBreakMin: Number.NaN },
    { longBreakMin: Number.POSITIVE_INFINITY },
    { longEvery: 0 },
    { longEvery: 1.5 },
    { extra: true },
  ])('rejects malformed cycle configuration fields %#', (update: Record<string, unknown>): void => {
    const cycling: Record<string, unknown> = {
      ...(SESSION_CONFIG.cycling as NonNullable<SessionConfig['cycling']>),
      ...update,
    };
    const request: Record<string, unknown> = replaceNested(VALID_REQUESTS.startSession, 'config', {
      cycling,
    });
    expect(parseRequest(request)).toBeNull();
  });

  it('accepts positive fractional cycle durations', (): void => {
    const config: SessionConfig = {
      ...SESSION_CONFIG,
      cycling: {
        focusMin: 0.25,
        shortBreakMin: 0.05,
        longBreakMin: 1.25,
        longEvery: 4,
      },
    };

    expect(parseRequest({ type: 'startSession', config })).toEqual({
      type: 'startSession',
      config,
    });
  });

  it('accepts editable freeze cadence and completion-notification settings', (): void => {
    const settings: Record<string, unknown> = {
      ...SETTINGS,
      streakFreezeIntervalDays: 7,
      sessionCompleteNotification: false,
    };

    expect(parseSettingsRequest(settings)).not.toBeNull();
  });

  it.each([
    { presetsMin: [15, 25] },
    { presetsMin: [15, -1, 50] },
    { defaultMode: 'other' },
    { defaultStrictness: 'other' },
    { defaultCycling: { ...SETTINGS.defaultCycling, longEvery: 1.5 } },
    { cyclingOnByDefault: 'yes' },
    { pause: { ...SETTINGS.pause, capMs: -1 } },
    { pause: { ...SETTINGS.pause, earnRatio: Number.NaN } },
    { pause: { ...SETTINGS.pause, extra: true } },
    { gate: { ...SETTINGS.gate, delayMs: 1.5 } },
    { gate: { ...SETTINGS.gate, allowForceEnd: 'yes' } },
    { gate: { ...SETTINGS.gate, extra: true } },
    { badgeCountdown: 1 },
    { sounds: { ...SETTINGS.sounds, masterVolume: 1.1 } },
    { sounds: { ...SETTINGS.sounds, extra: true } },
    { schedule: [{}] },
    { streakGoalMin: -1 },
    { streakFreezeIntervalDays: 0 },
    { streakFreezeIntervalDays: 1.5 },
    { sessionCompleteNotification: 'yes' },
    { retentionDays: 1.5 },
    { extra: true },
  ])('rejects malformed settings payload fields %#', (update: Record<string, unknown>): void => {
    expect(
      parseRequest({
        type: 'updateSettings',
        settings: { ...SETTINGS, ...update },
      }),
    ).toBeNull();
  });

  it('accepts the force-end gate request without payload fields', (): void => {
    expect(parseRequest({ type: 'forceEndGate' })).toEqual({ type: 'forceEndGate' });
    expect(parseRequest({ type: 'forceEndGate', extra: true })).toBeNull();
  });

  it.each([
    { id: ' ' },
    { days: [] },
    { days: [7] },
    { days: [1.5] },
    { start: '9:00' },
    { end: '24:00' },
    { mode: 'other' },
    { strictness: 'other' },
    { cycling: { ...SETTINGS.defaultCycling, longEvery: 0 } },
    { intention: null },
    { enabled: 1 },
    { extra: true },
  ])('rejects malformed schedule entries %#', (update: Record<string, unknown>): void => {
    const scheduleEntry: Record<string, unknown> = {
      id: 'weekday',
      days: [1, 2, 3, 4, 5],
      start: '09:00',
      end: '17:00',
      mode: 'blacklist',
      strictness: 'hard',
      cycling: null,
      intention: '',
      enabled: true,
      ...update,
    };
    expect(
      parseRequest({
        type: 'updateSettings',
        settings: { ...SETTINGS, schedule: [scheduleEntry] },
      }),
    ).toBeNull();
  });

  it('rejects overnight schedules while schedules use same-day semantics', (): void => {
    const scheduleEntry: Record<string, unknown> = {
      id: 'overnight',
      days: [1],
      start: '22:00',
      end: '06:00',
      mode: 'blacklist',
      strictness: 'hard',
      cycling: null,
      intention: '',
      enabled: true,
    };
    expect(
      parseRequest({
        type: 'updateSettings',
        settings: { ...SETTINGS, schedule: [scheduleEntry] },
      }),
    ).toBeNull();
  });

  it('rejects duplicate schedule IDs', (): void => {
    const first: Record<string, unknown> = scheduleEntry({ id: 'duplicate', start: '09:00' });
    const second: Record<string, unknown> = scheduleEntry({ id: 'duplicate', start: '13:00' });
    expect(parseSettingsRequest({ schedule: [first, second] })).toBeNull();
  });

  it('rejects duplicate days within one schedule entry', (): void => {
    expect(parseSettingsRequest({ schedule: [scheduleEntry({ days: [1, 1] })] })).toBeNull();
  });

  it('rejects overlapping enabled schedule entries on a shared day', (): void => {
    const first: Record<string, unknown> = scheduleEntry({
      id: 'first',
      days: [1, 2],
      start: '09:00',
      end: '12:00',
    });
    const second: Record<string, unknown> = scheduleEntry({
      id: 'second',
      days: [2, 3],
      start: '11:00',
      end: '13:00',
    });
    expect(parseSettingsRequest({ schedule: [first, second] })).toBeNull();
  });

  it('accepts adjacent, disabled, and disjoint-day schedule windows', (): void => {
    const base: Record<string, unknown> = scheduleEntry({
      id: 'base',
      days: [1],
      start: '09:00',
      end: '12:00',
    });
    const adjacent: Record<string, unknown> = scheduleEntry({
      id: 'adjacent',
      days: [1],
      start: '12:00',
      end: '13:00',
    });
    const disabled: Record<string, unknown> = scheduleEntry({
      id: 'disabled',
      days: [1],
      start: '10:00',
      end: '11:00',
      enabled: false,
    });
    const disjoint: Record<string, unknown> = scheduleEntry({
      id: 'disjoint',
      days: [2],
      start: '10:00',
      end: '11:00',
    });
    expect(parseSettingsRequest({ schedule: [base, adjacent, disabled, disjoint] })).not.toBeNull();
  });

  it.each([
    ['rules', { custom: sparseArray(1) }],
    ['presets', { presetsMin: sparseArray(3, { 0: 15, 2: 50 }) }],
    ['schedule', { schedule: sparseArray(1) }],
    ['schedule days', { schedule: [scheduleEntry({ days: sparseArray(2, { 0: 1 }) })] }],
  ])('rejects sparse %s arrays', (_label: string, update: Record<string, unknown>): void => {
    expect(parseSettingsOrListsRequest(update)).toBeNull();
  });

  it('rejects sparse exclusion host arrays', (): void => {
    expect(
      parseRequest({
        type: 'updateLists',
        lists: { ...LISTS, exclusions: { social: sparseArray(1) } },
      }),
    ).toBeNull();
  });

  it('rejects oversized settings before quadratic schedule overlap validation', (): void => {
    let enabledReads: number = 0;
    const entryCount: number = 120;
    const schedule: Record<string, unknown>[] = Array.from(
      { length: entryCount },
      (_value: unknown, index: number): Record<string, unknown> => {
        const entry: Record<string, unknown> = scheduleEntry({
          id: `oversized-${index}`,
          intention: 'x'.repeat(100),
        });
        Object.defineProperty(entry, 'enabled', {
          configurable: true,
          enumerable: true,
          get: (): boolean => {
            enabledReads += 1;
            return false;
          },
        });
        return entry;
      },
    );

    expect(parseSettingsRequest({ schedule })).toBeNull();
    expect(enabledReads).toBe(entryCount);
  });

  it('rejects oversized lists before compiling every custom rule', (): void => {
    let patternReads: number = 0;
    const ruleCount: number = 30;
    const custom: Record<string, unknown>[] = Array.from(
      { length: ruleCount },
      (): Record<string, unknown> => {
        const rule: Record<string, unknown> = { kind: 'regex' };
        Object.defineProperty(rule, 'pattern', {
          configurable: true,
          enumerable: true,
          get: (): string => {
            patternReads += 1;
            return 'a'.repeat(400);
          },
        });
        return rule;
      },
    );

    expect(
      parseRequest({
        type: 'updateLists',
        lists: { ...LISTS, custom },
      }),
    ).toBeNull();
    expect(patternReads).toBe(ruleCount);
  });

  it('rejects list items oversized only after Chromium escaping', (): void => {
    expect(
      parseRequest({
        type: 'updateLists',
        lists: {
          ...LISTS,
          custom: [{ kind: 'regex', pattern: '<\u2028\u2029'.repeat(500) }],
        },
      }),
    ).toBeNull();
  });

  it.each([
    [
      'zero session duration',
      replaceNested(VALID_REQUESTS.startSession, 'config', { durationMin: 0 }),
    ],
    [
      'sub-millisecond session duration',
      replaceNested(VALID_REQUESTS.startSession, 'config', { durationMin: 0.000_001 }),
    ],
    [
      'unsafe session duration',
      replaceNested(VALID_REQUESTS.startSession, 'config', {
        durationMin: Number.MAX_SAFE_INTEGER,
      }),
    ],
    [
      'zero focus cycle',
      replaceNested(VALID_REQUESTS.startSession, 'config', {
        cycling: { ...SESSION_CONFIG.cycling, focusMin: 0 },
      }),
    ],
    [
      'zero short break cycle',
      replaceNested(VALID_REQUESTS.startSession, 'config', {
        cycling: { ...SESSION_CONFIG.cycling, shortBreakMin: 0 },
      }),
    ],
    [
      'zero long break cycle',
      replaceNested(VALID_REQUESTS.startSession, 'config', {
        cycling: { ...SESSION_CONFIG.cycling, longBreakMin: 0 },
      }),
    ],
    [
      'unsafe cycle count',
      replaceNested(VALID_REQUESTS.startSession, 'config', {
        cycling: { ...SESSION_CONFIG.cycling, longEvery: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ],
  ])('rejects %s', (_label: string, request: unknown): void => {
    expect(parseRequest(request)).toBeNull();
  });

  it.each([
    ['zero preset', { presetsMin: [0, 25, 50] }],
    ['unsafe preset', { presetsMin: [15, Number.MAX_SAFE_INTEGER, 50] }],
    ['zero streak goal', { streakGoalMin: 0 }],
    ['unsafe streak goal', { streakGoalMin: Number.MAX_SAFE_INTEGER }],
    ['unsafe pause cap', { pause: { ...SETTINGS.pause, capMs: Number.MAX_SAFE_INTEGER + 1 } }],
    ['unsafe pause length', { pause: { ...SETTINGS.pause, pauseMs: Number.MAX_SAFE_INTEGER + 1 } }],
    [
      'unsafe unlock length',
      { pause: { ...SETTINGS.pause, unlockMs: Number.MAX_SAFE_INTEGER + 1 } },
    ],
    ['unsafe gate delay', { gate: { ...SETTINGS.gate, delayMs: Number.MAX_SAFE_INTEGER + 1 } }],
    ['unsafe freeze cadence', { streakFreezeIntervalDays: Number.MAX_SAFE_INTEGER }],
    [
      'unsafe retention date range',
      { retentionDays: Math.floor(Number.MAX_SAFE_INTEGER / DAY_MS) + 1 },
    ],
  ])('rejects %s', (_label: string, update: Record<string, unknown>): void => {
    expect(parseSettingsRequest(update)).toBeNull();
  });

  it('rejects a stats range whose date-day multiplication is unsafe', (): void => {
    const days: number = Math.floor(Number.MAX_SAFE_INTEGER / DAY_MS) + 1;
    expect(parseRequest({ type: 'getStats', days })).toBeNull();
  });

  it('rejects day counts beyond the JavaScript Date range', (): void => {
    const days: number = Math.floor(DATE_MAX_MS / DAY_MS) + 1;
    expect(parseRequest({ type: 'getStats', days })).toBeNull();
    expect(parseSettingsRequest({ streakFreezeIntervalDays: days })).toBeNull();
    expect(parseSettingsRequest({ retentionDays: days })).toBeNull();
  });

  it('accepts the exact Date-range freeze cadence boundary', (): void => {
    const days: number = DATE_MAX_MS / DAY_MS;
    expect(parseSettingsRequest({ streakFreezeIntervalDays: days })).not.toBeNull();
  });

  it('accepts the exact fixed half-Date-range relative-duration cap', (): void => {
    const capMin: number = MAX_RELATIVE_DURATION_MS / MINUTE_MS;
    const config: SessionConfig = {
      ...SESSION_CONFIG,
      durationMin: capMin,
      cycling: {
        focusMin: capMin,
        shortBreakMin: capMin,
        longBreakMin: capMin,
        longEvery: 1,
      },
    };
    expect(parseRequest({ type: 'startSession', config })).not.toBeNull();
    expect(
      parseSettingsRequest({
        presetsMin: [15, capMin, 50],
        defaultCycling: config.cycling,
        gate: { ...SETTINGS.gate, delayMs: MAX_RELATIVE_DURATION_MS },
        pause: {
          ...SETTINGS.pause,
          pauseMs: MAX_RELATIVE_DURATION_MS,
          unlockMs: MAX_RELATIVE_DURATION_MS,
        },
      }),
    ).not.toBeNull();
  });

  it.each([
    [
      'session duration',
      replaceNested(VALID_REQUESTS.startSession, 'config', {
        durationMin: (MAX_RELATIVE_DURATION_MS + 1) / MINUTE_MS,
      }),
    ],
    [
      'focus duration',
      replaceNested(VALID_REQUESTS.startSession, 'config', {
        cycling: {
          ...SESSION_CONFIG.cycling,
          focusMin: (MAX_RELATIVE_DURATION_MS + MINUTE_MS) / MINUTE_MS,
        },
      }),
    ],
    [
      'short break duration',
      replaceNested(VALID_REQUESTS.startSession, 'config', {
        cycling: {
          ...SESSION_CONFIG.cycling,
          shortBreakMin: (MAX_RELATIVE_DURATION_MS + MINUTE_MS) / MINUTE_MS,
        },
      }),
    ],
    [
      'long break duration',
      replaceNested(VALID_REQUESTS.startSession, 'config', {
        cycling: {
          ...SESSION_CONFIG.cycling,
          longBreakMin: (MAX_RELATIVE_DURATION_MS + MINUTE_MS) / MINUTE_MS,
        },
      }),
    ],
  ])(
    'rejects a %s above the fixed relative-duration cap',
    (_label: string, request: unknown): void => {
      expect(parseRequest(request)).toBeNull();
    },
  );

  it.each([
    ['preset duration', { presetsMin: [15, (MAX_RELATIVE_DURATION_MS + 1) / MINUTE_MS, 50] }],
    ['gate delay', { gate: { ...SETTINGS.gate, delayMs: MAX_RELATIVE_DURATION_MS + 1 } }],
    ['pause duration', { pause: { ...SETTINGS.pause, pauseMs: MAX_RELATIVE_DURATION_MS + 1 } }],
    ['unlock duration', { pause: { ...SETTINGS.pause, unlockMs: MAX_RELATIVE_DURATION_MS + 1 } }],
  ])(
    'rejects a %s above the fixed relative-duration cap',
    (_label: string, update: Record<string, unknown>): void => {
      expect(parseSettingsRequest(update)).toBeNull();
    },
  );

  it.each([
    { custom: [{ kind: 'host', pattern: '' }] },
    { custom: [{ kind: 'host', pattern: 'not a host' }] },
    { custom: [{ kind: 'regex', pattern: '[' }] },
    { custom: [{ kind: 'unknown', pattern: 'example.com' }] },
    { custom: [{ kind: 'host', pattern: 'example.com', extra: true }] },
    { whitelist: [null] },
    { categories: { ...LISTS.categories, social: 'yes' } },
    { categories: { ...LISTS.categories, other: false } },
    { exclusions: { social: [''] } },
    { exclusions: { social: ['not a host'] } },
    { exclusions: { other: ['example.com'] } },
    { extra: true },
  ])('rejects malformed list payload fields %#', (update: Record<string, unknown>): void => {
    expect(
      parseRequest({
        type: 'updateLists',
        lists: { ...LISTS, ...update },
      }),
    ).toBeNull();
  });
});

function scheduleEntry(update: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'weekday',
    days: [1, 2, 3, 4, 5],
    start: '09:00',
    end: '17:00',
    mode: 'blacklist',
    strictness: 'hard',
    cycling: null,
    intention: '',
    enabled: true,
    ...update,
  };
}

function sparseArray(length: number, values: Record<number, unknown> = {}): unknown[] {
  const array: unknown[] = new Array<unknown>(length);
  for (const [index, value] of Object.entries(values)) {
    array[Number(index)] = value;
  }
  return array;
}

function parseSettingsRequest(update: Record<string, unknown>): Request | null {
  return parseRequest({ type: 'updateSettings', settings: { ...SETTINGS, ...update } });
}

function parseSettingsOrListsRequest(update: Record<string, unknown>): Request | null {
  return Object.hasOwn(update, 'custom')
    ? parseRequest({ type: 'updateLists', lists: { ...LISTS, ...update } })
    : parseSettingsRequest(update);
}

describe('work target request validation', (): void => {
  it('accepts session-bound content choices and rejects mixed policy contexts', (): void => {
    for (const request of [
      { type: 'getWorkTabs', sessionId: 'one' },
      { type: 'setWorkTarget', sessionId: 'one', tabId: 7 },
    ]) {
      expect(parseRequest(request)).toEqual(request);
    }
    for (const request of [
      { type: 'getWorkTabs', sessionId: 'one', mode: 'blacklist' },
      { type: 'getWorkTabs', sessionId: 'one', windowId: 2 },
      { type: 'getWorkTabs', sessionId: '' },
      { type: 'setWorkTarget', sessionId: 'one', tabId: 7, url: 'https://work.example' },
    ]) {
      expect(parseRequest(request)).toBeNull();
    }
  });
  it('accepts an optional work destination without changing the legacy start request', (): void => {
    const request: unknown = {
      type: 'startSession',
      config: SESSION_CONFIG,
      workTabId: 7,
      windowId: 1,
    };
    expect(parseRequest(request)).toEqual(request);
    expect(parseRequest({ type: 'startSession', config: SESSION_CONFIG, workTabId: 7 })).toBeNull();
  });
  it.each([-1, 1.5, NaN, Infinity, '1'])(
    'rejects invalid destination identity %s',
    (tabId: unknown): void => {
      expect(
        parseRequest({ type: 'setWorkTarget', sessionId: 'session', tabId, windowId: 1 }),
      ).toBeNull();
    },
  );
  it('rejects arbitrary IDs in a return request', (): void => {
    expect(parseRequest({ type: 'returnToWork', sessionId: 'session', tabId: 1 })).toBeNull();
    expect(parseRequest({ type: 'returnToWork', sessionId: '' })).toBeNull();
  });
});

it('rejects icon requests with arbitrary URL or missing session identity', (): void => {
  for (const value of [
    { type: 'getWorkTabIcon', sessionId: 'session', tabId: 1, url: 'https://private.example' },
    { type: 'getWorkTabIcon', sessionId: '', tabId: 1 },
    { type: 'getWorkTabIcon', sessionId: 'session', tabId: -1 },
  ])
    expect(parseRequest(value)).toBeNull();
});

describe('manual unlock request', () => {
  it('accepts no deadline only for a manual friction session without cycles', () => {
    const config: SessionConfig = { ...SESSION_CONFIG, durationMin: null, cycling: null };
    expect(parseRequest({ type: 'startSession', config })).toEqual({
      type: 'startSession',
      config,
    });
    for (const change of [
      { strictness: 'hard' },
      { cycling: DEFAULT_SETTINGS.defaultCycling },
      { source: 'schedule', scheduleEntryId: 'scheduled' },
    ]) {
      expect(parseRequest({ type: 'startSession', config: { ...config, ...change } })).toBeNull();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { parseRequest } from '../../../src/background/request-validation';
import { DEFAULT_LISTS, DEFAULT_SETTINGS } from '../../../src/shared/constants';
import type { Request } from '../../../src/shared/messages';
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

const VALID_REQUESTS: RequestByType = {
  getSnapshot: { type: 'getSnapshot' },
  getBlockState: {
    type: 'getBlockState',
    url: 'https://news.example/story',
    docState: 'fresh',
  },
  startSession: { type: 'startSession', config: SESSION_CONFIG },
  openGate: { type: 'openGate', gate: 'unlockSite', host: 'news.example' },
  confirmGate: { type: 'confirmGate', typedPhrase: null },
  abandonGate: { type: 'abandonGate' },
  resumeFromPause: { type: 'resumeFromPause' },
  startNextFocusEarly: { type: 'startNextFocusEarly' },
  updateSettings: { type: 'updateSettings', settings: SETTINGS },
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
    { gate: { ...SETTINGS.gate, extra: true } },
    { badgeCountdown: 1 },
    { sounds: { ...SETTINGS.sounds, masterVolume: 1.1 } },
    { sounds: { ...SETTINGS.sounds, extra: true } },
    { schedule: [{}] },
    { streakGoalMin: -1 },
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

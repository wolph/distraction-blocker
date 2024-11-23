import { describe, expect, it } from 'vitest';
import { listsChangeAllowed, settingsChangeAllowed } from '../../../src/background/guard';
import { DEFAULT_LISTS, DEFAULT_SETTINGS } from '../../../src/shared/constants';
import type { ListsConfig, ScheduleEntry, SessionState, Settings } from '../../../src/shared/types';

const hardSession: SessionState = {
  config: {
    mode: 'blacklist',
    strictness: 'hard',
    durationMin: 60,
    cycling: null,
    intention: '',
    source: 'manual',
    scheduleEntryId: null,
  },
  startedAt: 0,
  sessionEndsAt: 1,
  phase: 'focus',
  phaseStartedAt: 0,
  phaseEndsAt: 1,
  cycleIndex: 0,
  pausedFrom: null,
  focusedMs: 0,
};

const frictionSession: SessionState = {
  ...hardSession,
  config: { ...hardSession.config, strictness: 'friction' },
};

const withCustom: ListsConfig = {
  ...DEFAULT_LISTS,
  custom: [{ kind: 'host', pattern: 'x.com' }],
};

describe('listsChangeAllowed', () => {
  it('rejects removing a rule during a hard session, allows adding', () => {
    expect(listsChangeAllowed(hardSession, 'blacklist', withCustom, DEFAULT_LISTS)).toMatch(
      /hard/i,
    );
    expect(listsChangeAllowed(hardSession, 'blacklist', DEFAULT_LISTS, withCustom)).toBeNull();
  });

  it('rejects new exclusions and disabled categories during hard', () => {
    const catOn: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, social: true },
    };
    const catOff: ListsConfig = { ...DEFAULT_LISTS };
    expect(listsChangeAllowed(hardSession, 'blacklist', catOn, catOff)).toMatch(/hard/i);
    const excl: ListsConfig = { ...catOn, exclusions: { social: ['facebook.com'] } };
    expect(listsChangeAllowed(hardSession, 'blacklist', catOn, excl)).toMatch(/hard/i);
  });

  it('rejects whitelist additions during a hard whitelist session', () => {
    const wl: ListsConfig = {
      ...DEFAULT_LISTS,
      whitelist: [{ kind: 'host', pattern: 'github.com' }],
    };
    expect(listsChangeAllowed(hardSession, 'whitelist', DEFAULT_LISTS, wl)).toMatch(/hard/i);
  });

  it('allows removing a whitelist rule during a hard whitelist session', () => {
    const wl: ListsConfig = {
      ...DEFAULT_LISTS,
      whitelist: [{ kind: 'host', pattern: 'github.com' }],
    };
    expect(listsChangeAllowed(hardSession, 'whitelist', wl, DEFAULT_LISTS)).toBeNull();
  });

  it('allows removing an exclusion during hard', () => {
    const catOn: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, social: true },
    };
    const excl: ListsConfig = { ...catOn, exclusions: { social: ['facebook.com'] } };
    expect(listsChangeAllowed(hardSession, 'blacklist', excl, catOn)).toBeNull();
  });

  it('allows everything when idle or friction', () => {
    expect(listsChangeAllowed(null, null, withCustom, DEFAULT_LISTS)).toBeNull();
    expect(listsChangeAllowed(frictionSession, 'blacklist', withCustom, DEFAULT_LISTS)).toBeNull();
  });
});

const scheduleEntry: ScheduleEntry = {
  id: 'e1',
  days: [1, 2, 3],
  start: '09:00',
  end: '12:00',
  mode: 'blacklist',
  strictness: 'hard',
  cycling: null,
  intention: '',
  enabled: true,
};

describe('settingsChangeAllowed', () => {
  it('rejects weakening the default strictness during a hard session', () => {
    const hardDefault: Settings = { ...DEFAULT_SETTINGS, defaultStrictness: 'hard' };
    const frictionDefault: Settings = { ...DEFAULT_SETTINGS, defaultStrictness: 'friction' };

    expect(settingsChangeAllowed(hardSession, hardDefault, frictionDefault)).toMatch(/hard/i);
    expect(settingsChangeAllowed(hardSession, frictionDefault, hardDefault)).toBeNull();
  });

  it('rejects lowering the gate delay during hard, allows raising it', () => {
    const weaker: Settings = {
      ...DEFAULT_SETTINGS,
      gate: { ...DEFAULT_SETTINGS.gate, delayMs: 1_000 },
    };
    expect(settingsChangeAllowed(hardSession, DEFAULT_SETTINGS, weaker)).toMatch(/hard/i);
    const stronger: Settings = {
      ...DEFAULT_SETTINGS,
      gate: { ...DEFAULT_SETTINGS.gate, delayMs: 30_000 },
    };
    expect(settingsChangeAllowed(hardSession, DEFAULT_SETTINGS, stronger)).toBeNull();
  });

  it('rejects turning the typed phrase off during hard', () => {
    const typed: Settings = {
      ...DEFAULT_SETTINGS,
      gate: { ...DEFAULT_SETTINGS.gate, requireTypedPhrase: true },
    };
    const untyped: Settings = {
      ...DEFAULT_SETTINGS,
      gate: { ...DEFAULT_SETTINGS.gate, requireTypedPhrase: false },
    };
    expect(settingsChangeAllowed(hardSession, typed, untyped)).toMatch(/hard/i);
    expect(settingsChangeAllowed(hardSession, untyped, typed)).toBeNull();
  });

  it('rejects raising the earn ratio or cap during hard', () => {
    const richer: Settings = {
      ...DEFAULT_SETTINGS,
      pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 1 },
    };
    expect(settingsChangeAllowed(hardSession, DEFAULT_SETTINGS, richer)).toMatch(/hard/i);
    const bigger: Settings = {
      ...DEFAULT_SETTINGS,
      pause: { ...DEFAULT_SETTINGS.pause, capMs: DEFAULT_SETTINGS.pause.capMs + 1 },
    };
    expect(settingsChangeAllowed(hardSession, DEFAULT_SETTINGS, bigger)).toMatch(/hard/i);
  });

  it('rejects editing or disabling the schedule entry the session came from', () => {
    const fromSchedule: SessionState = {
      ...hardSession,
      config: { ...hardSession.config, source: 'schedule', scheduleEntryId: 'e1' },
    };
    const current: Settings = { ...DEFAULT_SETTINGS, schedule: [scheduleEntry] };
    const disabled: Settings = {
      ...DEFAULT_SETTINGS,
      schedule: [{ ...scheduleEntry, enabled: false }],
    };
    const shortened: Settings = {
      ...DEFAULT_SETTINGS,
      schedule: [{ ...scheduleEntry, end: '10:00' }],
    };
    const removed: Settings = { ...DEFAULT_SETTINGS, schedule: [] };
    expect(settingsChangeAllowed(fromSchedule, current, disabled)).toMatch(/hard/i);
    expect(settingsChangeAllowed(fromSchedule, current, shortened)).toMatch(/hard/i);
    expect(settingsChangeAllowed(fromSchedule, current, removed)).toMatch(/hard/i);
  });

  it('allows new schedule entries during hard', () => {
    const added: Settings = { ...DEFAULT_SETTINGS, schedule: [scheduleEntry] };
    expect(settingsChangeAllowed(hardSession, DEFAULT_SETTINGS, added)).toBeNull();
  });

  it('allows the same changes outside hard sessions', () => {
    const richer: Settings = {
      ...DEFAULT_SETTINGS,
      pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 1 },
    };
    expect(settingsChangeAllowed(null, DEFAULT_SETTINGS, richer)).toBeNull();
    expect(settingsChangeAllowed(frictionSession, DEFAULT_SETTINGS, richer)).toBeNull();
  });
});

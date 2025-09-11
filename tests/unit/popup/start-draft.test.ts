import { describe, expect, it } from 'vitest';
import {
  addDraftAllowHost,
  createSessionDraft,
  type DraftUpdate,
  rebaseSessionDraft,
  type SessionDraft,
  toggleDraftCategory,
} from '../../../src/popup/session-draft';
import {
  createStartDraft,
  effectiveCycling,
  effectiveStrictness,
  effectiveTimedMinutes,
  type StartDraft,
  selectTimedPreset,
  selectUntilStopped,
  setCustomMinutes,
  setTimedCycling,
  setTimedStrictness,
  startLabel,
  toSessionConfigV2,
} from '../../../src/popup/start-draft';
import { DEFAULT_LISTS, DEFAULT_SETTINGS, rulesFromLists } from '../../../src/shared/constants';
import { isSessionConfigV2 } from '../../../src/shared/runtime-validation';
import type {
  CycleConfig,
  ListsConfig,
  SessionConfigV2,
  SettingsV2,
} from '../../../src/shared/types';

const SETTINGS: SettingsV2 = { ...DEFAULT_SETTINGS, schedule: [] };
const CUSTOM_CYCLE: CycleConfig = {
  focusMin: 20,
  shortBreakMin: 4,
  longBreakMin: 12,
  longEvery: 3,
};

function baseDraft(): StartDraft {
  return createStartDraft(SETTINGS, DEFAULT_LISTS);
}

/** A timed draft that differs from every Settings default, so restores are provable. */
function timedDraft(): StartDraft {
  return setTimedCycling(
    setTimedStrictness(selectTimedPreset(baseDraft(), 50), 'hard'),
    CUSTOM_CYCLE,
  );
}

describe('createStartDraft', (): void => {
  it('mirrors the v1 draft defaults and opens on the middle preset', (): void => {
    const draft: StartDraft = baseDraft();
    const v1: SessionDraft = createSessionDraft(DEFAULT_SETTINGS, DEFAULT_LISTS);

    expect(draft.mode).toBe(v1.mode);
    expect(draft.timedStrictness).toBe(v1.strictness);
    expect(draft.timedCycling).toEqual(v1.cycling);
    expect(draft.timedCycling).not.toBe(SETTINGS.defaultCycling);
    expect(draft.frictionGate).toEqual(v1.frictionGate);
    expect(draft.frictionGate).not.toBe(SETTINGS.gate);
    expect(draft.intention).toBe('');
    expect(draft.rules).toEqual(v1.rules);
    expect(draft.duration).toEqual({
      kind: 'timed',
      presetMin: SETTINGS.presetsMin[1],
      customMin: '',
    });
  });

  it('drops cycling when Settings starts cycles off', (): void => {
    const draft: StartDraft = createStartDraft(
      { ...SETTINGS, cyclingOnByDefault: false },
      DEFAULT_LISTS,
    );

    expect(draft.timedCycling).toBeNull();
  });
});

describe('selectUntilStopped', (): void => {
  it('forces Flexible and cycles off without destroying the timed draft', (): void => {
    const timed: StartDraft = timedDraft();
    const indefinite: StartDraft = selectUntilStopped(timed);

    expect(indefinite.duration).toEqual({ kind: 'until-stopped' });
    expect(indefinite.timedStrictness).toBe('hard');
    expect(indefinite.timedCycling).toEqual(CUSTOM_CYCLE);
    expect(effectiveStrictness(indefinite)).toBe('flexible');
    expect(effectiveCycling(indefinite)).toBeNull();
    expect(effectiveTimedMinutes(indefinite)).toBeNull();
    expect(timed.duration).toEqual({ kind: 'timed', presetMin: 50, customMin: '' });
    expect(timed.timedStrictness).toBe('hard');
    expect(timed.timedCycling).toEqual(CUSTOM_CYCLE);
  });

  it('restores the timed session type, cycles, and the newly chosen preset', (): void => {
    const back: StartDraft = selectTimedPreset(selectUntilStopped(timedDraft()), 15);

    expect(back.duration).toEqual({ kind: 'timed', presetMin: 15, customMin: '' });
    expect(effectiveStrictness(back)).toBe('hard');
    expect(effectiveCycling(back)).toEqual(CUSTOM_CYCLE);
    expect(effectiveTimedMinutes(back)).toBe(15);
  });

  it('restores the timed draft through custom minutes', (): void => {
    const back: StartDraft = setCustomMinutes(selectUntilStopped(timedDraft()), '40');

    expect(back.duration.kind).toBe('timed');
    expect(effectiveStrictness(back)).toBe('hard');
    expect(effectiveCycling(back)).toEqual(CUSTOM_CYCLE);
    expect(effectiveTimedMinutes(back)).toBe(40);
  });

  it('preserves the then-current timed draft when selected twice', (): void => {
    const timed: StartDraft = setCustomMinutes(timedDraft(), '35');
    const once: StartDraft = selectUntilStopped(timed);
    const twice: StartDraft = selectUntilStopped(once);

    expect(twice.timedStrictness).toBe('hard');
    expect(twice.timedCycling).toEqual(CUSTOM_CYCLE);
    expect(twice).toEqual(once);
    expect(selectTimedPreset(twice, 25)).toEqual(selectTimedPreset(once, 25));
  });
});

describe('effectiveTimedMinutes', (): void => {
  it('prefers custom minutes over the selected preset', (): void => {
    expect(effectiveTimedMinutes(setCustomMinutes(baseDraft(), '40'))).toBe(40);
    expect(effectiveTimedMinutes(setCustomMinutes(baseDraft(), ''))).toBe(25);
  });

  it('rejects hostile custom minutes', (): void => {
    expect(effectiveTimedMinutes(setCustomMinutes(baseDraft(), '1e400'))).toBeNull();
    expect(effectiveTimedMinutes(setCustomMinutes(baseDraft(), 'NaN'))).toBeNull();
    expect(effectiveTimedMinutes(setCustomMinutes(baseDraft(), '-5'))).toBeNull();
    expect(effectiveTimedMinutes(setCustomMinutes(baseDraft(), ' 25 '))).toBe(25);
    expect(effectiveTimedMinutes(setCustomMinutes(baseDraft(), '0'))).toBeNull();
    expect(effectiveTimedMinutes(setCustomMinutes(baseDraft(), 'abc'))).toBeNull();
  });

  it('has no minutes without a preset or a usable custom value', (): void => {
    const blank: StartDraft = setCustomMinutes(selectUntilStopped(baseDraft()), '   ');

    expect(blank.duration).toEqual({ kind: 'timed', presetMin: null, customMin: '   ' });
    expect(effectiveTimedMinutes(blank)).toBeNull();
  });
});

describe('startLabel', (): void => {
  it('names the duration and the blocking mode for timed drafts', (): void => {
    const draft: StartDraft = baseDraft();

    expect(startLabel(draft)).toBe('Start 25 min - Block selected sites');
    expect(startLabel({ ...draft, mode: 'whitelist' })).toBe(
      'Start 25 min - Allow selected sites only',
    );
    expect(startLabel(setCustomMinutes(draft, '40'))).toBe('Start 40 min - Block selected sites');
    expect(startLabel(setCustomMinutes(draft, '0'))).toBe(
      'Start invalid time - Block selected sites',
    );
  });

  it('names the indefinite plan', (): void => {
    expect(startLabel(selectUntilStopped(timedDraft()))).toBe('Start until stopped');
  });
});

describe('toSessionConfigV2', (): void => {
  it('submits a Flexible non-cycling until-stopped manual config', (): void => {
    const draft: StartDraft = selectUntilStopped({
      ...timedDraft(),
      intention: '  write the report  ',
    });
    const config: SessionConfigV2 | null = toSessionConfigV2(draft);

    expect(config).toEqual({
      mode: 'blacklist',
      strictness: 'flexible',
      duration: { kind: 'until-stopped' },
      cycling: null,
      intention: 'write the report',
      source: 'manual',
      scheduleOccurrence: null,
      rules: rulesFromLists(DEFAULT_LISTS),
    });
    expect(isSessionConfigV2(config)).toBe(true);
  });

  it('submits the effective minutes, session type, and cycles for a timed draft', (): void => {
    const config: SessionConfigV2 | null = toSessionConfigV2(
      setTimedStrictness(setCustomMinutes(timedDraft(), '40'), 'friction'),
    );

    expect(config).toEqual({
      mode: 'blacklist',
      strictness: 'friction',
      duration: { kind: 'timed', minutes: 40 },
      cycling: CUSTOM_CYCLE,
      intention: '',
      source: 'manual',
      scheduleOccurrence: null,
      rules: rulesFromLists(DEFAULT_LISTS),
    });
    expect(isSessionConfigV2(config)).toBe(true);
  });

  it('detaches the submitted rules and cycles from the draft', (): void => {
    const draft: StartDraft = timedDraft();
    const config: SessionConfigV2 | null = toSessionConfigV2(draft);

    expect(config?.rules).not.toBe(draft.rules);
    expect(config?.cycling).not.toBe(draft.timedCycling);
  });

  it('refuses unusable custom minutes', (): void => {
    const draft: StartDraft = baseDraft();

    expect(toSessionConfigV2(setCustomMinutes(draft, '0'))).toBeNull();
    expect(toSessionConfigV2(setCustomMinutes(draft, '-5'))).toBeNull();
    expect(toSessionConfigV2(setCustomMinutes(draft, '1e400'))).toBeNull();
    expect(toSessionConfigV2(setCustomMinutes(draft, 'NaN'))).toBeNull();
    expect(toSessionConfigV2(setCustomMinutes(selectUntilStopped(draft), '  '))).toBeNull();
  });
});

describe('shared rule helpers', (): void => {
  it('accept the v2 start draft and leave its duration alone', (): void => {
    const lists: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, video: true },
    };
    const draft: StartDraft = timedDraft();
    const toggled: StartDraft = toggleDraftCategory(draft, 'social');
    const rebased: StartDraft = rebaseSessionDraft(toggled, lists);
    const added: DraftUpdate<StartDraft> = addDraftAllowHost(
      rebased,
      'HTTPS://Docs.Python.org/3/library/',
    );

    expect(toggled.rules.categories.social).toBe(true);
    expect(draft.rules.categories.social).toBe(false);
    expect(rebased.rules.categories.social).toBe(true);
    expect(rebased.rules.categories.video).toBe(true);
    expect(rebased.rules.baselineRevision).toBe(rulesFromLists(lists).baselineRevision);
    expect(added.error).toBeNull();
    expect(added.draft.rules.sessionAllowlist).toEqual([
      { kind: 'host', pattern: 'docs.python.org' },
    ]);
    expect(added.draft.duration).toEqual(draft.duration);
    expect(added.draft.timedStrictness).toBe('hard');
    expect(added.draft.timedCycling).toEqual(CUSTOM_CYCLE);
  });
});

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
  restoreTimedDuration,
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

/**
 * A timed draft that differs from every Settings default, so restores are provable. The cycle
 * config lands after the deep work preset, because that preset turns cycles off.
 */
function timedDraft(): StartDraft {
  return setTimedCycling(
    setTimedStrictness(selectTimedPreset(baseDraft(), 50), 'hard'),
    CUSTOM_CYCLE,
  );
}

/** Only a hand-built draft can lack both a preset and a usable custom value. */
function presetLessDraft(customMin: string): StartDraft {
  return { ...baseDraft(), duration: { kind: 'timed', presetMin: null, customMin } };
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

  it('remembers which preset is deep work from Settings', (): void => {
    expect(baseDraft().deepWorkMin).toBe(SETTINGS.presetsMin[2]);
    expect(
      createStartDraft({ ...SETTINGS, presetsMin: [10, 20, 90] }, DEFAULT_LISTS).deepWorkMin,
    ).toBe(90);
  });
});

describe('selectTimedPreset', (): void => {
  it('turns cycles off for the deep work preset and keeps them for the others', (): void => {
    const draft: StartDraft = baseDraft();
    expect(draft.timedCycling).not.toBeNull();

    const deepWork: StartDraft = selectTimedPreset(draft, 50);
    expect(deepWork.duration).toEqual({ kind: 'timed', presetMin: 50, customMin: '' });
    expect(effectiveCycling(deepWork)).toBeNull();
    expect(draft.timedCycling).not.toBeNull();

    expect(effectiveCycling(selectTimedPreset(draft, 15))).toEqual(draft.timedCycling);
    expect(effectiveCycling(selectTimedPreset(draft, 25))).toEqual(draft.timedCycling);
  });

  it('lets the cycle checkbox turn cycles back on after deep work', (): void => {
    const deepWork: StartDraft = selectTimedPreset(baseDraft(), 50);
    const cycling: StartDraft = setTimedCycling(deepWork, CUSTOM_CYCLE);

    expect(effectiveCycling(cycling)).toEqual(CUSTOM_CYCLE);
    expect(effectiveTimedMinutes(cycling)).toBe(50);
  });

  it('keeps cycles when the deep work minutes are typed rather than chosen', (): void => {
    const typed: StartDraft = setCustomMinutes(baseDraft(), '50');

    expect(effectiveTimedMinutes(typed)).toBe(50);
    expect(effectiveCycling(typed)).toEqual(baseDraft().timedCycling);
  });

  it('applies the deep work rule to the preset chosen after an Until stopped detour', (): void => {
    const back: StartDraft = selectTimedPreset(selectUntilStopped(baseDraft()), 50);

    expect(back.duration).toEqual({ kind: 'timed', presetMin: 50, customMin: '' });
    expect(effectiveCycling(back)).toBeNull();
  });
});

describe('selectUntilStopped', (): void => {
  it('clamps Hard to Friction and turns cycles off without destroying the timed draft', (): void => {
    const timed: StartDraft = timedDraft();
    const indefinite: StartDraft = selectUntilStopped(timed);

    expect(indefinite.duration).toEqual({
      kind: 'until-stopped',
      timed: { presetMin: 50, customMin: '' },
    });
    expect(indefinite.timedStrictness).toBe('hard');
    expect(indefinite.timedCycling).toEqual(CUSTOM_CYCLE);
    expect(effectiveStrictness(indefinite)).toBe('friction');
    expect(effectiveCycling(indefinite)).toBeNull();
    expect(effectiveTimedMinutes(indefinite)).toBeNull();
    expect(timed.duration).toEqual({ kind: 'timed', presetMin: 50, customMin: '' });
    expect(timed.timedStrictness).toBe('hard');
    expect(timed.timedCycling).toEqual(CUSTOM_CYCLE);
  });

  it('keeps Flexible and Friction as chosen while until stopped', (): void => {
    const flexible: StartDraft = selectUntilStopped(setTimedStrictness(timedDraft(), 'flexible'));
    const friction: StartDraft = selectUntilStopped(setTimedStrictness(timedDraft(), 'friction'));

    expect(effectiveStrictness(flexible)).toBe('flexible');
    expect(effectiveStrictness(friction)).toBe('friction');
    // A type chosen during the detour is the draft's type, not a hidden timed one.
    expect(effectiveStrictness(setTimedStrictness(friction, 'flexible'))).toBe('flexible');
    expect(effectiveStrictness(setTimedStrictness(flexible, 'hard'))).toBe('friction');
  });

  it('restores the timed session type, cycles, and the newly chosen preset', (): void => {
    const back: StartDraft = selectTimedPreset(selectUntilStopped(timedDraft()), 15);

    expect(back.duration).toEqual({ kind: 'timed', presetMin: 15, customMin: '' });
    expect(effectiveStrictness(back)).toBe('hard');
    expect(effectiveCycling(back)).toEqual(CUSTOM_CYCLE);
    expect(effectiveTimedMinutes(back)).toBe(15);
  });

  it('restores the timed draft through custom minutes and keeps the stored preset', (): void => {
    const back: StartDraft = setCustomMinutes(selectUntilStopped(timedDraft()), '40');
    const cleared: StartDraft = setCustomMinutes(back, '');

    expect(back.duration).toEqual({ kind: 'timed', presetMin: 50, customMin: '40' });
    expect(effectiveStrictness(back)).toBe('hard');
    expect(effectiveCycling(back)).toEqual(CUSTOM_CYCLE);
    expect(effectiveTimedMinutes(back)).toBe(40);
    expect(cleared.duration).toEqual({ kind: 'timed', presetMin: 50, customMin: '' });
    expect(effectiveTimedMinutes(cleared)).toBe(50);
  });

  it('brings the stored preset and custom minutes back verbatim', (): void => {
    const timed: StartDraft = setCustomMinutes(timedDraft(), '35');
    const restored: StartDraft = restoreTimedDuration(selectUntilStopped(timed));

    expect(restored.duration).toEqual({ kind: 'timed', presetMin: 50, customMin: '35' });
    expect(restored.timedStrictness).toBe('hard');
    expect(restored.timedCycling).toEqual(CUSTOM_CYCLE);
    expect(effectiveStrictness(restored)).toBe('hard');
    expect(effectiveCycling(restored)).toEqual(CUSTOM_CYCLE);
    expect(effectiveTimedMinutes(restored)).toBe(35);
  });

  it('leaves a timed draft alone when restored', (): void => {
    const timed: StartDraft = setCustomMinutes(timedDraft(), '35');

    expect(restoreTimedDuration(timed)).toBe(timed);
  });

  it('preserves the then-current timed draft when selected twice', (): void => {
    const timed: StartDraft = setCustomMinutes(timedDraft(), '35');
    const once: StartDraft = selectUntilStopped(timed);
    const twice: StartDraft = selectUntilStopped(once);

    expect(twice.timedStrictness).toBe('hard');
    expect(twice.timedCycling).toEqual(CUSTOM_CYCLE);
    expect(twice.duration).toEqual({
      kind: 'until-stopped',
      timed: { presetMin: 50, customMin: '35' },
    });
    expect(twice).toEqual(once);
    expect(restoreTimedDuration(twice)).toEqual(restoreTimedDuration(once));
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
    expect(effectiveTimedMinutes(presetLessDraft('   '))).toBeNull();
    expect(effectiveTimedMinutes(presetLessDraft(''))).toBeNull();
  });

  it('keeps the stored preset when the custom field is cleared after a detour', (): void => {
    const blank: StartDraft = setCustomMinutes(selectUntilStopped(baseDraft()), '   ');

    expect(blank.duration).toEqual({ kind: 'timed', presetMin: 25, customMin: '   ' });
    expect(effectiveTimedMinutes(blank)).toBe(25);
  });
});

describe('startLabel', (): void => {
  it('names the duration for timed focus', (): void => {
    const draft: StartDraft = baseDraft();

    expect(startLabel(draft)).toBe('Start 25 min focus');
    expect(startLabel({ ...draft, mode: 'whitelist' })).toBe('Start 25 min focus');
    expect(startLabel(setCustomMinutes(draft, '40'))).toBe('Start 40 min focus');
    expect(startLabel(setCustomMinutes(draft, '0'))).toBe('Start invalid time focus');
  });

  it('names the indefinite plan by its session type', (): void => {
    const flexible: StartDraft = selectUntilStopped(setTimedStrictness(timedDraft(), 'flexible'));
    const friction: StartDraft = selectUntilStopped(setTimedStrictness(timedDraft(), 'friction'));

    expect(startLabel(flexible)).toBe('Start until stopped');
    expect(startLabel(friction)).toBe('Lock until manual unlock');
    // Hard clamps to Friction, so the button says what will actually start.
    expect(startLabel(selectUntilStopped(timedDraft()))).toBe('Lock until manual unlock');
  });
});

describe('toSessionConfigV2', (): void => {
  it('submits a non-cycling until-stopped manual config with the chosen type', (): void => {
    const draft: StartDraft = selectUntilStopped({
      ...setTimedStrictness(timedDraft(), 'flexible'),
      intention: '  write the report  ',
    });
    const config: SessionConfigV2 | null = toSessionConfigV2(draft);
    const friction: SessionConfigV2 | null = toSessionConfigV2(
      setTimedStrictness(draft, 'friction'),
    );

    expect(friction?.strictness).toBe('friction');
    expect(friction?.duration).toEqual({ kind: 'until-stopped' });
    expect(isSessionConfigV2(friction)).toBe(true);
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
    expect(toSessionConfigV2(presetLessDraft('  '))).toBeNull();
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

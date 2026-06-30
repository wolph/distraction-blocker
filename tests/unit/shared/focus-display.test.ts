import { describe, expect, it } from 'vitest';
import { DEFAULT_LISTS, emptySnapshotV2, rulesFromLists } from '../../../src/shared/constants';
import { type FocusDisplay, focusDisplay } from '../../../src/shared/focus-display';
import type { SessionConfigV2, SessionSnapshotV2 } from '../../../src/shared/types';

const NOW: number = 1_000_000;
const MINUTE: number = 60_000;

const TIMED_CONFIG: SessionConfigV2 = {
  mode: 'blacklist',
  strictness: 'friction',
  duration: { kind: 'timed', minutes: 100 },
  cycling: { focusMin: 30, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 },
  intention: 'Write the example',
  source: 'manual',
  scheduleOccurrence: null,
  rules: rulesFromLists(DEFAULT_LISTS),
};

function snapshot(overrides: Partial<SessionSnapshotV2> = {}): SessionSnapshotV2 {
  return {
    ...emptySnapshotV2(NOW),
    lifecycle: { kind: 'active', endAuthority: { kind: 'hidden' } },
    phase: 'focus',
    config: TIMED_CONFIG,
    startedAt: NOW - 10 * MINUTE,
    phaseStartedAt: NOW - 10 * MINUTE,
    phaseEndsAt: NOW + 20 * MINUTE,
    sessionEndsAt: NOW + 20 * MINUTE,
    ...overrides,
  };
}

function untilStoppedSnapshot(): SessionSnapshotV2 {
  return snapshot({
    config: {
      ...TIMED_CONFIG,
      strictness: 'flexible',
      duration: { kind: 'until-stopped' },
      cycling: null,
    },
    phaseEndsAt: null,
    sessionEndsAt: null,
  });
}

describe('focusDisplay', (): void => {
  it('labels an until-stopped session without a timer or automatic break', (): void => {
    expect(focusDisplay(untilStoppedSnapshot(), NOW)).toEqual({
      text: 'Until stopped',
      endsAt: null,
      progress: 0,
    });
  });

  it('shows session end with clamped focus progress', (): void => {
    expect(focusDisplay(snapshot(), NOW)).toEqual({
      text: '20 min left in this session',
      endsAt: NOW + 20 * MINUTE,
      progress: 1 / 3,
    });
  });

  it('uses the next break only when it precedes session end', (): void => {
    const snap: SessionSnapshotV2 = snapshot({ sessionEndsAt: NOW + 90 * MINUTE });
    expect(focusDisplay(snap, NOW).text).toBe('20 min until your break');
    expect(focusDisplay(snap, NOW + 1).text).toBe('20 min until your break');
  });

  it('uses a calm last-minute label and a distinct transition state', (): void => {
    const snap: SessionSnapshotV2 = snapshot({ phaseEndsAt: NOW + 59_000 });
    expect(focusDisplay(snap, NOW).text).toBe('Less than a minute until your break');
    expect(focusDisplay(snap, NOW + MINUTE).text).toBe('Updating session');
    expect(focusDisplay(snap, NOW + MINUTE).progress).toBe(1);
  });

  it.each([
    [0, 25],
    [3, 35],
  ])(
    'shows early completion instead of a final break for cycle %i',
    (cycleIndex, minutes): void => {
      const snap: SessionSnapshotV2 = snapshot({
        cycleIndex,
        sessionEndsAt: NOW + minutes * MINUTE,
      });
      expect(focusDisplay(snap, NOW).text).toBe('20 min left in this session');
    },
  );

  it('does not promise a zero-length break', (): void => {
    const snap: SessionSnapshotV2 = snapshot({
      sessionEndsAt: NOW + 90 * MINUTE,
      config: {
        ...TIMED_CONFIG,
        cycling: { focusMin: 30, shortBreakMin: 0, longBreakMin: 15, longEvery: 4 },
      },
    });
    expect(focusDisplay(snap, NOW).text).toBe('20 min left in this session');
  });

  it('handles a shortened session and absent phase timestamps', (): void => {
    const snap: SessionSnapshotV2 = snapshot({ sessionEndsAt: NOW + 5 * MINUTE });
    const shortened: FocusDisplay = focusDisplay(snap, NOW);
    expect(shortened.text).toBe('5 min left in this session');
    expect(shortened.progress).toBe(2 / 3);
    expect(focusDisplay(emptySnapshotV2(NOW), NOW)).toEqual({
      text: 'Updating session',
      endsAt: null,
      progress: 0,
    });
  });

  it('treats a timed session with no deadline as still updating', (): void => {
    const snap: SessionSnapshotV2 = snapshot({ phaseEndsAt: null, sessionEndsAt: null });
    expect(focusDisplay(snap, NOW).text).toBe('Updating session');
  });
});

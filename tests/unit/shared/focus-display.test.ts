import { describe, expect, it } from 'vitest';
import { accessAvailability } from '../../../src/shared/budget-display';
import { emptySnapshot } from '../../../src/shared/constants';
import { focusDisplay } from '../../../src/shared/focus-display';
import type { SessionSnapshot } from '../../../src/shared/types';

const NOW: number = 1_000_000;
const MINUTE: number = 60_000;

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    ...emptySnapshot(NOW),
    phase: 'focus',
    phaseStartedAt: NOW - 10 * MINUTE,
    phaseEndsAt: NOW + 20 * MINUTE,
    sessionEndsAt: NOW + 20 * MINUTE,
    bankMs: 2 * MINUTE,
    bankCapMs: 10 * MINUTE,
    bankAccrualPerMs: 1 / 5,
    config: {
      mode: 'blacklist',
      strictness: 'friction',
      durationMin: 100,
      cycling: { focusMin: 30, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 },
      intention: 'Write the example',
      source: 'manual',
      scheduleEntryId: null,
    },
    ...overrides,
  };
}

function indefiniteSnapshot(): SessionSnapshot {
  const snap: SessionSnapshot = snapshot();
  if (snap.config === null) throw new Error('Missing session config');
  return {
    ...snap,
    config: { ...snap.config, durationMin: null, cycling: null },
    phaseEndsAt: null,
    sessionEndsAt: null,
  };
}

describe('accessAvailability', (): void => {
  it('keeps earning credit without a focus deadline', (): void => {
    const snap: SessionSnapshot = indefiniteSnapshot();
    expect(accessAvailability(snap, NOW, 5 * MINUTE)).toEqual({
      affordable: false,
      waitMs: 15 * MINUTE,
      message: 'Ready in 15:00',
    });
    expect(accessAvailability(snap, NOW + 15 * MINUTE, 5 * MINUTE)).toEqual({
      affordable: true,
      waitMs: 0,
      message: null,
    });
    expect(accessAvailability(snap, NOW + 365 * 24 * 60 * MINUTE, 5 * MINUTE).affordable).toBe(
      true,
    );
    expect(accessAvailability(snap, NOW, 11 * MINUTE).message).toBe(
      'Cost exceeds the credit limit',
    );
  });
  it('counts to each action cost rather than the next whole minute', (): void => {
    expect(accessAvailability(snapshot(), NOW, 5 * MINUTE)).toEqual({
      affordable: false,
      waitMs: 15 * MINUTE,
      message: 'Ready in 15:00',
    });
    expect(accessAvailability(snapshot(), NOW, 3 * MINUTE).waitMs).toBe(5 * MINUTE);
    expect(accessAvailability(snapshot(), NOW, 2 * MINUTE)).toEqual({
      affordable: true,
      waitMs: 0,
      message: null,
    });
  });

  it('rounds sub-second waits up without delaying actual affordability', (): void => {
    const snap: SessionSnapshot = snapshot({ bankMs: MINUTE - 50, bankAccrualPerMs: 1 });
    expect(accessAvailability(snap, NOW, MINUTE).waitMs).toBe(1_000);
    expect(accessAvailability(snap, NOW + 50, MINUTE).affordable).toBe(true);
  });

  it.each([
    [{ bankCapMs: MINUTE }, 'Cost exceeds the credit limit'],
    [{ bankAccrualPerMs: 0 }, 'Credit earning is turned off'],
    [{ phase: 'break' }, 'Credit earning resumes during focus'],
    [{ phaseEndsAt: NOW + MINUTE }, 'Not enough time in this focus block'],
    [{ sessionEndsAt: NOW + MINUTE }, 'Not enough time in this focus block'],
    [{ bankAccrualPerMs: Number.MIN_VALUE }, 'Not enough time in this focus block'],
  ] as const)('explains unreachable credit for %o', (overrides, message): void => {
    expect(accessAvailability(snapshot(overrides), NOW, 5 * MINUTE)).toEqual({
      affordable: false,
      waitMs: null,
      message,
    });
  });

  it('does not promise a spend at the boundary where focus ends', (): void => {
    expect(
      accessAvailability(snapshot({ phaseEndsAt: NOW + 15 * MINUTE }), NOW, 5 * MINUTE).affordable,
    ).toBe(false);
    expect(
      accessAvailability(snapshot({ phaseEndsAt: NOW + 15 * MINUTE }), NOW, 5 * MINUTE).waitMs,
    ).toBeNull();
  });

  it('does not extrapolate credit past the focus boundary', (): void => {
    const snap: SessionSnapshot = snapshot({ phaseEndsAt: NOW + MINUTE });
    expect(accessAvailability(snap, NOW + 30 * MINUTE, 5 * MINUTE).affordable).toBe(false);
  });

  it('keeps spending disabled when the snapshot has reached its focus boundary', (): void => {
    const snap: SessionSnapshot = snapshot({ phaseEndsAt: NOW + 15 * MINUTE });
    expect(accessAvailability(snap, NOW + 15 * MINUTE, 5 * MINUTE)).toEqual({
      affordable: false,
      waitMs: null,
      message: 'Updating session',
    });
  });
});

describe('focusDisplay', (): void => {
  it('describes indefinite focus without a timer or automatic break', (): void => {
    expect(focusDisplay(indefiniteSnapshot(), NOW)).toEqual({
      text: 'Until manual unlock',
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
    const snap: SessionSnapshot = snapshot({ sessionEndsAt: NOW + 90 * MINUTE });
    expect(focusDisplay(snap, NOW).text).toBe('20 min until your break');
    expect(focusDisplay(snap, NOW + 1).text).toBe('20 min until your break');
  });

  it('uses a calm last-minute label and a distinct transition state', (): void => {
    const snap: SessionSnapshot = snapshot({ phaseEndsAt: NOW + 59_000 });
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
      const snap: SessionSnapshot = snapshot({ cycleIndex, sessionEndsAt: NOW + minutes * MINUTE });
      expect(focusDisplay(snap, NOW).text).toBe('20 min left in this session');
    },
  );

  it('does not promise a zero-length break', (): void => {
    const snap: SessionSnapshot = snapshot({ sessionEndsAt: NOW + 90 * MINUTE });
    if (snap.config?.cycling === null || snap.config?.cycling === undefined)
      throw new Error('Missing test cycle');
    snap.config.cycling.shortBreakMin = 0;
    expect(focusDisplay(snap, NOW).text).toBe('20 min left in this session');
  });

  it('handles a shortened session and absent phase timestamps', (): void => {
    const snap: SessionSnapshot = snapshot({ sessionEndsAt: NOW + 5 * MINUTE });
    expect(focusDisplay(snap, NOW).text).toBe('5 min left in this session');
    expect(focusDisplay(snap, NOW).progress).toBe(2 / 3);
    expect(focusDisplay(emptySnapshot(NOW), NOW)).toEqual({
      text: 'Updating session',
      endsAt: null,
      progress: 0,
    });
  });
});

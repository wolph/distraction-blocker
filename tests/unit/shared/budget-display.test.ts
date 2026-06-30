import { describe, expect, it } from 'vitest';
import { type AccessAvailability, accessAvailability } from '../../../src/shared/budget-display';
import { DEFAULT_LISTS, emptySnapshotV2, rulesFromLists } from '../../../src/shared/constants';
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
    bankMs: 2 * MINUTE,
    bankCapMs: 10 * MINUTE,
    bankAccrualPerMs: 1 / 5,
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

describe('accessAvailability', (): void => {
  it('keeps earning credit without a focus deadline', (): void => {
    const snap: SessionSnapshotV2 = untilStoppedSnapshot();
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

  it('grows the captured balance to the moment it is asked about', (): void => {
    const later: AccessAvailability = accessAvailability(snapshot(), NOW + 5 * MINUTE, 5 * MINUTE);
    expect(later).toEqual({ affordable: false, waitMs: 10 * MINUTE, message: 'Ready in 10:00' });
  });

  it('rounds sub-second waits up without delaying actual affordability', (): void => {
    const snap: SessionSnapshotV2 = snapshot({ bankMs: MINUTE - 50, bankAccrualPerMs: 1 });
    expect(accessAvailability(snap, NOW, MINUTE).waitMs).toBe(1_000);
    expect(accessAvailability(snap, NOW + 50, MINUTE).affordable).toBe(true);
  });

  it.each([
    [{ bankCapMs: MINUTE }, 'Cost exceeds the credit limit'],
    [{ bankAccrualPerMs: 0 }, 'Credit earning is turned off'],
    [{ phase: 'break' }, 'Credit earning resumes during focus'],
    [{ phase: 'paused' }, 'Credit earning resumes during focus'],
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
    const snap: SessionSnapshotV2 = snapshot({ phaseEndsAt: NOW + 15 * MINUTE });
    expect(accessAvailability(snap, NOW, 5 * MINUTE).affordable).toBe(false);
    expect(accessAvailability(snap, NOW, 5 * MINUTE).waitMs).toBeNull();
  });

  it('does not extrapolate credit past the focus boundary', (): void => {
    const snap: SessionSnapshotV2 = snapshot({ phaseEndsAt: NOW + MINUTE });
    expect(accessAvailability(snap, NOW + 30 * MINUTE, 5 * MINUTE).affordable).toBe(false);
  });

  it('keeps spending disabled when the snapshot has reached its focus boundary', (): void => {
    const snap: SessionSnapshotV2 = snapshot({ phaseEndsAt: NOW + 15 * MINUTE });
    expect(accessAvailability(snap, NOW + 15 * MINUTE, 5 * MINUTE)).toEqual({
      affordable: false,
      waitMs: null,
      message: 'Updating session',
    });
  });

  it('reports an affordable spend before any explanation', (): void => {
    const snap: SessionSnapshotV2 = snapshot({ phase: 'break', bankMs: 5 * MINUTE });
    expect(accessAvailability(snap, NOW, 5 * MINUTE).affordable).toBe(true);
  });
});

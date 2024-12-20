import { describe, expect, it } from 'vitest';
import { badgeFor, iconSpec } from '../../../src/background/icon';
import { emptySnapshot } from '../../../src/shared/constants';
import type { SessionSnapshot } from '../../../src/shared/types';

const focusSnap: SessionSnapshot = {
  ...emptySnapshot(1_000_000),
  phase: 'focus',
  startedAt: 0,
  phaseStartedAt: 0,
  phaseEndsAt: 1_500_000,
  sessionEndsAt: 1_500_000,
};

describe('iconSpec', () => {
  it('is a gray open padlock when idle', () => {
    expect(iconSpec(emptySnapshot(0))).toEqual({
      color: '#9ca3af',
      open: true,
      progress: 0,
      glyph: 'lock',
      ring: false,
    });
  });

  it('is green, closed, with phase progress during focus', () => {
    const spec = iconSpec({ ...focusSnap, at: 1_000_000, phaseEndsAt: 2_000_000 });
    expect(spec.color).toBe('#22c55e');
    expect(spec.open).toBe(false);
    expect(spec.progress).toBeCloseTo(0.5, 1);
  });

  it('keeps focus as a lock and marks only break for the cup overlay', (): void => {
    expect(iconSpec(focusSnap).glyph).toBe('lock');
    expect(iconSpec({ ...focusSnap, phase: 'break' }).glyph).toBe('cup');
  });

  it('is teal during break and amber during pause, both closed', () => {
    expect(iconSpec({ ...focusSnap, phase: 'break' }).color).toBe('#14b8a6');
    expect(iconSpec({ ...focusSnap, phase: 'paused' }).color).toBe('#f59e0b');
    expect(iconSpec({ ...focusSnap, phase: 'break' }).open).toBe(false);
  });

  it('clamps progress to [0, 1]', () => {
    expect(iconSpec({ ...focusSnap, at: 3_000_000 }).progress).toBe(1);
    expect(iconSpec({ ...focusSnap, at: -5 }).progress).toBe(0);
  });
});

describe('badgeFor', () => {
  it('shows the countdown during a session, empty when off or idle', () => {
    expect(badgeFor(focusSnap, true).text).toBe('9m');
    expect(badgeFor(focusSnap, false).text).toBe('');
    expect(badgeFor(emptySnapshot(0), true).text).toBe('');
  });

  it('uses the state color as badge color', () => {
    expect(badgeFor(focusSnap, true).color).toBe('#22c55e');
    expect(badgeFor({ ...focusSnap, phase: 'paused' }, true).color).toBe('#f59e0b');
  });
});

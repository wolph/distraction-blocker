import { describe, expect, it } from 'vitest';
import {
  advance,
  beginPause,
  endPauseEarly,
  startNextFocusEarly,
  startSession,
} from '../../../src/core/session';
import { CoreError } from '../../../src/shared/errors';
import type { SessionConfig, SessionState } from '../../../src/shared/types';

const T0 = 1_000_000_000;
const MIN = 60_000;

function cfg(partial: Partial<SessionConfig> = {}): SessionConfig {
  return {
    mode: 'blacklist',
    strictness: 'friction',
    durationMin: 60,
    cycling: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 },
    intention: 'write the report',
    source: 'manual',
    scheduleEntryId: null,
    ...partial,
  };
}

describe('startSession', () => {
  it('starts in focus with clamped phase end', () => {
    const s = startSession(cfg(), T0);
    expect(s.phase).toBe('focus');
    expect(s.phaseEndsAt).toBe(T0 + 25 * MIN);
    expect(s.sessionEndsAt).toBe(T0 + 60 * MIN);
    expect(s.cycleIndex).toBe(0);
  });
  it('without cycling the whole session is one focus phase', () => {
    const s = startSession(cfg({ cycling: null }), T0);
    expect(s.phaseEndsAt).toBe(s.sessionEndsAt);
  });
});

describe('advance', () => {
  it('is a no-op before the boundary', () => {
    const s = startSession(cfg(), T0);
    const { next, events } = advance(s, T0 + MIN);
    expect(next).toEqual(s);
    expect(events).toEqual([]);
  });
  it('moves focus to break and counts focusedMs', () => {
    const s = startSession(cfg(), T0);
    const { next, events } = advance(s, T0 + 25 * MIN + 1);
    expect(next?.phase).toBe('break');
    expect(next?.focusedMs).toBe(25 * MIN);
    expect(events).toEqual([{ type: 'phaseChanged', from: 'focus', to: 'break', at: T0 + 25 * MIN }]);
  });
  it('fast-forwards through multiple missed transitions after a worker restart', () => {
    const s = startSession(cfg(), T0);
    const { next, events } = advance(s, T0 + 32 * MIN);
    expect(next?.phase).toBe('focus');
    expect(next?.cycleIndex).toBe(1);
    expect(events.map((e) => e.type)).toEqual(['phaseChanged', 'phaseChanged']);
  });
  it('completes at sessionEndsAt with total focusedMs', () => {
    const s = startSession(cfg({ durationMin: 25, cycling: null }), T0);
    const { next, events } = advance(s, T0 + 26 * MIN);
    expect(next).toBeNull();
    expect(events).toEqual([{ type: 'completed', at: T0 + 25 * MIN, focusedMs: 25 * MIN }]);
  });
  it('uses the long break every 4th cycle', () => {
    const s = startSession(cfg({ durationMin: 180 }), T0);
    const afterFourth = advance(s, T0 + (25 * 4 + 5 * 3) * MIN + 1).next;
    expect(afterFourth?.phase).toBe('break');
    expect(afterFourth?.phaseEndsAt).toBe(T0 + (25 * 4 + 5 * 3 + 15) * MIN);
  });
});

describe('pause', () => {
  it('pauses only from focus, restores the timetable phase end', () => {
    const s = startSession(cfg(), T0);
    const p = beginPause(s, T0 + 10 * MIN, 5 * MIN);
    expect(p.phase).toBe('paused');
    expect(p.focusedMs).toBe(10 * MIN);
    expect(p.phaseEndsAt).toBe(T0 + 15 * MIN);
    const r = endPauseEarly(p, T0 + 12 * MIN);
    expect(r.phase).toBe('focus');
    expect(r.phaseEndsAt).toBe(T0 + 25 * MIN);
    const done = advance(r, T0 + 25 * MIN).next;
    expect(done?.focusedMs).toBe((10 + 13) * MIN);
  });
  it('a pause outliving its focus phase resumes into the timetable', () => {
    const s = startSession(cfg(), T0);
    const p = beginPause(s, T0 + 24 * MIN, 5 * MIN);
    const { next } = advance(p, T0 + 29 * MIN + 1);
    expect(next?.phase).toBe('break');
  });
  it('throws outside focus', () => {
    const s = startSession(cfg(), T0);
    const onBreak = advance(s, T0 + 25 * MIN + 1).next as SessionState;
    expect(() => beginPause(onBreak, T0 + 26 * MIN, MIN)).toThrow(CoreError);
  });
});

describe('startNextFocusEarly', () => {
  it('requires 2 minutes of break, then starts the next cycle', () => {
    const s = startSession(cfg(), T0);
    const onBreak = advance(s, T0 + 25 * MIN + 1).next as SessionState;
    expect(() => startNextFocusEarly(onBreak, T0 + 26 * MIN)).toThrow(CoreError);
    const early = startNextFocusEarly(onBreak, T0 + 27 * MIN + 1);
    expect(early.phase).toBe('focus');
    expect(early.cycleIndex).toBe(1);
  });
});

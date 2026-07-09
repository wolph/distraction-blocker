/**
 * The arithmetic the blocked page runs on its own from a frozen active view. The wording around
 * every number is the view's, so these cases pin the numbers and the boundary rules only.
 */
import { describe, expect, it } from 'vitest';
import {
  type AccessWait,
  type ActiveOverlayView,
  accessWait,
  focusProgress,
  remainingLabel,
} from '../../../src/content/overlay-timing';
import type { DocumentOverlayView } from '../../../src/shared/enforcement-v2';

type ActiveCopy = ActiveOverlayView['copy'];
type ActiveEconomy = ActiveOverlayView['economy'];
type ActiveTiming = ActiveOverlayView['timing'];

const NOW: number = 1_750_000_000_000;

function copy(overrides: Partial<ActiveCopy> = {}): ActiveCopy {
  return {
    nextStep: 'Your next step',
    status: { kind: 'timed', text: 'Locked until 14:35' },
    lockedUntil: '14:35',
    remainingSuffix: 'left in this session',
    minuteLabel: 'min',
    underMinuteLabel: 'Less than a minute',
    updatingLabel: 'Updating session',
    intention: 'Finish the release notes',
    verdictProvenance: 'Blocked by Social media: example.com',
    stoppedPage: null,
    accessSummary: 'Need a break or site access?',
    bankUnit: 'site access credit',
    pauseAction: 'Unlock all sites 1:00 - costs 1:00 credit',
    unlockAction: 'Unlock this site 2:00 - costs 2:00 credit',
    endAction: 'End session',
    bankWaitPrefix: 'Ready in',
    costAboveLimit: 'Cost exceeds the credit limit',
    earningOff: 'Credit earning is turned off',
    notEnoughFocus: 'Not enough time in this focus block',
    accessNote: 'You can step away at any time. Site access uses credit.',
    gateTitle: null,
    gateSaid: null,
    gateBack: 'Keep focusing',
    gatePhraseLabel: 'Type this to confirm:',
    gateForceEnd: 'Ignore timeout and end anyway',
    gateConfirm: null,
    transportError: 'Focus Lock could not update this action. Try again.',
    ...overrides,
  };
}

function view(
  timing: Partial<ActiveTiming> = {},
  economy: Partial<ActiveEconomy> = {},
  copyOverrides: Partial<ActiveCopy> = {},
): ActiveOverlayView {
  const built: DocumentOverlayView = {
    version: 1,
    presentation: 'active',
    theme: 'dark',
    sessionId: '10000000-0000-4000-8000-000000000001',
    phase: 'focus',
    mode: 'blacklist',
    strictness: 'flexible',
    duration: { kind: 'timed', minutes: 25 },
    timing: {
      capturedAt: NOW,
      phaseStartedAt: NOW - 60_000,
      phaseEndsAt: NOW + 240_000,
      sessionEndsAt: NOW + 540_000,
      ...timing,
    },
    economy: {
      bankMs: 0,
      bankAccrualPerMs: 0.5,
      bankCapMs: 300_000,
      pauseCostMs: 60_000,
      unlockCostMs: 120_000,
      ...economy,
    },
    gate: null,
    activeUnlocks: [],
    attemptsToday: 0,
    stoppedPage: false,
    actions: { state: 'ready', end: 'request-end', pause: 'request-gate', unlock: 'request-gate' },
    copy: copy(copyOverrides),
  };
  if (built.presentation !== 'active') throw new Error('unreachable');
  return built;
}

function untilStopped(economy: Partial<ActiveEconomy> = {}): ActiveOverlayView {
  return view({ phaseEndsAt: null, sessionEndsAt: null }, economy, {
    status: { kind: 'until-stopped', text: 'Until stopped' },
    lockedUntil: null,
    remainingSuffix: null,
  });
}

describe('accessWait', (): void => {
  it('counts to the action cost rather than the next whole minute', (): void => {
    expect(accessWait(view(), NOW, 60_000)).toEqual<AccessWait>({
      affordable: false,
      waitMs: 120_000,
      reason: 'ready-in',
    });
    expect(accessWait(view({}, { bankMs: 45_000 }), NOW, 60_000).waitMs).toBe(30_000);
  });

  it('grows the captured balance to the moment it is asked about', (): void => {
    expect(accessWait(view(), NOW + 120_000, 60_000)).toEqual<AccessWait>({
      affordable: true,
      waitMs: 0,
      reason: null,
    });
    expect(accessWait(view(), NOW + 60_000, 60_000).waitMs).toBe(60_000);
  });

  it('rounds a sub-second wait up without delaying affordability', (): void => {
    expect(accessWait(view({}, { bankMs: 59_900 }), NOW, 60_000).waitMs).toBe(1_000);
    expect(accessWait(view({}, { bankMs: 60_000 }), NOW, 60_000).affordable).toBe(true);
  });

  it('explains a cost the block can never reach', (): void => {
    expect(accessWait(view({}, { bankCapMs: 30_000 }), NOW, 60_000).reason).toBe('above-limit');
    expect(accessWait(view({}, { bankAccrualPerMs: 0 }), NOW, 60_000).reason).toBe('earning-off');
    expect(accessWait(view(), NOW, 120_000).reason).toBe('not-enough-time');
    expect(accessWait(view({}, { bankAccrualPerMs: Number.MIN_VALUE }), NOW, 60_000).reason).toBe(
      'not-enough-time',
    );
  });

  it('checks the limit before the earning rate, so a capped cost is named as capped', (): void => {
    expect(
      accessWait(view({}, { bankAccrualPerMs: 0, bankCapMs: 30_000 }), NOW, 60_000).reason,
    ).toBe('above-limit');
  });

  it('never promises a spend at or past the focus boundary', (): void => {
    const boundary: ActiveOverlayView = view({ phaseEndsAt: NOW + 120_000 });

    expect(accessWait(boundary, NOW, 60_000).reason).toBe('not-enough-time');
    expect(accessWait(boundary, NOW + 120_000, 60_000).reason).toBe('updating');
    expect(accessWait(view({}, { bankMs: 300_000 }), NOW + 240_000, 60_000).reason).toBe(
      'updating',
    );
  });

  it('bounds the wait by the session end when it comes before the phase end', (): void => {
    expect(accessWait(view({ sessionEndsAt: NOW + 100_000 }), NOW, 60_000).reason).toBe(
      'not-enough-time',
    );
  });

  it('keeps earning towards a cost with no focus boundary at all', (): void => {
    expect(accessWait(untilStopped(), NOW, 120_000).waitMs).toBe(240_000);
    expect(accessWait(untilStopped(), NOW + 240_000, 120_000).affordable).toBe(true);
  });
});

describe('focusProgress and remainingLabel', (): void => {
  it('clamps progress to the block and reads the earlier deadline', (): void => {
    expect(focusProgress(view(), NOW)).toBeCloseTo(0.2, 10);
    expect(focusProgress(view(), NOW + 240_000)).toBe(1);
    expect(focusProgress(view(), NOW - 120_000)).toBe(0);
    expect(focusProgress(view({ sessionEndsAt: NOW + 60_000 }), NOW)).toBeCloseTo(0.5, 10);
    expect(focusProgress(view({ phaseEndsAt: NOW - 60_000, sessionEndsAt: NOW }), NOW)).toBe(1);
    expect(focusProgress(untilStopped(), NOW + 3_600_000)).toBe(0);
  });

  it('rounds the remaining minutes up and switches to the calm last-minute label', (): void => {
    expect(remainingLabel(view(), NOW)).toBe('4 min left in this session');
    expect(remainingLabel(view(), NOW + 1)).toBe('4 min left in this session');
    expect(remainingLabel(view(), NOW + 180_000)).toBe('1 min left in this session');
    expect(remainingLabel(view(), NOW + 180_001)).toBe('Less than a minute left in this session');
    expect(remainingLabel(view(), NOW + 240_000)).toBe('Updating session');
    expect(remainingLabel(view({}, {}, { remainingSuffix: 'until your break' }), NOW)).toBe(
      '4 min until your break',
    );
    expect(remainingLabel(untilStopped(), NOW + 3_600_000)).toBe('Until stopped');
  });
});

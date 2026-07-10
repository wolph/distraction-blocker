/**
 * One frozen active view for the lock screen suites that drive the real renderer through the
 * work target flow. The picker and return tests read it as the worker's word, never as a snapshot.
 */
import type { DocumentOverlayView } from '../../../src/shared/enforcement-v2';
import type { GateState, Verdict } from '../../../src/shared/types';

export type ActiveOverlay = Extract<DocumentOverlayView, { presentation: 'active' }>;
export type ActiveCopy = ActiveOverlay['copy'];

export const SESSION_ID: string = '10000000-0000-4000-8000-000000000001';
export const OTHER_SESSION_ID: string = '10000000-0000-4000-8000-000000000002';
export const VERDICT: Verdict = {
  blocked: true,
  reason: 'category',
  categoryId: 'social',
  matchedPattern: 'blocked.example',
};

export function activeCopy(overrides: Partial<ActiveCopy> = {}): ActiveCopy {
  return {
    nextStep: 'Your next step',
    status: { kind: 'timed', text: 'Locked until 14:35' },
    lockedUntil: '14:35',
    remainingSuffix: 'left in this session',
    minuteLabel: 'min',
    underMinuteLabel: 'Less than a minute',
    updatingLabel: 'Updating session',
    intention: 'Continue your current task',
    verdictProvenance: 'Blocked by Social media: blocked.example',
    stoppedPage: null,
    backToWork: 'Back to work',
    chooseWorkTab: 'Choose a work tab',
    changeWorkTab: 'Change work tab',
    accessSummary: 'Need a break or site access?',
    bankUnit: 'site access credit',
    pauseAction: 'Unlock all sites 1:00 - costs 1:00 credit',
    unlockAction: 'Unlock this site 0:35 - costs 0:35 credit',
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

/** A Friction page one minute into a three minute block, captured now. */
export function activeView(overrides: Partial<ActiveOverlay> = {}): ActiveOverlay {
  const now: number = Date.now();
  return {
    version: 1,
    presentation: 'active',
    theme: 'auto',
    sessionId: SESSION_ID,
    phase: 'focus',
    mode: 'blacklist',
    strictness: 'friction',
    duration: { kind: 'timed', minutes: 3 },
    timing: {
      capturedAt: now,
      phaseStartedAt: now - 60_000,
      phaseEndsAt: now + 120_000,
      sessionEndsAt: now + 120_000,
    },
    economy: {
      bankMs: 60_000,
      bankAccrualPerMs: 1 / 6,
      bankCapMs: 300_000,
      pauseCostMs: 60_000,
      unlockCostMs: 35_000,
    },
    gate: null,
    activeUnlocks: [],
    attemptsToday: 2,
    stoppedPage: false,
    actions: {
      state: 'ready',
      end: 'open-end-gate',
      pause: 'request-gate',
      unlock: 'request-gate',
    },
    copy: activeCopy(),
    ...overrides,
  };
}

export function cancelGate(overrides: Partial<GateState> = {}): GateState {
  return {
    kind: 'cancel',
    host: null,
    openedAt: 1,
    readyAt: 20_000,
    requiredPhrase: 'I choose to stop',
    forceEndAvailable: false,
    ...overrides,
  };
}

/** The same page with its End gate open and the phrase still to type. */
export function gatedView(overrides: Partial<ActiveOverlay> = {}): ActiveOverlay {
  return activeView({
    gate: cancelGate(),
    actions: { state: 'gate', end: 'hidden', pause: 'hidden', unlock: 'hidden' },
    copy: activeCopy({ gateTitle: 'End this session', gateConfirm: 'End the session' }),
    ...overrides,
  });
}

export function root(): ShadowRoot {
  const handle: ShadowRoot | undefined = (globalThis as { __focusLockShadow?: ShadowRoot })
    .__focusLockShadow;
  if (handle === undefined) throw new Error('Focus Lock shadow root was not mounted');
  return handle;
}

import type {
  EndActionLabelV2,
  GateState,
  SessionDuration,
  SessionMode,
  SiteUnlock,
  Strictness,
  ThemeMode,
  Verdict,
} from './types';

export type EnforcementPresentation = 'starting' | 'active' | 'clear';

export interface StartingOverlayCopy {
  title: 'Focus Lock is starting';
  detail: 'Applying your selected rules.';
  verdictProvenance: string;
  stoppedPage: 'This page did not load. It will load by itself when the session ends.' | null;
}

/** The words after the remaining minutes. Null on an until-stopped page, which has no minutes. */
export type RemainingSuffix = 'until your break' | 'left in this session';

export interface ActiveOverlayCopy {
  /** The heading over the intention. */
  nextStep: 'Your next step';
  /**
   * The time line's wall-clock half. A timed page reads `Locked until 14:35`, an until-stopped
   * page reads `Until stopped` on its own.
   */
  status:
    | { kind: 'timed'; text: string }
    | {
        kind: 'until-stopped';
        text: 'Until stopped';
      };
  lockedUntil: string | null;
  /**
   * Chosen by the worker from the cycling plan: the break the page counts down to has to fit
   * before the session end, or the page counts to the end instead.
   */
  remainingSuffix: RemainingSuffix | null;
  /** The renderer's number formatting for the time line, so it authors no word of its own. */
  minuteLabel: 'min';
  underMinuteLabel: 'Less than a minute';
  updatingLabel: 'Updating session';
  /** The trimmed intention, or the next-step prompt the worker writes for a blank one. */
  intention: string;
  verdictProvenance: string;
  stoppedPage: 'This page did not load. It will load by itself when the session ends.' | null;
  /** The collapsed drawer that holds the credit line and every access action. */
  accessSummary: 'Need a break or site access?';
  bankUnit: 'site access credit';
  /** Each action names its own length and cost, such as `Unlock all sites 5:00 - costs 5:00 credit`. */
  pauseAction: string;
  unlockAction: string;
  /** The End control's label. A Friction until-stopped page unlocks, every other page ends. */
  endAction: EndActionLabelV2;
  /** Under an action the bank can still reach: the prefix before the renderer's countdown. */
  bankWaitPrefix: 'Ready in';
  /** Under an action this focus block can never afford, one of these says why. */
  costAboveLimit: 'Cost exceeds the credit limit';
  earningOff: 'Credit earning is turned off';
  notEnoughFocus: 'Not enough time in this focus block';
  accessNote: 'You can step away at any time. Site access uses credit.';
  gateTitle: string | null;
  /** `You said: <intention>` on an open gate, null when the session was started without one. */
  gateSaid: string | null;
  gateBack: 'Keep focusing';
  gatePhraseLabel: 'Type this to confirm:';
  /** The opt-in bypass, rendered only while the gate carries `forceEndAvailable`. */
  gateForceEnd: 'Ignore timeout and end anyway';
  gateConfirm: string | null;
  transportError: 'Focus Lock could not update this action. Try again.';
}

export type DocumentOverlayView =
  | {
      version: 1;
      presentation: 'starting';
      capturedAt: number;
      theme: ThemeMode;
      stoppedPage: boolean;
      copy: StartingOverlayCopy;
      actions: {
        end: 'hidden';
      };
    }
  | {
      version: 1;
      presentation: 'active';
      theme: ThemeMode;
      sessionId: string;
      phase: 'focus';
      mode: SessionMode;
      strictness: Strictness;
      duration: SessionDuration;
      timing: {
        capturedAt: number;
        phaseStartedAt: number;
        phaseEndsAt: number | null;
        sessionEndsAt: number | null;
      };
      economy: {
        bankMs: number;
        bankAccrualPerMs: number;
        bankCapMs: number;
        pauseCostMs: number;
        unlockCostMs: number;
      };
      gate: GateState | null;
      activeUnlocks: SiteUnlock[];
      attemptsToday: number;
      stoppedPage: boolean;
      actions:
        | {
            state: 'ready';
            end: 'hidden' | 'request-end' | 'open-end-gate';
            pause: 'request-gate';
            unlock: 'request-gate';
          }
        | {
            state: 'gate';
            end: 'hidden';
            pause: 'hidden';
            unlock: 'hidden';
          };
      copy: ActiveOverlayCopy;
    };

export interface DocumentEnforcementCommand {
  version: 1;
  command: 'apply-enforcement';
  operationId: string;
  enforcementEpoch: string;
  sessionId: string | null;
  reservedSessionId: string | null;
  basePolicyRevision: number;
  runtimeRevision: number;
  documentId: string;
  expectedUrl: string;
  presentation: EnforcementPresentation;
  verdict: Verdict;
  overlay: DocumentOverlayView | null;
}

export interface ResetEnforcementEpochCommand {
  version: 1;
  command: 'reset-enforcement-epoch';
  operationId: string;
  enforcementEpoch: string;
  documentId: string;
  expectedUrl: string;
}

export type DocumentContentCommand = ResetEnforcementEpochCommand | DocumentEnforcementCommand;

export interface ContentEnforcementTuple {
  enforcementEpoch: string;
  sessionId: string | null;
  reservedSessionId: string | null;
  basePolicyRevision: number;
  runtimeRevision: number;
}

export interface ContentEnforcementState {
  enforcementEpoch: string | null;
  retiredEnforcementEpochs: string[];
  tuple: ContentEnforcementTuple | null;
  presentation: EnforcementPresentation | null;
  verdict: Verdict | null;
  overlay: DocumentOverlayView | null;
}

export type ContentEnforcementResponse =
  | {
      version: 1;
      disposition: 'applied';
      operationId: string;
      enforcementEpoch: string;
      sessionId: string | null;
      reservedSessionId: string | null;
      basePolicyRevision: number;
      runtimeRevision: number;
      documentId: string;
      observedUrl: string;
      presentation: EnforcementPresentation;
      verdict: Verdict;
      overlay: DocumentOverlayView | null;
      handledAt: number;
    }
  | {
      version: 1;
      disposition: 'stale-command';
      operationId: string;
      enforcementEpoch: string;
      documentId: string;
      observedUrl: string;
      requested: {
        enforcementEpoch: string;
        sessionId: string | null;
        reservedSessionId: string | null;
        basePolicyRevision: number;
        runtimeRevision: number;
      };
      current: {
        enforcementEpoch: string;
        sessionId: string | null;
        reservedSessionId: string | null;
        basePolicyRevision: number;
        runtimeRevision: number;
      };
      handledAt: number;
    }
  | {
      version: 1;
      disposition: 'reset-required';
      operationId: string;
      enforcementEpoch: string;
      documentId: string;
      observedUrl: string;
      requestedEpoch: string;
      currentEpoch: string | null;
      handledAt: number;
    }
  | {
      version: 1;
      disposition: 'epoch-reset';
      operationId: string;
      enforcementEpoch: string;
      documentId: string;
      observedUrl: string;
      handledAt: number;
    }
  | {
      version: 1;
      disposition: 'epoch-reset-rejected';
      operationId: string;
      enforcementEpoch: string;
      currentEpoch: string;
      reason: 'retired-epoch';
      documentId: string;
      observedUrl: string;
      handledAt: number;
    };

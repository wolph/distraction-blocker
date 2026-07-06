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

export interface ActiveOverlayCopy {
  status:
    | { kind: 'timed'; text: string }
    | {
        kind: 'until-stopped';
        text: 'Focus Lock is active until you stop it.';
      };
  lockedUntil: string | null;
  intention: string | null;
  attempts: string;
  verdictProvenance: string;
  stoppedPage: 'This page did not load. It will load by itself when the session ends.' | null;
  bankUnit: 'site access credit';
  pauseAction: string;
  unlockAction: string;
  /** The End control's label. A Friction until-stopped page unlocks, every other page ends. */
  endAction: EndActionLabelV2;
  bankWaitFallback: 'earn site access credit by focusing';
  bankWaitPrefix: 'Ready in';
  gateTitle: string | null;
  gateBack: 'Never mind, back to work';
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

import { describe, expectTypeOf, it } from 'vitest';
import type { FrozenEpochResetCommand } from '../../../src/background/enforcement-persistence-v2';
import type {
  ActiveOverlayCopy,
  ContentEnforcementResponse,
  ContentEnforcementState,
  ContentEnforcementTuple,
  DocumentContentCommand,
  DocumentEnforcementCommand,
  DocumentOverlayView,
  EnforcementPresentation,
  ResetEnforcementEpochCommand,
  StartingOverlayCopy,
} from '../../../src/shared/enforcement-v2';
import type {
  GateState,
  SessionDuration,
  SessionMode,
  SiteUnlock,
  Strictness,
  ThemeMode,
  Verdict,
} from '../../../src/shared/types';

type MemberKeys<T> = T extends unknown ? keyof T : never;

describe('shared enforcement v2 contracts', (): void => {
  it('pins the presentation and exact overlay copy contracts', (): void => {
    expectTypeOf<EnforcementPresentation>().toEqualTypeOf<'starting' | 'active' | 'clear'>();
    expectTypeOf<StartingOverlayCopy>().toEqualTypeOf<{
      title: 'Focus Lock is starting';
      detail: 'Applying your selected rules.';
      verdictProvenance: string;
      stoppedPage: 'This page did not load. It will load by itself when the session ends.' | null;
    }>();
    expectTypeOf<ActiveOverlayCopy>().toEqualTypeOf<{
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
      bankUnit: 'pause banked';
      pauseAction: string;
      unlockAction: string;
      endAction: 'End session' | 'Unlock';
      bankWaitFallback: 'earn pause time by focusing';
      bankWaitPrefix: 'ready in';
      gateTitle: string | null;
      gateBack: 'Never mind, back to work';
      gatePhraseLabel: 'Type this to confirm:';
      gateForceEnd: 'Ignore timeout and end anyway';
      gateConfirm: string | null;
      transportError: 'Focus Lock could not update this action. Try again.';
    }>();
  });

  it('pins starting and active overlay fields and action tags', (): void => {
    expectTypeOf<DocumentOverlayView>().toEqualTypeOf<
      | {
          version: 1;
          presentation: 'starting';
          capturedAt: number;
          theme: ThemeMode;
          stoppedPage: boolean;
          copy: StartingOverlayCopy;
          actions: { end: 'hidden' };
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
        }
    >();
  });

  it('keeps the wire command tab-free and pins every command field', (): void => {
    expectTypeOf<DocumentEnforcementCommand>().toEqualTypeOf<{
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
    }>();
    expectTypeOf<Extract<'tabId', keyof DocumentEnforcementCommand>>().toEqualTypeOf<never>();
  });
  it('pins the reset command and the tab-free content command union', (): void => {
    expectTypeOf<ResetEnforcementEpochCommand>().toEqualTypeOf<{
      version: 1;
      command: 'reset-enforcement-epoch';
      operationId: string;
      enforcementEpoch: string;
      documentId: string;
      expectedUrl: string;
    }>();
    expectTypeOf<DocumentContentCommand>().toEqualTypeOf<
      ResetEnforcementEpochCommand | DocumentEnforcementCommand
    >();
    expectTypeOf<Extract<'tabId', MemberKeys<DocumentContentCommand>>>().toEqualTypeOf<never>();
    expectTypeOf<
      Omit<FrozenEpochResetCommand, 'tabId'>
    >().toEqualTypeOf<ResetEnforcementEpochCommand>();
    expectTypeOf<FrozenEpochResetCommand['tabId']>().toEqualTypeOf<number>();
  });

  it('pins the content enforcement tuple and stored content state', (): void => {
    expectTypeOf<ContentEnforcementTuple>().toEqualTypeOf<{
      enforcementEpoch: string;
      sessionId: string | null;
      reservedSessionId: string | null;
      basePolicyRevision: number;
      runtimeRevision: number;
    }>();
    expectTypeOf<ContentEnforcementState>().toEqualTypeOf<{
      enforcementEpoch: string | null;
      retiredEnforcementEpochs: string[];
      tuple: ContentEnforcementTuple | null;
      presentation: EnforcementPresentation | null;
      verdict: Verdict | null;
      overlay: DocumentOverlayView | null;
    }>();
  });

  it('pins every content response disposition and keeps responses tab-free', (): void => {
    expectTypeOf<ContentEnforcementResponse>().toEqualTypeOf<
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
        }
    >();
    expectTypeOf<Extract<'tabId', MemberKeys<ContentEnforcementResponse>>>().toEqualTypeOf<never>();
  });
});

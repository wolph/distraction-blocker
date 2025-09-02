import { describe, expectTypeOf, it } from 'vitest';
import type {
  ActiveOverlayCopy,
  DocumentEnforcementCommand,
  DocumentOverlayView,
  EnforcementPresentation,
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
            text: 'Focus Lock is active until you end it from the popup.';
          };
      lockedUntil: string | null;
      intention: string | null;
      attempts: string;
      verdictProvenance: string;
      stoppedPage: 'This page did not load. It will load by itself when the session ends.' | null;
      bankUnit: 'pause banked';
      pauseAction: string;
      unlockAction: string;
      endAction: 'End session';
      bankWaitFallback: 'earn pause time by focusing';
      bankWaitPrefix: 'ready in';
      gateTitle: string | null;
      gateBack: 'Never mind, back to work';
      gatePhraseLabel: 'Type this to confirm:';
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
                end: 'hidden' | 'request-end';
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
});

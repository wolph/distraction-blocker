import { describe, expect, it } from 'vitest';
import {
  isCanonicalSessionRuleSnapshot,
  isScheduleOccurrenceRef,
  isSessionConfigV2,
  isSessionDuration,
  isSessionStateV2,
} from '../../../src/shared/runtime-validation';
import type { SessionStateV2 } from '../../../src/shared/types';
import {
  validateDetachedCanonicalSessionRuleSnapshot,
  validateDetachedCycleConfigV2,
  validateDetachedGateState,
  validateDetachedPausedFromStateV2,
  validateDetachedScheduleOccurrenceRef,
  validateDetachedSessionConfigV2,
  validateDetachedSessionDuration,
  validateDetachedSessionStateV2,
  validateDetachedSiteUnlock,
} from '../../../src/shared/v2-domain-intrinsics';
import {
  MANUAL_INDEFINITE_CONFIG,
  MANUAL_TIMED_CONFIG,
  NOW,
  OCCURRENCE,
  SESSION_ID,
} from './v2-runtime-fixtures';

const TIMED_STATE: SessionStateV2 = {
  version: 2,
  sessionId: SESSION_ID,
  config: MANUAL_TIMED_CONFIG,
  startedAt: NOW,
  sessionEndsAt: NOW + 25 * 60_000,
  phase: 'focus',
  phaseStartedAt: NOW,
  phaseEndsAt: NOW + 25 * 60_000,
  cycleIndex: 0,
  pausedFrom: null,
  focusedMs: 0,
};

describe('detached v2 domain intrinsics', (): void => {
  it.each([
    [
      isCanonicalSessionRuleSnapshot,
      validateDetachedCanonicalSessionRuleSnapshot,
      MANUAL_TIMED_CONFIG.rules,
    ],
    [isSessionDuration, validateDetachedSessionDuration, MANUAL_TIMED_CONFIG.duration],
    [isScheduleOccurrenceRef, validateDetachedScheduleOccurrenceRef, OCCURRENCE],
    [isSessionConfigV2, validateDetachedSessionConfigV2, MANUAL_TIMED_CONFIG],
    [isSessionStateV2, validateDetachedSessionStateV2, TIMED_STATE],
  ] satisfies Array<[(value: unknown) => boolean, (value: unknown) => boolean, unknown]>)(
    'agrees with public guard %# on canonical detached values',
    (publicGuard: (value: unknown) => boolean, detachedGuard: (
      value: unknown,
    ) => boolean, canonical: unknown): void => {
      const detached: unknown = structuredClone(canonical);
      expect(detachedGuard(detached)).toBe(true);
      expect(publicGuard(detached)).toBe(detachedGuard(detached));
    },
  );

  it('validates cycle, paused-from, gate, and site-unlock leaves', (): void => {
    expect(
      validateDetachedCycleConfigV2({
        focusMin: 25,
        shortBreakMin: 5,
        longBreakMin: 15,
        longEvery: 4,
      }),
    ).toBe(true);
    expect(validateDetachedCycleConfigV2({ focusMin: 25 })).toBe(false);
    expect(validateDetachedPausedFromStateV2({ phase: 'focus', phaseEndsAt: null })).toBe(true);
    expect(validateDetachedPausedFromStateV2({ phase: 'idle', phaseEndsAt: null })).toBe(false);
    expect(
      validateDetachedGateState({
        kind: 'unlockSite',
        host: 'example.com',
        openedAt: NOW,
        readyAt: NOW + 1,
        requiredPhrase: null,
        forceEndAvailable: false,
      }),
    ).toBe(true);
    expect(
      validateDetachedGateState({
        kind: 'cancel',
        host: null,
        openedAt: NOW,
        readyAt: NOW + 1,
        requiredPhrase: null,
        forceEndAvailable: true,
      }),
    ).toBe(true);
    expect(
      validateDetachedGateState({
        kind: 'pause',
        host: 'example.com',
        openedAt: NOW,
        readyAt: NOW + 1,
        requiredPhrase: null,
        forceEndAvailable: false,
      }),
    ).toBe(false);
    // The worker-minted force end flag is part of the exact gate, never optional or loose.
    expect(
      validateDetachedGateState({
        kind: 'cancel',
        host: null,
        openedAt: NOW,
        readyAt: NOW + 1,
        requiredPhrase: null,
      }),
    ).toBe(false);
    expect(
      validateDetachedGateState({
        kind: 'cancel',
        host: null,
        openedAt: NOW,
        readyAt: NOW + 1,
        requiredPhrase: null,
        forceEndAvailable: 'true',
      }),
    ).toBe(false);
    expect(validateDetachedSiteUnlock({ host: 'example.com', until: NOW + 1 })).toBe(true);
    expect(validateDetachedSiteUnlock({ host: '', until: NOW + 1 })).toBe(false);
  });

  it('preserves timed and indefinite state relationships', (): void => {
    const indefinite: SessionStateV2 = {
      ...TIMED_STATE,
      config: MANUAL_INDEFINITE_CONFIG,
      sessionEndsAt: null,
      phaseEndsAt: null,
    };

    expect(validateDetachedSessionStateV2(TIMED_STATE)).toBe(true);
    expect(validateDetachedSessionStateV2(indefinite)).toBe(true);
    expect(
      validateDetachedSessionStateV2({
        ...indefinite,
        config: { ...MANUAL_INDEFINITE_CONFIG, strictness: 'friction' },
      }),
    ).toBe(true);
    expect(
      validateDetachedSessionStateV2({
        ...indefinite,
        config: { ...MANUAL_INDEFINITE_CONFIG, strictness: 'hard' },
      }),
    ).toBe(false);
    expect(validateDetachedSessionStateV2({ ...indefinite, sessionEndsAt: NOW + 1 })).toBe(false);
  });

  it('keeps hostile input rejection at every public boundary', (): void => {
    const validators: ReadonlyArray<(value: unknown) => boolean> = [
      isCanonicalSessionRuleSnapshot,
      isSessionDuration,
      isScheduleOccurrenceRef,
      isSessionConfigV2,
      isSessionStateV2,
    ];
    const revocable: { proxy: object; revoke: () => void } = Proxy.revocable({}, {});
    revocable.revoke();
    const throwing: object = new Proxy(
      {},
      {
        ownKeys: (): never => {
          throw new Error('ownKeys trap');
        },
      },
    );

    for (const hostile of [revocable.proxy, throwing]) {
      for (const validate of validators) {
        expect((): boolean => validate(hostile)).not.toThrow();
        expect(validate(hostile)).toBe(false);
      }
    }
  });
});

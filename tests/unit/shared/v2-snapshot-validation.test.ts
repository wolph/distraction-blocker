import { describe, expect, it } from 'vitest';
import { cancelPhrase, emptySnapshotV2 } from '../../../src/shared/constants';
import { isSessionSnapshotV2 } from '../../../src/shared/runtime-validation';
import type {
  EndAuthorityV2,
  GateState,
  SessionConfigV2,
  SessionLifecycleV2,
  SessionSnapshotV2,
  SiteUnlock,
} from '../../../src/shared/types';
import {
  activeSnapshotV2,
  CLOSED_FRICTION_AUTHORITY,
  HIDDEN_AUTHORITY,
  IMMEDIATE_AUTHORITY,
  OPEN_FRICTION_AUTHORITY,
} from './v2-public-fixtures';
import {
  MANUAL_INDEFINITE_CONFIG,
  MANUAL_TIMED_CONFIG,
  NOW,
  OCCURRENCE,
  SESSION_ID,
} from './v2-runtime-fixtures';

const CYCLING_50_CONFIG: SessionConfigV2 = {
  ...MANUAL_TIMED_CONFIG,
  duration: { kind: 'timed', minutes: 50 },
  cycling: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 },
};

function withGate(snapshot: SessionSnapshotV2, gate: GateState): SessionSnapshotV2 {
  const endAuthority: EndAuthorityV2 =
    gate.kind === 'cancel'
      ? { ...OPEN_FRICTION_AUTHORITY, gate: { ...gate, kind: 'cancel' } }
      : snapshot.lifecycle.kind === 'active'
        ? snapshot.lifecycle.endAuthority
        : HIDDEN_AUTHORITY;
  return {
    ...snapshot,
    lifecycle: {
      kind: 'active',
      endAuthority,
    },
    gate,
  };
}

describe('v2 public snapshot validation', (): void => {
  it('accepts exact idle, timed, cycling, and indefinite snapshots', (): void => {
    const cycling: SessionSnapshotV2 = activeSnapshotV2(CYCLING_50_CONFIG);
    const shortCycling: SessionSnapshotV2 = activeSnapshotV2({
      ...CYCLING_50_CONFIG,
      duration: { kind: 'timed', minutes: 10 },
    });

    expect(isSessionSnapshotV2(emptySnapshotV2(NOW))).toBe(true);
    expect(isSessionSnapshotV2(activeSnapshotV2())).toBe(true);
    expect(isSessionSnapshotV2(activeSnapshotV2(MANUAL_INDEFINITE_CONFIG))).toBe(true);
    expect(cycling.phaseEndsAt).toBe(NOW + 25 * 60_000);
    expect(cycling.sessionEndsAt).toBe(NOW + 50 * 60_000);
    expect(isSessionSnapshotV2(cycling)).toBe(true);
    expect(shortCycling.phaseEndsAt).toBe(NOW + 10 * 60_000);
    expect(shortCycling.sessionEndsAt).toBe(NOW + 10 * 60_000);
    expect(isSessionSnapshotV2(shortCycling)).toBe(true);
    expect(
      isSessionSnapshotV2(
        activeSnapshotV2({
          ...MANUAL_TIMED_CONFIG,
          duration: { kind: 'timed', minutes: 60_001 / 60_000 },
        }),
      ),
    ).toBe(true);
    expect(
      isSessionSnapshotV2({
        ...activeSnapshotV2({
          ...MANUAL_TIMED_CONFIG,
          source: 'schedule',
          scheduleOccurrence: OCCURRENCE,
        }),
        scheduleActive: true,
      }),
    ).toBe(true);
  });

  it('accepts settled focus, break, pause, unlock, gate, and schedule read models', (): void => {
    const at: number = NOW + 25 * 60_000 + 10_000;
    const pauseGate: GateState = {
      kind: 'pause',
      host: null,
      openedAt: NOW + 1_000,
      readyAt: NOW + 11_000,
      requiredPhrase: null,
    };
    const unlock: SiteUnlock = { host: 'example.com', until: NOW + 20_000 };

    expect(
      isSessionSnapshotV2({
        ...activeSnapshotV2(CYCLING_50_CONFIG),
        at,
        phase: 'break',
        phaseStartedAt: NOW + 25 * 60_000,
        phaseEndsAt: NOW + 30 * 60_000,
        sessionFocusedMs: 25 * 60_000,
        cycleIndex: 1,
        bankAccrualPerMs: 0,
      }),
    ).toBe(true);
    expect(
      isSessionSnapshotV2({
        ...activeSnapshotV2(MANUAL_INDEFINITE_CONFIG),
        phase: 'paused',
        phaseStartedAt: NOW + 10_000,
        phaseEndsAt: NOW + 5 * 60_000,
        sessionEndsAt: null,
        bankAccrualPerMs: 0,
      }),
    ).toBe(true);
    expect(isSessionSnapshotV2(withGate(activeSnapshotV2(), pauseGate))).toBe(true);
    expect(
      isSessionSnapshotV2({
        ...activeSnapshotV2(),
        activeUnlocks: [unlock],
        nextSchedule: { entryId: 'weekday', startsAt: NOW + 20_000 },
      }),
    ).toBe(true);
  });

  it('accepts open Friction authority with or without a typed phrase', (): void => {
    const openWithPhrase: SessionSnapshotV2 = {
      ...activeSnapshotV2(),
      lifecycle: { kind: 'active', endAuthority: OPEN_FRICTION_AUTHORITY },
      gate: OPEN_FRICTION_AUTHORITY.gate,
    };
    const nullPhraseGate: GateState & { kind: 'cancel' } = {
      ...OPEN_FRICTION_AUTHORITY.gate,
      requiredPhrase: null,
    };

    expect(isSessionSnapshotV2(openWithPhrase)).toBe(true);
    expect(
      isSessionSnapshotV2({
        ...activeSnapshotV2({ ...MANUAL_TIMED_CONFIG, intention: '  Review the release  ' }),
        lifecycle: {
          kind: 'active',
          endAuthority: { ...OPEN_FRICTION_AUTHORITY, gate: nullPhraseGate },
        },
        gate: nullPhraseGate,
      }),
    ).toBe(true);
  });

  it.each([
    { ...emptySnapshotV2(NOW), lifecycle: { kind: 'active', endAuthority: HIDDEN_AUTHORITY } },
    { ...emptySnapshotV2(NOW), phase: 'focus' },
    { ...emptySnapshotV2(NOW), config: MANUAL_INDEFINITE_CONFIG },
    { ...emptySnapshotV2(NOW), sessionFocusedMs: 1 },
    { ...emptySnapshotV2(NOW), cycleIndex: 1 },
    { ...emptySnapshotV2(NOW), bankAccrualPerMs: 1 },
    { ...emptySnapshotV2(NOW), scheduleActive: true },
    { ...emptySnapshotV2(NOW), activeUnlocks: [{ host: 'example.com', until: NOW + 1 }] },
    { ...emptySnapshotV2(NOW), canEnd: false },
    {
      ...activeSnapshotV2(MANUAL_INDEFINITE_CONFIG),
      lifecycle: { kind: 'active', endAuthority: HIDDEN_AUTHORITY },
    },
    {
      ...activeSnapshotV2({ ...MANUAL_TIMED_CONFIG, strictness: 'hard' }),
      lifecycle: { kind: 'active', endAuthority: IMMEDIATE_AUTHORITY },
    },
    {
      ...activeSnapshotV2(),
      lifecycle: { kind: 'active', endAuthority: IMMEDIATE_AUTHORITY },
    },
    { ...activeSnapshotV2(CYCLING_50_CONFIG), sessionEndsAt: NOW + 25 * 60_000 },
    { ...activeSnapshotV2(MANUAL_INDEFINITE_CONFIG), sessionEndsAt: NOW + 1 },
    { ...activeSnapshotV2(MANUAL_INDEFINITE_CONFIG), phaseEndsAt: NOW + 1 },
    { ...activeSnapshotV2(), sessionEndsAt: null },
    { ...activeSnapshotV2(), phaseEndsAt: null },
    { ...activeSnapshotV2(), sessionFocusedMs: Number.NaN },
    { ...activeSnapshotV2(), sessionFocusedMs: 10_001 },
    { ...activeSnapshotV2(), bankMs: 1_800_001 },
    {
      ...activeSnapshotV2(),
      config: {
        ...MANUAL_TIMED_CONFIG,
        rules: {
          ...MANUAL_TIMED_CONFIG.rules,
          sessionAllowlist: [{ kind: 'host', pattern: 'HTTPS://Docs.Python.org/guide/' }],
        },
      },
    },
    { ...activeSnapshotV2(), phase: 'other' },
    { ...activeSnapshotV2(), scheduleActive: true },
    {
      ...activeSnapshotV2({
        ...MANUAL_TIMED_CONFIG,
        source: 'schedule',
        scheduleOccurrence: OCCURRENCE,
      }),
      scheduleActive: false,
    },
    { ...activeSnapshotV2(), phaseStartedAt: NOW + 20_000 },
    { ...activeSnapshotV2(), startedAt: NOW + 20_000 },
    { ...activeSnapshotV2(), phaseStartedAt: NOW - 1 },
    { ...activeSnapshotV2(), phaseEndsAt: NOW + 10_000 },
    { ...activeSnapshotV2(), sessionEndsAt: NOW + 10_000 },
    {
      ...activeSnapshotV2(),
      startedAt: Number.MAX_SAFE_INTEGER - 1,
      at: Number.MAX_SAFE_INTEGER,
      phaseStartedAt: Number.MAX_SAFE_INTEGER - 1,
      phaseEndsAt: Number.MAX_SAFE_INTEGER,
      sessionEndsAt: Number.MAX_SAFE_INTEGER,
      sessionFocusedMs: 1,
    },
    {
      ...activeSnapshotV2(),
      lifecycle: { kind: 'active', endAuthority: OPEN_FRICTION_AUTHORITY },
      gate: null,
    },
    {
      ...activeSnapshotV2(),
      lifecycle: { kind: 'active', endAuthority: CLOSED_FRICTION_AUTHORITY },
      gate: OPEN_FRICTION_AUTHORITY.gate,
    },
    {
      ...activeSnapshotV2(),
      lifecycle: {
        kind: 'active',
        endAuthority: {
          ...OPEN_FRICTION_AUTHORITY,
          gate: {
            ...OPEN_FRICTION_AUTHORITY.gate,
            requiredPhrase: 'I am ending this focus session early',
          },
        },
      },
      gate: {
        ...OPEN_FRICTION_AUTHORITY.gate,
        requiredPhrase: 'I am ending this focus session early',
      },
    },
    {
      ...activeSnapshotV2(),
      lifecycle: {
        kind: 'active',
        endAuthority: {
          ...OPEN_FRICTION_AUTHORITY,
          copy: { ...OPEN_FRICTION_AUTHORITY.copy, intentionReminder: 'Other work' },
        },
      },
      gate: OPEN_FRICTION_AUTHORITY.gate,
    },
    { ...activeSnapshotV2(), extra: true },
  ])('rejects illegal snapshot %#', (value: unknown): void => {
    expect(isSessionSnapshotV2(value)).toBe(false);
  });

  it('rejects stale unlocks and non-exact unlock arrays without array methods', (): void => {
    const stale: SiteUnlock = { host: 'example.com', until: NOW + 10_000 };
    const withExtra: SiteUnlock & { extra: boolean } = {
      ...stale,
      until: NOW + 20_000,
      extra: true,
    };
    const withSymbol: SiteUnlock = { ...stale, until: NOW + 20_000 };
    Object.defineProperty(withSymbol, Symbol('extra'), { value: true, enumerable: true });
    const sparse: SiteUnlock[] = new Array<SiteUnlock>(1);
    const nullPrototype: SiteUnlock[] = [{ ...stale, until: NOW + 20_000 }];
    Object.setPrototypeOf(nullPrototype, null);
    const customPrototype: SiteUnlock[] = [{ ...stale, until: NOW + 20_000 }];
    Object.setPrototypeOf(customPrototype, Object.create(Array.prototype));
    const overriddenEvery: SiteUnlock[] = [{ ...stale, until: NOW + 20_000 }];
    Object.defineProperty(overriddenEvery, 'every', {
      value: (): boolean => true,
      enumerable: true,
    });

    expect(isSessionSnapshotV2({ ...activeSnapshotV2(), activeUnlocks: [stale] })).toBe(false);
    expect(isSessionSnapshotV2({ ...activeSnapshotV2(), activeUnlocks: [withExtra] })).toBe(false);
    expect(isSessionSnapshotV2({ ...activeSnapshotV2(), activeUnlocks: [withSymbol] })).toBe(false);
    expect(isSessionSnapshotV2({ ...activeSnapshotV2(), activeUnlocks: sparse })).toBe(false);
    expect(isSessionSnapshotV2({ ...activeSnapshotV2(), activeUnlocks: nullPrototype })).toBe(
      false,
    );
    expect(isSessionSnapshotV2({ ...activeSnapshotV2(), activeUnlocks: customPrototype })).toBe(
      false,
    );
    expect(isSessionSnapshotV2({ ...activeSnapshotV2(), activeUnlocks: overriddenEvery })).toBe(
      false,
    );
  });

  it('validates gate timestamps while preserving gates across phase transitions', (): void => {
    const futureGate: GateState & { kind: 'cancel' } = {
      ...OPEN_FRICTION_AUTHORITY.gate,
      openedAt: NOW + 10_001,
      readyAt: NOW + 20_001,
    };
    const pauseGate: GateState = {
      kind: 'pause',
      host: null,
      openedAt: NOW,
      readyAt: NOW + 1,
      requiredPhrase: null,
    };
    const unlockGate: GateState = {
      ...pauseGate,
      kind: 'unlockSite',
      host: 'example.com',
    };
    const paused: SessionSnapshotV2 = {
      ...activeSnapshotV2(MANUAL_INDEFINITE_CONFIG),
      phase: 'paused',
      phaseStartedAt: NOW + 10_000,
      phaseEndsAt: NOW + 20_000,
      bankAccrualPerMs: 0,
    };
    const breaking: SessionSnapshotV2 = {
      ...activeSnapshotV2(CYCLING_50_CONFIG),
      at: NOW + 25 * 60_000 + 1,
      phase: 'break',
      phaseStartedAt: NOW + 25 * 60_000,
      phaseEndsAt: NOW + 30 * 60_000,
      sessionFocusedMs: 25 * 60_000,
      cycleIndex: 1,
      bankAccrualPerMs: 0,
    };

    expect(isSessionSnapshotV2(withGate(activeSnapshotV2(), futureGate))).toBe(false);
    expect(isSessionSnapshotV2(withGate(paused, pauseGate))).toBe(true);
    expect(isSessionSnapshotV2(withGate(breaking, unlockGate))).toBe(true);
    expect(
      isSessionSnapshotV2({
        ...activeSnapshotV2(),
        nextSchedule: { entryId: 'weekday', startsAt: NOW + 10_000 },
      }),
    ).toBe(false);
    expect(
      isSessionSnapshotV2({
        ...activeSnapshotV2(),
        nextSchedule: { entryId: 'weekday', startsAt: NOW + 20_000, extra: true },
      }),
    ).toBe(false);
  });

  it('rejects mutable accessors and proxies at root and nested boundaries', (): void => {
    let accessorReads: number = 0;
    const rootAccessor: Record<string, unknown> = { ...activeSnapshotV2() };
    Object.defineProperty(rootAccessor, 'phase', {
      enumerable: true,
      get: (): string => {
        accessorReads += 1;
        return 'focus';
      },
    });
    const configAccessor: Record<string, unknown> = structuredClone(
      MANUAL_TIMED_CONFIG,
    ) as unknown as Record<string, unknown>;
    Object.defineProperty(configAccessor, 'duration', {
      enumerable: true,
      get: (): SessionConfigV2['duration'] => {
        accessorReads += 1;
        return { kind: 'timed', minutes: 25 };
      },
    });
    const unlockAccessor: Record<string, unknown> = { host: 'example.com', until: NOW + 20_000 };
    Object.defineProperty(unlockAccessor, 'until', {
      enumerable: true,
      get: (): number => {
        accessorReads += 1;
        return NOW + 20_000;
      },
    });
    const nextScheduleAccessor: Record<string, unknown> = {
      entryId: 'weekday',
      startsAt: NOW + 20_000,
    };
    Object.defineProperty(nextScheduleAccessor, 'startsAt', {
      enumerable: true,
      get: (): number => {
        accessorReads += 1;
        return NOW + 20_000;
      },
    });

    expect(isSessionSnapshotV2(rootAccessor)).toBe(false);
    expect(isSessionSnapshotV2({ ...activeSnapshotV2(), config: configAccessor })).toBe(false);
    expect(isSessionSnapshotV2({ ...activeSnapshotV2(), activeUnlocks: [unlockAccessor] })).toBe(
      false,
    );
    expect(isSessionSnapshotV2({ ...activeSnapshotV2(), nextSchedule: nextScheduleAccessor })).toBe(
      false,
    );
    expect(isSessionSnapshotV2(new Proxy(activeSnapshotV2(), {}))).toBe(false);
    expect(
      isSessionSnapshotV2({
        ...activeSnapshotV2(),
        config: new Proxy(MANUAL_TIMED_CONFIG, {}),
      }),
    ).toBe(false);
    expect(
      isSessionSnapshotV2({
        ...activeSnapshotV2(),
        activeUnlocks: [new Proxy({ host: 'example.com', until: NOW + 20_000 }, {})],
      }),
    ).toBe(false);
    expect(accessorReads).toBe(0);
  });

  it('rejects a nested proxy that mutates the root between boundary reads', (): void => {
    const snapshot: SessionSnapshotV2 | Record<string, unknown> = {
      ...activeSnapshotV2(),
      nextSchedule: null,
    };
    const scheduleTarget: { entryId: string; startsAt: number } = {
      entryId: 'weekday',
      startsAt: NOW + 20_000,
    };
    const scheduleProxy: { entryId: string; startsAt: number } = new Proxy(scheduleTarget, {
      ownKeys: (target: { entryId: string; startsAt: number }): ArrayLike<string | symbol> => {
        snapshot.config = 17;
        snapshot.nextSchedule = null;
        return Reflect.ownKeys(target);
      },
    });
    snapshot.nextSchedule = scheduleProxy;

    expect(isSessionSnapshotV2(snapshot)).toBe(false);
    expect(snapshot.config).toBe(17);
  });

  it('rejects a nested proxy that diverges the captured candidate from the root', (): void => {
    const snapshot: Record<string, unknown> = { ...activeSnapshotV2(), nextSchedule: null };
    const config: Record<string, unknown> = {
      ...MANUAL_TIMED_CONFIG,
      duration: null,
    };
    const durationTarget: { kind: 'timed'; minutes: number } = { kind: 'timed', minutes: 25 };
    const durationProxy: { kind: 'timed'; minutes: number } = new Proxy(durationTarget, {
      ownKeys: (target: { kind: 'timed'; minutes: number }): ArrayLike<string | symbol> => {
        config.duration = { kind: 'timed', minutes: 25 };
        snapshot.nextSchedule = 17;
        return Reflect.ownKeys(target);
      },
    });
    config.duration = durationProxy;
    snapshot.config = config;

    expect(isSessionSnapshotV2(snapshot)).toBe(false);
    expect(snapshot.nextSchedule).toBe(17);
  });

  it('rejects impossible settled-focus projections', (): void => {
    const paused: SessionSnapshotV2 = {
      ...activeSnapshotV2(MANUAL_INDEFINITE_CONFIG),
      phase: 'paused',
      phaseStartedAt: NOW + 10_000,
      phaseEndsAt: NOW + 20_000,
      bankAccrualPerMs: 0,
    };
    const breaking: SessionSnapshotV2 = {
      ...activeSnapshotV2(CYCLING_50_CONFIG),
      at: NOW + 25 * 60_000 + 10_000,
      phase: 'break',
      phaseStartedAt: NOW + 25 * 60_000,
      phaseEndsAt: NOW + 30 * 60_000,
      sessionFocusedMs: 25 * 60_000,
      cycleIndex: 1,
      bankAccrualPerMs: 0,
    };

    expect(isSessionSnapshotV2({ ...activeSnapshotV2(), sessionFocusedMs: 0 })).toBe(false);
    expect(isSessionSnapshotV2({ ...paused, sessionFocusedMs: 10_001 })).toBe(false);
    expect(isSessionSnapshotV2({ ...breaking, sessionFocusedMs: 25 * 60_000 + 1 })).toBe(false);
  });

  it.each([
    {
      kind: 'starting',
      operationId: SESSION_ID,
      transition: 'start',
      endAuthority: HIDDEN_AUTHORITY,
    },
    {
      kind: 'starting',
      operationId: SESSION_ID,
      transition: 'resume',
      endAuthority: IMMEDIATE_AUTHORITY,
    },
    {
      kind: 'cleanup',
      journal: 'closure',
      id: SESSION_ID,
      endAuthority: HIDDEN_AUTHORITY,
    },
    {
      kind: 'error',
      code: 'transition-cleanup-failed',
      retryAvailable: true,
      endAuthority: HIDDEN_AUTHORITY,
    },
  ] satisfies SessionLifecycleV2[])('hides active fields for lifecycle %#', (lifecycle): void => {
    expect(isSessionSnapshotV2({ ...emptySnapshotV2(NOW), lifecycle })).toBe(true);
    expect(
      isSessionSnapshotV2({
        ...emptySnapshotV2(NOW),
        lifecycle,
        config: MANUAL_INDEFINITE_CONFIG,
      }),
    ).toBe(false);
  });

  it('requires exact cancellation copy derived from immutable config', (): void => {
    expect(OPEN_FRICTION_AUTHORITY.gate.requiredPhrase).toBe(cancelPhrase('Review the release'));
    expect(
      isSessionSnapshotV2({
        ...activeSnapshotV2(),
        lifecycle: {
          kind: 'active',
          endAuthority: {
            ...OPEN_FRICTION_AUTHORITY,
            copy: { ...OPEN_FRICTION_AUTHORITY.copy, confirm: 'Stop now' },
          },
        },
        gate: OPEN_FRICTION_AUTHORITY.gate,
      }),
    ).toBe(false);
  });
});

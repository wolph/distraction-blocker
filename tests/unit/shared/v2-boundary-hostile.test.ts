import { describe, expect, it, vi } from 'vitest';
import {
  isCanonicalSessionRuleSnapshot,
  isCycleConfig,
  isEventRecord,
  isListsConfig,
  isPauseEconomy,
  isScheduleDuration,
  isScheduleEntryV2,
  isScheduleOccurrenceRef,
  isSessionConfigV2,
  isSessionDuration,
  isSessionEndedEventV2,
  isSessionLifecycleV2,
  isSessionSnapshotV2,
  isSessionStartedEventV2,
  isSessionStateV2,
  isSettings,
  parseStoredSettingsV2,
} from '../../../src/shared/runtime-validation';
import type { SessionStateV2, SettingsV2 } from '../../../src/shared/types';
import { activeSnapshotV2, HIDDEN_AUTHORITY } from './v2-public-fixtures';
import {
  ENDED,
  MANUAL_TIMED_CONFIG,
  NOW,
  OCCURRENCE,
  SESSION_ID,
  STARTED,
  WINDOW_ENTRY,
} from './v2-runtime-fixtures';

function withClassPrototype(value: object): object {
  class BoundaryRecord {}

  return Object.assign(new BoundaryRecord(), value);
}

function withCustomPrototype(value: object): object {
  const prototype: object = { boundaryRecord: true };
  return Object.assign(Object.create(prototype) as object, value);
}

const TIMED_FOCUS_STATE: SessionStateV2 = {
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

describe('v2 validator hostile inputs', (): void => {
  it('returns rejection values for revoked and throwing proxies', (): void => {
    const revocable: { proxy: object; revoke: () => void } = Proxy.revocable<object>({}, {});
    revocable.revoke();
    const throwing: unknown = new Proxy<Record<string, unknown>>(
      {},
      {
        get: (): never => {
          throw new Error('get trap');
        },
        ownKeys: (): never => {
          throw new Error('ownKeys trap');
        },
      },
    );
    const validators: ReadonlyArray<(value: unknown) => boolean> = [
      isCanonicalSessionRuleSnapshot,
      isSessionDuration,
      isScheduleDuration,
      isScheduleOccurrenceRef,
      isSessionConfigV2,
      isScheduleEntryV2,
      isSessionStartedEventV2,
      isSessionEndedEventV2,
      isSessionStateV2,
      isSessionLifecycleV2,
      isSessionSnapshotV2,
      // These four read the raw value through this module's own record helpers rather than through
      // a detaching snapshot, so they are where the boundary catch has to live. `Array.isArray`
      // throws on a revoked proxy and `Reflect.ownKeys` throws on the trap below.
      isCycleConfig,
      isListsConfig,
      isSettings,
      isPauseEconomy,
      isEventRecord,
    ];

    for (const hostile of [revocable.proxy, throwing]) {
      for (const validate of validators) {
        expect((): boolean => validate(hostile)).not.toThrow();
        expect(validate(hostile)).toBe(false);
      }
      expect((): SettingsV2 | null => parseStoredSettingsV2(hostile)).not.toThrow();
      expect(parseStoredSettingsV2(hostile)).toBeNull();
    }
  });

  it('rejects symbol keys and throwing nested getters', (): void => {
    expect(isSessionDuration({ kind: 'until-stopped', [Symbol('extra')]: true })).toBe(false);
    const duration: Record<string, unknown> = { kind: 'timed' };
    Object.defineProperty(duration, 'minutes', {
      enumerable: true,
      get: (): never => {
        throw new Error('nested getter');
      },
    });
    expect((): boolean => isSessionDuration(duration)).not.toThrow();
    expect(isSessionDuration(duration)).toBe(false);
  });

  it('rejects canonical-looking accessors without invoking them', (): void => {
    let cyclingReads: number = 0;
    const cycling: Record<string, unknown> = {
      focusMin: 25,
      shortBreakMin: 5,
      longBreakMin: 15,
    };
    Object.defineProperty(cycling, 'longEvery', {
      enumerable: true,
      get: (): number => {
        cyclingReads += 1;
        return 4;
      },
    });

    let ruleReads: number = 0;
    const rules: object = structuredClone(MANUAL_TIMED_CONFIG.rules);
    Object.defineProperty(rules, 'baselineRevision', {
      enumerable: true,
      get: (): string => {
        ruleReads += 1;
        return MANUAL_TIMED_CONFIG.rules.baselineRevision;
      },
    });

    let configReads: number = 0;
    const config: object = structuredClone(MANUAL_TIMED_CONFIG);
    Object.defineProperty(config, 'intention', {
      enumerable: true,
      get: (): string => {
        configReads += 1;
        return MANUAL_TIMED_CONFIG.intention;
      },
    });

    expect(isCycleConfig(cycling)).toBe(true);
    expect(isSessionConfigV2({ ...MANUAL_TIMED_CONFIG, cycling })).toBe(false);
    expect(isScheduleEntryV2({ ...WINDOW_ENTRY, cycling })).toBe(false);
    expect(isCanonicalSessionRuleSnapshot(rules)).toBe(false);
    expect(isSessionConfigV2(config)).toBe(false);
    expect(cyclingReads).toBe(1);
    expect(ruleReads).toBe(0);
    expect(configReads).toBe(0);
  });

  it('rejects transparent proxies at canonical roots and nested boundaries', (): void => {
    const cycling: unknown = new Proxy(
      {
        focusMin: 25,
        shortBreakMin: 5,
        longBreakMin: 15,
        longEvery: 4,
      },
      {},
    );
    const rules: unknown = new Proxy(structuredClone(MANUAL_TIMED_CONFIG.rules), {});
    const rootConfig: unknown = new Proxy(structuredClone(MANUAL_TIMED_CONFIG), {});
    const nestedCyclingConfig: unknown = {
      ...MANUAL_TIMED_CONFIG,
      cycling,
    };
    const nestedRulesConfig: unknown = {
      ...MANUAL_TIMED_CONFIG,
      rules,
    };

    expect(isCycleConfig(cycling)).toBe(true);
    expect(isCanonicalSessionRuleSnapshot(rules)).toBe(false);
    expect(isSessionConfigV2(rootConfig)).toBe(false);
    expect(isSessionConfigV2(nestedCyclingConfig)).toBe(false);
    expect(isScheduleEntryV2({ ...WINDOW_ENTRY, cycling })).toBe(false);
    expect(isSessionConfigV2(nestedRulesConfig)).toBe(false);
  });

  it('rejects stateful nested cycling and rules without reading through their proxies', (): void => {
    let cyclingReads: number = 0;
    const cycling: unknown = new Proxy(
      {
        focusMin: 25,
        shortBreakMin: 5,
        longBreakMin: 15,
        longEvery: 4,
      },
      {
        get: (target: Record<string, number>, key: string | symbol): unknown => {
          cyclingReads += 1;
          return cyclingReads % 2 === 0 ? Reflect.get(target, key) : 25;
        },
      },
    );
    let ruleReads: number = 0;
    const rules: unknown = new Proxy(structuredClone(MANUAL_TIMED_CONFIG.rules), {
      get: (target: object, key: string | symbol): unknown => {
        ruleReads += 1;
        return Reflect.get(target, key);
      },
    });

    expect(isSessionConfigV2({ ...MANUAL_TIMED_CONFIG, cycling })).toBe(false);
    expect(isSessionConfigV2({ ...MANUAL_TIMED_CONFIG, rules })).toBe(false);
    expect(cyclingReads).toBe(0);
    expect(ruleReads).toBe(0);
  });

  it('does not execute a getter installed by a later sibling proxy', (): void => {
    let getterCalls: number = 0;
    const duration: Record<string, unknown> = { kind: 'timed', minutes: 25 };
    const rulesTarget: typeof MANUAL_TIMED_CONFIG.rules = structuredClone(
      MANUAL_TIMED_CONFIG.rules,
    );
    const rules: unknown = new Proxy(rulesTarget, {
      getPrototypeOf: (target: typeof rulesTarget): object | null => {
        Object.defineProperty(duration, 'minutes', {
          configurable: true,
          enumerable: true,
          get: (): number => {
            getterCalls += 1;
            return 25;
          },
        });
        return Reflect.getPrototypeOf(target);
      },
    });

    expect(isSessionConfigV2({ ...MANUAL_TIMED_CONFIG, duration, rules })).toBe(false);
    expect(getterCalls).toBe(0);
  });

  it('does not execute getters installed across state, lifecycle, and event boundaries', (): void => {
    const getterCounts: number[] = [0, 0, 0, 0];

    const state: Record<string, unknown> = { ...structuredClone(TIMED_FOCUS_STATE) };
    state.pausedFrom = new Proxy(
      { phase: 'focus', phaseEndsAt: NOW + 25 * 60_000 },
      {
        getPrototypeOf: (target: object): object | null => {
          installCountingGetter(state, 'startedAt', NOW, getterCounts, 0);
          return Reflect.getPrototypeOf(target);
        },
      },
    );
    expect(isSessionStateV2(state)).toBe(false);

    const lifecycle: Record<string, unknown> = {
      kind: 'active',
      endAuthority: null,
    };
    lifecycle.endAuthority = new Proxy(
      { kind: 'hidden' },
      {
        getPrototypeOf: (target: object): object | null => {
          installCountingGetter(lifecycle, 'kind', 'active', getterCounts, 1);
          return Reflect.getPrototypeOf(target);
        },
      },
    );
    expect(isSessionLifecycleV2(lifecycle)).toBe(false);

    const startedDuration: Record<string, unknown> = { kind: 'timed', minutes: 25 };
    const startedOccurrence: unknown = getterInstallingOwnKeysProxy(
      structuredClone(OCCURRENCE),
      (): void => installCountingGetter(startedDuration, 'minutes', 25, getterCounts, 2),
    );
    expect(
      isSessionStartedEventV2({
        ...STARTED,
        duration: startedDuration,
        source: 'schedule',
        scheduleOccurrence: startedOccurrence,
      }),
    ).toBe(false);

    const endedDuration: Record<string, unknown> = { kind: 'timed', minutes: 25 };
    const endedOccurrence: unknown = getterInstallingOwnKeysProxy(
      structuredClone(OCCURRENCE),
      (): void => installCountingGetter(endedDuration, 'minutes', 25, getterCounts, 3),
    );
    expect(
      isSessionEndedEventV2({
        ...ENDED,
        outcome: 'completed',
        reason: 'timer-completed',
        duration: endedDuration,
        source: 'schedule',
        scheduleOccurrence: endedOccurrence,
      }),
    ).toBe(false);

    expect(getterCounts).toEqual([0, 0, 0, 0]);
  });

  it('rejects transparent roots for every exported v2 boundary validator', (): void => {
    const cases: ReadonlyArray<readonly [(value: unknown) => boolean, object]> = [
      [isCanonicalSessionRuleSnapshot, MANUAL_TIMED_CONFIG.rules],
      [isSessionDuration, MANUAL_TIMED_CONFIG.duration],
      [isScheduleDuration, { kind: 'window' }],
      [isScheduleOccurrenceRef, OCCURRENCE],
      [isSessionConfigV2, MANUAL_TIMED_CONFIG],
      [isScheduleEntryV2, WINDOW_ENTRY],
      [isSessionStartedEventV2, STARTED],
      [isSessionEndedEventV2, ENDED],
      [isSessionStateV2, TIMED_FOCUS_STATE],
      [isSessionLifecycleV2, { kind: 'idle', endAuthority: HIDDEN_AUTHORITY }],
      [isSessionSnapshotV2, activeSnapshotV2()],
    ];

    for (const [validate, value] of cases) {
      expect(validate(new Proxy(structuredClone(value), {}))).toBe(false);
    }
  });

  it('bounds exact comparison work for a shared depth-20 graph', (): void => {
    let graph: object = {};
    for (let depth: number = 0; depth < 20; depth++) {
      graph = { left: graph, right: graph };
    }
    const nativeOwnKeys: typeof Reflect.ownKeys = Reflect.ownKeys;
    let ownKeyCalls: number = 0;
    const ownKeysSpy: ReturnType<typeof vi.spyOn> = vi
      .spyOn(Reflect, 'ownKeys')
      .mockImplementation((target: object): (string | symbol)[] => {
        ownKeyCalls += 1;
        return nativeOwnKeys(target);
      });

    try {
      expect(isSessionConfigV2({ ...MANUAL_TIMED_CONFIG, intention: graph })).toBe(false);
      expect(ownKeyCalls).toBeLessThan(1_000);
    } finally {
      ownKeysSpy.mockRestore();
    }
  });

  it('keeps descriptor traversal linear for a wide invalid nested record', (): void => {
    const width: number = 50_000;
    const wide: Record<string, number> = {};
    for (let index: number = 0; index < width; index++) wide[`key-${index}`] = index;
    const nativeDescriptor: typeof Reflect.getOwnPropertyDescriptor =
      Reflect.getOwnPropertyDescriptor;
    let descriptorCalls: number = 0;
    const descriptorSpy: ReturnType<typeof vi.spyOn> = vi
      .spyOn(Reflect, 'getOwnPropertyDescriptor')
      .mockImplementation((target: object, key: PropertyKey): PropertyDescriptor | undefined => {
        descriptorCalls += 1;
        return nativeDescriptor(target, key);
      });

    try {
      expect(isSessionConfigV2({ ...MANUAL_TIMED_CONFIG, intention: wide })).toBe(false);
      expect(descriptorCalls).toBeLessThan(width * 6);
    } finally {
      descriptorSpy.mockRestore();
    }
  });

  it.each([
    ['duration class', isSessionDuration, withClassPrototype({ kind: 'timed', minutes: 25 })],
    [
      'duration custom prototype',
      isSessionDuration,
      withCustomPrototype({ kind: 'timed', minutes: 25 }),
    ],
    [
      'rules class',
      isCanonicalSessionRuleSnapshot,
      withClassPrototype(structuredClone(MANUAL_TIMED_CONFIG.rules)),
    ],
    [
      'rules custom prototype',
      isCanonicalSessionRuleSnapshot,
      withCustomPrototype(structuredClone(MANUAL_TIMED_CONFIG.rules)),
    ],
    ['config class', isSessionConfigV2, withClassPrototype(structuredClone(MANUAL_TIMED_CONFIG))],
    [
      'config custom prototype',
      isSessionConfigV2,
      withCustomPrototype(structuredClone(MANUAL_TIMED_CONFIG)),
    ],
  ])(
    'rejects clone-unstable %s records',
    (_label: string, validate: (value: unknown) => boolean, value: object): void => {
      expect(validate(value)).toBe(false);
    },
  );

  it.each([
    [
      'class',
      withClassPrototype({
        focusMin: 25,
        shortBreakMin: 5,
        longBreakMin: 15,
        longEvery: 4,
      }),
    ],
    [
      'custom prototype',
      withCustomPrototype({
        focusMin: 25,
        shortBreakMin: 5,
        longBreakMin: 15,
        longEvery: 4,
      }),
    ],
  ])(
    'preserves baseline v1 cycling acceptance for a %s record',
    (_label: string, cycling: object): void => {
      expect(isCycleConfig(cycling)).toBe(true);
      expect(isSessionConfigV2({ ...MANUAL_TIMED_CONFIG, cycling })).toBe(false);
      expect(isScheduleEntryV2({ ...WINDOW_ENTRY, cycling })).toBe(false);
    },
  );
});

function installCountingGetter(
  target: object,
  key: string,
  value: unknown,
  counts: number[],
  index: number,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    get: (): unknown => {
      counts[index] = (counts[index] ?? 0) + 1;
      return value;
    },
  });
}

function getterInstallingOwnKeysProxy<T extends object>(target: T, install: () => void): T {
  return new Proxy(target, {
    ownKeys: (proxyTarget: T): (string | symbol)[] => {
      install();
      return Reflect.ownKeys(proxyTarget);
    },
  });
}

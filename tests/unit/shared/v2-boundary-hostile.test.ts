import { describe, expect, it, vi } from 'vitest';
import {
  isCanonicalSessionRuleSnapshot,
  isCycleConfig,
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
  parseStoredSettingsV2,
} from '../../../src/shared/runtime-validation';
import type { SettingsV2 } from '../../../src/shared/types';
import { MANUAL_TIMED_CONFIG } from './v2-runtime-fixtures';

function withClassPrototype(value: object): object {
  class BoundaryRecord {}

  return Object.assign(new BoundaryRecord(), value);
}

function withCustomPrototype(value: object): object {
  const prototype: object = { boundaryRecord: true };
  return Object.assign(Object.create(prototype) as object, value);
}

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

    expect(isCycleConfig(cycling)).toBe(false);
    expect(isCanonicalSessionRuleSnapshot(rules)).toBe(false);
    expect(isSessionConfigV2(config)).toBe(false);
    expect(cyclingReads).toBe(0);
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

    expect(isCycleConfig(cycling)).toBe(false);
    expect(isCanonicalSessionRuleSnapshot(rules)).toBe(false);
    expect(isSessionConfigV2(rootConfig)).toBe(false);
    expect(isSessionConfigV2(nestedCyclingConfig)).toBe(false);
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

  it('stops descriptor traversal when a nested record exceeds the key budget', (): void => {
    const wide: Record<string, number> = {};
    for (let index: number = 0; index < 50_000; index++) wide[`key-${index}`] = index;
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
      expect(descriptorCalls).toBeLessThan(1_000);
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
      'cycling class',
      isCycleConfig,
      withClassPrototype({
        focusMin: 25,
        shortBreakMin: 5,
        longBreakMin: 15,
        longEvery: 4,
      }),
    ],
    [
      'cycling custom prototype',
      isCycleConfig,
      withCustomPrototype({
        focusMin: 25,
        shortBreakMin: 5,
        longBreakMin: 15,
        longEvery: 4,
      }),
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
});

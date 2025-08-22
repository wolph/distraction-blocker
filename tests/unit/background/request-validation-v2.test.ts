import { describe, expect, it } from 'vitest';
import { parseSessionStartRequestV2 } from '../../../src/background/request-validation';
import { DEFAULT_LISTS, rulesFromLists } from '../../../src/shared/constants';
import type { SessionStartRequestV2 } from '../../../src/shared/messages';
import { isSessionConfigV2 } from '../../../src/shared/runtime-validation';

const REQUEST: SessionStartRequestV2 = {
  type: 'startSession',
  config: {
    mode: 'blacklist',
    strictness: 'flexible',
    duration: { kind: 'until-stopped' },
    cycling: null,
    intention: 'Review the release',
    source: 'manual',
    scheduleOccurrence: null,
    rules: rulesFromLists(DEFAULT_LISTS),
  },
};

function requestWithSessionAllowlist(sessionAllowlist: unknown): unknown {
  return {
    ...REQUEST,
    config: {
      ...REQUEST.config,
      rules: { ...REQUEST.config.rules, sessionAllowlist },
    },
  };
}

function requestWithExclusions(exclusions: unknown): unknown {
  return {
    ...REQUEST,
    config: {
      ...REQUEST.config,
      rules: { ...REQUEST.config.rules, exclusions },
    },
  };
}

describe('parseSessionStartRequestV2', (): void => {
  it('accepts and clones the exact manual until-stopped request', (): void => {
    const parsed: SessionStartRequestV2 | null = parseSessionStartRequestV2(REQUEST);
    expect(parsed).toEqual(REQUEST);
    expect(parsed).not.toBe(REQUEST);
    expect(parsed?.config).not.toBe(REQUEST.config);
    expect(parsed?.config.rules).not.toBe(REQUEST.config.rules);
  });

  it('accepts a timed manual request and normalizes session-only hosts', (): void => {
    expect(
      parseSessionStartRequestV2({
        ...REQUEST,
        config: {
          ...REQUEST.config,
          duration: { kind: 'timed', minutes: 50 },
          strictness: 'friction',
          rules: {
            ...REQUEST.config.rules,
            sessionAllowlist: [{ kind: 'host', pattern: '  HTTPS://Docs.Python.org/3/library/  ' }],
          },
        },
      }),
    ).toMatchObject({
      config: {
        duration: { kind: 'timed', minutes: 50 },
        rules: {
          sessionAllowlist: [{ kind: 'host', pattern: 'docs.python.org' }],
        },
      },
    });
  });

  it.each([
    ['canonical manual', REQUEST.config, true, true],
    [
      'raw normalizable rules',
      {
        ...REQUEST.config,
        rules: {
          ...REQUEST.config.rules,
          sessionAllowlist: [{ kind: 'host', pattern: 'HTTPS://Docs.Python.org/guide/' }],
        },
      },
      false,
      true,
    ],
    [
      'canonical scheduled',
      {
        ...REQUEST.config,
        source: 'schedule',
        scheduleOccurrence: {
          version: 1,
          token: 'weekday@2026-09-02',
          entryId: 'weekday',
          localStartDate: '2026-09-02',
        },
      },
      true,
      false,
    ],
    [
      'persisted predecessor rules',
      {
        ...REQUEST.config,
        rules: Object.fromEntries(
          Object.entries(REQUEST.config.rules).filter(
            ([key]: [string, unknown]): boolean => key !== 'baselineCategories',
          ),
        ),
      },
      false,
      false,
    ],
    ['mixed numeric duration', { ...REQUEST.config, durationMin: 25 }, false, false],
    ['extra config key', { ...REQUEST.config, extra: true }, false, false],
  ])(
    'keeps canonical guard and raw request parser separate for %s',
    (_label: string, config: unknown, canonicalAccepted: boolean, requestAccepted: boolean): void => {
      expect(isSessionConfigV2(config)).toBe(canonicalAccepted);
      expect(parseSessionStartRequestV2({ type: 'startSession', config }) !== null).toBe(
        requestAccepted,
      );
    },
  );

  it.each([
    { ...REQUEST, extra: true },
    { type: 'startSession', config: { ...REQUEST.config, durationMin: 25 } },
    {
      type: 'startSession',
      config: { ...REQUEST.config, duration: { kind: 'until-stopped', minutes: 25 } },
    },
    { type: 'startSession', config: { ...REQUEST.config, strictness: 'hard' } },
    {
      type: 'startSession',
      config: {
        ...REQUEST.config,
        source: 'schedule',
        scheduleOccurrence: {
          version: 1,
          token: 'weekday@2026-09-02',
          entryId: 'weekday',
          localStartDate: '2026-09-02',
        },
      },
    },
    { type: 'startSession', config: { ...REQUEST.config, scheduleWindow: {} } },
    { type: 'startSession', config: { ...REQUEST.config, extra: true } },
  ])('rejects invalid manual request %#', (value: unknown): void => {
    expect(parseSessionStartRequestV2(value)).toBeNull();
  });

  it('returns null for revoked and throwing proxies', (): void => {
    const revocable: { proxy: object; revoke: () => void } = Proxy.revocable<object>({}, {});
    revocable.revoke();
    const throwing: unknown = new Proxy<Record<string, unknown>>(
      {},
      {
        get: (): never => {
          throw new Error('get trap');
        },
      },
    );
    for (const hostile of [revocable.proxy, throwing]) {
      expect((): SessionStartRequestV2 | null => parseSessionStartRequestV2(hostile)).not.toThrow();
      expect(parseSessionStartRequestV2(hostile)).toBeNull();
    }
  });

  it('rejects a root accessor without invoking its getter', (): void => {
    let getterCalls: number = 0;
    const request: Record<string, unknown> = { type: 'startSession' };
    Object.defineProperty(request, 'config', {
      enumerable: true,
      get: (): SessionStartRequestV2['config'] => {
        getterCalls += 1;
        return REQUEST.config;
      },
    });

    expect(parseSessionStartRequestV2(request)).toBeNull();
    expect(getterCalls).toBe(0);
  });

  it('rejects a config accessor without invoking its getter', (): void => {
    let getterCalls: number = 0;
    const config: Record<string, unknown> = { ...structuredClone(REQUEST.config) };
    Object.defineProperty(config, 'duration', {
      enumerable: true,
      get: (): never => {
        getterCalls += 1;
        throw new Error('config getter');
      },
    });

    expect(parseSessionStartRequestV2({ type: 'startSession', config })).toBeNull();
    expect(getterCalls).toBe(0);
  });

  it('rejects a cycling accessor without invoking its getter', (): void => {
    let getterCalls: number = 0;
    const cycling: Record<string, unknown> = {
      focusMin: 25,
      shortBreakMin: 5,
      longBreakMin: 15,
      longEvery: 4,
    };
    Object.defineProperty(cycling, 'focusMin', {
      enumerable: true,
      get: (): never => {
        getterCalls += 1;
        throw new Error('cycling getter');
      },
    });

    expect(
      parseSessionStartRequestV2({
        ...REQUEST,
        config: {
          ...REQUEST.config,
          duration: { kind: 'timed', minutes: 50 },
          strictness: 'friction',
          cycling,
        },
      }),
    ).toBeNull();
    expect(getterCalls).toBe(0);
  });

  it('rejects nested accessors without invoking their getters', (): void => {
    let getterCalls: number = 0;
    const rules: Record<string, unknown> = { ...structuredClone(REQUEST.config.rules) };
    Object.defineProperty(rules, 'sessionAllowlist', {
      enumerable: true,
      get: (): never => {
        getterCalls += 1;
        throw new Error('nested getter');
      },
    });

    expect(
      parseSessionStartRequestV2({
        ...REQUEST,
        config: { ...REQUEST.config, rules },
      }),
    ).toBeNull();
    expect(getterCalls).toBe(0);
  });

  it('rejects mutating proxy-backed request and config values without reading them', (): void => {
    let getCalls: number = 0;
    const mutatingHandler: ProxyHandler<Record<string, unknown>> = {
      get: (target: Record<string, unknown>, property: string | symbol): unknown => {
        getCalls += 1;
        target.mutated = true;
        return Reflect.get(target, property);
      },
    };
    const rootTarget: Record<string, unknown> = { ...structuredClone(REQUEST) };
    const configTarget: Record<string, unknown> = { ...structuredClone(REQUEST.config) };
    const rootProxy: unknown = new Proxy(rootTarget, mutatingHandler);
    const configProxy: unknown = new Proxy(configTarget, mutatingHandler);

    expect(parseSessionStartRequestV2(rootProxy)).toBeNull();
    expect(parseSessionStartRequestV2({ type: 'startSession', config: configProxy })).toBeNull();
    expect(getCalls).toBe(0);
    expect(rootTarget).not.toHaveProperty('mutated');
    expect(configTarget).not.toHaveProperty('mutated');
  });

  it('rejects clone-unstable non-enumerable duration data', (): void => {
    const duration: Record<string, unknown> = {};
    Object.defineProperty(duration, 'kind', {
      configurable: true,
      enumerable: false,
      value: 'until-stopped',
      writable: true,
    });

    expect(
      parseSessionStartRequestV2({
        ...REQUEST,
        config: { ...REQUEST.config, duration },
      }),
    ).toBeNull();
  });

  it('rejects raw arrays with extra keys, symbols, sparse slots, or custom iteration', (): void => {
    const extraString: unknown[] = [];
    Object.defineProperty(extraString, 'extra', { enumerable: false, value: true });
    const extraSymbol: unknown[] = [];
    Object.defineProperty(extraSymbol, Symbol('extra'), { enumerable: true, value: true });
    const sparse: unknown[] = new Array<unknown>(1);
    const customIterator: unknown[] = [{ kind: 'host', pattern: 'invalid host' }];
    Object.defineProperty(customIterator, Symbol.iterator, {
      enumerable: false,
      value: function customRuleIterator(): IterableIterator<never> {
        const empty: never[] = [];
        return empty[Symbol.iterator]();
      },
    });

    for (const sessionAllowlist of [extraString, extraSymbol, sparse, customIterator]) {
      expect(parseSessionStartRequestV2(requestWithSessionAllowlist(sessionAllowlist))).toBeNull();
    }
  });

  it('rejects accessor and proxy-backed raw arrays without reading them', (): void => {
    let getterCalls: number = 0;
    const accessorArray: unknown[] = new Array<unknown>(1);
    Object.defineProperty(accessorArray, 0, {
      enumerable: true,
      get: (): never => {
        getterCalls += 1;
        throw new Error('array getter');
      },
    });
    const proxyTarget: unknown[] = [{ kind: 'host', pattern: 'docs.python.org' }];
    const proxyArray: unknown = new Proxy(proxyTarget, {
      get: (target: unknown[], property: string | symbol): unknown => {
        getterCalls += 1;
        target.push({ kind: 'host', pattern: 'mutated.example' });
        return Reflect.get(target, property);
      },
    });

    expect(parseSessionStartRequestV2(requestWithSessionAllowlist(accessorArray))).toBeNull();
    expect(parseSessionStartRequestV2(requestWithSessionAllowlist(proxyArray))).toBeNull();
    expect(getterCalls).toBe(0);
    expect(proxyTarget).toHaveLength(1);
  });

  it.each([
    new Map<string, string[]>([['social', ['blocked.example']]]),
    new Set<string>(['social']),
    new Date('2026-09-02T00:00:00Z'),
    /social/,
    new (class EmptyExclusions {})(),
  ])('rejects non-plain raw rule records %#', (exclusions: unknown): void => {
    expect(parseSessionStartRequestV2(requestWithExclusions(exclusions))).toBeNull();
  });

  it('rejects a shared-reference data graph', (): void => {
    const sharedCategories: SessionStartRequestV2['config']['rules']['categories'] = {
      ...REQUEST.config.rules.categories,
    };

    expect(
      parseSessionStartRequestV2({
        ...REQUEST,
        config: {
          ...REQUEST.config,
          rules: {
            ...REQUEST.config.rules,
            baselineCategories: sharedCategories,
            categories: sharedCategories,
          },
        },
      }),
    ).toBeNull();
  });

  it('rejects a cyclic graph', (): void => {
    const intention: Record<string, unknown> = {};
    intention.self = intention;

    expect(
      parseSessionStartRequestV2({
        ...REQUEST,
        config: { ...REQUEST.config, intention },
      }),
    ).toBeNull();
  });

  it('rejects invalid scalar fields before traversing the nested graph', (): void => {
    let graphVisits: number = 0;
    const rules: unknown = new Proxy<Record<string, unknown>>(
      {},
      {
        getPrototypeOf: (): never => {
          graphVisits += 1;
          throw new Error('nested graph visited');
        },
      },
    );

    expect(
      parseSessionStartRequestV2({
        ...REQUEST,
        config: { ...REQUEST.config, intention: {}, rules },
      }),
    ).toBeNull();
    expect(graphVisits).toBe(0);
  });
});

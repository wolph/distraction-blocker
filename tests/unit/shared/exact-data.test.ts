import { describe, expect, it } from 'vitest';
import { exactDataEqual, snapshotExactData } from '../../../src/shared/exact-data';

function nestedRecord(depth: number): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let cursor: Record<string, unknown> = root;
  for (let index: number = 0; index < depth; index++) {
    const child: Record<string, unknown> = {};
    cursor.child = child;
    cursor = child;
  }
  return root;
}

const CHANGING_PROXY_CASES: Array<[string, ProxyHandler<Record<string, number>>]> = [
  ['keys', { ownKeys: (): string[] => ['changed'] }],
  [
    'descriptors',
    {
      getOwnPropertyDescriptor: (): PropertyDescriptor => ({
        configurable: true,
        enumerable: true,
        value: 2,
        writable: true,
      }),
    },
  ],
  ['values', { get: (): number => 2 }],
  ['prototype', { getPrototypeOf: (): object | null => null }],
];

describe('exact data snapshots', (): void => {
  it.each([null, undefined, false, true, 0, -0, Number.NaN, 'text', 12n])(
    'detaches the primitive %#',
    (value: unknown): void => {
      expect(snapshotExactData(value)?.value).toBe(value);
    },
  );

  it('detaches dense arrays and plain records in both mutation directions', (): void => {
    const source: { nested: { value: number }; values: number[] } = {
      nested: { value: 1 },
      values: [2, 3],
    };
    const snapshot: { nested: { value: number }; values: number[] } = snapshotExactData(source)
      ?.value as { nested: { value: number }; values: number[] };

    source.nested.value = 4;
    source.values[0] = 5;
    expect(snapshot).toEqual({ nested: { value: 1 }, values: [2, 3] });

    snapshot.nested.value = 6;
    snapshot.values[1] = 7;
    expect(source).toEqual({ nested: { value: 4 }, values: [5, 3] });
  });

  it.each([
    (): void => undefined,
    Symbol('root'),
    { nested: (): void => undefined },
    { nested: Symbol('nested') },
  ])('rejects functions and symbols at any depth %#', (value: unknown): void => {
    expect(snapshotExactData(value)).toBeNull();
  });

  it('rejects symbol keys at the root and nested boundaries', (): void => {
    const root: Record<PropertyKey, unknown> = { value: 1, [Symbol('extra')]: true };
    const nested: Record<PropertyKey, unknown> = { value: 1, [Symbol('extra')]: true };

    expect(snapshotExactData(root)).toBeNull();
    expect(snapshotExactData({ nested })).toBeNull();
  });

  it('rejects accessors without invoking them', (): void => {
    let reads: number = 0;
    const nested: Record<string, unknown> = {};
    Object.defineProperty(nested, 'value', {
      enumerable: true,
      get: (): number => {
        reads += 1;
        return 1;
      },
    });

    expect(snapshotExactData(nested)).toBeNull();
    expect(snapshotExactData({ nested })).toBeNull();
    expect(reads).toBe(0);
  });

  it('rejects non-plain prototypes and prototype laundering', (): void => {
    class Example {
      value: number = 1;
    }

    const nullPrototype: object = Object.create(null);
    const customPrototype: object = Object.create({ inherited: true });
    const arrayPrototypeObject: object = Object.create(Array.prototype);
    const launderedDate: object = new Proxy(new Date(0), {
      getPrototypeOf: (): object => Object.prototype,
    });

    for (const value of [
      nullPrototype,
      customPrototype,
      arrayPrototypeObject,
      new Example(),
      new Date(0),
      new Map<string, number>([['value', 1]]),
      new Set<number>([1]),
      launderedDate,
    ]) {
      expect(snapshotExactData(value)).toBeNull();
    }
  });

  it('rejects sparse arrays and arrays with extra keys', (): void => {
    const sparse: number[] = new Array<number>(2);
    sparse[1] = 2;
    const extra: number[] = [1, 2];
    Object.defineProperty(extra, 'extra', { enumerable: true, value: 3 });

    expect(snapshotExactData(sparse)).toBeNull();
    expect(snapshotExactData(extra)).toBeNull();
  });

  it('rejects cycles while preserving shared acyclic aliases', (): void => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const shared: { value: number } = { value: 1 };
    const source: { left: { value: number }; right: { value: number } } = {
      left: shared,
      right: shared,
    };
    const snapshot: typeof source = snapshotExactData(source)?.value as typeof source;

    expect(snapshotExactData(cyclic)).toBeNull();
    expect(snapshot.left).toBe(snapshot.right);
    expect(snapshot.left).not.toBe(shared);
  });

  it('rejects values deeper than the 128-level boundary', (): void => {
    expect(snapshotExactData(nestedRecord(128))).not.toBeNull();
    expect(snapshotExactData(nestedRecord(129))).toBeNull();
  });

  it.each(CHANGING_PROXY_CASES)(
    'rejects a proxy that changes %s during inspection',
    (_name: string, handler: ProxyHandler<Record<string, number>>): void => {
      expect(snapshotExactData(new Proxy({ value: 1 }, handler))).toBeNull();
    },
  );

  it('rejects array length and nested-data changes during inspection', (): void => {
    const arrayTarget: number[] = [1];
    const arrayProxy: number[] = new Proxy(arrayTarget, {
      ownKeys: (target: number[]): ArrayLike<string | symbol> => {
        target.push(2);
        return Reflect.ownKeys(target);
      },
    });
    const nested: { value: number } = { value: 1 };
    const mutator: object = new Proxy(
      {},
      {
        getPrototypeOf: (target: object): object | null => {
          nested.value = 2;
          return Reflect.getPrototypeOf(target);
        },
      },
    );

    expect(snapshotExactData(arrayProxy)).toBeNull();
    expect(snapshotExactData({ nested, mutator })).toBeNull();
  });

  it.each(['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor'] as const)(
    'contains a throwing %s proxy trap',
    (trap: 'getPrototypeOf' | 'ownKeys' | 'getOwnPropertyDescriptor'): void => {
      const handler: ProxyHandler<object> = {
        [trap]: (): never => {
          throw new Error(`${trap} trap`);
        },
      };
      expect((): unknown => snapshotExactData(new Proxy({}, handler))).not.toThrow();
      expect(snapshotExactData(new Proxy({}, handler))).toBeNull();
    },
  );
});

describe('exact data equality', (): void => {
  it('uses exact keys, dense arrays, nested values, and Object.is scalars', (): void => {
    const sparse: number[] = new Array<number>(1);
    const leftAlias: { value: number } = { value: 1 };
    const rightAlias: { value: number } = { value: 1 };

    expect(exactDataEqual({ value: 1 }, { value: 1 })).toBe(true);
    expect(exactDataEqual({ value: 1 }, { value: 1, extra: true })).toBe(false);
    expect(exactDataEqual([], sparse)).toBe(false);
    expect(
      exactDataEqual(
        { left: leftAlias, right: leftAlias },
        {
          left: rightAlias,
          right: { value: 2 },
        },
      ),
    ).toBe(false);
    expect(exactDataEqual(Number.NaN, Number.NaN)).toBe(true);
    expect(exactDataEqual(0, -0)).toBe(false);
  });

  it('returns false instead of throwing for hostile proxies and traps', (): void => {
    const throwing: object = new Proxy(
      {},
      {
        ownKeys: (): never => {
          throw new Error('ownKeys trap');
        },
      },
    );
    const revoked: { proxy: object; revoke: () => void } = Proxy.revocable({}, {});
    revoked.revoke();

    for (const hostile of [throwing, revoked.proxy]) {
      expect((): boolean => exactDataEqual(hostile, {})).not.toThrow();
      expect(exactDataEqual(hostile, {})).toBe(false);
    }
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  assertSyncItemWithinQuota,
  removeSyncItems,
  SYNC_QUOTA_BYTES_PER_ITEM,
  SYNC_QUOTA_BYTES_TOTAL,
  sanitizeSyncJournal,
  setSyncItemsWithinQuota,
  syncItemBytes,
} from '../../../src/background/sync-quota';

interface FakeSyncStorage {
  area: chrome.storage.SyncStorageArea;
  state: Record<string, unknown>;
  trace: string[];
}

function chromiumSerializedValue(value: unknown): string {
  const serialized: string | undefined = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Value is not JSON serializable');
  return serialized
    .replaceAll('<', '\\u003C')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function chromiumItemBytes(key: string, value: unknown): number {
  const encoder: TextEncoder = new TextEncoder();
  return encoder.encode(key).byteLength + encoder.encode(chromiumSerializedValue(value)).byteLength;
}

function storageBytes(
  items: Record<string, unknown>,
  byteOverrides: Readonly<Record<string, number>> = {},
): number {
  return Object.entries(items).reduce(
    (total: number, [key, value]: [string, unknown]): number =>
      total + (byteOverrides[key] ?? chromiumItemBytes(key, value)),
    0,
  );
}

function fakeSyncStorage(
  initial: Record<string, unknown>,
  byteOverrides: Readonly<Record<string, number>> = {},
): FakeSyncStorage {
  const state: Record<string, unknown> = structuredClone(initial);
  const trace: string[] = [];
  const get: chrome.storage.StorageArea['get'] = vi.fn(
    async (
      keys?: string | string[] | Record<string, unknown> | null,
    ): Promise<Record<string, unknown>> => {
      if (keys === null || keys === undefined) return structuredClone(state);
      const requested: string[] =
        typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      return Object.fromEntries(
        requested
          .filter((key: string): boolean => Object.hasOwn(state, key))
          .map((key: string): [string, unknown] => [key, structuredClone(state[key])]),
      );
    },
  ) as unknown as chrome.storage.StorageArea['get'];
  const area: chrome.storage.SyncStorageArea = {
    get,
    getBytesInUse: vi.fn(async (keys?: string | string[] | null): Promise<number> => {
      if (keys === null || keys === undefined) return storageBytes(state, byteOverrides);
      const requested: string[] = typeof keys === 'string' ? [keys] : keys;
      return requested.reduce(
        (total: number, key: string): number =>
          total +
          (Object.hasOwn(state, key)
            ? (byteOverrides[key] ?? chromiumItemBytes(key, state[key]))
            : 0),
        0,
      );
    }) as unknown as chrome.storage.StorageArea['getBytesInUse'],
    set: vi.fn(async (items: Record<string, unknown>): Promise<void> => {
      const projected: Record<string, unknown> = { ...state, ...structuredClone(items) };
      if (storageBytes(projected, byteOverrides) > SYNC_QUOTA_BYTES_TOTAL) {
        throw new Error('QUOTA_BYTES exceeded');
      }
      trace.push(`set:${Object.keys(items).sort().join(',')}`);
      Object.assign(state, structuredClone(items));
    }) as chrome.storage.StorageArea['set'],
    remove: vi.fn(async (keys: string | string[]): Promise<void> => {
      const requested: string[] = typeof keys === 'string' ? [keys] : keys;
      trace.push(`remove:${requested.join(',')}`);
      for (let index: number = 0; index < requested.length; index++) {
        const key: string = requested[index] as string;
        delete state[key];
      }
    }) as chrome.storage.StorageArea['remove'],
    clear: vi.fn() as chrome.storage.StorageArea['clear'],
    setAccessLevel: vi.fn() as chrome.storage.StorageArea['setAccessLevel'],
    onChanged: { addListener: vi.fn() } as unknown as chrome.events.Event<
      (changes: Record<string, chrome.storage.StorageChange>) => void
    >,
    getKeys: vi.fn() as chrome.storage.StorageArea['getKeys'],
    QUOTA_BYTES: 102_400,
    QUOTA_BYTES_PER_ITEM: 8_192,
    MAX_ITEMS: 512,
    MAX_WRITE_OPERATIONS_PER_HOUR: 1_800,
    MAX_WRITE_OPERATIONS_PER_MINUTE: 120,
    MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE: 1_000_000,
  };
  return { area, state, trace };
}

function nearQuotaState(monthlyValueLength: number = 5_900): Record<string, unknown> {
  const state: Record<string, unknown> = {
    'aggm:dev-a:2025-01': 'm'.repeat(monthlyValueLength),
  };
  for (let index: number = 0; index < 12; index++) {
    state[`agg:dev-a:2026-08-${String(index + 1).padStart(2, '0')}`] = 'd'.repeat(7_790);
  }
  return state;
}

describe('sync item quota', () => {
  it('uses Chrome storage.sync per-item byte limit', () => {
    expect(SYNC_QUOTA_BYTES_PER_ITEM).toBe(8_192);
  });

  it('accepts an item exactly at the byte limit', () => {
    const value: string = 'a'.repeat(8_189);

    expect(syncItemBytes('k', value)).toBe(8_192);
  });

  it('counts UTF-8 bytes for multibyte keys and values', () => {
    expect(syncItemBytes('é', '🙂')).toBe(8);
  });

  it('matches Chromium escaping for less-than signs', () => {
    expect(syncItemBytes('k', '<')).toBe(9);
  });

  it('matches Chromium escaping for Unicode line and paragraph separators', () => {
    expect(syncItemBytes('k', '\u2028')).toBe(9);
    expect(syncItemBytes('k', '\u2029')).toBe(9);
  });

  it('does not double-escape existing backslash escape sequences', () => {
    expect(syncItemBytes('k', String.raw`\u003C`)).toBe(10);
    expect(syncItemBytes('k', String.raw`\u2028`)).toBe(10);
    expect(syncItemBytes('k', String.raw`\u2029`)).toBe(10);
  });

  it('matches the live Chromium byte count for a non-Int32 integer', () => {
    expect(syncItemBytes('large', 2_147_483_648)).toBe(17);
  });

  it('preserves signed Int32 boundaries and marks integers outside them as doubles', () => {
    expect(syncItemBytes('k', 2_147_483_647)).toBe(11);
    expect(syncItemBytes('k', 2_147_483_648)).toBe(13);
    expect(syncItemBytes('k', -2_147_483_648)).toBe(12);
    expect(syncItemBytes('k', -2_147_483_649)).toBe(14);
  });

  it('matches live Chromium byte counts at its fixed-to-exponential boundary', () => {
    expect(syncItemBytes('k', -0)).toBe(2);
    expect(syncItemBytes('k', 99_999_999_999)).toBe(14);
    expect(syncItemBytes('k', 100_000_000_000)).toBe(15);
    expect(syncItemBytes('k', 999_999_999_999)).toBe(15);
    expect(syncItemBytes('k', 1_000_000_000_000)).toBe(6);
    expect(syncItemBytes('k', -1_000_000_000_000)).toBe(7);
    expect(syncItemBytes('k', 0.000_001)).toBe(9);
    expect(syncItemBytes('k', 0.000_000_1)).toBe(5);
  });

  it('matches live Chromium shortest-double bytes for large values', () => {
    expect(syncItemBytes('k', 100_000_000_000_000_000_000)).toBe(6);
    expect(syncItemBytes('k', 1e21)).toBe(6);
    expect(syncItemBytes('k', 9_007_199_254_740_991)).toBe(22);
    expect(syncItemBytes('k', 9_007_199_254_740_992)).toBe(22);
    expect(syncItemBytes('k', -9_007_199_254_740_991)).toBe(23);
    expect(syncItemBytes('k', -9_007_199_254_740_992)).toBe(23);
    expect(syncItemBytes('k', 1_000_000_000_000_000_100)).toBe(23);
    expect(syncItemBytes('k', 1.234_567_890_123_456_7e19)).toBe(23);
    expect(syncItemBytes('k', 0.1 + 0.2)).toBe(20);
  });

  it('does not reinterpret numeric-looking strings or object keys', () => {
    const value: Record<string, unknown> = {
      '1000000000000': ['9007199254740991', { escaped: '\\"1000000000000\\"' }],
      actual: 1_000_000_000_000,
    };
    const chromiumJson: string =
      '{"1000000000000":["9007199254740991",{"escaped":"\\\\\\"1000000000000\\\\\\""}],"actual":1e+12}';
    const encoder: TextEncoder = new TextEncoder();
    const expectedBytes: number =
      encoder.encode('nested').byteLength + encoder.encode(chromiumJson).byteLength;

    expect(syncItemBytes('nested', value)).toBe(expectedBytes);
  });

  it('matches Chromium double serialization in nested arrays and objects', () => {
    const value: Record<string, unknown> = {
      values: [2_147_483_648, { '-2147483649': -2_147_483_649 }],
    };
    const chromiumJson: string = '{"values":[2147483648.0,{"-2147483649":-2147483649.0}]}';
    const encoder: TextEncoder = new TextEncoder();
    const expectedBytes: number =
      encoder.encode('nested').byteLength + encoder.encode(chromiumJson).byteLength;

    expect(syncItemBytes('nested', value)).toBe(expectedBytes);
  });

  it('rejects a nested non-Int32 integer when its double suffix crosses the item limit', () => {
    const value: { large: number; padding: string } = {
      large: 2_147_483_648,
      padding: '',
    };
    const chromiumJson: string = '{"large":2147483648.0,"padding":""}';
    const encoder: TextEncoder = new TextEncoder();
    const baseBytes: number =
      encoder.encode('k').byteLength + encoder.encode(chromiumJson).byteLength;
    value.padding = 'a'.repeat(SYNC_QUOTA_BYTES_PER_ITEM + 1 - baseBytes);

    expect(syncItemBytes('k', value)).toBe(8_193);
    expect((): void => assertSyncItemWithinQuota('k', value)).toThrow();
  });

  it('rejects an unsafe integer whose Chromium exponent crosses the item limit', () => {
    const value: { large: number; padding: string } = {
      large: 9_007_199_254_740_991,
      padding: '',
    };
    const chromiumJson: string = '{"large":9.007199254740991e+15,"padding":""}';
    const encoder: TextEncoder = new TextEncoder();
    const baseBytes: number =
      encoder.encode('k').byteLength + encoder.encode(chromiumJson).byteLength;
    value.padding = 'a'.repeat(SYNC_QUOTA_BYTES_PER_ITEM + 1 - baseBytes);

    expect(syncItemBytes('k', value)).toBe(8_193);
    expect((): void => assertSyncItemWithinQuota('k', value)).toThrow();
  });

  it('accepts a large double exactly at the item limit using Chromium exponent bytes', () => {
    const value: { large: number; padding: string } = {
      large: 100_000_000_000_000_000_000,
      padding: '',
    };
    const chromiumJson: string = '{"large":1e+20,"padding":""}';
    const encoder: TextEncoder = new TextEncoder();
    const baseBytes: number =
      encoder.encode('k').byteLength + encoder.encode(chromiumJson).byteLength;
    value.padding = 'a'.repeat(SYNC_QUOTA_BYTES_PER_ITEM - baseBytes);

    expect(syncItemBytes('k', value)).toBe(8_192);
    expect((): void => assertSyncItemWithinQuota('k', value)).not.toThrow();
  });

  it('rejects an escaped value that crosses the per-item limit', () => {
    const value: string = `${'a'.repeat(8_184)}<`;

    expect(syncItemBytes('k', value)).toBe(8_193);
    expect((): void => assertSyncItemWithinQuota('k', value)).toThrow();
  });

  it('allows a value exactly at the byte limit', () => {
    const value: string = 'a'.repeat(8_189);

    expect((): void => assertSyncItemWithinQuota('k', value)).not.toThrow();
  });

  it('rejects a value one byte over the byte limit', () => {
    const value: string = 'a'.repeat(8_190);

    expect((): void => assertSyncItemWithinQuota('k', value)).toThrow(
      'Cannot sync item "k": 8193 bytes exceeds the 8192-byte limit.',
    );
  });

  it('rejects values that JSON.stringify cannot serialize', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    for (const value of [undefined, 1n, circular]) {
      expect((): void => assertSyncItemWithinQuota('settings', value)).toThrow(
        'Cannot sync item "settings": value cannot be serialized as JSON.',
      );
    }
  });

  it('sanitizes invalid initial journal sets and reports deterministic errors', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = sanitizeSyncJournal({
      sets: {
        valid: { enabled: true },
        huge: 'a'.repeat(8_192),
        circular,
      },
      removes: ['obsolete'],
    });

    expect(result.journal).toEqual({
      sets: { valid: { enabled: true } },
      removes: ['obsolete'],
    });
    expect(result.rejected).toEqual([
      {
        key: 'huge',
        message: 'Cannot sync item "huge": 8198 bytes exceeds the 8192-byte limit.',
      },
      {
        key: 'circular',
        message: 'Cannot sync item "circular": value cannot be serialized as JSON.',
      },
    ]);
  });
});

describe('sync total quota', () => {
  it('uses Chrome storage.sync total byte limit', () => {
    expect(SYNC_QUOTA_BYTES_TOTAL).toBe(102_400);
  });

  it('writes without deleting history when the projected total fits', async () => {
    const fake: FakeSyncStorage = fakeSyncStorage({ settings: { enabled: true } });

    await setSyncItemsWithinQuota({ bank: { balanceMs: 1 } }, fake.area);

    expect(fake.trace).toEqual(['set:bank']);
    expect(fake.state.bank).toEqual({ balanceMs: 1 });
    expect(fake.area.getBytesInUse).toHaveBeenCalledWith(null);
  });

  it('matches fake Chrome byte accounting for escaped values', async () => {
    const value: string = `<\u2028\u2029${String.raw`\u003C`}`;
    const fake: FakeSyncStorage = fakeSyncStorage({ escaped: value });

    await expect(fake.area.getBytesInUse('escaped')).resolves.toBe(syncItemBytes('escaped', value));
  });

  it('evicts monthly history when Chromium exponent bytes cross the total limit', async () => {
    const monthlyKey: string = 'aggm:dev-a:2025-01';
    const incoming: Record<string, unknown> = { large: 9_007_199_254_740_991 };
    const encoder: TextEncoder = new TextEncoder();
    const nativeIncomingBytes: number =
      encoder.encode('settings').byteLength +
      encoder.encode('{"large":9.007199254740991e+15}').byteLength;
    const initial: Record<string, unknown> = nearQuotaState(1);
    initial.fillerA = 'f'.repeat(8_000);
    const targetInitialBytes: number = SYNC_QUOTA_BYTES_TOTAL - nativeIncomingBytes + 1;
    const fillerBLength: number =
      targetInitialBytes - storageBytes(initial) - chromiumItemBytes('fillerB', '');
    initial.fillerB = 'f'.repeat(fillerBLength);
    const fake: FakeSyncStorage = fakeSyncStorage(initial, {
      settings: nativeIncomingBytes,
    });

    expect(storageBytes(initial) + nativeIncomingBytes).toBe(SYNC_QUOTA_BYTES_TOTAL + 1);

    await setSyncItemsWithinQuota({ settings: incoming }, fake.area);

    expect(fake.trace).toEqual([`remove:${monthlyKey}`, 'set:settings']);
    expect(fake.state[monthlyKey]).toBeUndefined();
    expect(fake.state.settings).toEqual(incoming);
  });

  it('evicts monthly history when Chromium escaping crosses the total limit', async () => {
    const monthlyKey: string = 'aggm:dev-a:2025-01';
    const initial: Record<string, unknown> = nearQuotaState(1);
    initial.fillerA = 'f'.repeat(8_000);
    initial.fillerB = 'f'.repeat(602);
    const fake: FakeSyncStorage = fakeSyncStorage(initial);

    await setSyncItemsWithinQuota({ settings: '<' }, fake.area);

    expect(fake.trace).toEqual([`remove:${monthlyKey}`, 'set:settings']);
    expect(fake.state[monthlyKey]).toBeUndefined();
    expect(fake.state.settings).toBe('<');
  });

  it('evicts oldest monthly history before a write would exceed the total quota', async () => {
    const fake: FakeSyncStorage = fakeSyncStorage(nearQuotaState());

    await setSyncItemsWithinQuota({ settings: 's'.repeat(4_000) }, fake.area);

    expect(fake.trace).toEqual(['remove:aggm:dev-a:2025-01', 'set:settings']);
    expect(fake.state['aggm:dev-a:2025-01']).toBeUndefined();
    expect(fake.state.settings).toBe('s'.repeat(4_000));
  });

  it('evicts monthly history in chronological order across devices', async () => {
    const initial: Record<string, unknown> = nearQuotaState(2_900);
    initial['aggm:dev-b:2024-12'] = 'a'.repeat(1_900);
    initial['aggm:dev-c:2025-01'] = 'b'.repeat(1_900);
    const fake: FakeSyncStorage = fakeSyncStorage(initial);

    await setSyncItemsWithinQuota({ settings: 's'.repeat(5_000) }, fake.area);

    expect(fake.trace[0]).toBe('remove:aggm:dev-b:2024-12,aggm:dev-a:2025-01');
    expect(fake.state['aggm:dev-c:2025-01']).toBe('b'.repeat(1_900));
  });

  it('omits an incoming month older than stored history when quota requires compaction', async () => {
    const initial: Record<string, unknown> = nearQuotaState();
    const fake: FakeSyncStorage = fakeSyncStorage(initial);

    await setSyncItemsWithinQuota({ 'aggm:dev-b:2024-12': 'o'.repeat(4_000) }, fake.area);

    expect(fake.trace).toEqual([]);
    expect(fake.state).toEqual(initial);
  });

  it('removes an incoming replacement when it is the oldest projected month', async () => {
    const initial: Record<string, unknown> = nearQuotaState();
    const fake: FakeSyncStorage = fakeSyncStorage(initial);

    await setSyncItemsWithinQuota(
      {
        'aggm:dev-a:2025-01': 'r'.repeat(8_000),
        settings: 's'.repeat(2_000),
      },
      fake.area,
    );

    expect(fake.trace).toEqual(['remove:aggm:dev-a:2025-01', 'set:settings']);
    expect(fake.state['aggm:dev-a:2025-01']).toBeUndefined();
    expect(fake.state.settings).toBe('s'.repeat(2_000));
  });

  it('charges replacements only for their net increase', async () => {
    const initial: Record<string, unknown> = nearQuotaState(1_900);
    initial.settings = 's'.repeat(3_900);
    const fake: FakeSyncStorage = fakeSyncStorage(initial);

    await setSyncItemsWithinQuota({ settings: 'r'.repeat(4_000) }, fake.area);

    expect(fake.trace).toEqual(['set:settings']);
    expect(fake.state['aggm:dev-a:2025-01']).toBeDefined();
  });

  it('leaves storage untouched when monthly eviction cannot make the batch fit', async () => {
    const initial: Record<string, unknown> = {
      'aggm:dev-a:2025-01': 'm'.repeat(500),
    };
    for (let index: number = 0; index < 12; index++) {
      initial[`agg:dev-a:2026-08-${String(index + 1).padStart(2, '0')}`] = 'd'.repeat(8_100);
    }
    const fake: FakeSyncStorage = fakeSyncStorage(initial);

    await expect(
      setSyncItemsWithinQuota({ settings: 's'.repeat(8_000) }, fake.area),
    ).rejects.toThrow('cannot fit after compacting all monthly history');

    expect(fake.trace).toEqual([]);
    expect(fake.state).toEqual(initial);
  });

  it('serializes removals with quota-checked writes', async () => {
    const fake: FakeSyncStorage = fakeSyncStorage(nearQuotaState());

    await Promise.all([
      setSyncItemsWithinQuota({ settings: 's'.repeat(4_000) }, fake.area),
      removeSyncItems(['agg:dev-a:2026-08-01'], fake.area),
    ]);

    expect(fake.trace).toEqual([
      'remove:aggm:dev-a:2025-01',
      'set:settings',
      'remove:agg:dev-a:2026-08-01',
    ]);
  });
});

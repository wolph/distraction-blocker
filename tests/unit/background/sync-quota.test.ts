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

function storageBytes(items: Record<string, unknown>): number {
  return Object.entries(items).reduce(
    (total: number, [key, value]: [string, unknown]): number => total + syncItemBytes(key, value),
    0,
  );
}

function fakeSyncStorage(initial: Record<string, unknown>): FakeSyncStorage {
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
      if (keys === null || keys === undefined) return storageBytes(state);
      const requested: string[] = typeof keys === 'string' ? [keys] : keys;
      return requested.reduce(
        (total: number, key: string): number =>
          total + (Object.hasOwn(state, key) ? syncItemBytes(key, state[key]) : 0),
        0,
      );
    }) as unknown as chrome.storage.StorageArea['getBytesInUse'],
    set: vi.fn(async (items: Record<string, unknown>): Promise<void> => {
      const projected: Record<string, unknown> = { ...state, ...structuredClone(items) };
      if (storageBytes(projected) > SYNC_QUOTA_BYTES_TOTAL) throw new Error('QUOTA_BYTES exceeded');
      trace.push(`set:${Object.keys(items).sort().join(',')}`);
      Object.assign(state, structuredClone(items));
    }) as chrome.storage.StorageArea['set'],
    remove: vi.fn(async (keys: string | string[]): Promise<void> => {
      const requested: string[] = typeof keys === 'string' ? [keys] : keys;
      trace.push(`remove:${requested.join(',')}`);
      for (const key of requested) delete state[key];
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

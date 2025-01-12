import { describe, expect, it } from 'vitest';
import {
  assertSyncItemWithinQuota,
  SYNC_QUOTA_BYTES_PER_ITEM,
  sanitizeSyncJournal,
  syncItemBytes,
} from '../../../src/background/sync-quota';

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

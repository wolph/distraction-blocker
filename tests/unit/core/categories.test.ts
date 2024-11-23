import { describe, expect, it } from 'vitest';
import { ALL_CATEGORIES } from '../../../src/core/categories';
import { validateRule } from '../../../src/core/matcher';

describe('bundled categories', () => {
  it('ships all seven categories with entries', () => {
    const ids: string[] = ALL_CATEGORIES.map((c) => c.id);
    expect(ids).toEqual(['social', 'video', 'news', 'mail', 'shopping', 'gaming', 'forums']);
    for (const cat of ALL_CATEGORIES) expect(cat.hosts.length).toBeGreaterThanOrEqual(5);
  });
  it('every entry is a valid host rule with no duplicates inside a category', () => {
    for (const cat of ALL_CATEGORIES) {
      expect(new Set(cat.hosts).size).toBe(cat.hosts.length);
      for (const host of cat.hosts) {
        expect(validateRule({ kind: 'host', pattern: host })).toBeNull();
      }
    }
  });
});

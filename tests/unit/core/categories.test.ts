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

  it('ships a broad starting list in every category', () => {
    for (const cat of ALL_CATEGORIES) {
      expect(cat.hosts.length, `${cat.id} is too small to start from`).toBeGreaterThanOrEqual(40);
    }
  });

  it('blocks the world rather than one country, so no ccTLD dominates a category', () => {
    for (const cat of ALL_CATEGORIES) {
      const counts: Map<string, number> = new Map<string, number>();
      for (const host of cat.hosts) {
        const tld: string = host.slice(host.lastIndexOf('.') + 1);
        counts.set(tld, (counts.get(tld) ?? 0) + 1);
      }
      for (const [tld, count] of counts) {
        if (tld === 'com' || tld === 'org' || tld === 'net') continue;
        expect(count / cat.hosts.length, `${cat.id} leans on .${tld}`).toBeLessThan(0.2);
      }
    }
  });

  it('gives every host one category, and never an entry a broader one already covers', () => {
    const owner: Map<string, string> = new Map<string, string>();
    for (const cat of ALL_CATEGORIES) {
      for (const host of cat.hosts) {
        expect(owner.get(host), `${host} is bundled twice`).toBeUndefined();
        owner.set(host, cat.id);
      }
    }
    const covered: string[] = [];
    for (const host of owner.keys()) {
      const labels: string[] = host.split('.');
      for (let index = 1; index < labels.length; index += 1) {
        const parent: string = labels.slice(index).join('.');
        if (owner.has(parent)) covered.push(`${host} is already covered by ${parent}`);
      }
    }
    expect(covered).toEqual([]);
  });
});

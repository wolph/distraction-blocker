import { describe, expect, it } from 'vitest';
import { ALL_CATEGORIES } from '../../../src/core/categories';
import { filterHosts, HOST_PAGE_SIZE, hostQueryTerms } from '../../../src/core/host-search';
import type { CategoryList } from '../../../src/shared/types';

const HOSTS: readonly string[] = [
  'facebook.com',
  'news.ycombinator.com',
  'BBC.co.uk',
  'nytimes.com',
  'mail.google.com',
];

describe('host search', () => {
  it('returns the whole list for a blank query', () => {
    expect(filterHosts(HOSTS, '')).toEqual([...HOSTS]);
    expect(filterHosts(HOSTS, '   ')).toEqual([...HOSTS]);
    expect(hostQueryTerms('   ')).toEqual([]);
  });

  it('matches anywhere in the host and ignores case on both sides', () => {
    expect(filterHosts(HOSTS, 'YCOMBINATOR')).toEqual(['news.ycombinator.com']);
    expect(filterHosts(HOSTS, 'bbc')).toEqual(['BBC.co.uk']);
    expect(filterHosts(HOSTS, '.co.uk')).toEqual(['BBC.co.uk']);
  });

  it('requires every term, so two words narrow rather than widen', () => {
    expect(filterHosts(HOSTS, 'mail google')).toEqual(['mail.google.com']);
    expect(filterHosts(HOSTS, 'mail nytimes')).toEqual([]);
    expect(hostQueryTerms(' Mail  GOOGLE ')).toEqual(['mail', 'google']);
  });

  it('keeps list order and leaves the source list untouched', () => {
    const source: string[] = [...HOSTS];
    expect(filterHosts(source, 'com')).toEqual([
      'facebook.com',
      'news.ycombinator.com',
      'nytimes.com',
      'mail.google.com',
    ]);
    expect(source).toEqual([...HOSTS]);
  });

  it('pages the bundled categories, so the search field has work to do', () => {
    const largest: number = Math.max(
      ...ALL_CATEGORIES.map((category: CategoryList): number => category.hosts.length),
    );
    expect(HOST_PAGE_SIZE).toBeGreaterThan(0);
    expect(HOST_PAGE_SIZE).toBeLessThan(largest);
  });
});

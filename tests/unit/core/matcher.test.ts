import { describe, expect, it } from 'vitest';
import {
  compileMatcher,
  evaluateUrl,
  registrableHost,
  validateRule,
} from '../../../src/core/matcher';
import { DEFAULT_LISTS } from '../../../src/shared/constants';
import type { CategoryList, ListsConfig, SiteUnlock } from '../../../src/shared/types';

const CATS: CategoryList[] = [{ id: 'social', title: 'Social', hosts: ['facebook.com', 'x.com'] }];

function lists(partial: Partial<ListsConfig>): ListsConfig {
  return { ...DEFAULT_LISTS, categories: { ...DEFAULT_LISTS.categories }, ...partial };
}

const NOW = 1_000_000;
const NONE: SiteUnlock[] = [];

describe('host rules', () => {
  const m = compileMatcher(
    lists({ custom: [{ kind: 'host', pattern: 'reddit.com' }] }),
    [],
    'blacklist',
  );
  it('blocks the domain and all subdomains', () => {
    expect(evaluateUrl(m, 'https://reddit.com/r/all', NONE, NOW).blocked).toBe(true);
    expect(evaluateUrl(m, 'https://old.reddit.com/', NONE, NOW).blocked).toBe(true);
  });
  it('does not match substrings or other hosts', () => {
    expect(evaluateUrl(m, 'https://notreddit.com/', NONE, NOW).blocked).toBe(false);
    expect(evaluateUrl(m, 'https://reddit.com.evil.example/', NONE, NOW).blocked).toBe(false);
  });
  it('ignores ports and case', () => {
    expect(evaluateUrl(m, 'https://REDDIT.com:8443/x', NONE, NOW).blocked).toBe(true);
  });
  it('a subdomain rule blocks only its subtree', () => {
    const sub = compileMatcher(
      lists({ custom: [{ kind: 'host', pattern: 'news.ycombinator.com' }] }),
      [],
      'blacklist',
    );
    expect(evaluateUrl(sub, 'https://news.ycombinator.com/item?id=1', NONE, NOW).blocked).toBe(
      true,
    );
    expect(evaluateUrl(sub, 'https://ycombinator.com/', NONE, NOW).blocked).toBe(false);
  });

  it('treats Unicode and punycode spellings as the same IDN host', () => {
    const idn = compileMatcher(
      lists({ custom: [{ kind: 'host', pattern: 'xn--bcher-kva.example' }] }),
      [],
      'blacklist',
    );

    expect(evaluateUrl(idn, 'https://bücher.example/catalog', NONE, NOW)).toEqual({
      blocked: true,
      reason: 'custom',
      matchedPattern: 'xn--bcher-kva.example',
    });
    expect(evaluateUrl(idn, 'https://xn--bcher-kva.example/catalog', NONE, NOW).blocked).toBe(true);
  });

  it('does not confuse an IDN rule with a prefixed or Unicode-lookalike host', () => {
    const idn = compileMatcher(
      lists({ custom: [{ kind: 'host', pattern: 'bücher.example' }] }),
      [],
      'blacklist',
    );

    expect(evaluateUrl(idn, 'https://bücher.example/catalog', NONE, NOW).blocked).toBe(true);
    expect(evaluateUrl(idn, 'https://xn--bcher-kva.example/catalog', NONE, NOW).blocked).toBe(true);
    expect(evaluateUrl(idn, 'https://notbücher.example/', NONE, NOW).blocked).toBe(false);
    expect(evaluateUrl(idn, 'https://bӵcher.example/', NONE, NOW).blocked).toBe(false);
  });
});

describe('regex rules', () => {
  const m = compileMatcher(
    lists({ custom: [{ kind: 'regex', pattern: 'youtube\\.com/shorts' }] }),
    [],
    'blacklist',
  );
  it('matches against the full URL, case-insensitive', () => {
    expect(evaluateUrl(m, 'https://www.youtube.com/shorts/abc', NONE, NOW).blocked).toBe(true);
    expect(evaluateUrl(m, 'https://www.youtube.com/watch?v=abc', NONE, NOW).blocked).toBe(false);
  });
});

describe('categories and exclusions', () => {
  const m = compileMatcher(
    lists({
      categories: { ...DEFAULT_LISTS.categories, social: true },
      exclusions: { social: ['facebook.com'] },
    }),
    CATS,
    'blacklist',
  );
  it('blocks enabled category entries with reason category', () => {
    const v = evaluateUrl(m, 'https://x.com/home', NONE, NOW);
    expect(v).toEqual({ blocked: true, reason: 'category', matchedPattern: 'x.com' });
  });
  it('excluded entries are allowed, subdomains included', () => {
    expect(evaluateUrl(m, 'https://www.facebook.com/work', NONE, NOW).reason).toBe('excluded');
  });
});

describe('always-allow and unlocks', () => {
  const m = compileMatcher(
    lists({ custom: [{ kind: 'host', pattern: 'facebook.com' }] }),
    [],
    'blacklist',
  );
  it('never blocks internal pages or local hosts', () => {
    expect(evaluateUrl(m, 'chrome://extensions/', NONE, NOW).reason).toBe('always-allow');
    expect(evaluateUrl(m, 'http://localhost:3000/', NONE, NOW).reason).toBe('always-allow');
    expect(evaluateUrl(m, 'http://myapp.test/', NONE, NOW).reason).toBe('always-allow');
  });
  it('an active unlock allows, an expired one does not', () => {
    const unlocks: SiteUnlock[] = [{ host: 'facebook.com', until: NOW + 1 }];
    expect(evaluateUrl(m, 'https://m.facebook.com/', unlocks, NOW).reason).toBe('unlock');
    expect(evaluateUrl(m, 'https://m.facebook.com/', unlocks, NOW + 2).blocked).toBe(true);
  });
});

describe('whitelist mode', () => {
  const m = compileMatcher(
    lists({ whitelist: [{ kind: 'host', pattern: 'github.com' }] }),
    CATS,
    'whitelist',
  );
  it('allows listed hosts, blocks everything else', () => {
    expect(evaluateUrl(m, 'https://github.com/pulls', NONE, NOW).reason).toBe('whitelist');
    expect(evaluateUrl(m, 'https://example.com/', NONE, NOW)).toEqual({
      blocked: true,
      reason: 'whitelist-miss',
      matchedPattern: null,
    });
  });
  it('always-allow still wins in whitelist mode', () => {
    expect(evaluateUrl(m, 'http://localhost:5173/', NONE, NOW).blocked).toBe(false);
  });
});

describe('validateRule', () => {
  it('accepts hosts, rejects garbage and bad regexes', () => {
    expect(validateRule({ kind: 'host', pattern: 'nu.nl' })).toBeNull();
    expect(validateRule({ kind: 'host', pattern: 'bücher.example' })).toBeNull();
    expect(validateRule({ kind: 'host', pattern: 'not a host!' })).toMatch(/host/i);
    expect(validateRule({ kind: 'regex', pattern: '(' })).toMatch(/regex/i);
  });
});

describe('registrableHost', () => {
  it('returns eTLD+1, null for IPs', () => {
    expect(registrableHost('https://old.reddit.com/x')).toBe('reddit.com');
    expect(registrableHost('https://a.b.co.uk/')).toBe('b.co.uk');
    expect(registrableHost('http://127.0.0.1/')).toBeNull();
  });
});

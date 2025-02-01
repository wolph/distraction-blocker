import { getDomain } from 'tldts';
import {
  ALWAYS_ALLOW_HOST_SUFFIXES,
  ALWAYS_ALLOW_HOSTS,
  ALWAYS_ALLOW_SCHEMES,
} from '../shared/constants';
import type {
  CategoryList,
  ListsConfig,
  Rule,
  SessionMode,
  SiteUnlock,
  Verdict,
} from '../shared/types';

export interface CompiledMatcher {
  mode: SessionMode;
  /** host suffix rules mapped to their provenance, drives Verdict.reason */
  hosts: ReadonlyMap<string, 'category' | 'custom' | 'whitelist'>;
  /** compiled full-URL regexes with their sources */
  regexes: ReadonlyArray<{ source: string; re: RegExp; via: 'custom' | 'whitelist' }>;
  /** hosts excluded from enabled categories */
  excluded: ReadonlySet<string>;
}

type HostProvenance = 'category' | 'custom' | 'whitelist';
type RegexProvenance = 'custom' | 'whitelist';
type BlacklistHostProvenance = Exclude<HostProvenance, 'whitelist'>;

export interface StoredBlacklistMatcher {
  mode: 'blacklist';
  hosts: Array<[string, BlacklistHostProvenance]>;
  regexes: Array<{ source: string; via: 'custom' }>;
  excluded: string[];
}

export interface StoredWhitelistMatcher {
  mode: 'whitelist';
  hosts: Array<[string, 'whitelist']>;
  regexes: Array<{ source: string; via: 'whitelist' }>;
  excluded: [];
}

export type StoredCompiledMatcher = StoredBlacklistMatcher | StoredWhitelistMatcher;

export interface StoredMatcherCache {
  version: 2;
  sourceSignature: string;
  compiledSignature: string;
  modes: {
    blacklist: StoredBlacklistMatcher;
    whitelist: StoredWhitelistMatcher;
  };
}

export interface CompiledMatcherSet {
  blacklist: CompiledMatcher;
  whitelist: CompiledMatcher;
}

export interface MatcherCacheBundle {
  stored: StoredMatcherCache;
  compiled: CompiledMatcherSet;
}

const HOST_RE: RegExp = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

function normalizeHost(pattern: string): string | null {
  try {
    return new URL(`http://${pattern.trim().toLowerCase()}`).hostname;
  } catch {
    return null;
  }
}

/** Returns an error message for an invalid rule, null when valid. */
export function validateRule(rule: Rule): string | null {
  if (rule.kind === 'host') {
    const host: string | null = normalizeHost(rule.pattern);
    if (host === null || !HOST_RE.test(host)) return `not a valid host name: ${rule.pattern}`;
    return null;
  }
  try {
    new RegExp(rule.pattern, 'i');
    return null;
  } catch (e: unknown) {
    return `not a valid regex: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function hostInSet(
  host: string,
  set: ReadonlyMap<string, string> | ReadonlySet<string>,
): string | null {
  const has: (h: string) => boolean = (h: string): boolean =>
    set instanceof Map ? set.has(h) : (set as ReadonlySet<string>).has(h);
  let probe: string = host;
  for (;;) {
    if (has(probe)) return probe;
    const dot: number = probe.indexOf('.');
    if (dot === -1) return null;
    probe = probe.slice(dot + 1);
  }
}

export function compileMatcher(
  lists: ListsConfig,
  categories: CategoryList[],
  mode: SessionMode,
): CompiledMatcher {
  const hosts: Map<string, 'category' | 'custom' | 'whitelist'> = new Map();
  const regexes: Array<{ source: string; re: RegExp; via: 'custom' | 'whitelist' }> = [];
  const excluded: Set<string> = new Set();

  const addRules: (rules: Rule[], via: 'custom' | 'whitelist') => void = (
    rules: Rule[],
    via: 'custom' | 'whitelist',
  ): void => {
    for (const rule of rules) {
      if (validateRule(rule) !== null) continue;
      if (rule.kind === 'host') {
        const host: string | null = normalizeHost(rule.pattern);
        if (host !== null && !hosts.has(host)) hosts.set(host, via);
      } else {
        regexes.push({ source: rule.pattern, re: new RegExp(rule.pattern, 'i'), via });
      }
    }
  };

  if (mode === 'whitelist') {
    addRules(lists.whitelist, 'whitelist');
  } else {
    for (const cat of categories) {
      if (!lists.categories[cat.id]) continue;
      const excludedHere: string[] = lists.exclusions[cat.id] ?? [];
      for (const raw of cat.hosts) {
        const host: string | null = normalizeHost(raw);
        if (host === null) continue;
        if (excludedHere.includes(raw)) excluded.add(host);
        else if (!hosts.has(host)) hosts.set(host, 'category');
      }
    }
    addRules(lists.custom, 'custom');
  }
  return { mode, hosts, regexes, excluded };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record: Record<string, unknown> = value as Record<string, unknown>;
  const members: string[] = Object.keys(record)
    .sort()
    .map((key: string): string => `${JSON.stringify(key)}:${stableJson(record[key])}`);
  return `{${members.join(',')}}`;
}

function sourceSignature(lists: ListsConfig, categories: CategoryList[]): string {
  return stableJson({ categories, lists });
}

function storeBlacklistMatcher(matcher: CompiledMatcher): StoredBlacklistMatcher {
  const hosts: Array<[string, BlacklistHostProvenance]> = [];
  for (const [host, provenance] of matcher.hosts) {
    if (provenance === 'whitelist') throw new Error('blacklist matcher has whitelist provenance');
    hosts.push([host, provenance]);
  }
  const regexes: Array<{ source: string; via: 'custom' }> = matcher.regexes.map(
    (entry: { source: string; via: RegexProvenance }): { source: string; via: 'custom' } => {
      if (entry.via !== 'custom') throw new Error('blacklist matcher has whitelist regex');
      return { source: entry.source, via: 'custom' };
    },
  );
  return {
    mode: 'blacklist',
    hosts,
    regexes,
    excluded: [...matcher.excluded],
  };
}

function storeWhitelistMatcher(matcher: CompiledMatcher): StoredWhitelistMatcher {
  const hosts: Array<[string, 'whitelist']> = [];
  for (const [host, provenance] of matcher.hosts) {
    if (provenance !== 'whitelist') throw new Error('whitelist matcher has blacklist provenance');
    hosts.push([host, provenance]);
  }
  const regexes: Array<{ source: string; via: 'whitelist' }> = matcher.regexes.map(
    (entry: { source: string; via: RegexProvenance }): { source: string; via: 'whitelist' } => {
      if (entry.via !== 'whitelist') throw new Error('whitelist matcher has custom regex');
      return { source: entry.source, via: 'whitelist' };
    },
  );
  if (matcher.excluded.size !== 0) throw new Error('whitelist matcher has exclusions');
  return {
    mode: 'whitelist',
    hosts,
    regexes,
    excluded: [],
  };
}

export function buildMatcherCache(
  lists: ListsConfig,
  categories: CategoryList[],
): MatcherCacheBundle {
  const compiled: CompiledMatcherSet = {
    blacklist: compileMatcher(lists, categories, 'blacklist'),
    whitelist: compileMatcher(lists, categories, 'whitelist'),
  };
  const modes: StoredMatcherCache['modes'] = {
    blacklist: storeBlacklistMatcher(compiled.blacklist),
    whitelist: storeWhitelistMatcher(compiled.whitelist),
  };
  return {
    stored: {
      version: 2,
      sourceSignature: sourceSignature(lists, categories),
      compiledSignature: stableJson(modes),
      modes,
    },
    compiled,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual: string[] = Object.keys(value).sort();
  const expected: string[] = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key: string, i: number): boolean => key === expected[i])
  );
}

function isNormalizedHost(value: unknown): value is string {
  return typeof value === 'string' && HOST_RE.test(value) && normalizeHost(value) === value;
}

function validHostProvenance(value: unknown, mode: SessionMode): value is HostProvenance {
  return mode === 'blacklist' ? value === 'category' || value === 'custom' : value === 'whitelist';
}

function validRegexProvenance(value: unknown, mode: SessionMode): value is RegexProvenance {
  return mode === 'blacklist' ? value === 'custom' : value === 'whitelist';
}

function restoreStoredMatcher(value: unknown, mode: SessionMode): CompiledMatcher | null {
  if (!isRecord(value) || !hasExactKeys(value, ['mode', 'hosts', 'regexes', 'excluded'])) {
    return null;
  }
  if (value.mode !== mode || !Array.isArray(value.hosts) || !Array.isArray(value.regexes)) {
    return null;
  }
  if (!Array.isArray(value.excluded)) return null;

  const hosts: Map<string, HostProvenance> = new Map();
  for (const candidate of value.hosts) {
    if (!Array.isArray(candidate) || candidate.length !== 2) return null;
    const [host, provenance]: unknown[] = candidate;
    if (!isNormalizedHost(host) || !validHostProvenance(provenance, mode) || hosts.has(host)) {
      return null;
    }
    hosts.set(host, provenance);
  }

  const regexes: Array<{ source: string; re: RegExp; via: RegexProvenance }> = [];
  for (const candidate of value.regexes) {
    if (!isRecord(candidate) || !hasExactKeys(candidate, ['source', 'via'])) return null;
    if (typeof candidate.source !== 'string' || !validRegexProvenance(candidate.via, mode)) {
      return null;
    }
    try {
      regexes.push({
        source: candidate.source,
        re: new RegExp(candidate.source, 'i'),
        via: candidate.via,
      });
    } catch {
      return null;
    }
  }

  const excluded: Set<string> = new Set();
  for (const host of value.excluded) {
    if (!isNormalizedHost(host) || excluded.has(host)) return null;
    excluded.add(host);
  }
  if (mode === 'whitelist' && excluded.size !== 0) return null;
  return { mode, hosts, regexes, excluded };
}

export function restoreMatcherCache(
  value: unknown,
  lists: ListsConfig,
  categories: CategoryList[],
): CompiledMatcherSet | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'sourceSignature', 'compiledSignature', 'modes'])
  ) {
    return null;
  }
  if (
    value.version !== 2 ||
    value.sourceSignature !== sourceSignature(lists, categories) ||
    typeof value.compiledSignature !== 'string' ||
    !isRecord(value.modes) ||
    !hasExactKeys(value.modes, ['blacklist', 'whitelist']) ||
    value.compiledSignature !== stableJson(value.modes)
  ) {
    return null;
  }
  const blacklist: CompiledMatcher | null = restoreStoredMatcher(
    value.modes.blacklist,
    'blacklist',
  );
  const whitelist: CompiledMatcher | null = restoreStoredMatcher(
    value.modes.whitelist,
    'whitelist',
  );
  return blacklist === null || whitelist === null ? null : { blacklist, whitelist };
}

/** eTLD+1 via tldts, null for IPs and unparseable input (callers fall back to hostname). */
export function registrableHost(url: string): string | null {
  return getDomain(url);
}

/** First match wins: always-allow, unlocks, exclusions, then rules, then mode default. */
export function evaluateUrl(
  matcher: CompiledMatcher,
  url: string,
  unlocks: SiteUnlock[],
  now: number,
): Verdict {
  const allow: (reason: Verdict['reason'], matchedPattern?: string | null) => Verdict = (
    reason: Verdict['reason'],
    matchedPattern: string | null = null,
  ): Verdict => ({
    blocked: false,
    reason,
    matchedPattern,
  });
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return allow('default');
  }
  if (ALWAYS_ALLOW_SCHEMES.includes(parsed.protocol)) return allow('always-allow');
  const host: string = parsed.hostname;
  if (
    ALWAYS_ALLOW_HOSTS.includes(host) ||
    ALWAYS_ALLOW_HOST_SUFFIXES.some((s: string): boolean => host.endsWith(s))
  ) {
    return allow('always-allow');
  }
  const domain: string = registrableHost(url) ?? host;
  for (const u of unlocks) {
    if (u.until > now && (u.host === domain || u.host === host)) return allow('unlock');
  }
  if (matcher.mode === 'whitelist') {
    const hit: string | null = hostInSet(host, matcher.hosts);
    if (hit !== null) return allow('whitelist', hit);
    for (const r of matcher.regexes) {
      if (r.re.test(url)) return allow('whitelist', r.source);
    }
    return { blocked: true, reason: 'whitelist-miss', matchedPattern: null };
  }
  if (hostInSet(host, matcher.excluded) !== null) return allow('excluded');
  const hit: string | null = hostInSet(host, matcher.hosts);
  if (hit !== null) {
    return {
      blocked: true,
      reason: matcher.hosts.get(hit) === 'category' ? 'category' : 'custom',
      matchedPattern: hit,
    };
  }
  for (const r of matcher.regexes) {
    if (r.re.test(url)) return { blocked: true, reason: 'custom', matchedPattern: r.source };
  }
  return allow('default');
}

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
  const has = (h: string): boolean =>
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

  const addRules = (rules: Rule[], via: 'custom' | 'whitelist'): void => {
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
  const allow = (reason: Verdict['reason'], matchedPattern: string | null = null): Verdict => ({
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

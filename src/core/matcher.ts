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

/** Returns an error message for an invalid rule, null when valid. */
export function validateRule(rule: Rule): string | null {
  throw new Error('not implemented, plan 02');
}

export function compileMatcher(
  lists: ListsConfig,
  categories: CategoryList[],
  mode: SessionMode,
): CompiledMatcher {
  throw new Error('not implemented, plan 02');
}

/** First match wins: always-allow, unlocks, exclusions, then rules, then mode default. */
export function evaluateUrl(
  matcher: CompiledMatcher,
  url: string,
  unlocks: SiteUnlock[],
  now: number,
): Verdict {
  throw new Error('not implemented, plan 02');
}

/** eTLD+1 via tldts, null for IPs and unparseable input (callers fall back to hostname). */
export function registrableHost(url: string): string | null {
  throw new Error('not implemented, plan 02');
}

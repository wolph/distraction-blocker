import { getDomain } from 'tldts';
import { normalizeHost } from './host-normalization';

/** One unlock covers a registrable domain, or the exact IP or local hostname. */
export function canonicalUnlockHost(host: string | null): string | null {
  if (host === null || /[\s/@?#]/.test(host) || host === '') return null;
  const hostname: string | null = normalizeHost(host);
  if (hostname === null || hostname === '') return null;
  return getDomain(hostname) ?? hostname;
}

/** A document must prove a web hostname before it can act on an unlock gate. */
export function unlockHostForUrl(url: string): string | null {
  try {
    const parsed: URL = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return canonicalUnlockHost(parsed.hostname);
  } catch {
    return null;
  }
}

export function unlockHostMatchesUrl(host: string | null, url: string): boolean {
  const expected: string | null = canonicalUnlockHost(host);
  return expected !== null && expected === unlockHostForUrl(url);
}

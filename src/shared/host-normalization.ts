/** Canonical ASCII hostname without a DNS root dot, or null when parsing fails. */
export function normalizeHost(host: string): string | null {
  try {
    const normalized: string = new URL(`http://${host.trim().toLowerCase()}`).hostname;
    return normalized.endsWith('.') ? normalized.slice(0, -1) : normalized;
  } catch {
    return null;
  }
}

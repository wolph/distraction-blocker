export const TASK7_CANONICAL_SHUTDOWN_MESSAGE: string =
  'focus-lock background error Error: The browser is shutting down.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isEmptyStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

export function assertTask7ManifestDiagnosticsAudit(value: unknown): void {
  if (!isRecord(value)) throw new Error('Production diagnostics audit is missing');
  if (
    value.unexpectedCountsZero !== true ||
    !isRecord(value.unexpected) ||
    Object.values(value.unexpected).some(
      (messages: unknown): boolean => !isEmptyStringArray(messages),
    ) ||
    Object.hasOwn(value, 'allAuditedCountsZero')
  ) {
    throw new Error('Production diagnostic audit has unexpected or misleading zero claims');
  }
  if (!Array.isArray(value.classifiedTeardown) || value.classifiedTeardown.length !== 1) {
    throw new Error('Production diagnostic audit is missing the classified teardown bucket');
  }
  const entry: unknown = value.classifiedTeardown[0];
  const observedCounts: unknown = value.observedCounts;
  if (!isRecord(entry) || !isRecord(observedCounts)) {
    throw new Error('Production shutdown diagnostic classification is malformed');
  }
  const count: unknown = entry.actualCount;
  const allowlist: unknown = entry.allowlist;
  const messages: unknown = entry.messages;
  if (
    entry.bucket !== 'shutdownWorkerMessages' ||
    entry.classification !== 'expected-browser-shutdown' ||
    entry.policy !== 'any-count-exact-allowlist' ||
    Object.hasOwn(entry, 'expectedCount') ||
    !Number.isSafeInteger(count) ||
    (count as number) < 0 ||
    !Array.isArray(allowlist) ||
    allowlist.length !== 1 ||
    allowlist[0] !== TASK7_CANONICAL_SHUTDOWN_MESSAGE ||
    !Array.isArray(messages) ||
    messages.length !== count ||
    messages.some((message: unknown): boolean => message !== TASK7_CANONICAL_SHUTDOWN_MESSAGE) ||
    observedCounts.shutdownWorkerMessages !== count
  ) {
    throw new Error('Production shutdown diagnostics differ from the canonical allowlist policy');
  }
}

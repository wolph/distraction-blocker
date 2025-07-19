import { describe, expect, it } from 'vitest';
import {
  assertTask7ManifestDiagnosticsAudit,
  TASK7_CANONICAL_SHUTDOWN_MESSAGE,
} from '../../../scripts/task7-manifest-diagnostics';

function audit(message: string = TASK7_CANONICAL_SHUTDOWN_MESSAGE): unknown {
  return {
    classifiedTeardown: [
      {
        actualCount: 2,
        allowlist: [message],
        bucket: 'shutdownWorkerMessages',
        classification: 'expected-browser-shutdown',
        messages: [message, message],
        policy: 'any-count-exact-allowlist',
      },
    ],
    observedCounts: { shutdownWorkerMessages: 2 },
    unexpected: {
      blockedRequests: [],
      consoleErrors: [],
      intentionalWorkerStopMessages: [],
      pageErrors: [],
      requestErrors: [],
      workerErrors: [],
    },
    unexpectedCountsZero: true,
  };
}

describe('Task 7 manifest diagnostics contract', () => {
  it('pins shutdown classification to the canonical message', (): void => {
    expect((): void => assertTask7ManifestDiagnosticsAudit(audit())).not.toThrow();
    expect((): void =>
      assertTask7ManifestDiagnosticsAudit(audit('self-declared replacement')),
    ).toThrow(/canonical|shutdown/i);
  });
});

import { describe, expect, it } from 'vitest';
import {
  type BrowserDiagnostics,
  createBrowserDiagnostics,
  EXPECTED_BROWSER_SHUTDOWN_MESSAGE,
} from '../../e2e/browser-diagnostics';
import { auditTask7Diagnostics, type Task7DiagnosticsAudit } from '../../e2e/task7-diagnostics';

function expectedDiagnostics(): BrowserDiagnostics {
  const diagnostics: BrowserDiagnostics = createBrowserDiagnostics();
  diagnostics.shutdownWorkerMessages.push(
    EXPECTED_BROWSER_SHUTDOWN_MESSAGE,
    EXPECTED_BROWSER_SHUTDOWN_MESSAGE,
  );
  return diagnostics;
}

describe('Task 7 diagnostics evidence contract', () => {
  it('records exact classified teardown messages without claiming an invariant count', (): void => {
    const audit: Task7DiagnosticsAudit = auditTask7Diagnostics(expectedDiagnostics());

    expect(audit.unexpectedCountsZero).toBe(true);
    expect(audit.classifiedTeardown).toEqual([
      {
        actualCount: 2,
        allowlist: [EXPECTED_BROWSER_SHUTDOWN_MESSAGE],
        bucket: 'shutdownWorkerMessages',
        classification: 'expected-browser-shutdown',
        messages: [EXPECTED_BROWSER_SHUTDOWN_MESSAGE, EXPECTED_BROWSER_SHUTDOWN_MESSAGE],
        policy: 'any-count-exact-allowlist',
      },
    ]);
    expect(audit).not.toHaveProperty('allAuditedCountsZero');
  });

  it.each([0, 2, 5])('accepts %i exact allowlisted shutdown messages', (count: number): void => {
    const diagnostics: BrowserDiagnostics = createBrowserDiagnostics();
    diagnostics.shutdownWorkerMessages.push(
      ...Array.from({ length: count }, (): string => EXPECTED_BROWSER_SHUTDOWN_MESSAGE),
    );

    const classified = auditTask7Diagnostics(diagnostics).classifiedTeardown[0];
    expect(classified?.actualCount).toBe(count);
    expect(classified?.messages).toHaveLength(count);
  });

  it.each([
    {
      label: 'changed message',
      mutate: (diagnostics: BrowserDiagnostics): void => {
        diagnostics.shutdownWorkerMessages[1] = 'focus-lock background error Error: changed';
      },
    },
    {
      label: 'unclassified message',
      mutate: (diagnostics: BrowserDiagnostics): void => {
        diagnostics.workerErrors.push('unclassified teardown failure');
      },
    },
  ])('rejects a $label', ({ mutate }): void => {
    const diagnostics: BrowserDiagnostics = expectedDiagnostics();
    mutate(diagnostics);

    expect((): Task7DiagnosticsAudit => auditTask7Diagnostics(diagnostics)).toThrow(
      /diagnostic|classified|count|allowlist|unexpected/i,
    );
  });
});

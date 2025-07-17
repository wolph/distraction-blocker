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
  it('records exact classified teardown messages without claiming every observed count is zero', (): void => {
    const audit: Task7DiagnosticsAudit = auditTask7Diagnostics(expectedDiagnostics());

    expect(audit.unexpectedCountsZero).toBe(true);
    expect(audit.classifiedTeardown).toEqual([
      {
        actualCount: 2,
        allowlist: [EXPECTED_BROWSER_SHUTDOWN_MESSAGE],
        bucket: 'shutdownWorkerMessages',
        classification: 'expected-browser-shutdown',
        expectedCount: 2,
        messages: [EXPECTED_BROWSER_SHUTDOWN_MESSAGE, EXPECTED_BROWSER_SHUTDOWN_MESSAGE],
      },
    ]);
    expect(audit).not.toHaveProperty('allAuditedCountsZero');
  });

  it('records any exact allowlisted count outside persistent evidence mode', (): void => {
    expect(
      (): Task7DiagnosticsAudit => auditTask7Diagnostics(createBrowserDiagnostics(), null),
    ).not.toThrow();
    expect(
      (): Task7DiagnosticsAudit => auditTask7Diagnostics(expectedDiagnostics(), null),
    ).not.toThrow();
    const extra: BrowserDiagnostics = expectedDiagnostics();
    extra.shutdownWorkerMessages.push(EXPECTED_BROWSER_SHUTDOWN_MESSAGE);
    expect(auditTask7Diagnostics(extra, null).classifiedTeardown[0]?.actualCount).toBe(3);
    extra.shutdownWorkerMessages[2] = 'changed shutdown message';
    expect((): Task7DiagnosticsAudit => auditTask7Diagnostics(extra, null)).toThrow(
      /classified|allowlist/i,
    );
  });

  it.each([
    {
      label: 'changed message',
      mutate: (diagnostics: BrowserDiagnostics): void => {
        diagnostics.shutdownWorkerMessages[1] = 'focus-lock background error Error: changed';
      },
    },
    {
      label: 'extra message',
      mutate: (diagnostics: BrowserDiagnostics): void => {
        diagnostics.shutdownWorkerMessages.push(EXPECTED_BROWSER_SHUTDOWN_MESSAGE);
      },
    },
    {
      label: 'missing message',
      mutate: (diagnostics: BrowserDiagnostics): void => {
        diagnostics.shutdownWorkerMessages.pop();
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

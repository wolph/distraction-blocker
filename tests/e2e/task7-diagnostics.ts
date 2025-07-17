import { type BrowserDiagnostics, EXPECTED_BROWSER_SHUTDOWN_MESSAGE } from './browser-diagnostics';

export interface Task7ClassifiedDiagnostic {
  actualCount: number;
  allowlist: readonly string[];
  bucket: 'shutdownWorkerMessages';
  classification: 'expected-browser-shutdown';
  expectedCount: number;
  messages: string[];
}

export interface Task7DiagnosticsAudit {
  classifiedTeardown: Task7ClassifiedDiagnostic[];
  observedCounts: Record<keyof BrowserDiagnostics, number>;
  unexpected: Pick<
    BrowserDiagnostics,
    | 'blockedRequests'
    | 'consoleErrors'
    | 'intentionalWorkerStopMessages'
    | 'pageErrors'
    | 'requestErrors'
    | 'workerErrors'
  >;
  unexpectedCountsZero: true;
}

function normalizeTask7DiagnosticMessage(message: string): string {
  return message.replace(/\r\n?/g, '\n').trim();
}

export function auditTask7Diagnostics(
  diagnostics: BrowserDiagnostics,
  expectedShutdownCount: number | null = 2,
): Task7DiagnosticsAudit {
  const unexpected: Task7DiagnosticsAudit['unexpected'] = {
    blockedRequests: diagnostics.blockedRequests.map(normalizeTask7DiagnosticMessage),
    consoleErrors: diagnostics.consoleErrors.map(normalizeTask7DiagnosticMessage),
    intentionalWorkerStopMessages: diagnostics.intentionalWorkerStopMessages.map(
      normalizeTask7DiagnosticMessage,
    ),
    pageErrors: diagnostics.pageErrors.map(normalizeTask7DiagnosticMessage),
    requestErrors: diagnostics.requestErrors.map(normalizeTask7DiagnosticMessage),
    workerErrors: diagnostics.workerErrors.map(normalizeTask7DiagnosticMessage),
  };
  const unexpectedMessages: string[] = Object.values(unexpected).flat();
  if (unexpectedMessages.length > 0) {
    throw new Error(`Task 7 unexpected diagnostics: ${JSON.stringify(unexpected)}`);
  }

  const shutdownMessages: string[] = diagnostics.shutdownWorkerMessages.map(
    normalizeTask7DiagnosticMessage,
  );
  if (
    (expectedShutdownCount !== null && shutdownMessages.length !== expectedShutdownCount) ||
    shutdownMessages.some(
      (message: string): boolean => message !== EXPECTED_BROWSER_SHUTDOWN_MESSAGE,
    )
  ) {
    throw new Error(
      `Task 7 classified teardown diagnostics differ from the exact allowlist/count: ${JSON.stringify(shutdownMessages)}`,
    );
  }

  const observedCounts = Object.fromEntries(
    Object.entries(diagnostics).map(([bucket, messages]: [string, string[]]): [string, number] => [
      bucket,
      messages.length,
    ]),
  ) as Record<keyof BrowserDiagnostics, number>;
  return {
    classifiedTeardown: [
      {
        actualCount: shutdownMessages.length,
        allowlist: [EXPECTED_BROWSER_SHUTDOWN_MESSAGE],
        bucket: 'shutdownWorkerMessages',
        classification: 'expected-browser-shutdown',
        expectedCount: shutdownMessages.length,
        messages: shutdownMessages,
      },
    ],
    observedCounts,
    unexpected,
    unexpectedCountsZero: true,
  };
}

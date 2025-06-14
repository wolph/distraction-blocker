import type {
  BrowserContext,
  ConsoleMessage,
  Page,
  Request as PlaywrightRequest,
  Worker,
} from '@playwright/test';

export interface BrowserDiagnostics {
  blockedRequests: string[];
  consoleErrors: string[];
  intentionalWorkerStopMessages: string[];
  pageErrors: string[];
  requestErrors: string[];
  shutdownWorkerMessages: string[];
  workerErrors: string[];
}

export const EXPECTED_BROWSER_SHUTDOWN_MESSAGE: string =
  'focus-lock background error Error: The browser is shutting down.';
export const EXPECTED_INTENTIONAL_WORKER_STOP_MESSAGE: string =
  'focus-lock background error Error: No SW';

const intentionalWorkerStopWindows: WeakSet<BrowserDiagnostics> = new WeakSet<BrowserDiagnostics>();

export function createBrowserDiagnostics(): BrowserDiagnostics {
  return {
    blockedRequests: [],
    consoleErrors: [],
    intentionalWorkerStopMessages: [],
    pageErrors: [],
    requestErrors: [],
    shutdownWorkerMessages: [],
    workerErrors: [],
  };
}

export function beginIntentionalWorkerStopDiagnosticWindow(
  diagnostics: BrowserDiagnostics,
): () => void {
  if (intentionalWorkerStopWindows.has(diagnostics)) {
    throw new Error('intentional worker-stop diagnostic window is already open');
  }
  intentionalWorkerStopWindows.add(diagnostics);
  let closed: boolean = false;
  return (): void => {
    if (closed) return;
    closed = true;
    intentionalWorkerStopWindows.delete(diagnostics);
  };
}

function classifyIntentionalWorkerStopMessage(
  diagnostics: BrowserDiagnostics,
  message: ConsoleMessage,
): boolean {
  if (
    message.type() !== 'error' ||
    message.text() !== EXPECTED_INTENTIONAL_WORKER_STOP_MESSAGE ||
    !intentionalWorkerStopWindows.has(diagnostics)
  ) {
    return false;
  }
  diagnostics.intentionalWorkerStopMessages.push(message.text());
  return true;
}

function errorFromUnknown(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function assertNoUnexpectedBrowserDiagnostics(diagnostics: BrowserDiagnostics): void {
  const invalidIntentionalWorkerStopMessages: string[] =
    diagnostics.intentionalWorkerStopMessages.filter(
      (message: string): boolean => message !== EXPECTED_INTENTIONAL_WORKER_STOP_MESSAGE,
    );
  const invalidShutdownMessages: string[] = diagnostics.shutdownWorkerMessages.filter(
    (message: string): boolean => message !== EXPECTED_BROWSER_SHUTDOWN_MESSAGE,
  );
  const unexpected: Record<string, string[]> = {
    blockedRequests: diagnostics.blockedRequests,
    consoleErrors: diagnostics.consoleErrors,
    intentionalWorkerStopMessages: invalidIntentionalWorkerStopMessages,
    pageErrors: diagnostics.pageErrors,
    requestErrors: diagnostics.requestErrors,
    shutdownWorkerMessages: invalidShutdownMessages,
    workerErrors: diagnostics.workerErrors,
  };
  if (Object.values(unexpected).every((messages: string[]): boolean => messages.length === 0)) {
    return;
  }
  throw new Error(`unexpected browser diagnostics: ${JSON.stringify(unexpected)}`);
}

export async function closeAndAssertBrowserDiagnostics(
  close: () => Promise<void>,
  diagnostics: BrowserDiagnostics,
): Promise<void> {
  const failures: Error[] = [];
  try {
    await close();
  } catch (error: unknown) {
    failures.push(errorFromUnknown(error));
  }
  try {
    assertNoUnexpectedBrowserDiagnostics(diagnostics);
  } catch (error: unknown) {
    failures.push(errorFromUnknown(error));
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'browser context teardown and diagnostics failed');
  }
}

export function monitorBrowserContext(
  context: BrowserContext,
  diagnostics: BrowserDiagnostics,
): void {
  const monitoredPages: WeakSet<Page> = new WeakSet<Page>();
  const monitoredWorkers: WeakSet<Worker> = new WeakSet<Worker>();
  const monitorPage = (page: Page): void => {
    if (monitoredPages.has(page)) return;
    monitoredPages.add(page);
    page.on('console', (message: ConsoleMessage): void => {
      if (message.type() !== 'error') return;
      if (classifyIntentionalWorkerStopMessage(diagnostics, message)) return;
      const location: string = message.location().url;
      diagnostics.consoleErrors.push(
        location === '' ? message.text() : `${location}: ${message.text()}`,
      );
    });
    page.on('pageerror', (error: Error): void => {
      diagnostics.pageErrors.push(error.message);
    });
  };
  const monitorWorker = (worker: Worker): void => {
    if (monitoredWorkers.has(worker)) return;
    monitoredWorkers.add(worker);
    worker.on('console', (message: ConsoleMessage): void => {
      if (message.type() !== 'error') return;
      if (message.text() === EXPECTED_BROWSER_SHUTDOWN_MESSAGE) {
        diagnostics.shutdownWorkerMessages.push(message.text());
        return;
      }
      if (classifyIntentionalWorkerStopMessage(diagnostics, message)) return;
      diagnostics.workerErrors.push(message.text());
    });
  };
  context.on('requestfailed', (request: PlaywrightRequest): void => {
    const failure: string = request.failure()?.errorText ?? 'failed';
    const rendered: string = `${request.url()}: ${failure}`;
    if (failure.includes('ERR_BLOCKED')) diagnostics.blockedRequests.push(rendered);
    else diagnostics.requestErrors.push(rendered);
  });
  context.on('page', monitorPage);
  context.on('serviceworker', monitorWorker);
  context.pages().forEach(monitorPage);
  context.serviceWorkers().forEach(monitorWorker);
}

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
  pageErrors: string[];
  requestErrors: string[];
  workerErrors: string[];
}

export function createBrowserDiagnostics(): BrowserDiagnostics {
  return {
    blockedRequests: [],
    consoleErrors: [],
    pageErrors: [],
    requestErrors: [],
    workerErrors: [],
  };
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
      const location: string = message.location().url;
      diagnostics.consoleErrors.push(
        location === '' ? message.text() : `${location}: ${message.text()}`,
      );
    });
    page.on('pageerror', (error: Error): void => {
      diagnostics.pageErrors.push(error.message);
    });
    page.on('requestfailed', (request: PlaywrightRequest): void => {
      const failure: string = request.failure()?.errorText ?? 'failed';
      const rendered: string = `${request.url()}: ${failure}`;
      if (failure.includes('ERR_BLOCKED')) diagnostics.blockedRequests.push(rendered);
      else diagnostics.requestErrors.push(rendered);
    });
  };
  const monitorWorker = (worker: Worker): void => {
    if (monitoredWorkers.has(worker)) return;
    monitoredWorkers.add(worker);
    worker.on('console', (message: ConsoleMessage): void => {
      if (
        message.type() === 'error' &&
        message.text() !== 'focus-lock background error Error: The browser is shutting down.'
      ) {
        diagnostics.workerErrors.push(message.text());
      }
    });
  };
  context.on('page', monitorPage);
  context.on('serviceworker', monitorWorker);
  context.pages().forEach(monitorPage);
  context.serviceWorkers().forEach(monitorWorker);
}

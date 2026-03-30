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
  /** Errors a scenario declared it was driving, kept as evidence rather than as a failure. */
  expectedWorkerErrors: string[];
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

/** One open declaration: the message a scenario is deliberately driving, and what it has seen. */
interface ExpectedWorkerErrorWindow {
  fragment: string;
  seen: string[];
}

const expectedWorkerErrorWindows: WeakMap<BrowserDiagnostics, ExpectedWorkerErrorWindow> =
  new WeakMap<BrowserDiagnostics, ExpectedWorkerErrorWindow>();

export function createBrowserDiagnostics(): BrowserDiagnostics {
  return {
    blockedRequests: [],
    consoleErrors: [],
    expectedWorkerErrors: [],
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

/**
 * Declares the one worker error a scenario is deliberately driving, and answers the close.
 *
 * Four of the session end reasons are failures the worker reports, and every fixture asserts zero
 * worker errors on close, so without this a scenario that drives one can never be green. The
 * window is narrow on purpose. Only a message carrying `messageFragment` is diverted, every other
 * error still lands in the strict buckets and still fails, and the close raises when the declared
 * error never arrived, so a scenario that quietly stops driving its failure fails rather than
 * passing on an assertion that no longer happens. Only one window is open at a time, and leaving
 * one open fails the diagnostics assertion, so this can never widen into a general mute.
 *
 * ```ts
 * const closeWindow: () => void = beginExpectedWorkerErrorWindow(diagnostics, 'website-access-lost');
 * try {
 *   await revokeWebsiteAccess();
 *   await waitForLifecycle(extPage, 'idle');
 * } finally {
 *   closeWindow();
 * }
 * ```
 */
export function beginExpectedWorkerErrorWindow(
  diagnostics: BrowserDiagnostics,
  messageFragment: string,
): () => void {
  if (messageFragment.trim() === '') {
    throw new Error('an expected worker error window needs the message it expects');
  }
  if (expectedWorkerErrorWindows.has(diagnostics)) {
    throw new Error('an expected worker error window is already open');
  }
  const declared: ExpectedWorkerErrorWindow = { fragment: messageFragment, seen: [] };
  expectedWorkerErrorWindows.set(diagnostics, declared);
  let closed: boolean = false;
  return (): void => {
    if (closed) return;
    closed = true;
    expectedWorkerErrorWindows.delete(diagnostics);
    diagnostics.expectedWorkerErrors.push(...declared.seen);
    if (declared.seen.length === 0) {
      throw new Error(`the declared worker error was never reported: ${messageFragment}`);
    }
  };
}

/** True while this message is the one an open window declared, which diverts it from the strict buckets. */
function classifyExpectedWorkerError(diagnostics: BrowserDiagnostics, text: string): boolean {
  const declared: ExpectedWorkerErrorWindow | undefined =
    expectedWorkerErrorWindows.get(diagnostics);
  if (declared === undefined || !text.includes(declared.fragment)) return false;
  declared.seen.push(text);
  return true;
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
  // An open declaration would keep diverting errors nobody is watching for any more, so the window
  // has to be closed before anything is judged.
  if (expectedWorkerErrorWindows.has(diagnostics)) {
    throw new Error('an expected worker error window is still open');
  }
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
      // A worker failure is mirrored into the page console as well, so a declaration that covered
      // only the worker channel would still fail here on the same message.
      if (classifyExpectedWorkerError(diagnostics, message.text())) return;
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
      if (classifyExpectedWorkerError(diagnostics, message.text())) return;
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

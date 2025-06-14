import type { BrowserContext, ConsoleMessage, Page, Request, Worker } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import type { BrowserDiagnostics } from '../../../tests/e2e/browser-diagnostics';
import {
  assertNoUnexpectedBrowserDiagnostics,
  beginIntentionalWorkerStopDiagnosticWindow,
  closeAndAssertBrowserDiagnostics,
  createBrowserDiagnostics,
  monitorBrowserContext,
} from '../../../tests/e2e/browser-diagnostics';

type Listener = (value: unknown) => void;

const FULL_INTENTIONAL_WORKER_STOP_MESSAGE: string = 'focus-lock background error Error: No SW';

class FakeEmitter {
  private readonly listeners: Map<string, Listener[]> = new Map<string, Listener[]>();

  on(event: string, listener: Listener): this {
    const current: Listener[] = this.listeners.get(event) ?? [];
    current.push(listener);
    this.listeners.set(event, current);
    return this;
  }

  emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

interface FakeContext extends FakeEmitter {
  pages(): Page[];
  serviceWorkers(): Worker[];
}

function fakeContext(existingWorkers: Worker[] = []): FakeContext {
  return Object.assign(new FakeEmitter(), {
    pages: (): Page[] => [],
    serviceWorkers: (): Worker[] => existingWorkers,
  });
}

function errorMessage(text: string, url: string = ''): ConsoleMessage {
  return {
    type: (): string => 'error',
    text: (): string => text,
    location: (): { url: string } => ({ url }),
  } as ConsoleMessage;
}

function requestFailure(url: string, errorText: string): Request {
  return {
    url: (): string => url,
    failure: (): { errorText: string } => ({ errorText }),
  } as Request;
}

describe('monitorBrowserContext', (): void => {
  it('cannot recover worker errors emitted before listeners attach', (): void => {
    const startupWorker: FakeEmitter = new FakeEmitter();
    const context: FakeContext = fakeContext([startupWorker as unknown as Worker]);
    const diagnostics: BrowserDiagnostics = createBrowserDiagnostics();

    startupWorker.emit('console', errorMessage('unobservable launch error'));
    monitorBrowserContext(context as unknown as BrowserContext, diagnostics);
    startupWorker.emit('console', errorMessage('observable worker error'));

    expect(diagnostics.workerErrors).toEqual(['observable worker error']);
  });

  it('collects request failures from the browser context', (): void => {
    const context: FakeContext = fakeContext();
    const diagnostics: BrowserDiagnostics = createBrowserDiagnostics();

    monitorBrowserContext(context as unknown as BrowserContext, diagnostics);
    context.emit(
      'requestfailed',
      requestFailure('https://example.test/api', 'net::ERR_CONNECTION_REFUSED'),
    );
    context.emit(
      'requestfailed',
      requestFailure('https://blocked.test/', 'net::ERR_BLOCKED_BY_CLIENT'),
    );

    expect(diagnostics.requestErrors).toEqual([
      'https://example.test/api: net::ERR_CONNECTION_REFUSED',
    ]);
    expect(diagnostics.blockedRequests).toEqual([
      'https://blocked.test/: net::ERR_BLOCKED_BY_CLIENT',
    ]);
  });

  it('captures the boot error from a worker restarted after monitoring begins', (): void => {
    const context: FakeContext = fakeContext();
    const diagnostics: BrowserDiagnostics = createBrowserDiagnostics();
    const restartedWorker: FakeEmitter = new FakeEmitter();

    monitorBrowserContext(context as unknown as BrowserContext, diagnostics);
    context.emit('serviceworker', restartedWorker as unknown as Worker);
    restartedWorker.emit('console', errorMessage('monitored restart boot failed'));

    expect(diagnostics.workerErrors).toEqual(['monitored restart boot failed']);
  });

  it('classifies exact browser shutdown messages separately from worker errors', (): void => {
    const startupWorker: FakeEmitter = new FakeEmitter();
    const context: FakeContext = fakeContext([startupWorker as unknown as Worker]);
    const diagnostics: BrowserDiagnostics = createBrowserDiagnostics();

    monitorBrowserContext(context as unknown as BrowserContext, diagnostics);
    startupWorker.emit(
      'console',
      errorMessage('focus-lock background error Error: The browser is shutting down.'),
    );
    startupWorker.emit('console', errorMessage('different worker error'));

    expect(diagnostics.shutdownWorkerMessages).toEqual([
      'focus-lock background error Error: The browser is shutting down.',
    ]);
    expect(diagnostics.workerErrors).toEqual(['different worker error']);
  });

  it('captures page console and uncaught errors from pages created after attachment', (): void => {
    const context: FakeContext = fakeContext();
    const diagnostics: BrowserDiagnostics = createBrowserDiagnostics();
    const page: FakeEmitter = new FakeEmitter();

    monitorBrowserContext(context as unknown as BrowserContext, diagnostics);
    context.emit('page', page as unknown as Page);
    page.emit('console', errorMessage('navigation failed', 'chrome-extension://test/popup.html'));
    page.emit('pageerror', new Error('page crashed'));

    expect(diagnostics.consoleErrors).toEqual([
      'chrome-extension://test/popup.html: navigation failed',
    ]);
    expect(diagnostics.pageErrors).toEqual(['page crashed']);
  });

  it('accepts the exact full diagnostic from page and worker consoles only inside the window', (): void => {
    const context: FakeContext = fakeContext();
    const diagnostics: BrowserDiagnostics = createBrowserDiagnostics();
    const page: FakeEmitter = new FakeEmitter();
    const worker: FakeEmitter = new FakeEmitter();

    monitorBrowserContext(context as unknown as BrowserContext, diagnostics);
    context.emit('page', page as unknown as Page);
    context.emit('serviceworker', worker as unknown as Worker);
    const closeWindow: () => void = beginIntentionalWorkerStopDiagnosticWindow(diagnostics);
    page.emit('console', errorMessage(FULL_INTENTIONAL_WORKER_STOP_MESSAGE));
    worker.emit('console', errorMessage(FULL_INTENTIONAL_WORKER_STOP_MESSAGE));
    closeWindow();

    expect(diagnostics.intentionalWorkerStopMessages).toEqual([
      FULL_INTENTIONAL_WORKER_STOP_MESSAGE,
      FULL_INTENTIONAL_WORKER_STOP_MESSAGE,
    ]);
    expect((): void => assertNoUnexpectedBrowserDiagnostics(diagnostics)).not.toThrow();
  });

  it('keeps the identical full diagnostic fatal outside the intentional worker-stop window', (): void => {
    const context: FakeContext = fakeContext();
    const diagnostics: BrowserDiagnostics = createBrowserDiagnostics();
    const page: FakeEmitter = new FakeEmitter();

    monitorBrowserContext(context as unknown as BrowserContext, diagnostics);
    context.emit('page', page as unknown as Page);
    const closeWindow: () => void = beginIntentionalWorkerStopDiagnosticWindow(diagnostics);
    closeWindow();
    page.emit('console', errorMessage(FULL_INTENTIONAL_WORKER_STOP_MESSAGE));

    expect(diagnostics.intentionalWorkerStopMessages).toEqual([]);
    expect(diagnostics.consoleErrors).toEqual([FULL_INTENTIONAL_WORKER_STOP_MESSAGE]);
    expect((): void => assertNoUnexpectedBrowserDiagnostics(diagnostics)).toThrow(
      FULL_INTENTIONAL_WORKER_STOP_MESSAGE,
    );
  });

  it.each([
    'No SW',
    'focus-lock background error Error: No SW!',
    'focus-lock background error Error: no sw',
  ])('keeps the in-window near-match fatal: %s', (message: string): void => {
    const context: FakeContext = fakeContext();
    const diagnostics: BrowserDiagnostics = createBrowserDiagnostics();
    const worker: FakeEmitter = new FakeEmitter();

    monitorBrowserContext(context as unknown as BrowserContext, diagnostics);
    context.emit('serviceworker', worker as unknown as Worker);
    const closeWindow: () => void = beginIntentionalWorkerStopDiagnosticWindow(diagnostics);
    worker.emit('console', errorMessage(message));
    closeWindow();

    expect(diagnostics.intentionalWorkerStopMessages).toEqual([]);
    expect(diagnostics.workerErrors).toEqual([message]);
    expect((): void => assertNoUnexpectedBrowserDiagnostics(diagnostics)).toThrow(message);
  });
});

describe('closeAndAssertBrowserDiagnostics', (): void => {
  it('closes the final context before checking late diagnostics', async (): Promise<void> => {
    const diagnostics: BrowserDiagnostics = createBrowserDiagnostics();
    let closed: boolean = false;

    await expect(
      closeAndAssertBrowserDiagnostics(async (): Promise<void> => {
        closed = true;
        diagnostics.workerErrors.push('worker teardown failed');
      }, diagnostics),
    ).rejects.toThrow('worker teardown failed');
    expect(closed).toBe(true);
  });

  it('surfaces both context-close and diagnostic failures', async (): Promise<void> => {
    const diagnostics: BrowserDiagnostics = createBrowserDiagnostics();
    diagnostics.pageErrors.push('page failed');

    await expect(
      closeAndAssertBrowserDiagnostics(async (): Promise<void> => {
        throw new Error('context close failed');
      }, diagnostics),
    ).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: 'context close failed' }),
        expect.objectContaining({ message: expect.stringContaining('page failed') }),
      ],
    });
  });
});

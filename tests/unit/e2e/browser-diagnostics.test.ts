import type { BrowserContext, ConsoleMessage, Page, Request, Worker } from '@playwright/test';
import { expect, it } from 'vitest';
import type { BrowserDiagnostics } from '../../../tests/e2e/browser-diagnostics';
import {
  createBrowserDiagnostics,
  monitorBrowserContext,
} from '../../../tests/e2e/browser-diagnostics';

type Listener = (value: unknown) => void;

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

it('captures startup, navigation, restart, request, and blocked-request diagnostics', (): void => {
  const startupWorker: FakeEmitter = new FakeEmitter();
  const initialPage: FakeEmitter = new FakeEmitter();
  const context: FakeEmitter & {
    pages(): Page[];
    serviceWorkers(): Worker[];
  } = Object.assign(new FakeEmitter(), {
    pages: (): Page[] => [],
    serviceWorkers: (): Worker[] => [startupWorker as unknown as Worker],
  });
  const diagnostics: BrowserDiagnostics = createBrowserDiagnostics();

  monitorBrowserContext(context as unknown as BrowserContext, diagnostics);
  startupWorker.emit('console', errorMessage('startup failed'));
  startupWorker.emit(
    'console',
    errorMessage('focus-lock background error Error: The browser is shutting down.'),
  );
  context.emit('page', initialPage as unknown as Page);
  initialPage.emit(
    'console',
    errorMessage('navigation failed', 'chrome-extension://test/popup.html'),
  );
  initialPage.emit('pageerror', new Error('page crashed'));
  initialPage.emit(
    'requestfailed',
    requestFailure('https://example.test/api', 'net::ERR_CONNECTION_REFUSED'),
  );
  initialPage.emit(
    'requestfailed',
    requestFailure('https://blocked.test/', 'net::ERR_BLOCKED_BY_CLIENT'),
  );
  const restartedWorker: FakeEmitter = new FakeEmitter();
  context.emit('serviceworker', restartedWorker as unknown as Worker);
  restartedWorker.emit('console', errorMessage('restart failed'));

  expect(diagnostics).toEqual({
    blockedRequests: ['https://blocked.test/: net::ERR_BLOCKED_BY_CLIENT'],
    consoleErrors: ['chrome-extension://test/popup.html: navigation failed'],
    pageErrors: ['page crashed'],
    requestErrors: ['https://example.test/api: net::ERR_CONNECTION_REFUSED'],
    workerErrors: ['startup failed', 'restart failed'],
  });
});

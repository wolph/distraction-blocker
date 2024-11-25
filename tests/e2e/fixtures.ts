import path from 'node:path';
import {
  type BrowserContext,
  test as base,
  chromium,
  type Page,
  type Worker,
} from '@playwright/test';
import type { Request, ResponseMap } from '../../src/shared/messages';
import type { Rule, SessionConfig } from '../../src/shared/types';
import { startServer, type TestServer } from './server';

interface ExtFixtures {
  context: BrowserContext;
  worker: Worker;
  extensionId: string;
  extPage: Page;
  siteUrl(pathname: string): string;
}

export const test = base.extend<ExtFixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: playwright fixture signature
  context: async ({}, use) => {
    const dist: string = path.resolve(import.meta.dirname, '../../dist');
    const context: BrowserContext = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${dist}`,
        `--load-extension=${dist}`,
        '--host-resolver-rules=MAP blocked.example 127.0.0.1, MAP *.blocked.example 127.0.0.1',
      ],
    });
    await use(context);
    await context.close();
  },
  worker: async ({ context }, use) => {
    const existing: Worker | undefined = context.serviceWorkers()[0];
    const worker: Worker = existing ?? (await context.waitForEvent('serviceworker'));
    await use(worker);
  },
  extensionId: async ({ worker }, use) => {
    await use(new URL(worker.url()).host);
  },
  extPage: async ({ context, extensionId }, use) => {
    const page: Page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await use(page);
  },
  // biome-ignore lint/correctness/noEmptyPattern: playwright fixture signature
  siteUrl: async ({}, use) => {
    const server: TestServer = await startServer();
    await use((requestedPath: string): string => {
      const pathname: string = requestedPath.startsWith('/') ? requestedPath : `/${requestedPath}`;
      return `http://blocked.example:${server.port}${pathname}`;
    });
    await server.close();
  },
});

export const expect = test.expect;

export async function sendExtensionRequest<T extends Request['type']>(
  extPage: Page,
  request: Extract<Request, { type: T }>,
): Promise<ResponseMap[T]> {
  return (await extPage.evaluate(
    async (message: Request): Promise<unknown> => await chrome.runtime.sendMessage(message),
    request,
  )) as ResponseMap[T];
}

export async function startTestSession(
  extPage: Page,
  overrides: Partial<SessionConfig> = {},
  customRules: Rule[] = [{ kind: 'host', pattern: 'blocked.example' }],
): Promise<void> {
  const config: SessionConfig = {
    mode: 'blacklist',
    strictness: 'friction',
    durationMin: 0.2,
    cycling: null,
    intention: 'e2e test run',
    source: 'manual',
    scheduleEntryId: null,
    ...overrides,
  };

  await extPage.evaluate(
    async ({ cfg, rules }): Promise<void> => {
      const listsAck: { ok: boolean; error?: string } = await chrome.runtime.sendMessage({
        type: 'updateLists',
        lists: {
          custom: rules,
          whitelist: [],
          categories: {
            social: false,
            video: false,
            news: false,
            mail: false,
            shopping: false,
            gaming: false,
            forums: false,
          },
          exclusions: {},
        },
      });
      if (!listsAck.ok) throw new Error(listsAck.error ?? 'updateLists rejected');

      const sessionAck: { ok: boolean; error?: string } = await chrome.runtime.sendMessage({
        type: 'startSession',
        config: cfg,
      });
      if (!sessionAck.ok) throw new Error(sessionAck.error ?? 'startSession rejected');
    },
    { cfg: config, rules: customRules },
  );
}

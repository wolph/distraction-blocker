import path from 'node:path';
import { type BrowserContext, test as base, chromium, type Worker } from '@playwright/test';

interface ExtFixtures {
  context: BrowserContext;
  worker: Worker;
  extensionId: string;
}

export const test = base.extend<ExtFixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: playwright fixture signature
  context: async ({}, use) => {
    const dist: string = path.resolve(import.meta.dirname, '../../dist');
    const context: BrowserContext = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
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
});

export const expect = test.expect;

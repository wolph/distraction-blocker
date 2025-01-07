import path from 'node:path';
import {
  type BrowserContext,
  test as base,
  chromium,
  type Page,
  type Worker,
} from '@playwright/test';
import type { Request, ResponseMap, SoundId } from '../../src/shared/messages';
import type { Rule, SessionConfig } from '../../src/shared/types';
import { closeContextOnSetupFailure } from './context-cleanup';
import { startServer, type TestServer } from './server';

interface ExtFixtures {
  context: BrowserContext;
  worker: Worker;
  extensionId: string;
  extPage: Page;
  siteUrl(pathname: string): string;
  restartableExtension: RestartableExtension;
}

export interface ExtensionLaunch {
  context: BrowserContext;
  worker: Worker;
  extensionId: string;
  extPage: Page;
}

export interface ObservedSound {
  type: 'playSound';
  sound: SoundId;
  volume: number;
}

export interface RestartableExtension {
  launch(): Promise<ExtensionLaunch>;
  close(): Promise<void>;
}

function extensionArgs(dist: string): string[] {
  return [
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    '--host-resolver-rules=MAP blocked.example 127.0.0.1, MAP *.blocked.example 127.0.0.1, MAP other.example 127.0.0.1',
  ];
}

async function extensionLaunch(
  profileDir: string,
  restoreLastSession: boolean,
): Promise<ExtensionLaunch> {
  const dist: string = path.resolve(import.meta.dirname, '../../dist');
  const args: string[] = extensionArgs(dist);
  if (restoreLastSession) args.push('--restore-last-session');
  const context: BrowserContext = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    args,
  });
  return await closeContextOnSetupFailure(context, async (): Promise<ExtensionLaunch> => {
    const existing: Worker | undefined = context.serviceWorkers()[0];
    const worker: Worker = existing ?? (await context.waitForEvent('serviceworker'));
    const extensionId: string = new URL(worker.url()).host;
    const extPage: Page = await context.newPage();
    await extPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    return { context, worker, extensionId, extPage };
  });
}

export const test = base.extend<ExtFixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: playwright fixture signature
  context: async ({}, use) => {
    const dist: string = path.resolve(import.meta.dirname, '../../dist');
    const context: BrowserContext = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: extensionArgs(dist),
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
  // biome-ignore lint/correctness/noEmptyPattern: playwright fixture signature
  restartableExtension: async ({}, use, testInfo) => {
    const profileDir: string = testInfo.outputPath('restart-profile');
    let current: ExtensionLaunch | null = null;
    const close = async (): Promise<void> => {
      if (current === null) return;
      const closing: ExtensionLaunch = current;
      current = null;
      await closing.context.close();
    };
    const launch = async (): Promise<ExtensionLaunch> => {
      if (current !== null) throw new Error('close the isolated browser before relaunching it');
      current = await extensionLaunch(profileDir, true);
      return current;
    };

    await use({ launch, close });
    await close();
  },
});

export const expect = test.expect;

export async function observeSoundMessages(extPage: Page): Promise<void> {
  await extPage.evaluate((): void => {
    const scope = globalThis as unknown as { __focusLockE2ESounds?: ObservedSound[] };
    scope.__focusLockE2ESounds = [];
    chrome.runtime.onMessage.addListener((message: unknown): void => {
      if (typeof message !== 'object' || message === null) return;
      const candidate = message as Partial<ObservedSound>;
      if (
        candidate.type === 'playSound' &&
        typeof candidate.sound === 'string' &&
        typeof candidate.volume === 'number'
      ) {
        scope.__focusLockE2ESounds?.push(candidate as ObservedSound);
      }
    });
  });
}

export async function observedSounds(extPage: Page): Promise<ObservedSound[]> {
  return await extPage.evaluate(
    (): ObservedSound[] =>
      (globalThis as unknown as { __focusLockE2ESounds?: ObservedSound[] }).__focusLockE2ESounds ??
      [],
  );
}

export async function clearNotifications(worker: Worker): Promise<void> {
  await worker.evaluate(async (): Promise<void> => {
    const notifications: Record<string, boolean> = await chrome.notifications.getAll();
    await Promise.all(
      Object.keys(notifications).map(
        async (notificationId: string): Promise<boolean> =>
          await chrome.notifications.clear(notificationId),
      ),
    );
  });
}

export async function notificationIds(worker: Worker): Promise<string[]> {
  return await worker.evaluate(
    async (): Promise<string[]> => Object.keys(await chrome.notifications.getAll()),
  );
}

export async function hasOffscreenAudioDocument(worker: Worker): Promise<boolean> {
  return await worker.evaluate(async (): Promise<boolean> => {
    const contexts: chrome.runtime.ExtensionContext[] = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    return contexts.some(
      (extensionContext: chrome.runtime.ExtensionContext): boolean =>
        typeof extensionContext.documentUrl === 'string' &&
        extensionContext.documentUrl.endsWith('/src/offscreen/audio.html'),
    );
  });
}

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

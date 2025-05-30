import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type BrowserContext,
  test as base,
  type CDPSession,
  chromium,
  type Page,
  type Worker,
} from '@playwright/test';
import { DEFAULT_LISTS, DEFAULT_SETTINGS, rulesFromLists } from '../../src/shared/constants';
import type { Request, ResponseMap, SoundId } from '../../src/shared/messages';
import { CONTENT_SCRIPT_ID, WEBSITE_ORIGINS } from '../../src/shared/permissions';
import type {
  ListsConfig,
  OnboardingDraft,
  Rule,
  SessionConfig,
  SetupState,
  StorageMode,
} from '../../src/shared/types';
import { closeContextOnSetupFailure } from './context-cleanup';
import { startServer, type TestServer } from './server';

interface ExtFixtures {
  context: BrowserContext;
  worker: Worker;
  extensionId: string;
  extPage: Page;
  siteUrl(pathname: string): string;
  restartableExtension: RestartableExtension;
  freshInstallExtension: FreshInstallExtension;
}

export interface ExtensionLaunch {
  context: BrowserContext;
  worker: Worker;
  extensionId: string;
  extPage: Page;
}

export interface FreshInstallLaunch extends ExtensionLaunch {
  onboardingPage: Page;
}

export interface FreshInstallExtension {
  launch(): Promise<FreshInstallLaunch>;
  close(): Promise<void>;
  relaunch(): Promise<FreshInstallLaunch>;
  grantWebsiteAccess(): Promise<FreshInstallLaunch>;
  denyWebsiteAccess(): Promise<void>;
  revokeWebsiteAccess(): Promise<void>;
  restartWorker(): Promise<FreshInstallLaunch>;
  onboardingUrl(): string;
  hasWebsiteAccess(): Promise<boolean>;
  dynamicRegistrations(): Promise<chrome.scripting.RegisteredContentScript[]>;
  completeSetup(storageMode: StorageMode): Promise<SetupState>;
  fillSyncNearQuota(): Promise<{ bytes: number; keys: string[]; quota: number }>;
  clearSyncFiller(): Promise<void>;
  localItems(): Promise<Record<string, unknown>>;
  syncItems(): Promise<Record<string, unknown>>;
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
  distOverride?: string,
): Promise<ExtensionLaunch> {
  const dist: string = distOverride ?? path.resolve(import.meta.dirname, '../../dist');
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

interface ExtensionManifest {
  optional_host_permissions?: string[];
  host_permissions?: string[];
}

interface ServiceWorkerVersionInfo {
  versionId: string;
  scriptURL: string;
  runningStatus: 'stopped' | 'starting' | 'running' | 'stopping';
}

async function waitForServiceWorkerVersion(
  versions: () => readonly ServiceWorkerVersionInfo[],
  predicate: (version: ServiceWorkerVersionInfo) => boolean,
  failure: string,
): Promise<ServiceWorkerVersionInfo> {
  for (let attempt: number = 0; attempt < 100; attempt += 1) {
    const found: ServiceWorkerVersionInfo | undefined = versions().find(predicate);
    if (found !== undefined) return found;
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error(failure);
}

const SYNC_FILLER_PREFIX: string = '__focusLockE2EQuota:';

async function createPermissionGrantDist(outputPath: string): Promise<string> {
  const dist: string = path.resolve(import.meta.dirname, '../../dist');
  await cp(dist, outputPath, { recursive: true });
  const manifestPath: string = path.join(outputPath, 'manifest.json');
  const manifest: ExtensionManifest = JSON.parse(
    await readFile(manifestPath, 'utf8'),
  ) as ExtensionManifest;
  manifest.host_permissions = [...WEBSITE_ORIGINS];
  await writeFile(manifestPath, JSON.stringify(manifest));
  return outputPath;
}

async function grantProfileWebsiteAccess(profileDir: string, grantDist: string): Promise<void> {
  const optionalLaunch: ExtensionLaunch = await extensionLaunch(profileDir, false);
  await sendExtensionRequest(optionalLaunch.extPage, { type: 'getSetupState' });
  await optionalLaunch.context.close();
  const grantingLaunch: ExtensionLaunch = await extensionLaunch(profileDir, false, grantDist);
  await sendExtensionRequest(grantingLaunch.extPage, { type: 'reconcileWebsiteAccess' });
  await grantingLaunch.context.close();
}

async function completedExtensionLaunch(
  profileDir: string,
  grantDist: string,
): Promise<ExtensionLaunch> {
  await grantProfileWebsiteAccess(profileDir, grantDist);
  const launch: ExtensionLaunch = await extensionLaunch(profileDir, false);
  const reconciled = await sendExtensionRequest(launch.extPage, {
    type: 'reconcileWebsiteAccess',
  });
  if (!reconciled.ok || !reconciled.granted || reconciled.registration !== 'ready') {
    const permissions = await launch.worker.evaluate(
      async (): Promise<chrome.permissions.Permissions> => await chrome.permissions.getAll(),
    );
    const setup: SetupState = await sendExtensionRequest(launch.extPage, {
      type: 'getSetupState',
    });
    await launch.context.close();
    throw new Error(
      `could not prepare website access for the default E2E fixture: ${JSON.stringify({
        reconciled,
        permissions,
        setup,
      })}`,
    );
  }
  const completed = await sendExtensionRequest(launch.extPage, {
    type: 'completeSetup',
    storageMode: 'sync',
    settings: structuredClone(DEFAULT_SETTINGS),
    lists: structuredClone(DEFAULT_LISTS),
  });
  if (!completed.ok) {
    await launch.context.close();
    throw new Error(completed.error);
  }
  return launch;
}

export const test = base.extend<ExtFixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: playwright fixture signature
  context: async ({}, use, testInfo) => {
    const profileDir: string = testInfo.outputPath('default-profile');
    const grantDist: string = await createPermissionGrantDist(
      testInfo.outputPath('permission-grant-dist'),
    );
    const launch: ExtensionLaunch = await completedExtensionLaunch(profileDir, grantDist);
    await use(launch.context);
    await launch.context.close();
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
    const grantDist: string = await createPermissionGrantDist(
      testInfo.outputPath('restart-permission-grant-dist'),
    );
    const prepared: ExtensionLaunch = await completedExtensionLaunch(profileDir, grantDist);
    await prepared.context.close();
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
  // biome-ignore lint/correctness/noEmptyPattern: playwright fixture signature
  freshInstallExtension: async ({}, use, testInfo) => {
    const profileDir: string = testInfo.outputPath('fresh-install-profile');
    const grantDist: string = await createPermissionGrantDist(
      testInfo.outputPath('fresh-permission-grant-dist'),
    );
    let current: FreshInstallLaunch | null = null;
    const requireCurrent = (): FreshInstallLaunch => {
      if (current === null) throw new Error('launch the fresh-install browser first');
      return current;
    };
    const close = async (): Promise<void> => {
      if (current === null) return;
      const closing: FreshInstallLaunch = current;
      current = null;
      await closing.context.close();
    };
    const launch = async (): Promise<FreshInstallLaunch> => {
      if (current !== null) throw new Error('close the isolated browser before relaunching it');
      const baseLaunch: ExtensionLaunch = await extensionLaunch(profileDir, true);
      const onboardingPage: Page = await baseLaunch.context.newPage();
      await onboardingPage.goto(
        `chrome-extension://${baseLaunch.extensionId}/src/onboarding/onboarding.html`,
      );
      current = { ...baseLaunch, onboardingPage };
      return current;
    };
    const relaunch = async (): Promise<FreshInstallLaunch> => {
      await close();
      return await launch();
    };
    const onboardingUrl = (): string => {
      const launchState: FreshInstallLaunch = requireCurrent();
      return `chrome-extension://${launchState.extensionId}/src/onboarding/onboarding.html`;
    };
    const hasWebsiteAccess = async (): Promise<boolean> =>
      await requireCurrent().worker.evaluate(
        async (origins: string[]): Promise<boolean> =>
          await chrome.permissions.contains({ origins }),
        [...WEBSITE_ORIGINS],
      );
    const dynamicRegistrations = async (): Promise<chrome.scripting.RegisteredContentScript[]> =>
      await requireCurrent().worker.evaluate(
        async (scriptId: string): Promise<chrome.scripting.RegisteredContentScript[]> =>
          await chrome.scripting.getRegisteredContentScripts({ ids: [scriptId] }),
        CONTENT_SCRIPT_ID,
      );
    const localItems = async (): Promise<Record<string, unknown>> =>
      await requireCurrent().worker.evaluate(
        async (): Promise<Record<string, unknown>> => await chrome.storage.local.get(null),
      );
    const syncItems = async (): Promise<Record<string, unknown>> =>
      await requireCurrent().worker.evaluate(
        async (): Promise<Record<string, unknown>> => await chrome.storage.sync.get(null),
      );
    const grantWebsiteAccess = async (): Promise<FreshInstallLaunch> => {
      await close();
      await grantProfileWebsiteAccess(profileDir, grantDist);
      return await launch();
    };
    const revokeWebsiteAccess = async (): Promise<void> => {
      const removed: boolean = await requireCurrent().extPage.evaluate(
        async (origins: string[]): Promise<boolean> => await chrome.permissions.remove({ origins }),
        [...WEBSITE_ORIGINS],
      );
      if (!removed) throw new Error('Chrome did not remove the test website permission');
      const reconciled = await sendExtensionRequest(requireCurrent().extPage, {
        type: 'reconcileWebsiteAccess',
      });
      if (!reconciled.ok || reconciled.granted || reconciled.registration !== 'unavailable') {
        throw new Error('website access did not reconcile to denied');
      }
    };
    const denyWebsiteAccess = async (): Promise<void> => {
      if (await hasWebsiteAccess()) await revokeWebsiteAccess();
      const launchState: FreshInstallLaunch = requireCurrent();
      const reconciled = await sendExtensionRequest(launchState.extPage, {
        type: 'reconcileWebsiteAccess',
      });
      if (!reconciled.ok || reconciled.granted || reconciled.registration !== 'unavailable') {
        throw new Error('website access did not reconcile to denied');
      }
      const loaded = await sendExtensionRequest(launchState.extPage, {
        type: 'getOnboardingDraft',
      });
      if (!loaded.ok) throw new Error(loaded.error);
      if (loaded.draft === null) throw new Error('onboarding draft is unavailable');
      const deniedDraft: OnboardingDraft = {
        ...loaded.draft,
        websiteAccessChoice: 'denied',
      };
      const saved = await sendExtensionRequest(launchState.extPage, {
        type: 'saveOnboardingDraft',
        draft: deniedDraft,
      });
      if (!saved.ok) throw new Error(saved.error);
      await launchState.onboardingPage.reload();
    };
    const restartWorker = async (): Promise<FreshInstallLaunch> => {
      const launchState: FreshInstallLaunch = requireCurrent();
      const session: CDPSession = await launchState.context.newCDPSession(launchState.extPage);
      let versions: readonly ServiceWorkerVersionInfo[] = [];
      session.on('ServiceWorker.workerVersionUpdated', (payload): void => {
        versions = payload.versions as readonly ServiceWorkerVersionInfo[];
      });
      try {
        await session.send('ServiceWorker.enable');
        const scriptPrefix: string = `chrome-extension://${launchState.extensionId}/`;
        const running: ServiceWorkerVersionInfo = await waitForServiceWorkerVersion(
          (): readonly ServiceWorkerVersionInfo[] => versions,
          (version: ServiceWorkerVersionInfo): boolean =>
            version.scriptURL.startsWith(scriptPrefix) && version.runningStatus === 'running',
          'running extension worker version is unavailable',
        );
        await session.send('ServiceWorker.stopWorker', { versionId: running.versionId });
        await waitForServiceWorkerVersion(
          (): readonly ServiceWorkerVersionInfo[] => versions,
          (version: ServiceWorkerVersionInfo): boolean =>
            version.versionId === running.versionId && version.runningStatus === 'stopped',
          'extension worker did not stop',
        );
        const nextWorker: Promise<Worker | undefined> = launchState.context
          .waitForEvent('serviceworker', { timeout: 5_000 })
          .catch((): undefined => undefined);
        await launchState.extPage.evaluate(
          async (): Promise<unknown> => await chrome.runtime.sendMessage({ type: 'getSetupState' }),
        );
        await waitForServiceWorkerVersion(
          (): readonly ServiceWorkerVersionInfo[] => versions,
          (version: ServiceWorkerVersionInfo): boolean =>
            version.scriptURL.startsWith(scriptPrefix) && version.runningStatus === 'running',
          'extension worker did not restart',
        );
        const emittedWorker: Worker | undefined = await nextWorker;
        const worker: Worker =
          emittedWorker ??
          launchState.context
            .serviceWorkers()
            .find((candidate: Worker): boolean => candidate.url().startsWith(scriptPrefix)) ??
          launchState.worker;
        await worker.evaluate(async (): Promise<void> => {
          await chrome.storage.local.get(null);
        });
        current = { ...launchState, worker };
        return current;
      } finally {
        await session.detach();
      }
    };
    const completeSetup = async (storageMode: StorageMode): Promise<SetupState> => {
      const launchState: FreshInstallLaunch = requireCurrent();
      const page: Page = launchState.onboardingPage;
      await page.reload();
      const stepOne = page.getByRole('heading', { name: 'Choose your starting block list' });
      if (await stepOne.isVisible()) await page.getByRole('button', { name: 'Continue' }).click();
      const stepTwo = page.getByRole('heading', { name: 'Enable website blocking' });
      if (await stepTwo.isVisible()) {
        if (await hasWebsiteAccess()) {
          await page.getByRole('button', { name: /^(Enable website blocking|Retry)$/ }).click();
        } else {
          await page.getByRole('button', { name: 'Not now' }).click();
        }
      }
      const syncSwitch = page.getByRole('switch', { name: 'Sync across Chrome devices' });
      await syncSwitch.waitFor();
      const wantSync: boolean = storageMode === 'sync';
      if ((await syncSwitch.isChecked()) !== wantSync) await syncSwitch.click();
      await page
        .getByRole('button', {
          name: wantSync ? 'Finish setup with sync enabled' : 'Finish setup without sync',
        })
        .click();
      await page.getByRole('heading', { name: 'Setup complete' }).waitFor();
      return await sendExtensionRequest(launchState.extPage, { type: 'getSetupState' });
    };
    const fillSyncNearQuota = async (): Promise<{
      bytes: number;
      keys: string[];
      quota: number;
    }> =>
      await requireCurrent().worker.evaluate(
        async (prefix: string): Promise<{ bytes: number; keys: string[]; quota: number }> => {
          const quota: number = chrome.storage.sync.QUOTA_BYTES;
          const itemQuota: number = chrome.storage.sync.QUOTA_BYTES_PER_ITEM;
          const target: number = quota - 128;
          const keys: string[] = [];
          let bytes: number = await chrome.storage.sync.getBytesInUse(null);
          let index: number = 0;
          while (bytes < target) {
            const key: string = `${prefix}${String(index).padStart(2, '0')}`;
            const remaining: number = target - bytes;
            const valueLength: number = Math.max(1, Math.min(itemQuota - 256, remaining - 64));
            await chrome.storage.sync.set({ [key]: 'q'.repeat(valueLength) });
            keys.push(key);
            bytes = await chrome.storage.sync.getBytesInUse(null);
            index += 1;
          }
          return { bytes, keys, quota };
        },
        SYNC_FILLER_PREFIX,
      );
    const clearSyncFiller = async (): Promise<void> => {
      await requireCurrent().worker.evaluate(async (prefix: string): Promise<void> => {
        const stored: Record<string, unknown> = await chrome.storage.sync.get(null);
        const keys: string[] = Object.keys(stored).filter((key: string): boolean =>
          key.startsWith(prefix),
        );
        if (keys.length > 0) await chrome.storage.sync.remove(keys);
      }, SYNC_FILLER_PREFIX);
    };

    await use({
      launch,
      close,
      relaunch,
      grantWebsiteAccess,
      denyWebsiteAccess,
      revokeWebsiteAccess,
      restartWorker,
      onboardingUrl,
      hasWebsiteAccess,
      dynamicRegistrations,
      completeSetup,
      fillSyncNearQuota,
      clearSyncFiller,
      localItems,
      syncItems,
    });
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
  const lists: ListsConfig = {
    custom: customRules,
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
  };
  const config: SessionConfig = {
    mode: 'blacklist',
    strictness: 'friction',
    durationMin: 0.2,
    cycling: null,
    intention: 'e2e test run',
    source: 'manual',
    scheduleEntryId: null,
    ...overrides,
    rules: overrides.rules ?? rulesFromLists(lists),
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

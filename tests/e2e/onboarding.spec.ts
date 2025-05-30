import type { ConsoleMessage, Page, Request as PlaywrightRequest, Worker } from '@playwright/test';
import { decodeListsSyncSnapshot } from '../../src/background/list-sync-codec';
import {
  LOCAL_FIRST_SYNC_PUBLICATION,
  LOCAL_LISTS,
  LOCAL_ONBOARDING_DRAFT,
  LOCAL_SETTINGS,
  LOCAL_SETUP,
  LOCAL_SYNC_JOURNAL,
  SYNC_SETTINGS,
} from '../../src/shared/storage-keys';
import type {
  ListsConfig,
  SessionConfig,
  SessionSnapshot,
  SetupState,
} from '../../src/shared/types';
import {
  expect,
  type FreshInstallLaunch,
  sendExtensionRequest,
  startTestSession,
  test,
} from './fixtures';

test.setTimeout(90_000);

interface BrowserDiagnostics {
  consoleErrors: string[];
  pageErrors: string[];
  requestErrors: string[];
  workerErrors: string[];
}

function emptyDiagnostics(): BrowserDiagnostics {
  return { consoleErrors: [], pageErrors: [], requestErrors: [], workerErrors: [] };
}

function monitorLaunch(launch: FreshInstallLaunch, diagnostics: BrowserDiagnostics): void {
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
      diagnostics.requestErrors.push(
        `${request.url()}: ${request.failure()?.errorText ?? 'failed'}`,
      );
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
  launch.context.pages().forEach(monitorPage);
  launch.context.serviceWorkers().forEach(monitorWorker);
  launch.context.on('page', monitorPage);
  launch.context.on('serviceworker', monitorWorker);
}

function expectNoDiagnostics(diagnostics: BrowserDiagnostics): void {
  expect(diagnostics).toEqual(emptyDiagnostics());
}

async function currentSetup(launch: FreshInstallLaunch): Promise<SetupState> {
  return await sendExtensionRequest(launch.extPage, { type: 'getSetupState' });
}

test('fresh install has no host access and popup routes to unfinished setup', async ({
  freshInstallExtension,
}) => {
  const launch: FreshInstallLaunch = await freshInstallExtension.launch();
  const diagnostics: BrowserDiagnostics = emptyDiagnostics();
  monitorLaunch(launch, diagnostics);

  expect(await freshInstallExtension.hasWebsiteAccess()).toBe(false);
  expect(await freshInstallExtension.dynamicRegistrations()).toEqual([]);
  expect(await currentSetup(launch)).toMatchObject({
    completed: false,
    websiteAccess: 'denied',
    blockingRegistration: 'unavailable',
    storageMode: null,
  });
  await expect(launch.onboardingPage).toHaveURL(freshInstallExtension.onboardingUrl());
  await expect(
    launch.onboardingPage.getByRole('heading', { name: 'Choose your starting block list' }),
  ).toBeVisible();
  await expect(
    launch.extPage.getByRole('heading', { name: 'Finish setting up Focus Lock' }),
  ).toBeVisible();
  await expect(launch.extPage.getByRole('button', { name: 'Start focusing' })).toHaveCount(0);
  expectNoDiagnostics(diagnostics);
});

test('denied access can be retried, completed locally, and block a real page', async ({
  freshInstallExtension,
  siteUrl,
}) => {
  let launch: FreshInstallLaunch = await freshInstallExtension.launch();
  const diagnostics: BrowserDiagnostics = emptyDiagnostics();
  monitorLaunch(launch, diagnostics);
  await launch.onboardingPage.getByRole('button', { name: 'Continue' }).click();

  await freshInstallExtension.denyWebsiteAccess();
  await expect(
    launch.onboardingPage.getByText('Chrome did not grant website access. You can retry.'),
  ).toBeVisible();
  await expect(launch.onboardingPage.getByRole('button', { name: 'Retry' })).toBeVisible();
  expect(await freshInstallExtension.hasWebsiteAccess()).toBe(false);

  launch = await freshInstallExtension.grantWebsiteAccess();
  monitorLaunch(launch, diagnostics);
  expect(await freshInstallExtension.hasWebsiteAccess()).toBe(true);
  expect(await freshInstallExtension.dynamicRegistrations()).toMatchObject([
    {
      id: 'focus-lock-blocker',
      matches: ['http://*/*', 'https://*/*'],
      runAt: 'document_start',
      persistAcrossSessions: true,
    },
  ]);
  await launch.onboardingPage.getByRole('button', { name: 'Retry' }).click();
  await expect(
    launch.onboardingPage.getByRole('heading', {
      name: 'Choose where your settings are stored',
    }),
  ).toBeVisible();

  const setup: SetupState = await freshInstallExtension.completeSetup('local');
  expect(setup).toMatchObject({
    completed: true,
    storageMode: 'local',
    websiteAccess: 'granted',
    blockingRegistration: 'ready',
  });
  await startTestSession(launch.extPage, { durationMin: 0.3 });
  const blockedPage: Page = await launch.context.newPage();
  await blockedPage.goto(siteUrl('/plain.html'), { waitUntil: 'commit' });
  await expect(blockedPage.locator('focus-lock-overlay')).toBeAttached();
  await expect(blockedPage).toHaveTitle('Locked - Focus Lock');
  expectNoDiagnostics(diagnostics);
});

test('sync completion and dynamic registration survive a browser restart', async ({
  freshInstallExtension,
}) => {
  await freshInstallExtension.launch();
  let launch: FreshInstallLaunch = await freshInstallExtension.grantWebsiteAccess();
  const diagnostics: BrowserDiagnostics = emptyDiagnostics();
  monitorLaunch(launch, diagnostics);

  const completed: SetupState = await freshInstallExtension.completeSetup('sync');
  expect(completed).toMatchObject({
    completed: true,
    storageMode: 'sync',
    syncWriteStatus: 'idle',
    storageError: null,
    websiteAccess: 'granted',
    blockingRegistration: 'ready',
  });
  expect(await freshInstallExtension.syncItems()).toHaveProperty(SYNC_SETTINGS);

  launch = await freshInstallExtension.relaunch();
  monitorLaunch(launch, diagnostics);
  expect(await currentSetup(launch)).toEqual(completed);
  expect(await freshInstallExtension.hasWebsiteAccess()).toBe(true);
  expect(await freshInstallExtension.dynamicRegistrations()).toHaveLength(1);
  await expect(
    launch.onboardingPage.getByRole('heading', { name: 'Setup complete' }),
  ).toBeVisible();
  await expect(launch.extPage.getByRole('button', { name: 'Start focusing' })).toBeVisible();
  expectNoDiagnostics(diagnostics);
});

test('permission revocation ends a session and rejects another session start', async ({
  freshInstallExtension,
}) => {
  await freshInstallExtension.launch();
  const launch: FreshInstallLaunch = await freshInstallExtension.grantWebsiteAccess();
  const diagnostics: BrowserDiagnostics = emptyDiagnostics();
  monitorLaunch(launch, diagnostics);
  await freshInstallExtension.completeSetup('local');
  await startTestSession(launch.extPage, { durationMin: 0.3 });
  const active: SessionSnapshot = await sendExtensionRequest(launch.extPage, {
    type: 'getSnapshot',
  });
  const config: SessionConfig | null = active.config;
  if (config === null) throw new Error('active session config is unavailable');

  await freshInstallExtension.revokeWebsiteAccess();
  expect(await freshInstallExtension.hasWebsiteAccess()).toBe(false);
  expect(await freshInstallExtension.dynamicRegistrations()).toEqual([]);
  expect(await sendExtensionRequest(launch.extPage, { type: 'getSnapshot' })).toMatchObject({
    phase: 'idle',
    config: null,
  });
  expect(await currentSetup(launch)).toMatchObject({
    completed: true,
    websiteAccess: 'denied',
    blockingRegistration: 'unavailable',
    websiteAccessNotice: 'revoked-during-session',
  });
  expect(
    await sendExtensionRequest(launch.extPage, {
      type: 'startSession',
      config,
    }),
  ).toEqual({
    ok: false,
    error: 'Website blocking is not enabled. Finish setup or grant website access, then try again.',
  });
  await launch.extPage.reload();
  await expect(
    launch.extPage.getByText('Your session ended because website access was removed.'),
  ).toBeVisible();
  await expect(
    launch.extPage.getByRole('heading', { name: 'Website blocking is off' }),
  ).toBeVisible();
  await expect(launch.extPage.getByRole('button', { name: 'Start focusing' })).toHaveCount(0);
  expectNoDiagnostics(diagnostics);
});

test('quota-backed first sync checkpoint survives worker and browser restart, then retries', async ({
  freshInstallExtension,
}) => {
  let launch: FreshInstallLaunch = await freshInstallExtension.launch();
  const diagnostics: BrowserDiagnostics = emptyDiagnostics();
  monitorLaunch(launch, diagnostics);
  const socialMedia = launch.onboardingPage.getByRole('checkbox', { name: 'Social media' });
  await socialMedia.click();
  await expect(socialMedia).toBeChecked();
  await launch.onboardingPage.getByRole('button', { name: 'Continue' }).click();
  await launch.onboardingPage.getByRole('button', { name: 'Not now' }).click();
  await launch.worker.evaluate(async (): Promise<void> => {
    await chrome.storage.sync.set({ foreignSyncSentinel: { owner: 'another extension test' } });
  });
  const filler: { bytes: number; keys: string[]; quota: number } =
    await freshInstallExtension.fillSyncNearQuota();
  expect(filler.keys.length).toBeGreaterThan(0);
  expect(filler.bytes).toBeGreaterThanOrEqual(filler.quota - 128);

  await launch.onboardingPage
    .getByRole('button', { name: 'Finish setup with sync enabled' })
    .click();
  await expect(launch.onboardingPage.getByRole('alert')).toHaveText(
    'Could not complete setup. Your choices are still saved. Try again.',
  );
  expect(await currentSetup(launch)).toMatchObject({
    completed: false,
    storageMode: null,
    syncWriteStatus: 'error',
    storageError: 'sync-publish-failed',
  });
  const failedLocal: Record<string, unknown> = await freshInstallExtension.localItems();
  expect(failedLocal).toHaveProperty(LOCAL_FIRST_SYNC_PUBLICATION);
  expect(failedLocal).toHaveProperty(LOCAL_ONBOARDING_DRAFT);
  expect(failedLocal).toHaveProperty(LOCAL_SETTINGS);
  expect(failedLocal).toHaveProperty(LOCAL_LISTS);
  expect(failedLocal[LOCAL_LISTS]).toMatchObject({ categories: { social: true } });
  const failedJournal = failedLocal[LOCAL_SYNC_JOURNAL] as {
    sets: Record<string, unknown>;
    removes: string[];
  };
  expect(Object.keys(failedJournal.sets).length).toBeGreaterThan(0);

  launch = await freshInstallExtension.restartWorker();
  expect(await currentSetup(launch)).toMatchObject({
    completed: false,
    storageMode: null,
    storageError: 'sync-publish-failed',
  });
  expect(await freshInstallExtension.localItems()).toHaveProperty(LOCAL_FIRST_SYNC_PUBLICATION);

  launch = await freshInstallExtension.relaunch();
  monitorLaunch(launch, diagnostics);
  await expect(
    launch.onboardingPage.getByRole('heading', {
      name: 'Choose where your settings are stored',
    }),
  ).toBeVisible();
  expect(await currentSetup(launch)).toMatchObject({
    completed: false,
    storageMode: null,
    syncWriteStatus: 'pending',
    storageError: 'sync-publish-failed',
  });
  expect(await freshInstallExtension.localItems()).toMatchObject({
    [LOCAL_FIRST_SYNC_PUBLICATION]: { phase: 'publishing' },
    [LOCAL_SYNC_JOURNAL]: failedJournal,
  });

  await freshInstallExtension.clearSyncFiller();
  const afterClear: Record<string, unknown> = await freshInstallExtension.syncItems();
  expect(afterClear.foreignSyncSentinel).toEqual({ owner: 'another extension test' });
  expect(filler.keys.some((key: string): boolean => Object.hasOwn(afterClear, key))).toBe(false);
  await launch.onboardingPage
    .getByRole('button', { name: 'Finish setup with sync enabled' })
    .click();
  await expect(
    launch.onboardingPage.getByRole('heading', { name: 'Setup complete' }),
  ).toBeVisible();

  expect(await currentSetup(launch)).toMatchObject({
    completed: true,
    storageMode: 'sync',
    syncWriteStatus: 'idle',
    storageError: null,
  });
  const recoveredLocal: Record<string, unknown> = await freshInstallExtension.localItems();
  const recoveredRemote: Record<string, unknown> = await freshInstallExtension.syncItems();
  const localLists: ListsConfig = recoveredLocal[LOCAL_LISTS] as ListsConfig;
  expect(recoveredRemote[SYNC_SETTINGS]).toEqual(recoveredLocal[LOCAL_SETTINGS]);
  expect(decodeListsSyncSnapshot(recoveredRemote)).toEqual({ kind: 'complete', lists: localLists });
  expect(recoveredRemote.foreignSyncSentinel).toEqual({ owner: 'another extension test' });
  expect(recoveredLocal[LOCAL_SYNC_JOURNAL]).toEqual({ sets: {}, removes: [] });
  expect(recoveredLocal).not.toHaveProperty(LOCAL_FIRST_SYNC_PUBLICATION);
  expect(recoveredLocal).not.toHaveProperty(LOCAL_ONBOARDING_DRAFT);
  expect(recoveredLocal[LOCAL_SETUP]).toEqual(await currentSetup(launch));
  expectNoDiagnostics(diagnostics);
});

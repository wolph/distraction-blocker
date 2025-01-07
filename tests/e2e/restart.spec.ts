import type { Page, Worker } from '@playwright/test';
import type { SessionSnapshot } from '../../src/shared/types';
import {
  type ExtensionLaunch,
  expect,
  sendExtensionRequest,
  startTestSession,
  test,
} from './fixtures';

interface PersistedTabState {
  hasTabState: boolean;
  priorMuted: boolean | null;
  stoppedDocumentId: string | null;
  frameDocumentId: string | null;
  muted: boolean;
  extensionOwnedMute: boolean;
}

async function readPersistedTabState(worker: Worker, url: string): Promise<PersistedTabState> {
  return await worker.evaluate(async (targetUrl: string): Promise<PersistedTabState> => {
    const tab: chrome.tabs.Tab | undefined = (await chrome.tabs.query({})).find(
      (candidate: chrome.tabs.Tab): boolean => candidate.url === targetUrl,
    );
    if (tab?.id === undefined) throw new Error(`restored tab not found: ${targetUrl}`);
    const stored: Record<string, unknown> = await chrome.storage.local.get('runtime');
    const runtime = stored.runtime as {
      tabStates?: Record<
        number,
        { priorMuted?: boolean | null; stoppedDocumentId?: string | null }
      >;
    };
    const tabState = runtime.tabStates?.[tab.id];
    const frame: chrome.webNavigation.GetFrameResultDetails | null =
      await chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 });
    return {
      hasTabState: tabState !== undefined,
      priorMuted: tabState?.priorMuted ?? null,
      stoppedDocumentId: tabState?.stoppedDocumentId ?? null,
      frameDocumentId: frame?.documentId ?? null,
      muted: tab.mutedInfo?.muted === true,
      extensionOwnedMute:
        tab.mutedInfo?.muted === true && tab.mutedInfo.extensionId === chrome.runtime.id,
    };
  }, url);
}

async function restoredBlockedPage(launch: ExtensionLaunch, url: string): Promise<Page> {
  await expect
    .poll((): boolean =>
      launch.context.pages().some((candidate: Page): boolean => candidate.url() === url),
    )
    .toBe(true);
  const page: Page | undefined = launch.context
    .pages()
    .find((candidate: Page): boolean => candidate.url() === url);
  if (page === undefined) throw new Error(`restored page not found: ${url}`);
  return page;
}

test('persistent profile restores a stopped muted tab and active countdown after relaunch', async ({
  restartableExtension,
  siteUrl,
}) => {
  const url: string = siteUrl('/plain.html');
  const first: ExtensionLaunch = await restartableExtension.launch();
  await startTestSession(first.extPage, {
    durationMin: 0.15,
    intention: 'survive browser restart',
  });
  const blockedPage: Page = await first.context.newPage();
  await blockedPage.goto(url, { waitUntil: 'commit' });
  await expect(blockedPage.locator('focus-lock-overlay')).toBeAttached();
  await expect(blockedPage).toHaveTitle('Locked - Focus Lock');

  const before: SessionSnapshot = await sendExtensionRequest(first.extPage, {
    type: 'getSnapshot',
  });
  const tabBefore: PersistedTabState = await readPersistedTabState(first.worker, url);
  expect(before.phase).toBe('focus');
  expect(before.phaseEndsAt).not.toBeNull();
  expect(tabBefore.hasTabState).toBe(true);
  expect(tabBefore.priorMuted).toBe(false);
  expect(tabBefore.stoppedDocumentId).toBe(tabBefore.frameDocumentId);
  expect(tabBefore.stoppedDocumentId).not.toBeNull();
  expect(tabBefore.muted).toBe(true);
  expect(tabBefore.extensionOwnedMute).toBe(true);

  await restartableExtension.close();
  const second: ExtensionLaunch = await restartableExtension.launch();
  const restoredPage: Page = await restoredBlockedPage(second, url);
  await expect(restoredPage.locator('focus-lock-overlay')).toBeAttached();
  await expect(restoredPage).toHaveTitle('Locked - Focus Lock');
  await expect(second.extPage.locator('.phase-label')).toHaveText('focusing');
  await expect(second.extPage.locator('.clock')).toHaveText(/\d+:[0-5]\d/);

  const after: SessionSnapshot = await sendExtensionRequest(second.extPage, {
    type: 'getSnapshot',
  });
  const tabAfter: PersistedTabState = await readPersistedTabState(second.worker, url);
  expect(after.phase).toBe('focus');
  expect(after.startedAt).toBe(before.startedAt);
  expect(after.phaseEndsAt).toBe(before.phaseEndsAt);
  expect((after.phaseEndsAt ?? 0) - after.at).toBeGreaterThan(0);
  expect((after.phaseEndsAt ?? 0) - after.at).toBeLessThan((before.phaseEndsAt ?? 0) - before.at);
  expect(tabAfter.stoppedDocumentId).toBe(tabAfter.frameDocumentId);
  expect(tabAfter.stoppedDocumentId).not.toBeNull();
  expect(tabAfter.muted).toBe(true);
  expect(tabAfter.extensionOwnedMute).toBe(true);

  await expect
    .poll(
      async (): Promise<SessionSnapshot['phase']> => {
        const snapshot: SessionSnapshot = await sendExtensionRequest(second.extPage, {
          type: 'getSnapshot',
        });
        return snapshot.phase;
      },
      { timeout: 15_000 },
    )
    .toBe('idle');
  await expect(restoredPage.locator('focus-lock-overlay')).toHaveCount(0);
  await expect(restoredPage.locator('#marker')).toHaveText('plain page');

  const settledTab: PersistedTabState = await readPersistedTabState(second.worker, url);
  expect(settledTab.hasTabState).toBe(false);
  expect(settledTab.stoppedDocumentId).toBeNull();
  expect(settledTab.muted).toBe(false);
  expect(settledTab.extensionOwnedMute).toBe(false);
});

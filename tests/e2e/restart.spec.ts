import type { Page, Worker } from '@playwright/test';
import type { SessionSnapshot, SetupState } from '../../src/shared/types';
import {
  assertNoUnexpectedBrowserDiagnostics,
  type BrowserDiagnostics,
} from './browser-diagnostics';
import {
  type ExtensionLaunch,
  expect,
  sendExtensionRequest,
  startTestSession,
  test,
  waitForActiveSession,
} from './fixtures';

test.setTimeout(180_000);

function expectNoDiagnostics(diagnostics: BrowserDiagnostics): void {
  expect((): void => assertNoUnexpectedBrowserDiagnostics(diagnostics)).not.toThrow();
}

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

interface RetainedCommands {
  closurePending: boolean;
  documentCommands: number;
}

/** Whether a closure journal is still stored, and how many document commands the runtime holds. */
async function readRetainedCommands(worker: Worker): Promise<RetainedCommands> {
  return await worker.evaluate(async (): Promise<RetainedCommands> => {
    const stored: Record<string, unknown> = await chrome.storage.local.get('runtime');
    const runtime = stored.runtime as {
      pendingClosure?: unknown;
      documentCommands?: Record<string, unknown>;
    };
    return {
      closurePending: runtime.pendingClosure !== null && runtime.pendingClosure !== undefined,
      documentCommands: Object.keys(runtime.documentCommands ?? {}).length,
    };
  });
}

interface RetainedAddresses {
  /** The page address of every stored document command, sorted. */
  commandUrls: string[];
  /** How many epoch acknowledgement records the runtime holds. */
  acks: number;
  /** How many of those records carry a page address, which after this slice is always zero. */
  acksWithUrl: number;
  /**
   * The whole stored runtime as JSON. The promise is about the runtime, not about two of its
   * fields, so the address assertions run against this rather than against the fields above.
   */
  serialized: string;
}

/** Every page address the runtime holds, in its command map, its records, and as a whole. */
async function readRetainedAddresses(worker: Worker): Promise<RetainedAddresses> {
  return await worker.evaluate(async (): Promise<RetainedAddresses> => {
    const stored: Record<string, unknown> = await chrome.storage.local.get('runtime');
    const runtime = stored.runtime as {
      documentCommands?: Record<string, { expectedUrl?: unknown }>;
      epochResetAcks?: Record<string, Record<string, unknown>>;
    };
    const acks: Array<Record<string, unknown>> = Object.values(runtime.epochResetAcks ?? {});
    return {
      commandUrls: Object.values(runtime.documentCommands ?? {})
        .map((command: { expectedUrl?: unknown }): string => String(command.expectedUrl))
        .sort(),
      acks: acks.length,
      acksWithUrl: acks.filter((ack: Record<string, unknown>): boolean => 'url' in ack).length,
      serialized: JSON.stringify(stored.runtime),
    };
  });
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

test('persistent profile restores a blocked muted tab and active countdown after relaunch', async ({
  restartableExtension,
  siteUrl,
}) => {
  const url: string = siteUrl('/plain.html');
  // The same test server under a host the session does not block: an allowed tab that stays open
  // through the restart and the cleanup, so the runtime has an address it must not keep.
  const allowedUrl: string = url.replace('blocked.example', 'other.example');
  const first: ExtensionLaunch = await restartableExtension.launch();
  const setupBefore: SetupState = await sendExtensionRequest(first.extPage, {
    type: 'getSetupState',
  });
  expect(setupBefore).toMatchObject({
    completed: true,
    storageMode: 'sync',
    websiteAccess: 'granted',
    blockingRegistration: 'ready',
  });
  // The allowed tab is open before the start, so the start's own sweep freezes a view for it and
  // the runtime has to decide what it keeps of that view when the session publishes.
  const allowedPage: Page = await first.context.newPage();
  await allowedPage.goto(allowedUrl, { waitUntil: 'load' });
  await expect(allowedPage.locator('#marker')).toHaveText('plain page');
  await startTestSession(first.extPage, {
    duration: { kind: 'timed', minutes: 0.5 },
    intention: 'survive browser restart',
  });
  await expect(allowedPage.locator('focus-lock-overlay')).toHaveCount(0);
  const blockedPage: Page = await first.context.newPage();
  await blockedPage.goto(url, { waitUntil: 'commit' });
  await expect(blockedPage.locator('focus-lock-overlay')).toBeAttached();
  await expect(blockedPage).toHaveTitle('Locked - Focus Lock');
  await expect(blockedPage.locator('#marker')).toHaveCount(0);
  // During the session the runtime holds the blocked tab's address and no other. The allowed tab
  // was swept at the start and acknowledged the epoch like every open tab, and its record
  // carries no address. Nothing else in the runtime, the start's audit included, holds it either.
  await expect
    .poll(
      async (): Promise<Omit<RetainedAddresses, 'serialized'>> => {
        const { serialized: _serialized, ...fields } = await readRetainedAddresses(first.worker);
        return fields;
      },
      { timeout: 15_000 },
    )
    .toEqual({ commandUrls: [url], acks: 2, acksWithUrl: 0 });
  const duringSession: RetainedAddresses = await readRetainedAddresses(first.worker);
  expect(duringSession.serialized).toContain(url);
  expect(duringSession.serialized).not.toContain(allowedUrl);

  const before: SessionSnapshot = await sendExtensionRequest(first.extPage, {
    type: 'getSnapshot',
  });
  const tabBefore: PersistedTabState = await readPersistedTabState(first.worker, url);
  expect(before.lifecycle.kind).toBe('active');
  expect(before.phase).toBe('focus');
  expect(before.phaseEndsAt).not.toBeNull();
  expect(tabBefore.hasTabState).toBe(true);
  expect(tabBefore.priorMuted).toBe(false);
  expect(tabBefore.stoppedDocumentId).toBe(tabBefore.frameDocumentId);
  expect(tabBefore.stoppedDocumentId).not.toBeNull();
  expect(tabBefore.muted).toBe(true);
  expect(tabBefore.extensionOwnedMute).toBe(true);
  expectNoDiagnostics(restartableExtension.diagnostics);

  await restartableExtension.close();
  const second: ExtensionLaunch = await restartableExtension.launch();
  expect(await sendExtensionRequest(second.extPage, { type: 'getSetupState' })).toEqual(
    setupBefore,
  );
  const restoredPage: Page = await restoredBlockedPage(second, url);
  expect(restoredPage.url()).toBe(url);
  await expect(restoredPage.locator('focus-lock-overlay')).toBeAttached();
  await expect(restoredPage).toHaveTitle('Plain test page');
  await expect(restoredPage.locator('#marker')).toHaveText('plain page');
  const topmostAtInput: string | null = await restoredPage
    .locator('#keep')
    .evaluate((input: HTMLInputElement): string | null => {
      const bounds: DOMRect = input.getBoundingClientRect();
      return (
        document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
          ?.tagName ?? null
      );
    });
  expect(topmostAtInput).toBe('FOCUS-LOCK-OVERLAY');
  // A restarted worker republishes only after recovery resolves its journals, and the popup opened
  // before that shows the idle view until the republication reaches it.
  await waitForActiveSession(second.extPage);
  // The v2 popup labels its clocks instead of naming a phase: the first row is the running one.
  await expect(second.extPage.locator('.clock-stack__value').first()).toHaveText(/\d+:[0-5]\d/);
  await expect(second.extPage.locator('.clock-stack__label').first()).not.toBeEmpty();
  const after: SessionSnapshot = await sendExtensionRequest(second.extPage, {
    type: 'getSnapshot',
  });
  const tabAfter: PersistedTabState = await readPersistedTabState(second.worker, url);
  expect(after.lifecycle.kind).toBe('active');
  expect(after.phase).toBe('focus');
  expect(after.startedAt).toBe(before.startedAt);
  expect(after.phaseEndsAt).toBe(before.phaseEndsAt);
  expect((after.phaseEndsAt ?? 0) - after.at).toBeGreaterThan(0);
  expect((after.phaseEndsAt ?? 0) - after.at).toBeLessThan((before.phaseEndsAt ?? 0) - before.at);
  expect(tabAfter.stoppedDocumentId).toBeNull();
  expect(tabAfter.frameDocumentId).not.toBeNull();
  expect(tabAfter.muted).toBe(true);
  expect(tabAfter.extensionOwnedMute).toBe(true);
  // Recovery froze the restored tabs the same way the start did: the blocked one alone.
  await expect
    .poll(async (): Promise<string[]> => (await readRetainedAddresses(second.worker)).commandUrls, {
      timeout: 15_000,
    })
    .toEqual([url]);

  await expect
    .poll(
      async (): Promise<SessionSnapshot['phase']> => {
        const snapshot: SessionSnapshot = await sendExtensionRequest(second.extPage, {
          type: 'getSnapshot',
        });
        return snapshot.phase;
      },
      { timeout: 45_000 },
    )
    .toBe('idle');
  await expect(restoredPage.locator('focus-lock-overlay')).toHaveCount(0);
  await expect(restoredPage.locator('#marker')).toHaveText('plain page');
  // The end-of-session cleanup empties the command map in the write that removes its journal, so
  // the idle runtime keeps no page address for the tab it just released.
  await expect
    .poll(async (): Promise<RetainedCommands> => await readRetainedCommands(second.worker), {
      timeout: 15_000,
    })
    .toEqual({ closurePending: false, documentCommands: 0 });

  // The cleanup dropped the records of the tabs the restart renumbered away and kept an
  // address-free record for each tab still open.
  const settledAddresses: RetainedAddresses = await readRetainedAddresses(second.worker);
  expect(settledAddresses.commandUrls).toEqual([]);
  expect(settledAddresses.acksWithUrl).toBe(0);
  expect(settledAddresses.acks).toBeGreaterThan(0);
  expect(settledAddresses.serialized).not.toContain(allowedUrl);
  // No address of any tab remains in the runtime once the cleanup is done. The one field the
  // cleanup does not reach is the attempt debounce, keyed by tab and URL, which the minute tick
  // prunes thirty seconds after the attempt, so this waits for that tick.
  await expect
    .poll(
      async (): Promise<boolean> => {
        const retained: RetainedAddresses = await readRetainedAddresses(second.worker);
        return retained.serialized.includes(url) || retained.serialized.includes(allowedUrl);
      },
      { timeout: 120_000 },
    )
    .toBe(false);

  const settledTab: PersistedTabState = await readPersistedTabState(second.worker, url);
  expect(settledTab.hasTabState).toBe(false);
  expect(settledTab.stoppedDocumentId).toBeNull();
  expect(settledTab.muted).toBe(false);
  expect(settledTab.extensionOwnedMute).toBe(false);
  expectNoDiagnostics(restartableExtension.diagnostics);
});

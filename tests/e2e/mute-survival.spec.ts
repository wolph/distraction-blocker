/**
 * Pins the browser behaviour `restoreClaimedTabs` is built on.
 *
 * A closure captures a claim per muted tab so it can put the mute back the way it found it. When
 * the browser relaunches, that claim names a tab identifier Chrome will never issue again, and
 * `src/background/tabs.ts` settles such a claim immediately rather than waiting for the tab to
 * come back. That is only correct while a relaunch actually discards the mute: if a restored tab
 * ever kept it, settling would strand a mute nobody removes, and the closure would report success
 * having done nothing.
 *
 * Two earlier fixes argued about this without measuring it, and both shipped a defect. So the
 * premise is asserted here rather than described in a comment somewhere.
 */

import type { Page, Worker } from '@playwright/test';
import { type ExtensionLaunch, expect, test } from './fixtures';

interface MuteReading {
  id: number;
  muted: boolean | null;
  extensionId: string | null;
}

/** Reads the mute this extension applied, for whichever tab currently shows the URL. */
async function readMute(worker: Worker, target: string): Promise<MuteReading | null> {
  return await worker.evaluate(async (url: string): Promise<MuteReading | null> => {
    const tabs: chrome.tabs.Tab[] = await chrome.tabs.query({});
    const found: chrome.tabs.Tab | undefined = tabs.find(
      (tab: chrome.tabs.Tab): boolean => tab.url === url,
    );
    if (found === undefined || found.id === undefined) return null;
    return {
      id: found.id,
      muted: found.mutedInfo?.muted ?? null,
      extensionId: found.mutedInfo?.extensionId ?? null,
    };
  }, target);
}

test('a browser relaunch discards the mute this extension applied, and its attribution', async ({
  restartableExtension,
  siteUrl,
}): Promise<void> => {
  test.setTimeout(180_000);
  const url: string = siteUrl('/plain.html');

  const first: ExtensionLaunch = await restartableExtension.launch();
  const page: Page = await first.context.newPage();
  await page.goto(url);
  await first.worker.evaluate(async (target: string): Promise<void> => {
    const tabs: chrome.tabs.Tab[] = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id !== undefined && tab.url === target) {
        await chrome.tabs.update(tab.id, { muted: true });
      }
    }
  }, url);

  // The mute is real and attributed to us before the relaunch, so the reading after it is a
  // measurement of what the relaunch did rather than of a mute that never applied.
  const before: MuteReading | null = await readMute(first.worker, url);
  expect(before).not.toBeNull();
  expect(before?.muted).toBe(true);
  expect(before?.extensionId).toBe(first.extensionId);

  await restartableExtension.close();
  const second: ExtensionLaunch = await restartableExtension.launch();
  const liveWorker: Worker = second.context.serviceWorkers()[0] ?? second.worker;

  // Chrome restores tabs lazily, so wait for the tab to exist before reading what it carries.
  // Reading too early would measure a tab that has not arrived, not a mute that did not survive.
  await expect
    .poll(async (): Promise<MuteReading | null> => await readMute(liveWorker, url), {
      timeout: 30_000,
    })
    .not.toBeNull();

  const after: MuteReading | null = await readMute(liveWorker, url);
  expect(after?.muted).toBe(false);
  expect(after?.extensionId).toBeNull();
  // A new identifier is why the claim cannot be matched by the one it recorded, which is what sent
  // the earlier fix looking for the effect instead.
  expect(after?.id).not.toBe(before?.id);

  // It stays gone. A mute that reappeared once the restore finished would make settling wrong
  // again, so the reading is repeated rather than taken once and trusted.
  for (let sample: number = 0; sample < 3; sample += 1) {
    await new Promise((resolve): void => {
      setTimeout(resolve, 2_000);
    });
    const later: MuteReading | null = await readMute(liveWorker, url);
    expect(later?.muted).toBe(false);
    expect(later?.extensionId).toBeNull();
  }
});

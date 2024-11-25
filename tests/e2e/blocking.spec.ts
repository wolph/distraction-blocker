import type { Buffer } from 'node:buffer';
import type { Frame } from '@playwright/test';
import { PNG } from 'pngjs';
import { expect, startTestSession, test } from './fixtures';

test('fresh navigation to a blocked site is stopped and overlaid', async ({
  context,
  extPage,
  siteUrl,
}) => {
  await startTestSession(extPage);
  const page = await context.newPage();
  await page.goto(siteUrl('/plain.html'), { waitUntil: 'commit' });

  await expect(page.locator('focus-lock-overlay')).toBeAttached();
  await expect(page).toHaveTitle(/Locked/);
  await expect
    .poll(async (): Promise<boolean> => {
      const screenshot: Buffer = await page.screenshot();
      const image: PNG = PNG.sync.read(screenshot);
      const offset: number = (5 * image.width + 5) * 4;
      const red: number = image.data[offset] ?? 255;
      const green: number = image.data[offset + 1] ?? 255;
      const blue: number = image.data[offset + 2] ?? 255;
      const alpha: number = image.data[offset + 3] ?? 0;
      return red === 15 && green === 23 && blue === 42 && alpha === 255;
    })
    .toBe(true);
  await expect(page.locator('#marker')).toHaveCount(0);
});

test('existing tab overlays, mutes, and resumes without reload', async ({
  context,
  extPage,
  siteUrl,
  worker,
}) => {
  const url: string = siteUrl('/plain.html');
  const page = await context.newPage();
  await page.goto(url);
  let navigationEvents: number = 0;
  page.on('framenavigated', (frame: Frame): void => {
    if (frame === page.mainFrame()) navigationEvents += 1;
  });
  await page.locator('#keep').fill('still here');
  await page.evaluate((): void => {
    (window as typeof window & { __focusLockAlive?: boolean }).__focusLockAlive = true;
  });

  await startTestSession(extPage, { durationMin: 0.12 });
  await expect(page.locator('focus-lock-overlay')).toBeAttached();
  await expect
    .poll(async (): Promise<boolean> => {
      const tabs: chrome.tabs.Tab[] = await worker.evaluate(
        async (): Promise<chrome.tabs.Tab[]> => await chrome.tabs.query({}),
      );
      return tabs.some(
        (tab: chrome.tabs.Tab): boolean => tab.url === url && tab.mutedInfo?.muted === true,
      );
    })
    .toBe(true);

  await expect(page.locator('focus-lock-overlay')).toHaveCount(0, { timeout: 20_000 });
  expect(
    await page.evaluate(
      (): boolean =>
        (window as typeof window & { __focusLockAlive?: boolean }).__focusLockAlive === true,
    ),
  ).toBe(true);
  await expect(page.locator('#keep')).toHaveValue('still here');
  expect(navigationEvents).toBe(0);
  await expect
    .poll(async (): Promise<boolean> => {
      const tabs: chrome.tabs.Tab[] = await worker.evaluate(
        async (): Promise<chrome.tabs.Tab[]> => await chrome.tabs.query({}),
      );
      return tabs.some(
        (tab: chrome.tabs.Tab): boolean => tab.url === url && tab.mutedInfo?.muted === false,
      );
    })
    .toBe(true);
});

test('a stopped tab reloads after the session ends', async ({ context, extPage, siteUrl }) => {
  await startTestSession(extPage, { durationMin: 0.12 });
  const page = await context.newPage();
  await page.goto(siteUrl('/plain.html'), { waitUntil: 'commit' });

  await expect(page.locator('focus-lock-overlay')).toBeAttached();
  await expect(page.locator('#marker')).toHaveCount(0);
  await expect(page.locator('#marker')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('focus-lock-overlay')).toHaveCount(0);
  await expect(page).toHaveTitle('Plain test page');
});

test('SPA history navigation is blocked without a reload', async ({
  context,
  extPage,
  siteUrl,
}) => {
  const page = await context.newPage();
  await page.goto(siteUrl('/spa.html'));
  await startTestSession(extPage, { durationMin: 0.3 }, [
    { kind: 'regex', pattern: 'blocked\\.example(?::\\d+)?/shorts' },
  ]);
  await expect(page.locator('focus-lock-overlay')).toHaveCount(0);

  await page.locator('#navigate').click();
  await expect(page).toHaveURL(/blocked\.example.*\/shorts\/feed/);
  await expect(page.locator('focus-lock-overlay')).toBeAttached();
  await expect(page.locator('#marker')).toHaveText('shorts feed');
});

test('a blocked media tab is muted', async ({ context, extPage, siteUrl, worker }) => {
  const url: string = siteUrl('/media.html');
  const page = await context.newPage();
  await page.goto(url);
  await startTestSession(extPage, { durationMin: 0.12 });

  await expect(page.locator('focus-lock-overlay')).toBeAttached();
  await expect
    .poll(async (): Promise<boolean> => {
      const tabs: chrome.tabs.Tab[] = await worker.evaluate(
        async (): Promise<chrome.tabs.Tab[]> => await chrome.tabs.query({}),
      );
      return tabs.some(
        (tab: chrome.tabs.Tab): boolean => tab.url === url && tab.mutedInfo?.muted === true,
      );
    })
    .toBe(true);
});

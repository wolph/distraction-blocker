/**
 * The three beats a visitor clicks through on the landing page, in a real Chromium against the
 * built site. The popup and the lockscreen here are the product's own components, so a product
 * change that breaks them breaks this before it reaches the site.
 */
import {
  type Browser,
  chromium,
  expect,
  type FrameLocator,
  type Locator,
  type Page,
  test,
} from '@playwright/test';
import { type PagesServer, startPagesServer } from './pages-server';

let server: PagesServer;
let browser: Browser;

test.beforeAll(async (): Promise<void> => {
  server = await startPagesServer();
  browser = await chromium.launch();
});

test.afterAll(async (): Promise<void> => {
  await browser.close();
  await server.close();
});

test('a visitor starts a session, meets the lockscreen, and returns to the draft', async (): Promise<void> => {
  const page: Page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error: Error): void => {
    errors.push(error.message);
  });
  page.on('console', (message): void => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(server.url);

  const work: FrameLocator = page.frameLocator('iframe[data-tab-id="11"]');
  await work.locator('#draft').fill('Section one: why this matters.');

  await page.getByRole('button', { name: 'Open Focus Lock' }).click();
  const popup: Locator = page.locator('#popup');
  await popup.getByLabel('Intention').fill('Finish the proposal');
  // The popup auto-selects the active tab as the work target once its own lookup of eligible
  // tabs resolves. Starting before that lookup settles starts with no work target at all, which
  // leaves the lockscreen's Back to work control permanently reading Choose a work tab.
  await expect(popup.locator('.work-target')).toHaveText(/Proposal draft/);
  await popup.getByRole('button', { name: /^Start/ }).click();
  await expect(page.locator('[data-beat="start"]')).toHaveClass(/guide-done/);

  await page.getByRole('button', { name: 'Headlines' }).click();
  const headlines: FrameLocator = page.frameLocator('iframe[data-tab-id="12"]');
  await expect(headlines.locator('focus-lock-overlay')).toBeAttached();
  await expect(page.locator('[data-beat="blocked"]')).toHaveClass(/guide-done/);

  // The lockscreen mounts in a closed shadow root (src/content/overlay-host.ts), which hides its
  // contents from every locator, Playwright included: a closed root refuses JS access to anyone,
  // not just the page. The popup shows the same Back to work control for a running session
  // (src/popup/ReturnToWorkButton.tsx), rendered in the popup's own light DOM, so the visitor
  // returns to work through there instead.
  await popup.getByRole('button', { name: /Back to work/ }).click();
  await expect(page.locator('button.tab-active')).toHaveText('Proposal draft');
  await expect(work.locator('#draft')).toHaveValue('Section one: why this matters.');
  await expect(page.locator('[data-beat="back"]')).toHaveClass(/guide-done/);

  expect(errors).toEqual([]);
});

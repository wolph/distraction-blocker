/**
 * The three beats a visitor clicks through on the landing page, in a real Chromium against the
 * built site. The popup and the lockscreen here are the product's own components, so a product
 * change that breaks them breaks this before it reaches the site.
 */
import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  chromium,
  expect,
  type FrameLocator,
  type Locator,
  type Page,
  test,
} from '@playwright/test';
import {
  type AccessibilityNode,
  type AccessibilityProperty,
  type AccessibilityTree,
  type FrameTree,
  findFrameId,
} from './cdp-accessibility';
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

/**
 * Clicks a button inside a tab iframe's lockscreen, which mounts in a closed shadow root
 * (src/content/overlay-host.ts). A closed shadow root refuses `.shadowRoot` to every piece of
 * page JavaScript, Playwright's own locators included, so no CSS or role locator can reach in.
 * The CDP Accessibility domain, scoped to the iframe's own frame, still reports the button and
 * its on-screen box: the accessibility tree is built from the flattened render tree, not from
 * the script-visible shadow root reference that `closed` withholds. The technique matches
 * `clickClosedShadowButton` in gates.spec.ts, extended with a frame lookup because that helper's
 * target sits on the top-level page and this one sits inside a tab iframe.
 */
async function clickLockscreenButton(
  context: BrowserContext,
  page: Page,
  tabId: number,
  accessibleName: string,
): Promise<void> {
  const session: CDPSession = await context.newCDPSession(page);
  try {
    await session.send('Page.enable');
    const frameTree: FrameTree = await session.send('Page.getFrameTree');
    const frameId: string | undefined = findFrameId(frameTree.frameTree, `tab=${String(tabId)}`);
    if (frameId === undefined) throw new Error(`tab iframe not found: ${String(tabId)}`);
    let backendNodeId: number | undefined;
    // The button starts disabled until the engine records a work target for the session, so this
    // polls rather than reading the tree once.
    await expect
      .poll(
        async (): Promise<boolean> => {
          const tree: AccessibilityTree = await session.send('Accessibility.getFullAXTree', {
            frameId,
          });
          const node: AccessibilityNode | undefined = tree.nodes.find(
            (candidate: AccessibilityNode): boolean =>
              candidate.role?.value === 'button' &&
              String(candidate.name?.value).startsWith(accessibleName),
          );
          if (node === undefined) return false;
          const disabled: boolean =
            node.properties?.some(
              (property: AccessibilityProperty): boolean =>
                property.name === 'disabled' && property.value?.value === true,
            ) ?? false;
          if (disabled) return false;
          backendNodeId = node.backendDOMNodeId;
          return true;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    if (backendNodeId === undefined) throw new Error(`button not found: ${accessibleName}`);
    const box: { model: { content: number[] } } = await session.send('DOM.getBoxModel', {
      backendNodeId,
    });
    const [left, top, right, , , bottom] = box.model.content;
    if (left === undefined || top === undefined || right === undefined || bottom === undefined) {
      throw new Error(`button has no content box: ${accessibleName}`);
    }
    await page.mouse.click((left + right) / 2, (top + bottom) / 2);
  } finally {
    await session.detach();
  }
}

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
  // Starting a session makes every tab, Headlines and Videos included, re-request a verdict while
  // still hidden. None of that is the visitor meeting the lockscreen, so the beat must stay open
  // until the Headlines tab is actually clicked below.
  await expect(page.locator('[data-beat="blocked"]')).not.toHaveClass(/guide-done/);

  await page.getByRole('button', { name: 'Headlines' }).click();
  const headlines: FrameLocator = page.frameLocator('iframe[data-tab-id="12"]');
  await expect(headlines.locator('focus-lock-overlay')).toBeAttached();
  await expect(page.locator('[data-beat="blocked"]')).toHaveClass(/guide-done/);

  await clickLockscreenButton(page.context(), page, 12, 'Back to work');
  await expect(page.locator('button.tab-active')).toHaveText('Proposal draft');
  await expect(work.locator('#draft')).toHaveValue('Section one: why this matters.');
  await expect(page.locator('[data-beat="back"]')).toHaveClass(/guide-done/);

  expect(errors).toEqual([]);
});

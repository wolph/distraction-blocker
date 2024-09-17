import { expect, test } from './fixtures';

test('extension loads and the worker answers getSnapshot', async ({ context, extensionId }) => {
  // chrome.runtime.sendMessage never loops back to the sending context, so the
  // worker cannot ask itself. An extension page exercises the real path instead.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  const snapshot: { phase: string } = await page.evaluate(async () => {
    return await chrome.runtime.sendMessage({ type: 'getSnapshot' });
  });
  expect(snapshot.phase).toBe('idle');
});

test('popup page renders', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await expect(page.locator('#app')).toBeVisible();
});

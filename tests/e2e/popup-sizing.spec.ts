import { expect, test } from './fixtures';

test('the toolbar popup opens at its intended width without viewport emulation', async ({
  extPage,
}) => {
  await extPage.evaluate(async (): Promise<void> => {
    await chrome.action.openPopup();
  });

  await expect
    .poll(async (): Promise<number | null> => {
      return await extPage.evaluate((): number | null => {
        const popup: Window | undefined = chrome.extension.getViews({ type: 'popup' })[0];
        return popup === undefined ? null : popup.innerWidth;
      });
    })
    .toBe(480);

  expect(
    await extPage.evaluate((): number | null => {
      const popup: Window | undefined = chrome.extension.getViews({ type: 'popup' })[0];
      return popup?.document.body.getBoundingClientRect().width ?? null;
    }),
  ).toBe(480);
});

test('the popup page still fits a narrow tab viewport', async ({ extPage }) => {
  for (const width of [375, 768]) {
    await extPage.setViewportSize({ width, height: 1000 });
    expect(await extPage.evaluate((): number => document.body.getBoundingClientRect().width)).toBe(
      Math.min(width, 480),
    );
    expect(
      await extPage.evaluate((): number => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
});

import { expect, test } from './fixtures';

/**
 * Chrome measures the toolbar popup before its first layout, so a maximum width in viewport units
 * reads a viewport that does not exist yet and clamps the popup to a fraction of its width. These
 * scenarios read the real popup window through `chrome.extension.getViews`, without emulating a
 * viewport, so the regression is measured where it happens.
 */
const POPUP_WIDTH: number = 480;
const POPUP_HEIGHT: number = 600;

test('the toolbar popup opens at its intended size without viewport emulation', async ({
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
    .toBe(POPUP_WIDTH);

  expect(
    await extPage.evaluate((): { width: number; height: number; app: number } | null => {
      const popup: Window | undefined = chrome.extension.getViews({ type: 'popup' })[0];
      if (popup === undefined) return null;
      const body: DOMRect = popup.document.body.getBoundingClientRect();
      const app: number = popup.document.querySelector('.app')?.getBoundingClientRect().height ?? 0;
      return { width: body.width, height: body.height, app };
    }),
  ).toEqual({ width: POPUP_WIDTH, height: POPUP_HEIGHT, app: POPUP_HEIGHT });
});

test('the popup page still fits a narrow tab viewport', async ({ extPage }) => {
  for (const width of [375, 768]) {
    await extPage.setViewportSize({ width, height: 1000 });
    expect(await extPage.evaluate((): number => document.body.getBoundingClientRect().width)).toBe(
      Math.min(width, POPUP_WIDTH),
    );
    expect(
      await extPage.evaluate((): number => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
});

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

interface CssColors {
  backgroundColor: string;
  color: string;
}

function relativeLuminance(channel: number): number {
  const normalized: number = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function rgbChannels(value: string): [number, number, number] {
  const matches: string[] = value.match(/[\d.]+/g) ?? [];
  if (matches.length < 3) throw new Error(`Expected an RGB color, received ${value}`);
  return [Number(matches[0]), Number(matches[1]), Number(matches[2])];
}

function contrastRatio(foreground: string, background: string): number {
  const [fr, fg, fb]: [number, number, number] = rgbChannels(foreground);
  const [br, bg, bb]: [number, number, number] = rgbChannels(background);
  const foregroundLuminance: number =
    0.2126 * relativeLuminance(fr) +
    0.7152 * relativeLuminance(fg) +
    0.0722 * relativeLuminance(fb);
  const backgroundLuminance: number =
    0.2126 * relativeLuminance(br) +
    0.7152 * relativeLuminance(bg) +
    0.0722 * relativeLuminance(bb);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

async function elementContrast(page: Page, selector: string): Promise<number> {
  const colors: CssColors = await page
    .locator(selector)
    .first()
    .evaluate((element: Element) => {
      const style: CSSStyleDeclaration = getComputedStyle(element);
      return { backgroundColor: style.backgroundColor, color: style.color };
    });
  return contrastRatio(colors.color, colors.backgroundColor);
}

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
  await expect(page.getByRole('heading', { level: 1, name: 'Focus Lock' })).toBeVisible();
});

test('Stats navigation round-trips through an Options section', async ({
  context,
  extensionId,
}) => {
  const page: Page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/stats/stats.html`);

  const statsNavigation = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(statsNavigation).toBeVisible();
  await expect(statsNavigation.getByRole('link', { name: 'Stats' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  const optionsDestinations: ReadonlyArray<{ name: string; id: string }> = [
    { name: 'Lists', id: 'lists' },
    { name: 'Categories', id: 'categories' },
    { name: 'Schedule', id: 'schedule' },
    { name: 'Strictness and gate', id: 'strictness' },
    { name: 'Pause economy', id: 'pause' },
    { name: 'Sounds and badge', id: 'sounds' },
    { name: 'Data', id: 'data' },
  ];
  for (const destination of optionsDestinations) {
    await expect(statsNavigation.getByRole('link', { name: destination.name })).toHaveAttribute(
      'href',
      `../options/options.html#${destination.id}`,
    );
  }

  await statsNavigation.getByRole('link', { name: 'Pause economy' }).click();
  await expect(page).toHaveURL(`chrome-extension://${extensionId}/src/options/options.html#pause`);
  const optionsNavigation = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(optionsNavigation).toBeVisible();
  await expect(optionsNavigation.getByRole('link', { name: 'Pause economy' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('heading', { level: 2, name: 'Pause economy' })).toBeVisible();

  await optionsNavigation.getByRole('link', { name: 'Stats' }).click();
  await expect(page).toHaveURL(`chrome-extension://${extensionId}/src/stats/stats.html`);
  const returnedNavigation = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(returnedNavigation.getByRole('link', { name: 'Stats' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('heading', { level: 1, name: 'Your focus record' })).toBeVisible();
});

test('blockable test site loads without a session', async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(siteUrl('/plain.html'));
  await expect(page.locator('#marker')).toHaveText('plain page');
});

test('options page fits a mobile viewport', async ({ context, extensionId }) => {
  const page: Page = await context.newPage();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await expect(page.getByRole('heading', { level: 2 })).toBeVisible();

  const horizontalOverflowPx: number = await page.evaluate(
    (): number => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(horizontalOverflowPx).toBeLessThanOrEqual(0);
});

test('options current navigation meets light text contrast', async ({ context, extensionId }) => {
  const page: Page = await context.newPage();
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await expect(page.getByRole('heading', { level: 2 })).toBeVisible();
  expect(await elementContrast(page, '.settings-nav-item.current')).toBeGreaterThanOrEqual(4.5);
});

test('options primary button meets dark text contrast', async ({ context, extensionId }) => {
  const page: Page = await context.newPage();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await expect(page.getByRole('heading', { level: 2 })).toBeVisible();
  expect(await elementContrast(page, 'button.primary')).toBeGreaterThanOrEqual(4.5);
});

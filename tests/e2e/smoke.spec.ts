import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

interface CssColors {
  backgroundColor: string;
  color: string;
}

interface ElementBounds {
  label: string;
  left: number;
  right: number;
}

interface StatsLayoutMetrics {
  documentWidth: number;
  viewportWidth: number;
  elements: ElementBounds[];
  horizontalScrollers: string[];
  tableClientWidth: number;
  tableScrollWidth: number;
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

test('Stats content stays inside responsive viewports', async ({
  context,
  extensionId,
  extPage,
}) => {
  await extPage.evaluate(async (): Promise<void> => {
    const seedDate: Date = new Date();
    seedDate.setDate(seedDate.getDate() - 1);
    const year: string = String(seedDate.getFullYear());
    const month: string = String(seedDate.getMonth() + 1).padStart(2, '0');
    const day: string = String(seedDate.getDate()).padStart(2, '0');
    const date: string = `${year}-${month}-${day}`;
    const now: number = Date.now();

    await chrome.storage.sync.set({
      [`agg:e2e-responsive:${date}`]: {
        date,
        focusMs: 30 * 60_000,
        sessionsStarted: 1,
        sessionsCompleted: 1,
        attempts: { 'blocked.example': 2 },
        attemptsOther: 0,
        pausesTaken: 1,
        pauseMsSpent: 2 * 60_000,
        pauseMsEarned: 6 * 60_000,
        unlocksTaken: 1,
        unlockMsSpent: 60_000,
        resisted: 1,
      },
    });
    await chrome.storage.local.set({
      events: [
        {
          t: 'sessionStarted',
          at: now - 30 * 60_000,
          source: 'manual',
          mode: 'blacklist',
          strictness: 'friction',
          durationMin: 25,
          intention: 'Responsive layout regression with a deliberately long session intention',
          sessionId: 'responsive-layout',
        },
        {
          t: 'sessionCompleted',
          at: now,
          focusedMs: 25 * 60_000,
          sessionId: 'responsive-layout',
        },
      ],
    });
  });

  const page: Page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/stats/stats.html`);
  await expect(page.locator('.tile-row')).toBeVisible();
  await expect(page.locator('.chart')).toHaveCount(3);
  await expect(page.locator('.session-table')).toBeVisible();

  const viewports: ReadonlyArray<{ width: number; height: number }> = [
    { width: 375, height: 812 },
    { width: 768, height: 900 },
    { width: 1280, height: 850 },
  ];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    const metrics: StatsLayoutMetrics = await page.evaluate((): StatsLayoutMetrics => {
      function bounds(selector: string): ElementBounds[] {
        const elements: Element[] = Array.from(document.querySelectorAll(selector));
        if (elements.length === 0) throw new Error(`Missing Stats element: ${selector}`);
        return elements.map((element: Element, index: number): ElementBounds => {
          const rect: DOMRect = element.getBoundingClientRect();
          return { label: `${selector}[${index}]`, left: rect.left, right: rect.right };
        });
      }

      const tableScroll: HTMLElement | null = document.querySelector('.table-scroll');
      if (tableScroll === null) throw new Error('Missing Stats session table scroller');
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        elements: [
          ...bounds('.stats-page'),
          ...bounds('.tile'),
          ...bounds('.card'),
          ...bounds('.chart'),
          ...bounds('.table-scroll'),
        ],
        horizontalScrollers: Array.from(document.querySelectorAll<HTMLElement>('*'))
          .filter((element: HTMLElement): boolean => {
            const overflowX: string = getComputedStyle(element).overflowX;
            return (
              (overflowX === 'auto' || overflowX === 'scroll') &&
              element.scrollWidth > element.clientWidth
            );
          })
          .map((element: HTMLElement): string => {
            const classes: string = Array.from(element.classList)
              .map((className: string): string => `.${className}`)
              .join('');
            return `${element.tagName.toLowerCase()}${classes}`;
          }),
        tableClientWidth: tableScroll.clientWidth,
        tableScrollWidth: tableScroll.scrollWidth,
      };
    });

    expect(metrics.documentWidth, JSON.stringify({ viewport, metrics })).toBeLessThanOrEqual(
      metrics.viewportWidth,
    );
    for (const element of metrics.elements) {
      const evidence: string = JSON.stringify({ viewport, element });
      expect(element.left, evidence).toBeGreaterThanOrEqual(0);
      expect(element.right, evidence).toBeLessThanOrEqual(metrics.viewportWidth);
    }
    expect(
      metrics.horizontalScrollers.every(
        (selector: string): boolean => selector === 'div.table-scroll',
      ),
      JSON.stringify({ viewport, horizontalScrollers: metrics.horizontalScrollers }),
    ).toBe(true);
    if (viewport.width === 375) {
      expect(metrics.tableScrollWidth).toBeGreaterThan(metrics.tableClientWidth);
      expect(metrics.horizontalScrollers).toContain('div.table-scroll');
    }
  }
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

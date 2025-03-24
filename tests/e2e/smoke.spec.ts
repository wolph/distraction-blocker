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

interface ChartTextBounds {
  bottom: number;
  label: string;
  left: number;
  right: number;
  top: number;
  viewBoxHeight: number;
  viewBoxWidth: number;
}

interface ChartTextGap {
  first: string;
  gap: number;
  second: string;
}

interface ChartTextSeparation {
  direct: string;
  separation: number;
  tick: string;
}

interface HbarRowGeometry {
  barLeft: number;
  barRight: number;
  domainRight: number;
  label: string;
  valueLeft: number;
  valueRight: number;
  viewBoxWidth: number;
}

interface StatsLayoutMetrics {
  chartLabelScreenFontSizes: number[];
  chartTextBounds: ChartTextBounds[];
  chartTextGaps: ChartTextGap[];
  chartTextSeparations: ChartTextSeparation[];
  documentWidth: number;
  viewportWidth: number;
  elements: ElementBounds[];
  hbarRows: HbarRowGeometry[];
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
    const firstSeedDate: Date = new Date();
    firstSeedDate.setDate(firstSeedDate.getDate() - 13);
    const firstYear: string = String(firstSeedDate.getFullYear());
    const firstMonth: string = String(firstSeedDate.getMonth() + 1).padStart(2, '0');
    const firstDay: string = String(firstSeedDate.getDate()).padStart(2, '0');
    const firstDate: string = `${firstYear}-${firstMonth}-${firstDay}`;
    const now: number = Date.now();

    await chrome.storage.sync.set({
      [`agg:e2e-responsive-first:${firstDate}`]: {
        date: firstDate,
        focusMs: 60 * 60_000,
        sessionsStarted: 1,
        sessionsCompleted: 1,
        attempts: {},
        attemptsOther: 0,
        pausesTaken: 0,
        pauseMsSpent: 0,
        pauseMsEarned: 0,
        unlocksTaken: 0,
        unlockMsSpent: 0,
        resisted: 0,
      },
      [`agg:e2e-responsive:${date}`]: {
        date,
        focusMs: 40 * 60_000,
        sessionsStarted: 1,
        sessionsCompleted: 1,
        attempts: {
          'blocked.example': 2,
          'representative-long-domain.example': 9_999_999,
        },
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
    { width: 480, height: 812 },
    { width: 481, height: 812 },
    { width: 600, height: 812 },
    { width: 601, height: 812 },
    { width: 767, height: 900 },
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
      const chartLabels: SVGTextElement[] = Array.from(
        document.querySelectorAll<SVGTextElement>(
          '.chart .axis-text, .chart .value-label, .chart .direct-label',
        ),
      );
      return {
        chartLabelScreenFontSizes: chartLabels.map((label: SVGTextElement): number => {
          const matrix: DOMMatrix | null = label.getScreenCTM();
          if (matrix === null) throw new Error('Missing Stats chart screen transform');
          const screenScaleY: number = Math.hypot(matrix.c, matrix.d);
          return Number.parseFloat(getComputedStyle(label).fontSize) * screenScaleY;
        }),
        chartTextBounds: chartLabels.map((label: SVGTextElement): ChartTextBounds => {
          const box: DOMRect = label.getBBox();
          const svg: SVGSVGElement | null = label.ownerSVGElement;
          if (svg === null) throw new Error('Missing Stats chart owner SVG');
          return {
            bottom: box.y + box.height,
            label: label.textContent ?? '',
            left: box.x,
            right: box.x + box.width,
            top: box.y,
            viewBoxHeight: svg.viewBox.baseVal.height,
            viewBoxWidth: svg.viewBox.baseVal.width,
          };
        }),
        chartTextGaps: Array.from(
          document.querySelectorAll<SVGSVGElement>('.chart:not(.hbar)'),
        ).flatMap((chart: SVGSVGElement): ChartTextGap[] => {
          const labels: Array<{ box: DOMRect; text: string }> = Array.from(
            chart.querySelectorAll<SVGTextElement>('.axis-text'),
          )
            .map((label: SVGTextElement): { box: DOMRect; text: string } => ({
              box: label.getBBox(),
              text: label.textContent ?? '',
            }))
            .filter(
              ({ box }: { box: DOMRect; text: string }): boolean =>
                box.y > chart.viewBox.baseVal.height * 0.8,
            )
            .sort(
              (
                first: { box: DOMRect; text: string },
                second: { box: DOMRect; text: string },
              ): number => first.box.x - second.box.x,
            );
          return labels
            .slice(1)
            .map((label: { box: DOMRect; text: string }, index: number): ChartTextGap => {
              const previous: { box: DOMRect; text: string } | undefined = labels[index];
              if (previous === undefined) throw new Error('Missing previous Stats chart label');
              return {
                first: previous.text,
                gap: label.box.x - (previous.box.x + previous.box.width),
                second: label.text,
              };
            });
        }),
        chartTextSeparations: Array.from(
          document.querySelectorAll<SVGSVGElement>('.chart:not(.hbar)'),
        ).flatMap((chart: SVGSVGElement): ChartTextSeparation[] => {
          const direct: SVGTextElement | null = chart.querySelector('.direct-label');
          if (direct === null) throw new Error('Missing Stats direct chart label');
          const directBox: DOMRect = direct.getBBox();
          const ticks: SVGTextElement[] = Array.from(
            chart.querySelectorAll<SVGTextElement>('.axis-text'),
          ).filter(
            (tick: SVGTextElement): boolean =>
              tick.getBBox().y <= chart.viewBox.baseVal.height * 0.8,
          );
          return ticks.map((tick: SVGTextElement): ChartTextSeparation => {
            const tickBox: DOMRect = tick.getBBox();
            return {
              direct: direct.textContent ?? '',
              separation: Math.max(
                tickBox.x - (directBox.x + directBox.width),
                directBox.x - (tickBox.x + tickBox.width),
                tickBox.y - (directBox.y + directBox.height),
                directBox.y - (tickBox.y + tickBox.height),
              ),
              tick: tick.textContent ?? '',
            };
          });
        }),
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
        hbarRows: Array.from(document.querySelectorAll<SVGGElement>('.hbar-row')).map(
          (row: SVGGElement): HbarRowGeometry => {
            const domain: SVGTextElement | null = row.querySelector('.axis-text');
            const bar: SVGGraphicsElement | null = row.querySelector('.hbar-mark');
            const value: SVGTextElement | null = row.querySelector('.value-label');
            const svg: SVGSVGElement | null = row.ownerSVGElement;
            if (domain === null || bar === null || value === null || svg === null) {
              throw new Error('Incomplete Stats horizontal chart row');
            }
            const domainBox: DOMRect = domain.getBBox();
            const barBox: DOMRect = bar.getBBox();
            const valueBox: DOMRect = value.getBBox();
            return {
              barLeft: barBox.x,
              barRight: barBox.x + barBox.width,
              domainRight: domainBox.x + domainBox.width,
              label: domain.textContent ?? '',
              valueLeft: valueBox.x,
              valueRight: valueBox.x + valueBox.width,
              viewBoxWidth: svg.viewBox.baseVal.width,
            };
          },
        ),
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
    expect(metrics.chartLabelScreenFontSizes.length).toBeGreaterThan(0);
    expect
      .soft(
        Math.min(...metrics.chartLabelScreenFontSizes),
        JSON.stringify({ viewport, chartLabelScreenFontSizes: metrics.chartLabelScreenFontSizes }),
      )
      .toBeGreaterThanOrEqual(9);
    for (const label of metrics.chartTextBounds) {
      const evidence: string = JSON.stringify({ viewport, label });
      expect.soft(label.left, evidence).toBeGreaterThanOrEqual(0);
      expect.soft(label.top, evidence).toBeGreaterThanOrEqual(0);
      expect.soft(label.right, evidence).toBeLessThanOrEqual(label.viewBoxWidth);
      expect.soft(label.bottom, evidence).toBeLessThanOrEqual(label.viewBoxHeight);
    }
    for (const gap of metrics.chartTextGaps) {
      expect.soft(gap.gap, JSON.stringify({ viewport, gap })).toBeGreaterThanOrEqual(2);
    }
    for (const separation of metrics.chartTextSeparations) {
      expect
        .soft(separation.separation, JSON.stringify({ viewport, separation }))
        .toBeGreaterThanOrEqual(2);
    }
    for (const row of metrics.hbarRows) {
      const evidence: string = JSON.stringify({ viewport, row });
      expect.soft(row.domainRight, evidence).toBeLessThanOrEqual(row.barLeft);
      expect.soft(row.barRight, evidence).toBeLessThanOrEqual(row.valueLeft);
      expect.soft(row.valueRight, evidence).toBeLessThanOrEqual(row.viewBoxWidth);
    }
    if (viewport.width === 375) {
      expect(metrics.tableScrollWidth).toBeGreaterThan(metrics.tableClientWidth);
      expect(metrics.horizontalScrollers).toContain('div.table-scroll');
    }
  }

  const containerCases: ReadonlyArray<{ expectedFontSize: number; width: number }> = [
    { width: 334, expectedFontSize: 18 },
    { width: 335, expectedFontSize: 18 },
    { width: 336, expectedFontSize: 15.1 },
    { width: 390, expectedFontSize: 15.1 },
    { width: 391, expectedFontSize: 15.1 },
    { width: 392, expectedFontSize: 13 },
    { width: 446, expectedFontSize: 13 },
    { width: 447, expectedFontSize: 13 },
    { width: 448, expectedFontSize: 12 },
    { width: 502, expectedFontSize: 12 },
    { width: 503, expectedFontSize: 12 },
    { width: 504, expectedFontSize: 10.1 },
  ];
  await page.setViewportSize({ width: 1280, height: 850 });
  for (const containerCase of containerCases) {
    const labelSize: { containerWidth: number; internal: number; screen: number } = await page
      .locator('.chart-wrap')
      .first()
      .evaluate(
        (
          chartWrap: HTMLElement,
          width: number,
        ): { containerWidth: number; internal: number; screen: number } => {
          chartWrap.style.width = `${width}px`;
          const label: SVGTextElement | null = chartWrap.querySelector('.axis-text');
          if (label === null) throw new Error('Missing Stats chart threshold label');
          const matrix: DOMMatrix | null = label.getScreenCTM();
          if (matrix === null) throw new Error('Missing Stats chart threshold transform');
          const internal: number = Number.parseFloat(getComputedStyle(label).fontSize);
          return {
            containerWidth: chartWrap.getBoundingClientRect().width,
            internal,
            screen: internal * Math.hypot(matrix.c, matrix.d),
          };
        },
        containerCase.width,
      );
    expect(labelSize.containerWidth).toBe(containerCase.width);
    expect(labelSize.internal).toBe(containerCase.expectedFontSize);
    expect(labelSize.screen).toBeGreaterThanOrEqual(9);
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

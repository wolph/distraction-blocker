import type { Locator, Page, Worker } from '@playwright/test';
import { expect, test } from './fixtures';
import { assertTask7SingleResponsiveCopy, type Task7ThemeCase } from './task7-evidence';
import { TASK7_THEME_CASES, type Task7CaptureContext } from './task7-matrix-support';

export type ApplyTask7StatsTheme = (page: Page, themeCase: Task7ThemeCase) => Promise<void>;

export async function seedTask7Stats(worker: Worker): Promise<void> {
  await worker.evaluate(async (): Promise<void> => {
    const now: number = Date.now();
    const dateFor = (daysAgo: number): string => {
      const date: Date = new Date(now);
      date.setDate(date.getDate() - daysAgo);
      const year: string = String(date.getFullYear());
      const month: string = String(date.getMonth() + 1).padStart(2, '0');
      const day: string = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };
    await chrome.storage.sync.set({
      [`agg:task7-current:${dateFor(1)}`]: {
        attempts: { 'blocked.example': 7, 'research.example.org': 3 },
        attemptsOther: 1,
        date: dateFor(1),
        focusMs: 42 * 60_000,
        pauseMsEarned: 8 * 60_000,
        pauseMsSpent: 2 * 60_000,
        pausesTaken: 1,
        resisted: 2,
        sessionsCompleted: 1,
        sessionsStarted: 1,
        unlockMsSpent: 60_000,
        unlocksTaken: 1,
      },
      [`agg:task7-current:${dateFor(13)}`]: {
        attempts: { 'archive.example.net': 2 },
        attemptsOther: 0,
        date: dateFor(13),
        focusMs: 18 * 60_000,
        pauseMsEarned: 4 * 60_000,
        pauseMsSpent: 0,
        pausesTaken: 0,
        resisted: 1,
        sessionsCompleted: 1,
        sessionsStarted: 1,
        unlockMsSpent: 0,
        unlocksTaken: 0,
      },
    });
    await chrome.storage.local.set({
      events: [
        {
          at: now - 45 * 60_000,
          durationMin: 25,
          intention: 'Review example.com release notes',
          mode: 'blacklist',
          sessionId: 'task7-current-stats',
          source: 'manual',
          strictness: 'friction',
          t: 'sessionStarted',
        },
        {
          at: now - 20 * 60_000,
          focusedMs: 25 * 60_000,
          sessionId: 'task7-current-stats',
          t: 'sessionCompleted',
        },
        { at: now - 10 * 60_000, domain: 'blocked.example', t: 'attempt' },
      ],
    });
  });
}

export async function captureTask7StatsMatrix(input: {
  applyTheme: ApplyTask7StatsTheme;
  capture: Task7CaptureContext;
  extensionId: string;
  page: Page;
  viewports: readonly { height: number; width: number }[];
}): Promise<Record<string, unknown>[]> {
  const geometry: Record<string, unknown>[] = [];
  for (const themeCase of TASK7_THEME_CASES) {
    for (const viewport of input.viewports) {
      await test.step(`stats ${themeCase.id} ${String(viewport.width)} current language and chart focus`, async () => {
        await input.page.setViewportSize(viewport);
        await input.page.goto(`chrome-extension://${input.extensionId}/src/stats/stats.html`);
        await input.applyTheme(input.page, themeCase);
        await expect(
          input.page.getByRole('heading', { level: 1, name: 'Your focus record' }),
        ).toBeVisible();
        await expect(
          input.page.getByText(/Totals from this machine|Synced totals from this Chrome account/),
        ).toBeVisible();
        for (const heading of [
          'Focus, last 14 days',
          'Top blocked sites, last 30 days',
          'Attempts by hour, this machine only',
          'Recent sessions on this machine',
        ]) {
          await expect(input.page.getByRole('heading', { name: heading })).toBeVisible();
        }
        const seededIntention: Locator = input.page.getByText('Review example.com release notes');
        await expect(seededIntention).toHaveCount(2);
        const visibleResponsiveCopies: number = await seededIntention.evaluateAll(
          (elements: Element[]): number =>
            elements.filter((element: Element): boolean => {
              const style: CSSStyleDeclaration = getComputedStyle(element);
              const rect: DOMRect = element.getBoundingClientRect();
              return (
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                rect.width > 0 &&
                rect.height > 0
              );
            }).length,
        );
        expect((): void => assertTask7SingleResponsiveCopy(visibleResponsiveCopies)).not.toThrow();
        await input.capture.capture(
          input.page,
          'stats',
          'current-language',
          themeCase,
          viewport,
          'full',
          true,
          { visibleResponsiveCopies },
        );
        const chartCard: Locator = input.page.locator('.card').filter({
          has: input.page.getByRole('heading', { name: 'Focus, last 14 days' }),
        });
        await chartCard.scrollIntoViewIfNeeded();
        const tableDisclosure: Locator = chartCard.locator('summary', { hasText: 'View as table' });
        await tableDisclosure.focus();
        await expect(tableDisclosure).toBeFocused();
        await input.capture.capture(
          chartCard,
          'stats',
          'current-language',
          themeCase,
          viewport,
          'focused',
          false,
          { visibleResponsiveCopies },
        );
        const metrics = await input.page.evaluate(() => {
          const root: HTMLElement = document.documentElement;
          const chartLabels: SVGTextElement[] = Array.from(
            document.querySelectorAll<SVGTextElement>('.axis-text, .value-label, .direct-label'),
          );
          const sessionTable: HTMLElement | null = document.querySelector('.session-table-wrap');
          return {
            chartLabelFontSizes: chartLabels.map((label: SVGTextElement): number => {
              const matrix: DOMMatrix | null = label.getScreenCTM();
              if (matrix === null) throw new Error('Missing Stats label transform.');
              return (
                Number.parseFloat(getComputedStyle(label).fontSize) * Math.hypot(matrix.c, matrix.d)
              );
            }),
            clientWidth: root.clientWidth,
            horizontalOverflow: root.scrollWidth - root.clientWidth,
            sessionTable:
              sessionTable === null
                ? null
                : {
                    clientWidth: sessionTable.clientWidth,
                    overflowX: getComputedStyle(sessionTable).overflowX,
                    scrollWidth: sessionTable.scrollWidth,
                  },
          };
        });
        expect(metrics.horizontalOverflow).toBe(0);
        expect(Math.min(...metrics.chartLabelFontSizes)).toBeGreaterThanOrEqual(9);
        geometry.push({ metrics, themeCase: themeCase.id, viewport, visibleResponsiveCopies });
      });
    }
  }
  return geometry;
}

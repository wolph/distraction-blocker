import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Locator, Page, Worker } from '@playwright/test';
import type { BrowserDiagnostics } from './browser-diagnostics';
import type * as StatsVisualSeedsModule from './stats-visual-seeds';
import type { StatsVisualSeed, StatsVisualStateId } from './stats-visual-seeds';

const { buildStatsVisualSeed, STATS_VISUAL_STATES } = (await import(
  new URL('./stats-visual-seeds.ts', import.meta.url).href
)) as typeof StatsVisualSeedsModule;

export { STATS_VISUAL_STATES };

export type StatsVisualBuildSource = 'dev' | 'production';
export type StatsVisualCaptureScope =
  | 'charts'
  | 'full'
  | 'heat-strip'
  | 'sessions'
  | 'tables'
  | 'tiles';

export interface StatsVisualThemeCase {
  colorScheme: 'dark' | 'light';
  id: 'auto-dark' | 'auto-light' | 'dark-light-media' | 'light-dark-media';
  theme: 'auto' | 'dark' | 'light';
}

export interface StatsVisualEvidenceRecord {
  buildSource: StatsVisualBuildSource;
  bytes?: number;
  file: string;
  sha256?: string;
  scope: StatsVisualCaptureScope;
  state: StatsVisualStateId;
  themeCase: StatsVisualThemeCase['id'];
  viewport: { height: number; width: number };
}

export interface StatsVisualDiagnosticCounts {
  blockedRequests: number;
  consoleErrors: number;
  pageErrors: number;
  requestErrors: number;
  workerErrors: number;
}

export interface StatsVisualGeometry {
  chartTextFontSizes: number[];
  diagnostics: StatsVisualDiagnosticCounts;
  disclosureCount: number;
  disclosuresKeyboardUsable: boolean;
  documentHorizontalOverflow: number;
  hasSessions: boolean;
  sessionArticlesDisplay: string | null;
  sessionArticlesHorizontalOverflow: number | null;
  sessionTableDisplay: string | null;
  viewport: { height: number; width: number };
}

export const STATS_VISUAL_CAPTURE_SCOPES: readonly StatsVisualCaptureScope[] = [
  'full',
  'tiles',
  'heat-strip',
  'charts',
  'tables',
  'sessions',
];

export const STATS_VISUAL_THEME_CASES: readonly StatsVisualThemeCase[] = [
  { colorScheme: 'light', id: 'auto-light', theme: 'auto' },
  { colorScheme: 'dark', id: 'auto-dark', theme: 'auto' },
  { colorScheme: 'dark', id: 'light-dark-media', theme: 'light' },
  { colorScheme: 'light', id: 'dark-light-media', theme: 'dark' },
];

export const STATS_VISUAL_VIEWPORTS: readonly { height: number; width: number }[] = [
  { height: 667, width: 375 },
  { height: 800, width: 768 },
  { height: 800, width: 1280 },
];

export function expectedStatsVisualEvidenceCount(): number {
  return (
    STATS_VISUAL_STATES.length *
    STATS_VISUAL_THEME_CASES.length *
    STATS_VISUAL_VIEWPORTS.length *
    STATS_VISUAL_CAPTURE_SCOPES.length
  );
}

function evidenceKey(record: StatsVisualEvidenceRecord): string {
  return `${record.buildSource}/${record.state}/${record.themeCase}/${String(record.viewport.width)}/${record.scope}`;
}

export function assertStatsVisualInventoryCoverage(
  inventory: readonly StatsVisualEvidenceRecord[],
  buildSource: StatsVisualBuildSource,
): void {
  const observed: string[] = inventory.map(evidenceKey);
  const duplicates: string[] = observed.filter(
    (key: string, index: number): boolean => observed.indexOf(key) !== index,
  );
  if (duplicates.length > 0) {
    throw new Error(`Duplicate Stats visual evidence: ${[...new Set(duplicates)].join(', ')}`);
  }
  const required: string[] = STATS_VISUAL_STATES.flatMap((state) =>
    STATS_VISUAL_THEME_CASES.flatMap((themeCase) =>
      STATS_VISUAL_VIEWPORTS.flatMap((viewport) =>
        STATS_VISUAL_CAPTURE_SCOPES.map(
          (scope: StatsVisualCaptureScope): string =>
            `${buildSource}/${state.id}/${themeCase.id}/${String(viewport.width)}/${scope}`,
        ),
      ),
    ),
  );
  const observedSet: Set<string> = new Set(observed);
  const requiredSet: Set<string> = new Set(required);
  const missing: string[] = required.filter((key: string): boolean => !observedSet.has(key));
  const unexpected: string[] = observed.filter((key: string): boolean => !requiredSet.has(key));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Stats visual inventory differs. Missing: ${missing.join(', ') || 'none'}. Unexpected: ${unexpected.join(', ') || 'none'}.`,
    );
  }
}

export function diagnosticCounts(diagnostics: BrowserDiagnostics): StatsVisualDiagnosticCounts {
  return {
    blockedRequests: diagnostics.blockedRequests.length,
    consoleErrors: diagnostics.consoleErrors.length,
    pageErrors: diagnostics.pageErrors.length,
    requestErrors: diagnostics.requestErrors.length,
    workerErrors: diagnostics.workerErrors.length,
  };
}

export function assertStatsVisualGeometry(geometry: StatsVisualGeometry): void {
  const minimumFontSize: number = Math.min(...geometry.chartTextFontSizes);
  if (!Number.isFinite(minimumFontSize) || minimumFontSize < 12) {
    throw new Error(`Stats chart text is below 12 CSS px: ${String(minimumFontSize)}.`);
  }
  if (geometry.documentHorizontalOverflow !== 0) {
    throw new Error(
      `Stats document has ${String(geometry.documentHorizontalOverflow)} px horizontal overflow.`,
    );
  }
  if (geometry.disclosureCount < 1 || !geometry.disclosuresKeyboardUsable) {
    throw new Error(
      `Stats table disclosures are not all keyboard usable: ${String(geometry.disclosureCount)} disclosures.`,
    );
  }
  if (geometry.viewport.width <= 600) {
    if (geometry.hasSessions && geometry.sessionTableDisplay !== 'none') {
      throw new Error('The wide session table is visible at the mobile width.');
    }
    if (geometry.hasSessions && geometry.sessionArticlesDisplay === 'none') {
      throw new Error('Mobile session articles are hidden.');
    }
    if (
      geometry.hasSessions &&
      geometry.sessionArticlesHorizontalOverflow !== null &&
      geometry.sessionArticlesHorizontalOverflow !== 0
    ) {
      throw new Error('Mobile session articles require sideways scrolling.');
    }
  }
  const nonZeroDiagnostic: [string, number] | undefined = Object.entries(geometry.diagnostics).find(
    ([, count]: [string, number]): boolean => count !== 0,
  );
  if (nonZeroDiagnostic !== undefined) {
    throw new Error(
      `Stats visual diagnostics are not empty: ${nonZeroDiagnostic[0]}=${String(nonZeroDiagnostic[1])}.`,
    );
  }
}

export type ApplyStatsVisualTheme = (page: Page, themeCase: StatsVisualThemeCase) => Promise<void>;

export interface StatsVisualCaptureResult {
  geometry: Array<
    StatsVisualGeometry & {
      state: StatsVisualStateId;
      themeCase: StatsVisualThemeCase['id'];
    }
  >;
  records: StatsVisualEvidenceRecord[];
}

function statsEvidenceFile(
  buildSource: StatsVisualBuildSource,
  state: StatsVisualStateId,
  themeCase: StatsVisualThemeCase,
  viewport: { height: number; width: number },
  scope: StatsVisualCaptureScope,
): string {
  return `stats-${buildSource}-${state}-${themeCase.id}-${String(viewport.width)}-${scope}.png`;
}

async function captureStatsVisualTarget(input: {
  buildSource: StatsVisualBuildSource;
  evidenceDir: string;
  scope: StatsVisualCaptureScope;
  state: StatsVisualStateId;
  target: Locator | Page;
  themeCase: StatsVisualThemeCase;
  viewport: { height: number; width: number };
}): Promise<StatsVisualEvidenceRecord> {
  const file: string = statsEvidenceFile(
    input.buildSource,
    input.state,
    input.themeCase,
    input.viewport,
    input.scope,
  );
  const absolutePath: string = path.join(path.resolve(input.evidenceDir), file);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  if ('page' in input.target) {
    await input.target.screenshot({ animations: 'disabled', path: absolutePath });
  } else {
    await input.target.screenshot({ animations: 'disabled', fullPage: true, path: absolutePath });
  }
  const payload: Buffer = await readFile(absolutePath);
  return {
    buildSource: input.buildSource,
    bytes: (await stat(absolutePath)).size,
    file,
    scope: input.scope,
    sha256: createHash('sha256').update(payload).digest('hex'),
    state: input.state,
    themeCase: input.themeCase.id,
    viewport: input.viewport,
  };
}

export async function seedProductionStatsVisualState(
  controlPage: Page,
  worker: Worker,
  state: StatsVisualStateId,
  now: number = Date.now(),
): Promise<StatsVisualSeed> {
  const seed: StatsVisualSeed = buildStatsVisualSeed(state, now);
  const response: unknown = await controlPage.evaluate(
    async (storageMode: 'local' | 'sync'): Promise<unknown> =>
      await chrome.runtime.sendMessage({
        deleteRemote: false,
        storageMode,
        type: 'setStorageMode',
      }),
    seed.storageMode,
  );
  if (
    typeof response !== 'object' ||
    response === null ||
    !('ok' in response) ||
    response.ok !== true
  ) {
    throw new Error(
      `Could not select the Stats evidence storage mode: ${JSON.stringify(response)}`,
    );
  }
  await worker.evaluate(async (payload: StatsVisualSeed): Promise<void> => {
    const aggregateKeys = (items: Record<string, unknown>): string[] =>
      Object.keys(items).filter(
        (key: string): boolean =>
          key === 'streak' ||
          key === 'aggregatePrune' ||
          key === 'aggregateTombstones' ||
          key === 'blockedAggregatePublications' ||
          /^aggm?:/.test(key),
      );
    const [localItems, syncItems]: [Record<string, unknown>, Record<string, unknown>] =
      await Promise.all([chrome.storage.local.get(null), chrome.storage.sync.get(null)]);
    const localKeys: string[] = aggregateKeys(localItems);
    const syncKeys: string[] = aggregateKeys(syncItems);
    if (localKeys.length > 0) await chrome.storage.local.remove(localKeys);
    if (syncKeys.length > 0) await chrome.storage.sync.remove(syncKeys);
    await chrome.storage.local.set({ events: payload.events });
    const aggregates: Record<string, unknown> = Object.fromEntries(
      payload.bundle.days.map((day): [string, unknown] => [`agg:stats-task5:${day.date}`, day]),
    );
    aggregates.streak = payload.bundle.streak;
    if (payload.storageMode === 'sync') await chrome.storage.sync.set(aggregates);
    else await chrome.storage.local.set(aggregates);
  }, seed);
  return seed;
}

async function disclosuresKeyboardUsable(page: Page): Promise<boolean> {
  await page.evaluate(
    async (): Promise<void> =>
      await new Promise<void>((resolve: () => void): void => {
        requestAnimationFrame((): void => {
          requestAnimationFrame(resolve);
        });
      }),
  );
  const summaries: Locator = page.locator('.chart-table > summary');
  const count: number = await summaries.count();
  for (let index: number = 0; index < count; index += 1) {
    const summary: Locator = summaries.nth(index);
    await summary.focus();
    const focused: boolean = await summary.evaluate(
      (element: Element): boolean => document.activeElement === element,
    );
    const before: boolean = await summary.evaluate(
      (element: Element): boolean => (element.parentElement as HTMLDetailsElement).open,
    );
    await summary.press('Space');
    await page.waitForFunction(
      ({ open, position }): boolean =>
        (document.querySelectorAll<HTMLDetailsElement>('.chart-table')[position]?.open ?? open) !==
        open,
      { open: before, position: index },
      { timeout: 1_000 },
    );
    const after: boolean = !before;
    await page.evaluate(
      async (): Promise<void> =>
        await new Promise<void>((resolve: () => void): void => {
          requestAnimationFrame((): void => {
            requestAnimationFrame(resolve);
          });
        }),
    );
    await summary.press('Space');
    await page.waitForFunction(
      ({ open, position }): boolean =>
        (document.querySelectorAll<HTMLDetailsElement>('.chart-table')[position]?.open ?? !open) ===
        open,
      { open: before, position: index },
      { timeout: 1_000 },
    );
    const restored: boolean = before;
    if (!focused || before === after || restored !== before) {
      throw new Error(
        `Stats disclosure ${String(index)} keyboard audit failed: focused=${String(focused)}, before=${String(before)}, after=${String(after)}, restored=${String(restored)}.`,
      );
    }
  }
  return count > 0;
}

async function statsVisualGeometry(
  page: Page,
  hasSessions: boolean,
  diagnostics: StatsVisualDiagnosticCounts,
): Promise<StatsVisualGeometry> {
  const keyboardUsable: boolean = await disclosuresKeyboardUsable(page);
  return await page.evaluate(
    ({ diagnosticCounts: counts, keyboard, sessions }): StatsVisualGeometry => {
      const visible: (element: Element) => boolean = (element: Element): boolean => {
        const bounds: DOMRect = element.getBoundingClientRect();
        const style: CSSStyleDeclaration = getComputedStyle(element);
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          bounds.width > 0 &&
          bounds.height > 0
        );
      };
      const chartText: Element[] = Array.from(
        document.querySelectorAll(
          '.axis-text, .value-label, .direct-label, .heat-cell-label, .chart-table summary, .chart-table th, .chart-table td',
        ),
      ).filter(visible);
      const chartTextFontSizes: number[] = chartText.map((element: Element): number => {
        const base: number = Number.parseFloat(getComputedStyle(element).fontSize);
        if (!(element instanceof SVGGraphicsElement)) return base;
        const matrix: DOMMatrix | null = element.getScreenCTM();
        if (matrix === null) throw new Error('Missing Stats chart text transform.');
        return base * Math.hypot(matrix.c, matrix.d);
      });
      const root: HTMLElement = document.documentElement;
      const sessionTable: HTMLElement | null = document.querySelector('.session-table-wrap');
      const sessionArticles: HTMLElement | null = document.querySelector('.session-articles');
      const articleOverflow: number | null =
        sessionArticles === null
          ? null
          : Math.max(
              0,
              ...Array.from(sessionArticles.querySelectorAll<HTMLElement>('.session-article')).map(
                (article: HTMLElement): number => article.scrollWidth - article.clientWidth,
              ),
            );
      return {
        chartTextFontSizes,
        diagnostics: counts,
        disclosureCount: document.querySelectorAll('.chart-table > summary').length,
        disclosuresKeyboardUsable: keyboard,
        documentHorizontalOverflow: root.scrollWidth - root.clientWidth,
        hasSessions: sessions,
        sessionArticlesDisplay:
          sessionArticles === null ? null : getComputedStyle(sessionArticles).display,
        sessionArticlesHorizontalOverflow: articleOverflow,
        sessionTableDisplay: sessionTable === null ? null : getComputedStyle(sessionTable).display,
        viewport: { height: window.innerHeight, width: window.innerWidth },
      };
    },
    { diagnosticCounts: diagnostics, keyboard: keyboardUsable, sessions: hasSessions },
  );
}

function cardWithHeading(page: Page, heading: string): Locator {
  return page.locator('.card').filter({ has: page.getByRole('heading', { name: heading }) });
}

async function assertRenderedStatsVisualState(
  page: Page,
  state: StatsVisualStateId,
): Promise<void> {
  const hourlyValues: number[] = await cardWithHeading(page, 'Attempts by hour, this machine only')
    .locator('.chart-table tbody td')
    .allTextContents()
    .then((values: string[]): number[] =>
      values.map((value: string): number => Number.parseInt(value, 10)),
    );
  const activeHours: number = hourlyValues.filter((value: number): boolean => value > 0).length;
  const expectedActiveHours: number =
    state === 'one-active-hour-sync' ? 1 : state === 'all-hours-boundaries-local' ? 24 : 0;
  if (hourlyValues.length !== 24 || activeHours !== expectedActiveHours) {
    throw new Error(
      `Stats hourly state ${state} expected 24 rows and ${String(expectedActiveHours)} active hours, received ${String(hourlyValues.length)} and ${String(activeHours)}.`,
    );
  }
  if (state === 'no-activity-local') {
    if ((await page.getByText('Stats appear after your first session.').count()) !== 1) {
      throw new Error('The no-activity Stats state did not render its empty summary.');
    }
    return;
  }
  if (state === 'one-active-hour-sync') {
    if ((await page.getByText('Prepare the release summary').count()) !== 2) {
      throw new Error('The completed one-hour session is missing a responsive representation.');
    }
    return;
  }
  const longDomain: string =
    'a-very-long-research-subdomain-for-layout-boundary-verification.example.org';
  if (
    (await page.getByText(longDomain, { exact: true }).count()) < 1 ||
    (await page.getByText('1234567', { exact: true }).count()) < 1 ||
    (await page.getByText('completed', { exact: true }).count()) < 1 ||
    (await page.getByText('ended early', { exact: true }).count()) < 1
  ) {
    throw new Error('The Stats boundary state is missing domain, count, or session outcomes.');
  }
}

async function captureStatsVisualScopes(input: {
  buildSource: StatsVisualBuildSource;
  evidenceDir: string;
  page: Page;
  state: StatsVisualStateId;
  themeCase: StatsVisualThemeCase;
  viewport: { height: number; width: number };
}): Promise<StatsVisualEvidenceRecord[]> {
  const tiles: Locator =
    (await input.page.locator('.tile-row').count()) > 0
      ? input.page.locator('.tile-row')
      : input.page.getByText('Stats appear after your first session.');
  const heatStrip: Locator = cardWithHeading(input.page, 'Attempts by hour, this machine only');
  const sessions: Locator = cardWithHeading(input.page, 'Recent sessions on this machine');
  const tables: Locator = input.page.locator('.chart-table').first();
  const targets: Readonly<Record<StatsVisualCaptureScope, Locator | Page>> = {
    charts: input.page.locator('.charts'),
    full: input.page,
    'heat-strip': heatStrip,
    sessions,
    tables,
    tiles,
  };
  const records: StatsVisualEvidenceRecord[] = [];
  for (const scope of STATS_VISUAL_CAPTURE_SCOPES) {
    const target: Locator | Page = targets[scope];
    if ('page' in target) await target.scrollIntoViewIfNeeded();
    records.push(
      await captureStatsVisualTarget({
        buildSource: input.buildSource,
        evidenceDir: input.evidenceDir,
        scope,
        state: input.state,
        target,
        themeCase: input.themeCase,
        viewport: input.viewport,
      }),
    );
  }
  return records;
}

export async function captureStatsVisualMatrix(input: {
  applyTheme: ApplyStatsVisualTheme;
  beforeState?: (state: StatsVisualStateId) => Promise<StatsVisualSeed>;
  buildSource: StatsVisualBuildSource;
  curatedImagePath?: string;
  diagnostics: () => StatsVisualDiagnosticCounts;
  evidenceDir: string;
  page: Page;
  statsUrl: string | ((state: StatsVisualStateId) => string);
}): Promise<StatsVisualCaptureResult> {
  const records: StatsVisualEvidenceRecord[] = [];
  const geometry: StatsVisualCaptureResult['geometry'] = [];
  for (const state of STATS_VISUAL_STATES) {
    const seed: StatsVisualSeed =
      input.beforeState === undefined
        ? buildStatsVisualSeed(state.id, Date.now())
        : await input.beforeState(state.id);
    for (const themeCase of STATS_VISUAL_THEME_CASES) {
      for (const viewport of STATS_VISUAL_VIEWPORTS) {
        await input.page.setViewportSize(viewport);
        const statsUrl: string =
          typeof input.statsUrl === 'string' ? input.statsUrl : input.statsUrl(state.id);
        await input.page.goto(statsUrl);
        await input.applyTheme(input.page, themeCase);
        await input.page.getByRole('heading', { level: 1, name: 'Your focus record' }).waitFor();
        await input.page
          .getByText(
            state.storageMode === 'sync'
              ? 'Synced totals from this Chrome account. Local-only panels are labeled.'
              : 'Totals from this machine. Focus Lock statistics are not synced.',
          )
          .waitFor();
        await assertRenderedStatsVisualState(input.page, state.id);
        const observed: StatsVisualGeometry = await statsVisualGeometry(
          input.page,
          state.hasSessions,
          input.diagnostics(),
        );
        assertStatsVisualGeometry(observed);
        geometry.push({ ...observed, state: state.id, themeCase: themeCase.id });
        if (
          input.curatedImagePath !== undefined &&
          state.id === 'all-hours-boundaries-local' &&
          themeCase.id === 'dark-light-media' &&
          viewport.width === 1280
        ) {
          await mkdir(path.dirname(path.resolve(input.curatedImagePath)), { recursive: true });
          await input.page.screenshot({
            animations: 'disabled',
            fullPage: true,
            path: path.resolve(input.curatedImagePath),
          });
        }
        records.push(
          ...(await captureStatsVisualScopes({
            buildSource: input.buildSource,
            evidenceDir: input.evidenceDir,
            page: input.page,
            state: state.id,
            themeCase,
            viewport,
          })),
        );
      }
    }
    if (seed.storageMode !== state.storageMode) {
      throw new Error(`Stats evidence seed mode differs for ${state.id}.`);
    }
  }
  assertStatsVisualInventoryCoverage(records, input.buildSource);
  return { geometry, records };
}

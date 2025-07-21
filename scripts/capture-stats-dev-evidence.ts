import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Browser, type BrowserContext, chromium, type Page } from '@playwright/test';
import type * as StatsVisualEvidenceModule from '../tests/e2e/stats-visual-evidence';
import type {
  StatsVisualDiagnosticCounts,
  StatsVisualEvidenceRecord,
  StatsVisualThemeCase,
} from '../tests/e2e/stats-visual-evidence';
import type { StatsVisualStateId } from '../tests/e2e/stats-visual-seeds';
import type * as Task7EvidenceModule from '../tests/e2e/task7-evidence';
import type * as Task7DevEvidenceModule from './task7-dev-evidence';

const { assertStatsVisualInventoryCoverage, captureStatsVisualMatrix } = (await import(
  new URL('../tests/e2e/stats-visual-evidence.ts', import.meta.url).href
)) as typeof StatsVisualEvidenceModule;
const { assertTask7ResolvedTheme } = (await import(
  new URL('../tests/e2e/task7-evidence.ts', import.meta.url).href
)) as typeof Task7EvidenceModule;
const { stopTask7Vite, task7ViteStartupState } = (await import(
  new URL('./task7-dev-evidence.ts', import.meta.url).href
)) as typeof Task7DevEvidenceModule;

const PORT: number = 4178;
const BASE_URL: string = `http://127.0.0.1:${String(PORT)}`;

interface DevDiagnostics {
  blockedRequests: string[];
  consoleErrors: string[];
  pageErrors: string[];
  requestErrors: string[];
  workerErrors: string[];
}

function emptyDiagnostics(): DevDiagnostics {
  return {
    blockedRequests: [],
    consoleErrors: [],
    pageErrors: [],
    requestErrors: [],
    workerErrors: [],
  };
}

function monitorDevPage(page: Page, diagnostics: DevDiagnostics): void {
  page.on('console', (message): void => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error: Error): void => {
    diagnostics.pageErrors.push(error.message);
  });
  page.on('requestfailed', (request): void => {
    const rendered: string = `${request.url()}: ${request.failure()?.errorText ?? 'failed'}`;
    if (rendered.includes('ERR_BLOCKED')) diagnostics.blockedRequests.push(rendered);
    else diagnostics.requestErrors.push(rendered);
  });
}

function counts(diagnostics: DevDiagnostics): StatsVisualDiagnosticCounts {
  return {
    blockedRequests: diagnostics.blockedRequests.length,
    consoleErrors: diagnostics.consoleErrors.length,
    pageErrors: diagnostics.pageErrors.length,
    requestErrors: diagnostics.requestErrors.length,
    workerErrors: diagnostics.workerErrors.length,
  };
}

async function applyTheme(page: Page, themeCase: StatsVisualThemeCase): Promise<void> {
  await page.emulateMedia({ colorScheme: themeCase.colorScheme, reducedMotion: 'reduce' });
  const response: unknown = await page.evaluate(
    async (theme: 'auto' | 'dark' | 'light'): Promise<unknown> =>
      await chrome.runtime.sendMessage({ theme, type: 'updateTheme' }),
    themeCase.theme,
  );
  if (
    typeof response !== 'object' ||
    response === null ||
    !('ok' in response) ||
    response.ok !== true
  ) {
    throw new Error(`Could not apply source-harness theme: ${JSON.stringify(response)}`);
  }
  await page.reload();
  const expectedMode: 'dark' | 'light' =
    themeCase.theme === 'auto' ? themeCase.colorScheme : themeCase.theme;
  const expectedBackground: string =
    expectedMode === 'dark' ? 'rgb(13, 13, 13)' : 'rgb(249, 249, 247)';
  await page.waitForFunction(
    ({ background, theme }): boolean =>
      document.documentElement.dataset.theme === theme &&
      getComputedStyle(document.body).backgroundColor === background,
    { background: expectedBackground, theme: themeCase.theme },
  );
  const resolved = await page.evaluate(() => {
    const root: CSSStyleDeclaration = getComputedStyle(document.documentElement);
    const body: CSSStyleDeclaration = getComputedStyle(document.body);
    return {
      backgroundColor: body.backgroundColor,
      color: body.color,
      colorScheme: root.colorScheme,
    };
  });
  assertTask7ResolvedTheme(resolved, themeCase, 'stats');
}

async function startVite(): Promise<ChildProcessWithoutNullStreams> {
  const vitePath: string = path.resolve('node_modules/vite/bin/vite.js');
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [vitePath, '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    { cwd: process.cwd(), stdio: 'pipe' },
  );
  let output: string = '';
  child.stdout.on('data', (chunk: Buffer): void => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer): void => {
    output += chunk.toString();
  });
  for (let attempt: number = 0; attempt < 100; attempt += 1) {
    let responseReady: boolean = false;
    try {
      const response: Response = await fetch(BASE_URL);
      responseReady = response.ok || response.status === 404;
    } catch {
      // The owned Vite child is still starting.
    }
    const state: ReturnType<typeof task7ViteStartupState> = task7ViteStartupState({
      exitCode: child.exitCode,
      output,
      responseReady,
    });
    if (state === 'failed') throw new Error(`Vite exited before readiness.\n${output}`);
    if (state === 'ready') return child;
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 100);
    });
  }
  await stopTask7Vite(child);
  throw new Error(`Vite did not become ready.\n${output}`);
}

async function main(): Promise<void> {
  const requestedDir: string | undefined = process.env.STATS_DEV_EVIDENCE_DIR;
  if (requestedDir === undefined) throw new Error('STATS_DEV_EVIDENCE_DIR is required.');
  const outputDir: string = path.resolve(requestedDir);
  const approvedDir: string = path.resolve('artifacts/stats-task5/dev');
  if (outputDir !== approvedDir) {
    throw new Error(`Stats Task 5 development evidence must use ${approvedDir}.`);
  }
  await mkdir(outputDir, { recursive: true });
  const server: ChildProcessWithoutNullStreams = await startVite();
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context: BrowserContext = await browser.newContext();
    const page: Page = await context.newPage();
    const diagnostics: DevDiagnostics = emptyDiagnostics();
    monitorDevPage(page, diagnostics);
    const result = await captureStatsVisualMatrix({
      applyTheme,
      buildSource: 'dev',
      diagnostics: (): StatsVisualDiagnosticCounts => counts(diagnostics),
      evidenceDir: outputDir,
      page,
      statsUrl: (state: StatsVisualStateId): string =>
        `${BASE_URL}/tests/e2e/stats-dev-harness/stats.html?state=${state}`,
    });
    await page.close();
    await context.close();
    assertStatsVisualInventoryCoverage(result.records, 'dev');
    const inventory: StatsVisualEvidenceRecord[] = [...result.records].sort(
      (left: StatsVisualEvidenceRecord, right: StatsVisualEvidenceRecord): number =>
        left.file.localeCompare(right.file),
    );
    await writeFile(
      path.join(outputDir, 'stats-dev-run-report.json'),
      `${JSON.stringify(
        {
          browser: 'Playwright bundled Chromium',
          buildSource: 'dev',
          diagnostics: counts(diagnostics),
          diagnosticsBoundary: 'owned context closed before report write',
          geometry: result.geometry,
          inventory,
          schemaVersion: 1,
          screenshotCount: inventory.length,
          sourceHarness: 'tests/e2e/stats-dev-harness/stats.html',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    process.stdout.write(`Stats Task 5 dev evidence: ${String(inventory.length)} screenshots\n`);
  } finally {
    try {
      await browser?.close();
    } finally {
      await stopTask7Vite(server);
    }
  }
}

await main();

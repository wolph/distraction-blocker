import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Locator,
  type Page,
} from '@playwright/test';
import type * as Task7EvidenceModule from '../tests/e2e/task7-evidence';
import type * as Task7MatrixSupportModule from '../tests/e2e/task7-matrix-support';
import type * as Task7DevEvidenceModule from './task7-dev-evidence';
import type { Task7DevEvidenceRecord } from './task7-dev-evidence';
import type * as Task7PngModule from './task7-png';

const { assertTask7DevInventoryParity, stopTask7Vite, task7ViteStartupState } = (await import(
  new URL('./task7-dev-evidence.ts', import.meta.url).href
)) as typeof Task7DevEvidenceModule;
const { assertTask7ResolvedTheme } = (await import(
  new URL('../tests/e2e/task7-evidence.ts', import.meta.url).href
)) as typeof Task7EvidenceModule;
const { task7PngDimensions } = (await import(
  new URL('./task7-png.ts', import.meta.url).href
)) as typeof Task7PngModule;
const { task7VisibleContentIntersections } = (await import(
  new URL('../tests/e2e/task7-matrix-support.ts', import.meta.url).href
)) as typeof Task7MatrixSupportModule;

type ColorScheme = 'dark' | 'light';
type Theme = 'auto' | 'dark' | 'light';
type Scope = 'focused' | 'full';

interface ThemeCase {
  id: 'auto-dark' | 'auto-light' | 'dark-light-media' | 'light-dark-media';
  media: ColorScheme;
  resolved: ColorScheme;
  theme: Theme;
}

interface Diagnostics {
  consoleMessages: string[];
  pageErrors: string[];
  requestFailures: string[];
}

const THEME_CASES: readonly ThemeCase[] = [
  { id: 'auto-light', media: 'light', resolved: 'light', theme: 'auto' },
  { id: 'auto-dark', media: 'dark', resolved: 'dark', theme: 'auto' },
  { id: 'light-dark-media', media: 'dark', resolved: 'light', theme: 'light' },
  { id: 'dark-light-media', media: 'light', resolved: 'dark', theme: 'dark' },
];
const VIEWPORTS: readonly { height: number; width: number }[] = [
  { height: 667, width: 375 },
  { height: 800, width: 768 },
  { height: 800, width: 1280 },
];
const PORT: number = 4177;
const BASE_URL: string = `http://127.0.0.1:${String(PORT)}`;

function diagnosticsFor(page: Page): Diagnostics {
  const diagnostics: Diagnostics = { consoleMessages: [], pageErrors: [], requestFailures: [] };
  page.on('console', (message): void => {
    if (message.type() === 'error' || message.type() === 'warning') {
      diagnostics.consoleMessages.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error): void => {
    diagnostics.pageErrors.push(error.message);
  });
  page.on('requestfailed', (request): void => {
    diagnostics.requestFailures.push(
      `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'unknown failure'}`,
    );
  });
  return diagnostics;
}

function expectedFiles(): string[] {
  const files: string[] = [];
  for (const themeCase of THEME_CASES) {
    for (const viewport of VIEWPORTS) {
      for (const state of ['typed-gate', 'untyped-gate']) {
        for (const scope of ['full', 'focused']) {
          files.push(fileName('gate', themeCase, viewport.width, state, scope as Scope));
        }
      }
      for (const scope of ['full', 'focused']) {
        files.push(
          fileName('stats', themeCase, viewport.width, 'current-language', scope as Scope),
        );
        files.push(
          fileName(
            'stopped-overlay',
            themeCase,
            viewport.width,
            'stopped-document',
            scope as Scope,
          ),
        );
      }
    }
    for (const state of [
      'allow-invalid',
      'block',
      'flexible-hover',
      'friction-focus',
      'hard-click',
      'long-list-scrolled-focus',
      'unsupported-tab',
    ]) {
      for (const scope of ['full', 'focused']) {
        files.push(fileName('popup', themeCase, 340, state, scope as Scope));
      }
    }
    for (const viewport of VIEWPORTS) {
      for (const state of ['category-off-focus', 'partial-dirty', 'sticky-save']) {
        for (const scope of ['full', 'focused']) {
          files.push(fileName('options', themeCase, viewport.width, state, scope as Scope));
        }
      }
      for (const state of ['sync-error', 'local-confirm', 'remote-confirm']) {
        for (const scope of ['full', 'focused']) {
          files.push(fileName('privacy', themeCase, viewport.width, state, scope as Scope));
        }
      }
      for (const scope of ['full', 'focused']) {
        files.push(fileName('overlay', themeCase, viewport.width, 'provenance', scope as Scope));
      }
    }
  }
  return files.sort();
}

function fileName(
  surface: string,
  themeCase: ThemeCase,
  width: number,
  state: string,
  scope: Scope,
): string {
  return `task7-dev-current-${surface}-${themeCase.id}-${String(width)}-${state}-${scope}.png`;
}

async function fileRecord(
  outputDir: string,
  file: string,
  input: Omit<Task7DevEvidenceRecord, 'bytes' | 'file' | 'image' | 'sha256'>,
): Promise<Task7DevEvidenceRecord> {
  const absolutePath: string = path.join(outputDir, file);
  const payload: Buffer = await readFile(absolutePath);
  return {
    ...input,
    bytes: (await stat(absolutePath)).size,
    file,
    image: task7PngDimensions(payload),
    sha256: createHash('sha256').update(payload).digest('hex'),
  };
}

async function capture(
  outputDir: string,
  target: Locator | Page,
  input: {
    assertions: Omit<Task7DevEvidenceRecord['assertions'], 'resolvedTheme'>;
    diagnostics: Diagnostics;
    scope: Scope;
    state: string;
    surface: string;
    themeCase: ThemeCase;
    viewport: { height: number; width: number };
  },
): Promise<Task7DevEvidenceRecord> {
  const file: string = fileName(
    input.surface,
    input.themeCase,
    input.viewport.width,
    input.state,
    input.scope,
  );
  const absolutePath: string = path.join(outputDir, file);
  if ('page' in target) {
    await target.screenshot({ animations: 'disabled', path: absolutePath });
  } else {
    await target.screenshot({ animations: 'disabled', fullPage: true, path: absolutePath });
  }
  const page: Page = 'page' in target ? target.page() : target;
  const resolvedTheme: Task7DevEvidenceRecord['assertions']['resolvedTheme'] =
    await resolvedThemeFor(page, input.surface, input.themeCase);
  return await fileRecord(outputDir, file, {
    assertions: { ...input.assertions, resolvedTheme },
    buildSource: 'dev',
    colorScheme: input.themeCase.media,
    diagnostics: {
      consoleMessages: [...input.diagnostics.consoleMessages],
      pageErrors: [...input.diagnostics.pageErrors],
      requestFailures: [...input.diagnostics.requestFailures],
    },
    scope: input.scope,
    state: input.state,
    surface: input.surface,
    theme: input.themeCase.theme,
    themeCase: input.themeCase.id,
    viewport: input.viewport,
  });
}

async function resolvedThemeFor(
  page: Page,
  surface: string,
  themeCase: ThemeCase,
): Promise<Task7DevEvidenceRecord['assertions']['resolvedTheme']> {
  const overlaySurface: boolean = surface === 'overlay' || surface === 'stopped-overlay';
  const resolvedTheme: Task7DevEvidenceRecord['assertions']['resolvedTheme'] = overlaySurface
    ? await page
        .locator('focus-lock-overlay')
        .evaluate((host: Element): Task7DevEvidenceRecord['assertions']['resolvedTheme'] => {
          const style: CSSStyleDeclaration = getComputedStyle(host);
          return {
            backgroundColor: style.getPropertyValue('--overlay-bg').trim(),
            color: style.getPropertyValue('--overlay-text').trim(),
            colorScheme: style.colorScheme,
          };
        })
    : await page.evaluate((): Task7DevEvidenceRecord['assertions']['resolvedTheme'] => {
        const root: CSSStyleDeclaration = getComputedStyle(document.documentElement);
        const body: CSSStyleDeclaration = getComputedStyle(document.body);
        return {
          backgroundColor: body.backgroundColor,
          color: body.color,
          colorScheme: root.colorScheme,
        };
      });
  assertTask7ResolvedTheme(
    resolvedTheme,
    { colorScheme: themeCase.media, id: themeCase.id, theme: themeCase.theme },
    surface as Task7EvidenceModule.Task7ThemeSurface,
  );
  return resolvedTheme;
}

async function expectTheme(page: Page, themeCase: ThemeCase): Promise<void> {
  await page.waitForFunction(
    (theme: string): boolean => document.documentElement.dataset.theme === theme,
    themeCase.theme,
  );
  const theme = await page.evaluate(() => ({
    attribute: document.documentElement.dataset.theme ?? null,
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
  }));
  if (
    theme.attribute !== themeCase.theme ||
    !theme.colorScheme.split(/\s+/).includes(themeCase.resolved)
  ) {
    throw new Error(
      `Theme mismatch for ${themeCase.id}: ${JSON.stringify(theme)} expected ${themeCase.theme}/${themeCase.resolved}`,
    );
  }
}

async function expectText(page: Page, texts: readonly string[]): Promise<void> {
  const body: string = await page.locator('body').innerText();
  for (const text of texts) {
    if (!body.includes(text)) throw new Error(`Missing current copy: ${text}`);
  }
}

async function captureGateAndStats(
  context: BrowserContext,
  outputDir: string,
  records: Task7DevEvidenceRecord[],
): Promise<void> {
  for (const themeCase of THEME_CASES) {
    for (const viewport of VIEWPORTS) {
      for (const state of ['typed-gate', 'untyped-gate'] as const) {
        const page: Page = await context.newPage();
        const diagnostics: Diagnostics = diagnosticsFor(page);
        await page.setViewportSize(viewport);
        await page.emulateMedia({ colorScheme: themeCase.media, reducedMotion: 'reduce' });
        await page.goto(
          `${BASE_URL}/tests/e2e/task7-dev-harness/popup.html?theme=${themeCase.theme}&state=${state}`,
        );
        const panel: Locator = page.locator('.gate-panel');
        await panel.waitFor({ state: 'visible' });
        const copy: readonly string[] = ['A moment to decide', 'End the session'];
        await expectText(page, copy);
        await expectTheme(page, themeCase);
        const forceEndControlCount: number = await page
          .getByText('Ignore timeout and end anyway')
          .count();
        if (forceEndControlCount !== 0) throw new Error('Force-end control unexpectedly visible.');
        const focusTarget: Locator =
          state === 'typed-gate'
            ? panel.locator('input[type="text"]')
            : panel.getByRole('button', { name: 'Never mind, back to work' });
        await focusTarget.focus();
        for (const scope of ['full', 'focused'] as const) {
          records.push(
            await capture(outputDir, scope === 'full' ? page : panel, {
              assertions: { exactCopy: copy, forceEndControlCount },
              diagnostics,
              scope,
              state,
              surface: 'gate',
              themeCase,
              viewport,
            }),
          );
        }
        await page.close();
      }

      const page: Page = await context.newPage();
      const diagnostics: Diagnostics = diagnosticsFor(page);
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: themeCase.media, reducedMotion: 'reduce' });
      await page.goto(
        `${BASE_URL}/tests/e2e/task7-dev-harness/stats.html?theme=${themeCase.theme}`,
      );
      const copy: readonly string[] = [
        'Your focus record',
        'Focus, last 14 days',
        'Recent sessions on this machine',
        'Review example.com release notes',
      ];
      await expectText(page, copy);
      await expectTheme(page, themeCase);
      const seededIntention: Locator = page.getByText('Review example.com release notes');
      const visibleResponsiveCopies: number = await seededIntention.evaluateAll(
        (elements: Element[]): number =>
          elements.filter((element: Element): boolean => {
            const style: CSSStyleDeclaration = getComputedStyle(element);
            const bounds: DOMRect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0;
          }).length,
      );
      if (visibleResponsiveCopies !== 1) {
        throw new Error(
          `Expected one visible Stats copy, found ${String(visibleResponsiveCopies)}.`,
        );
      }
      const card: Locator = page
        .locator('.card')
        .filter({ hasText: 'Focus, last 14 days' })
        .first();
      await card.locator('summary').focus();
      for (const scope of ['full', 'focused'] as const) {
        records.push(
          await capture(outputDir, scope === 'full' ? page : card, {
            assertions: { exactCopy: copy, visibleResponsiveCopies },
            diagnostics,
            scope,
            state: 'current-language',
            surface: 'stats',
            themeCase,
            viewport,
          }),
        );
      }
      await page.close();
    }
  }
}

async function captureStoppedOverlay(
  context: BrowserContext,
  outputDir: string,
  records: Task7DevEvidenceRecord[],
): Promise<void> {
  for (const themeCase of THEME_CASES) {
    for (const viewport of VIEWPORTS) {
      const page: Page = await context.newPage();
      const diagnostics: Diagnostics = diagnosticsFor(page);
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: themeCase.media, reducedMotion: 'reduce' });
      await page.goto(
        `${BASE_URL}/tests/e2e/task7-dev-harness/overlay.html?theme=${themeCase.theme}`,
      );
      const overlay: Locator = page.locator('focus-lock-overlay');
      await overlay.waitFor({ state: 'visible' });
      const attribute: string | null = await overlay.getAttribute('data-theme');
      const resolvedScheme: string = await overlay.evaluate(
        (element: Element): string => getComputedStyle(element).colorScheme,
      );
      if (
        attribute !== themeCase.theme ||
        !resolvedScheme.split(/\s+/).includes(themeCase.resolved)
      ) {
        throw new Error(
          `Stopped overlay theme mismatch for ${themeCase.id}: ${String(attribute)}/${resolvedScheme}`,
        );
      }
      const copy: readonly string[] = [
        'Task 7 source-module QA',
        'This page did not load. It will load by itself when the session ends.',
      ];
      const session = await context.newCDPSession(page);
      await session.send('Accessibility.enable');
      const tree = await session.send('Accessibility.getFullAXTree');
      const names: string[] = tree.nodes.flatMap((node): string[] =>
        typeof node.name?.value === 'string' ? [node.name.value] : [],
      );
      await session.detach();
      for (const text of copy) {
        if (!names.includes(text)) throw new Error(`Missing stopped overlay copy: ${text}`);
      }
      records.push(
        await capture(outputDir, page, {
          assertions: { exactCopy: copy },
          diagnostics,
          scope: 'full',
          state: 'stopped-document',
          surface: 'stopped-overlay',
          themeCase,
          viewport,
        }),
      );
      const resolvedTheme: Task7DevEvidenceRecord['assertions']['resolvedTheme'] =
        await resolvedThemeFor(page, 'stopped-overlay', themeCase);
      const file: string = fileName(
        'stopped-overlay',
        themeCase,
        viewport.width,
        'stopped-document',
        'focused',
      );
      await page.screenshot({
        animations: 'disabled',
        clip: {
          height: Math.min(viewport.height, 560),
          width: Math.min(viewport.width, 600),
          x: Math.max(0, (viewport.width - Math.min(viewport.width, 600)) / 2),
          y: Math.max(0, (viewport.height - Math.min(viewport.height, 560)) / 2),
        },
        path: path.join(outputDir, file),
      });
      records.push(
        await fileRecord(outputDir, file, {
          assertions: { exactCopy: copy, resolvedTheme },
          buildSource: 'dev',
          colorScheme: themeCase.media,
          diagnostics,
          scope: 'focused',
          state: 'stopped-document',
          surface: 'stopped-overlay',
          theme: themeCase.theme,
          themeCase: themeCase.id,
          viewport,
        }),
      );
      await page.close();
    }
  }
}

async function capturePopup(
  context: BrowserContext,
  outputDir: string,
  records: Task7DevEvidenceRecord[],
): Promise<void> {
  const viewport = { height: 760, width: 340 };
  for (const themeCase of THEME_CASES) {
    const page: Page = await context.newPage();
    const diagnostics: Diagnostics = diagnosticsFor(page);
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: themeCase.media, reducedMotion: 'reduce' });
    await page.goto(
      `${BASE_URL}/tests/e2e/task7-dev-harness/popup.html?theme=${themeCase.theme}&state=idle`,
    );
    await page.getByRole('heading', { name: 'What will be blocked' }).waitFor();
    await expectTheme(page, themeCase);
    const blockCopy: readonly string[] = ['What will be blocked', 'Session rule details'];
    const blockSummary: Locator = page.locator('.rule-summary');
    for (const scope of ['full', 'focused'] as const) {
      records.push(
        await capture(outputDir, scope === 'full' ? page : blockSummary, {
          assertions: { exactCopy: blockCopy },
          diagnostics,
          scope,
          state: 'block',
          surface: 'popup',
          themeCase,
          viewport,
        }),
      );
    }
    const ruleScroll: Locator = page.getByRole('region', { name: 'Session rule details' });
    await ruleScroll.evaluate((element: HTMLElement): void => {
      element.scrollTop = element.scrollHeight;
    });
    await ruleScroll.focus();
    if ((await ruleScroll.evaluate((element: HTMLElement): number => element.scrollTop)) <= 0) {
      throw new Error('Popup long-list source harness did not scroll.');
    }
    for (const scope of ['full', 'focused'] as const) {
      records.push(
        await capture(outputDir, scope === 'full' ? page : ruleScroll, {
          assertions: { exactCopy: ['Session rule details'] },
          diagnostics,
          scope,
          state: 'long-list-scrolled-focus',
          surface: 'popup',
          themeCase,
          viewport,
        }),
      );
    }
    const helpCases = [
      {
        action: 'hover',
        button: 'Flexible',
        state: 'flexible-hover',
        text: 'End the session immediately',
      },
      {
        action: 'focus',
        button: 'Friction',
        state: 'friction-focus',
        text: 'Ending early requires a 10-second wait',
      },
      {
        action: 'click',
        button: 'Hard lock',
        state: 'hard-click',
        text: 'The session cannot end early',
      },
    ] as const;
    for (const help of helpCases) {
      const button: Locator = page.getByRole('button', { name: help.button });
      if (help.action === 'hover') await button.hover();
      else if (help.action === 'focus') await button.focus();
      else await button.click();
      const tooltip: Locator = page.getByRole('tooltip').filter({ hasText: help.text });
      await tooltip.waitFor({ state: 'visible' });
      for (const scope of ['full', 'focused'] as const) {
        records.push(
          await capture(outputDir, scope === 'full' ? page : tooltip, {
            assertions: { exactCopy: [help.text] },
            diagnostics,
            scope,
            state: help.state,
            surface: 'popup',
            themeCase,
            viewport,
          }),
        );
      }
      if (help.action === 'hover') await page.mouse.move(0, 0);
      else await page.keyboard.press('Escape');
    }
    await page.getByRole('radio', { name: /Allow selected sites only/ }).check();
    await page.getByLabel('Add an allowed domain').fill('https://user@example.com/private');
    await page.getByRole('button', { name: 'Add allowed domain' }).click();
    const invalid: Locator = page.getByRole('alert');
    const invalidCopy: readonly string[] = ['Enter a valid domain such as docs.example.com.'];
    await invalid.waitFor({ state: 'visible' });
    for (const scope of ['full', 'focused'] as const) {
      records.push(
        await capture(outputDir, scope === 'full' ? page : invalid, {
          assertions: { exactCopy: invalidCopy },
          diagnostics,
          scope,
          state: 'allow-invalid',
          surface: 'popup',
          themeCase,
          viewport,
        }),
      );
    }
    await page.close();

    const unsupportedPage: Page = await context.newPage();
    const unsupportedDiagnostics: Diagnostics = diagnosticsFor(unsupportedPage);
    await unsupportedPage.setViewportSize(viewport);
    await unsupportedPage.emulateMedia({ colorScheme: themeCase.media, reducedMotion: 'reduce' });
    await unsupportedPage.goto(
      `${BASE_URL}/tests/e2e/task7-dev-harness/popup.html?theme=${themeCase.theme}&state=unsupported`,
    );
    const unsupported: Locator = unsupportedPage
      .locator('.spend-button')
      .filter({ hasText: 'Unlock this site' });
    await unsupported.waitFor({ state: 'visible' });
    const unsupportedCopy: readonly string[] = ['Open a regular website to unlock it'];
    await expectText(unsupportedPage, unsupportedCopy);
    for (const scope of ['full', 'focused'] as const) {
      records.push(
        await capture(outputDir, scope === 'full' ? unsupportedPage : unsupported, {
          assertions: { exactCopy: unsupportedCopy },
          diagnostics: unsupportedDiagnostics,
          scope,
          state: 'unsupported-tab',
          surface: 'popup',
          themeCase,
          viewport,
        }),
      );
    }
    await unsupportedPage.close();
  }
}

async function captureOptionsAndPrivacy(
  context: BrowserContext,
  outputDir: string,
  records: Task7DevEvidenceRecord[],
): Promise<void> {
  for (const themeCase of THEME_CASES) {
    for (const viewport of VIEWPORTS) {
      const page: Page = await context.newPage();
      const diagnostics: Diagnostics = diagnosticsFor(page);
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: themeCase.media, reducedMotion: 'reduce' });
      await page.goto(
        `${BASE_URL}/tests/e2e/task7-dev-harness/options.html?theme=${themeCase.theme}#blocking`,
      );
      await page.getByRole('heading', { name: 'Blocking' }).waitFor();
      await expectTheme(page, themeCase);
      const socialRow: Locator = page.locator('.cat-row').filter({ hasText: 'Social media' });
      const socialGroup: Locator = socialRow.locator('xpath=..');
      await socialRow.getByRole('checkbox', { name: 'Social media' }).uncheck();
      const categoryOffCopy: readonly string[] = ['Category off', 'included when enabled'];
      await expectText(page, categoryOffCopy);
      await socialRow.getByRole('checkbox', { name: 'Social media' }).focus();
      for (const scope of ['full', 'focused'] as const) {
        records.push(
          await capture(outputDir, scope === 'full' ? page : socialGroup, {
            assertions: { exactCopy: categoryOffCopy },
            diagnostics,
            scope,
            state: 'category-off-focus',
            surface: 'options',
            themeCase,
            viewport,
          }),
        );
      }
      await socialRow.getByRole('checkbox', { name: 'Social media' }).check();
      await page.getByRole('checkbox', { name: 'News', exact: true }).uncheck();
      await socialRow.scrollIntoViewIfNeeded();
      const saveBar: Locator = page.locator('.dirty-save-bar');
      const partialCopy: readonly string[] = ['Selected 11', 'Deselected 1', 'Unsaved changes'];
      await expectText(page, partialCopy);
      for (const [state, target] of [
        ['partial-dirty', socialGroup],
        ['sticky-save', saveBar],
      ] as const) {
        for (const scope of ['full', 'focused'] as const) {
          records.push(
            await capture(outputDir, scope === 'full' ? page : target, {
              assertions: { exactCopy: partialCopy },
              diagnostics,
              scope,
              state,
              surface: 'options',
              themeCase,
              viewport,
            }),
          );
        }
      }
      const intersections = await task7VisibleContentIntersections(page);
      if (intersections.targets.length !== 0) {
        throw new Error(
          `Dev Options save bar intersects ${JSON.stringify(intersections.targets)}.`,
        );
      }
      await page.close();

      const privacyPage: Page = await context.newPage();
      const privacyDiagnostics: Diagnostics = diagnosticsFor(privacyPage);
      await privacyPage.setViewportSize(viewport);
      await privacyPage.emulateMedia({ colorScheme: themeCase.media, reducedMotion: 'reduce' });
      await privacyPage.goto(
        `${BASE_URL}/tests/e2e/task7-dev-harness/options.html?theme=${themeCase.theme}#privacy`,
      );
      await privacyPage.getByRole('heading', { name: 'Privacy and data' }).waitFor();
      await expectTheme(privacyPage, themeCase);
      const syncError: Locator = privacyPage.getByRole('alert');
      const syncCopy: readonly string[] = [
        'Chrome Sync could not save your latest changes. Your local save is safe.',
      ];
      await expectText(privacyPage, syncCopy);
      for (const scope of ['full', 'focused'] as const) {
        records.push(
          await capture(outputDir, scope === 'full' ? privacyPage : syncError, {
            assertions: { exactCopy: syncCopy },
            diagnostics: privacyDiagnostics,
            scope,
            state: 'sync-error',
            surface: 'privacy',
            themeCase,
            viewport,
          }),
        );
      }
      const confirmations = [
        { button: 'Delete local history', dialog: 'Delete local history?', state: 'local-confirm' },
        {
          button: 'Delete remote Sync data',
          dialog: 'Delete remote Sync data?',
          state: 'remote-confirm',
        },
      ] as const;
      for (const confirmation of confirmations) {
        await privacyPage.getByRole('button', { name: confirmation.button }).click();
        const dialog: Locator = privacyPage.getByRole('dialog', { name: confirmation.dialog });
        await dialog.waitFor({ state: 'visible' });
        for (const scope of ['full', 'focused'] as const) {
          records.push(
            await capture(outputDir, scope === 'full' ? privacyPage : dialog, {
              assertions: { exactCopy: [confirmation.dialog] },
              diagnostics: privacyDiagnostics,
              scope,
              state: confirmation.state,
              surface: 'privacy',
              themeCase,
              viewport,
            }),
          );
        }
        await privacyPage.keyboard.press('Escape');
      }
      await privacyPage.close();
    }
  }
}

async function captureOverlayProvenance(
  context: BrowserContext,
  outputDir: string,
  records: Task7DevEvidenceRecord[],
): Promise<void> {
  for (const themeCase of THEME_CASES) {
    for (const viewport of VIEWPORTS) {
      const page: Page = await context.newPage();
      const diagnostics: Diagnostics = diagnosticsFor(page);
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: themeCase.media, reducedMotion: 'reduce' });
      await page.goto(
        `${BASE_URL}/tests/e2e/task7-dev-harness/overlay.html?theme=${themeCase.theme}&stopped=false`,
      );
      const overlay: Locator = page.locator('focus-lock-overlay');
      await overlay.waitFor({ state: 'visible' });
      const copy: readonly string[] = ['Blocked by your block list: blocked.example'];
      for (const scope of ['full', 'focused'] as const) {
        records.push(
          await capture(outputDir, page, {
            assertions: { exactCopy: copy },
            diagnostics,
            scope,
            state: 'provenance',
            surface: 'overlay',
            themeCase,
            viewport,
          }),
        );
      }
      await page.close();
    }
  }
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
      // The isolated source server is still starting.
    }
    const state: ReturnType<typeof task7ViteStartupState> = task7ViteStartupState({
      exitCode: child.exitCode,
      output,
      responseReady,
    });
    if (state === 'failed') throw new Error(`Vite exited before readiness.\n${output}`);
    if (state === 'ready') return child;
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 100);
    });
  }
  await stopTask7Vite(child);
  throw new Error(`Vite did not become ready.\n${output}`);
}

async function main(): Promise<void> {
  const requestedDir: string | undefined = process.env.TASK7_DEV_EVIDENCE_DIR;
  if (requestedDir === undefined) throw new Error('TASK7_DEV_EVIDENCE_DIR is required.');
  const outputDir: string = path.resolve(requestedDir);
  const approvedDir: string = path.resolve('artifacts/daily-product-surfaces-task7');
  if (outputDir !== approvedDir) {
    throw new Error(`Task 7 dev evidence must use ${approvedDir}.`);
  }
  const server: ChildProcessWithoutNullStreams = await startVite();
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context: BrowserContext = await browser.newContext();
    const records: Task7DevEvidenceRecord[] = [];
    await capturePopup(context, outputDir, records);
    await captureOptionsAndPrivacy(context, outputDir, records);
    await captureOverlayProvenance(context, outputDir, records);
    await captureGateAndStats(context, outputDir, records);
    await captureStoppedOverlay(context, outputDir, records);
    await context.close();
    const sorted: Task7DevEvidenceRecord[] = records.sort(
      (left: Task7DevEvidenceRecord, right: Task7DevEvidenceRecord): number =>
        left.file.localeCompare(right.file),
    );
    assertTask7DevInventoryParity(expectedFiles(), sorted);
    const report = {
      browser: 'Playwright bundled Chromium',
      buildSource: 'dev',
      diagnosticsBoundary: 'owned context closed before report write',
      inventory: sorted,
      schemaVersion: 1,
      screenshotCount: sorted.length,
      sourceHarnesses: [
        'tests/e2e/task7-dev-harness/popup.html',
        'tests/e2e/task7-dev-harness/stats.html',
        'tests/e2e/task7-dev-harness/overlay.html',
        'tests/e2e/task7-dev-harness/options.html',
      ],
    };
    await writeFile(
      path.join(outputDir, 'task7-dev-current-run-report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
    process.stdout.write(`Task 7 dev evidence: ${String(sorted.length)} screenshots\n`);
  } finally {
    try {
      await browser?.close();
    } finally {
      await stopTask7Vite(server);
    }
  }
}

await main();

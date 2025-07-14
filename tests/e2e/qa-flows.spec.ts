import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  BrowserContext,
  CDPSession,
  ElementHandle,
  Frame,
  Locator,
  Page,
  Worker,
} from '@playwright/test';
import type { ListsConfig, SessionSnapshot, Settings, ThemeMode } from '../../src/shared/types';
import {
  assertNoUnexpectedBrowserDiagnostics,
  type BrowserDiagnostics,
} from './browser-diagnostics';
import {
  browserDiagnosticsFor,
  clearNotifications,
  expect,
  hasOffscreenAudioDocument,
  notificationIds,
  type ObservedSound,
  observedSounds,
  observeSoundMessages,
  sendExtensionRequest,
  startTestSession,
  test,
} from './fixtures';
import {
  assertTask7BuildProvenance,
  assertTask7CurrentSurfaceCoverage,
  assertTask7ResolvedTheme,
  readTask7BuildProvenance,
  type Task7BuildProvenance,
  type Task7ResolvedTheme,
  type Task7ThemeCase,
  type Task7ThemeSurface,
} from './task7-evidence';

test.setTimeout(60_000);

const NEXT_THEME: Readonly<Record<ThemeMode, ThemeMode>> = {
  auto: 'light',
  light: 'dark',
  dark: 'auto',
};

const THEME_LABEL: Readonly<Record<ThemeMode, string>> = {
  auto: 'Auto',
  light: 'Light',
  dark: 'Dark',
};

interface Task7EvidenceRecord {
  buildSource: 'production';
  bytes: number;
  colorScheme: 'dark' | 'light';
  file: string;
  scope: 'focused' | 'full';
  sha256: string;
  state: string;
  surface: Task7ThemeSurface;
  theme: ThemeMode;
  themeCase: Task7ThemeCase['id'];
  viewport: { height: number; width: number };
}

const TASK7_THEME_CASES: readonly Task7ThemeCase[] = [
  { colorScheme: 'light', id: 'auto-light', theme: 'auto' },
  { colorScheme: 'dark', id: 'auto-dark', theme: 'auto' },
  { colorScheme: 'dark', id: 'light-dark-media', theme: 'light' },
  { colorScheme: 'light', id: 'dark-light-media', theme: 'dark' },
];

async function expectPageTheme(page: Page, theme: ThemeMode): Promise<void> {
  const next: ThemeMode = NEXT_THEME[theme];
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(
    page.getByRole('button', {
      name: `Theme: ${THEME_LABEL[theme]}. Switch to ${THEME_LABEL[next]}`,
    }),
  ).toBeEnabled();
}

async function overlayHandle(page: Page): Promise<ElementHandle<HTMLElement | SVGElement>> {
  await expect(page.locator('focus-lock-overlay')).toBeAttached();
  const handle: ElementHandle<HTMLElement | SVGElement> | null = await page
    .locator('focus-lock-overlay')
    .elementHandle();
  if (handle === null) throw new Error('Focus Lock overlay was not mounted');
  return handle;
}

async function expectOverlayTheme(
  handle: ElementHandle<HTMLElement | SVGElement>,
  theme: ThemeMode,
): Promise<void> {
  await expect
    .poll(
      async (): Promise<{ connected: boolean; theme: string | undefined }> =>
        await handle.evaluate(
          (host: HTMLElement | SVGElement): { connected: boolean; theme: string | undefined } => ({
            connected: host.isConnected,
            theme: host.dataset.theme,
          }),
        ),
    )
    .toEqual({ connected: true, theme });
}

async function expectWithinViewport(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const bounds: { bottom: number; left: number; right: number; top: number } =
    await locator.evaluate(
      (element: Element): { bottom: number; left: number; right: number; top: number } => {
        const rect: DOMRect = element.getBoundingClientRect();
        return { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top };
      },
    );
  const viewport: { height: number; width: number } = await locator
    .page()
    .evaluate((): { height: number; width: number } => ({
      height: window.innerHeight,
      width: window.innerWidth,
    }));
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(viewport.width);
  expect(bounds.bottom).toBeLessThanOrEqual(viewport.height);
}

async function captureTask7Evidence(
  target: Locator | Page,
  stem: string,
  fullPage: boolean = false,
): Promise<void> {
  const evidenceDir: string | undefined = process.env.TASK7_EVIDENCE_DIR;
  if (evidenceDir === undefined) return;
  const absoluteDir: string = path.resolve(evidenceDir);
  await mkdir(absoluteDir, { recursive: true });
  if ('page' in target) {
    await target.screenshot({
      path: path.join(absoluteDir, `${stem}.png`),
      animations: 'disabled',
    });
    return;
  }
  await target.screenshot({
    path: path.join(absoluteDir, `${stem}.png`),
    animations: 'disabled',
    fullPage,
  });
}

async function task7FileRecord(
  absolutePath: string,
  metadata: Omit<Task7EvidenceRecord, 'bytes' | 'file' | 'sha256'>,
): Promise<Task7EvidenceRecord> {
  const payload: Buffer = await readFile(absolutePath);
  return {
    ...metadata,
    bytes: (await stat(absolutePath)).size,
    file: path.basename(absolutePath),
    sha256: createHash('sha256').update(payload).digest('hex'),
  };
}

async function captureTask7MatrixEvidence(
  evidenceDir: string,
  target: Locator | Page,
  stem: string,
  metadata: Omit<Task7EvidenceRecord, 'bytes' | 'file' | 'sha256'>,
  fullPage: boolean = false,
): Promise<Task7EvidenceRecord | null> {
  const absoluteDir: string = path.resolve(evidenceDir);
  const absolutePath: string = path.join(absoluteDir, `${stem}.png`);
  await mkdir(absoluteDir, { recursive: true });
  if ('page' in target) {
    await target.screenshot({ path: absolutePath, animations: 'disabled' });
  } else {
    await target.screenshot({ path: absolutePath, animations: 'disabled', fullPage });
  }
  return await task7FileRecord(absolutePath, metadata);
}

async function captureTask7ClipEvidence(
  evidenceDir: string,
  page: Page,
  stem: string,
  metadata: Omit<Task7EvidenceRecord, 'bytes' | 'file' | 'sha256'>,
  clip: { height: number; width: number; x: number; y: number },
): Promise<Task7EvidenceRecord | null> {
  const absoluteDir: string = path.resolve(evidenceDir);
  const absolutePath: string = path.join(absoluteDir, `${stem}.png`);
  await mkdir(absoluteDir, { recursive: true });
  await page.screenshot({ path: absolutePath, animations: 'disabled', clip });
  return await task7FileRecord(absolutePath, metadata);
}

function appendTask7Record(
  records: Task7EvidenceRecord[],
  record: Task7EvidenceRecord | null,
): void {
  if (record !== null) records.push(record);
}

async function applyTask7ThemeCase(
  page: Page,
  themeCase: Task7ThemeCase,
  surface: Exclude<Task7ThemeSurface, 'overlay' | 'stopped-overlay'>,
): Promise<void> {
  await page.emulateMedia({ colorScheme: themeCase.colorScheme });
  expect(
    await page.evaluate(
      async (theme: ThemeMode): Promise<unknown> =>
        await chrome.runtime.sendMessage({ type: 'updateTheme', theme }),
      themeCase.theme,
    ),
  ).toEqual({ ok: true });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', themeCase.theme);
  await expectTask7ResolvedPageTheme(page, themeCase, surface);
}

async function expectTask7ResolvedPageTheme(
  page: Page,
  themeCase: Task7ThemeCase,
  surface: Exclude<Task7ThemeSurface, 'overlay' | 'stopped-overlay'>,
): Promise<void> {
  const resolved: Task7ResolvedTheme = await page.evaluate((): Task7ResolvedTheme => {
    const root: CSSStyleDeclaration = getComputedStyle(document.documentElement);
    const body: CSSStyleDeclaration = getComputedStyle(document.body);
    return {
      backgroundColor: body.backgroundColor,
      color: body.color,
      colorScheme: root.colorScheme,
    };
  });
  expect((): void => assertTask7ResolvedTheme(resolved, themeCase, surface)).not.toThrow();
}

function task7Metadata(
  themeCase: Task7ThemeCase,
  viewport: { height: number; width: number },
  surface: Task7EvidenceRecord['surface'],
  state: string,
  scope: Task7EvidenceRecord['scope'],
): Omit<Task7EvidenceRecord, 'bytes' | 'file' | 'sha256'> {
  return {
    buildSource: 'production',
    colorScheme: themeCase.colorScheme,
    scope,
    state,
    surface,
    theme: themeCase.theme,
    themeCase: themeCase.id,
    viewport,
  };
}

async function expectClosedOverlayText(
  context: BrowserContext,
  page: Page,
  text: string,
): Promise<void> {
  const session: CDPSession = await context.newCDPSession(page);
  try {
    await session.send('Accessibility.enable');
    await expect
      .poll(async (): Promise<number> => {
        const tree = await session.send('Accessibility.getFullAXTree');
        return tree.nodes.filter(
          (node): boolean => node.role?.value === 'StaticText' && node.name?.value === text,
        ).length;
      })
      .toBe(1);
  } finally {
    await session.detach();
  }
}

test('popup daily states keep help and long rules contained at native width', async ({
  context,
  extPage,
  siteUrl,
}) => {
  const lists: ListsConfig = await sendExtensionRequest(extPage, { type: 'getLists' });
  const seededLists: ListsConfig = {
    ...lists,
    custom: Array.from({ length: 18 }, (_unused: unknown, index: number) => ({
      kind: 'host' as const,
      pattern: `blocked-${String(index).padStart(2, '0')}.example`,
    })),
    whitelist: Array.from({ length: 18 }, (_unused: unknown, index: number) => ({
      kind: index % 3 === 0 ? ('regex' as const) : ('host' as const),
      pattern:
        index % 3 === 0
          ? `^docs-${String(index).padStart(2, '0')}\\.example\\.org/very/long/path$`
          : `allowed-${String(index).padStart(2, '0')}.very-long-example-domain.org`,
    })),
    categories: {
      social: true,
      video: true,
      news: true,
      mail: true,
      shopping: true,
      gaming: true,
      forums: true,
    },
  };
  expect(await sendExtensionRequest(extPage, { type: 'updateLists', lists: seededLists })).toEqual({
    ok: true,
  });

  await extPage.setViewportSize({ width: 340, height: 760 });
  await extPage.reload();
  await expect(extPage.getByRole('heading', { name: 'What will be blocked' })).toBeVisible();
  await captureTask7Evidence(extPage, 'production-popup-block-340-full');
  const ruleScroll: Locator = extPage.getByRole('region', { name: 'Session rule details' });
  expect(
    await ruleScroll.evaluate((element: HTMLElement): boolean =>
      Boolean(element.scrollHeight > element.clientHeight),
    ),
  ).toBe(true);
  await ruleScroll.focus();
  const startButton: Locator = extPage.getByRole('button', {
    name: 'Start 25 min - Block selected sites',
  });
  const startBoundsBefore: { bottom: number; top: number } = await startButton.evaluate(
    (element: Element): { bottom: number; top: number } => {
      const rect: DOMRect = element.getBoundingClientRect();
      return { bottom: rect.bottom, top: rect.top };
    },
  );
  await ruleScroll.press('PageDown');
  expect(
    await ruleScroll.evaluate((element: HTMLElement): number => element.scrollTop),
  ).toBeGreaterThan(0);
  expect(
    await startButton.evaluate((element: Element): { bottom: number; top: number } => {
      const rect: DOMRect = element.getBoundingClientRect();
      return { bottom: rect.bottom, top: rect.top };
    }),
  ).toEqual(startBoundsBefore);

  const flexible: Locator = extPage.getByRole('button', { name: 'Flexible' });
  await flexible.hover();
  await expect(extPage.getByRole('tooltip')).toHaveText(
    'End the session immediately whenever you choose.',
  );
  await expectWithinViewport(extPage.getByRole('tooltip'));
  await extPage.mouse.move(0, 0);
  await expect(extPage.getByRole('tooltip')).toHaveCount(0);

  const friction: Locator = extPage.getByRole('button', { name: 'Friction' });
  await friction.focus();
  const frictionTooltip: Locator = extPage
    .getByRole('tooltip')
    .filter({ hasText: 'Ending early requires a 10-second wait' });
  await expect(frictionTooltip).toHaveText(
    'Ending early requires a 10-second wait. No typing is required.',
  );
  await expectWithinViewport(frictionTooltip);
  await captureTask7Evidence(extPage, 'production-popup-friction-focus-340-full');
  await friction.press('Escape');

  const hard: Locator = extPage.getByRole('button', { name: 'Hard lock' });
  await hard.click();
  await expect(hard).toHaveAttribute('aria-pressed', 'true');
  const hardTooltip: Locator = extPage
    .getByRole('tooltip')
    .filter({ hasText: 'The session cannot end early' });
  await expect(hardTooltip).toHaveText('The session cannot end early. Earned pauses still work.');
  await expectWithinViewport(hardTooltip);
  await extPage.keyboard.press('Escape');

  await extPage.getByRole('radio', { name: /Allow selected sites only/ }).check();
  await expect(extPage.getByRole('heading', { name: 'What will be allowed' })).toBeVisible();
  await expect(extPage.getByRole('heading', { name: 'Blocked categories' })).toHaveCount(0);
  const allowInput: Locator = extPage.getByLabel('Add an allowed domain');
  await allowInput.fill('https://user@example.com/private');
  await extPage.getByRole('button', { name: 'Add allowed domain' }).click();
  await expect(extPage.getByRole('alert')).toHaveText(
    'Enter a valid domain such as docs.example.com.',
  );
  await expectWithinViewport(extPage.getByRole('alert'));
  await captureTask7Evidence(extPage, 'production-popup-allow-invalid-340-full');
  await allowInput.fill('https://Docs.Python.org/3/library/');
  await extPage.getByRole('button', { name: 'Add allowed domain' }).click();
  await expect(extPage.getByText('docs.python.org', { exact: true })).toBeVisible();
  expect(
    await ruleScroll.evaluate((element: HTMLElement): boolean =>
      Boolean(element.scrollHeight > element.clientHeight),
    ),
  ).toBe(true);
  await expectWithinViewport(extPage.locator('.app'));

  const existingPage: Page = await context.newPage();
  await existingPage.goto(siteUrl('/plain.html'));
  await extPage.bringToFront();
  await startTestSession(extPage, { durationMin: 0.3, strictness: 'friction' });
  await expect(existingPage.locator('focus-lock-overlay')).toBeAttached();
  await expectClosedOverlayText(
    context,
    existingPage,
    'Blocked by your block list: blocked.example',
  );
  await captureTask7Evidence(existingPage, 'production-overlay-provenance-340-full');

  await extPage.bringToFront();
  await extPage.reload();
  const unlock: Locator = extPage.locator('.spend-button').filter({ hasText: 'Unlock this site' });
  await expect(unlock).toBeDisabled();
  await expect(unlock).toContainText('Open a regular website to unlock it');
  await expectWithinViewport(unlock);
  await captureTask7Evidence(extPage, 'production-popup-unsupported-tab-340-full');
});

test('Options exposes destination saving, category states, and scoped privacy confirmations', async ({
  context,
  extensionId,
}) => {
  const optionsPage: Page = await context.newPage();
  await optionsPage.setViewportSize({ width: 375, height: 667 });
  await optionsPage.goto(`chrome-extension://${extensionId}/src/options/options.html#blocking`);
  await expect(optionsPage.getByRole('heading', { name: 'Blocking' })).toBeVisible();
  const socialRow: Locator = optionsPage.locator('.cat-row').filter({ hasText: 'Social media' });
  await expect(socialRow.getByText('Selected 12')).toBeVisible();
  await expect(socialRow.getByText('Deselected 0')).toBeVisible();
  const socialState: Locator = socialRow.locator('xpath=following-sibling::p[1]');
  await expect(socialState).toContainText('Category off');
  await expect(socialState).toContainText('12 included when enabled');
  const categoryStateGaps: number[] = await optionsPage
    .locator('.category-state')
    .evaluateAll((states: Element[]): number[] =>
      states.map((state: Element): number => {
        const row: Element | null = state.previousElementSibling;
        if (row === null || !row.classList.contains('cat-row')) {
          throw new Error('Category state must immediately follow its category row.');
        }
        return state.getBoundingClientRect().top - row.getBoundingClientRect().bottom;
      }),
    );
  expect(categoryStateGaps.length).toBeGreaterThan(0);
  for (const gap of categoryStateGaps) {
    expect(gap, 'category status text must not overlap its row separator').toBeGreaterThanOrEqual(
      0,
    );
  }

  await socialRow.getByRole('button', { name: 'Show Social media sites' }).click();
  await optionsPage.getByRole('checkbox', { name: 'facebook.com' }).uncheck();
  await expect(socialRow.getByText('Selected 11')).toBeVisible();
  await expect(socialRow.getByText('Deselected 1')).toBeVisible();
  await expect(socialState).toContainText('Category off');
  await expect(socialState).toContainText('11 included when enabled');
  await socialRow.getByRole('checkbox', { name: 'Social media' }).check();
  await expect(socialState).toHaveText('11 sites included');
  const saveBar: Locator = optionsPage.locator('.dirty-save-bar');
  await expect(saveBar.getByText('Unsaved changes')).toBeVisible();
  expect(
    await saveBar.evaluate((element: Element): string => getComputedStyle(element).position),
  ).toBe('sticky');
  await optionsPage.evaluate((): void => window.scrollTo(0, document.documentElement.scrollHeight));
  await expectWithinViewport(saveBar);
  await captureTask7Evidence(optionsPage, 'production-options-partial-dirty-375-full', true);
  await captureTask7Evidence(saveBar, 'production-options-sticky-save-375');
  await saveBar.getByRole('button', { name: 'Discard changes' }).click();
  await expect(saveBar.getByText('No unsaved changes')).toBeVisible();
  await expect(socialState).toContainText('Category off');
  await expect(socialState).toContainText('12 included when enabled');

  await optionsPage.getByRole('link', { name: 'Privacy and data' }).click();
  await expect(optionsPage.getByRole('heading', { name: 'Privacy and data' })).toBeVisible();
  await expect(optionsPage.getByText('Nothing is sent to the Focus Lock developer.')).toBeVisible();
  const deleteLocal: Locator = optionsPage.getByRole('button', { name: 'Delete local history' });
  await deleteLocal.click();
  const localDialog: Locator = optionsPage.getByRole('dialog', { name: 'Delete local history?' });
  await expect(localDialog).toContainText(
    'full URLs, focus intentions, and detailed session events',
  );
  await expect(localDialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expectWithinViewport(localDialog);
  await captureTask7Evidence(localDialog, 'production-privacy-local-confirm-375');
  await optionsPage.keyboard.press('Escape');
  await expect(localDialog).toHaveCount(0);
  await expect(deleteLocal).toBeFocused();

  const syncSwitch: Locator = optionsPage.getByRole('switch', {
    name: 'Sync Focus Lock data across Chrome devices',
  });
  expect(
    await optionsPage.evaluate(
      async (): Promise<unknown> =>
        await chrome.runtime.sendMessage({
          type: 'setStorageMode',
          storageMode: 'local',
          deleteRemote: false,
        }),
    ),
  ).toEqual({ ok: true });
  await optionsPage.reload();
  await expect(syncSwitch).not.toBeChecked();
  const deleteRemote: Locator = optionsPage.getByRole('button', {
    name: 'Delete remote Sync data',
  });
  await deleteRemote.click();
  const remoteDialog: Locator = optionsPage.getByRole('dialog', {
    name: 'Delete remote Sync data?',
  });
  await expect(remoteDialog).toContainText('Local settings and statistics stay on this device.');
  await expectWithinViewport(remoteDialog);
  await captureTask7Evidence(remoteDialog, 'production-privacy-remote-confirm-375');
  await remoteDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(remoteDialog).toHaveCount(0);
  await expect(deleteRemote).toBeFocused();
});

interface Task7CaptureContext {
  capture(
    target: Locator | Page,
    surface: Task7EvidenceRecord['surface'],
    state: string,
    themeCase: Task7ThemeCase,
    viewport: { height: number; width: number },
    scope: Task7EvidenceRecord['scope'],
    fullPage?: boolean,
  ): Promise<void>;
  evidenceDir: string;
  records: Task7EvidenceRecord[];
}

function createTask7CaptureContext(evidenceDir: string): Task7CaptureContext {
  const records: Task7EvidenceRecord[] = [];
  return {
    evidenceDir,
    records,
    capture: async (
      target: Locator | Page,
      surface: Task7EvidenceRecord['surface'],
      state: string,
      themeCase: Task7ThemeCase,
      viewport: { height: number; width: number },
      scope: Task7EvidenceRecord['scope'],
      fullPage: boolean = false,
    ): Promise<void> => {
      appendTask7Record(
        records,
        await captureTask7MatrixEvidence(
          evidenceDir,
          target,
          `task7-production-${surface}-${themeCase.id}-${String(viewport.width)}-${state}-${scope}`,
          task7Metadata(themeCase, viewport, surface, state, scope),
          fullPage,
        ),
      );
    },
  };
}

function task7LongLists(lists: ListsConfig): ListsConfig {
  return {
    ...lists,
    custom: Array.from({ length: 18 }, (_unused: unknown, index: number) => ({
      kind: 'host' as const,
      pattern: `blocked-${String(index).padStart(2, '0')}.example`,
    })),
    whitelist: Array.from({ length: 18 }, (_unused: unknown, index: number) => ({
      kind: index % 3 === 0 ? ('regex' as const) : ('host' as const),
      pattern:
        index % 3 === 0
          ? `^docs-${String(index).padStart(2, '0')}\\.example\\.org/very/long/path$`
          : `allowed-${String(index).padStart(2, '0')}.very-long-example-domain.org`,
    })),
    categories: {
      social: true,
      video: true,
      news: true,
      mail: true,
      shopping: true,
      gaming: true,
      forums: true,
    },
  };
}

async function captureTask7PopupMatrix(input: {
  capture: Task7CaptureContext;
  page: Page;
  viewport: { height: number; width: number };
}): Promise<Record<string, unknown>[]> {
  const geometry: Record<string, unknown>[] = [];
  await input.page.setViewportSize(input.viewport);
  for (const themeCase of TASK7_THEME_CASES) {
    await test.step(`popup ${themeCase.id} ${String(input.viewport.width)} block and help states`, async () => {
      await applyTask7ThemeCase(input.page, themeCase, 'popup');
      await expect(input.page.getByRole('heading', { name: 'What will be blocked' })).toBeVisible();
      await input.capture.capture(
        input.page,
        'popup',
        'block',
        themeCase,
        input.viewport,
        'full',
        true,
      );
      await input.capture.capture(
        input.page.locator('.rule-summary'),
        'popup',
        'block-summary',
        themeCase,
        input.viewport,
        'focused',
      );

      const ruleScroll: Locator = input.page.getByRole('region', {
        name: 'Session rule details',
      });
      const scrollGeometry: Record<string, number> = await ruleScroll.evaluate(
        (element: HTMLElement): Record<string, number> => {
          element.scrollTop = element.scrollHeight;
          const rect: DOMRect = element.getBoundingClientRect();
          return {
            bottom: rect.bottom,
            clientHeight: element.clientHeight,
            clientWidth: element.clientWidth,
            left: rect.left,
            right: rect.right,
            scrollHeight: element.scrollHeight,
            scrollTop: element.scrollTop,
            scrollWidth: element.scrollWidth,
            top: rect.top,
          };
        },
      );
      await ruleScroll.focus();
      expect(scrollGeometry.scrollTop).toBeGreaterThan(0);
      expect(scrollGeometry.clientWidth).toBe(scrollGeometry.scrollWidth);
      await input.capture.capture(
        input.page,
        'popup',
        'long-list-scrolled-focus',
        themeCase,
        input.viewport,
        'full',
      );
      await input.capture.capture(
        ruleScroll,
        'popup',
        'long-list-scrolled-focus',
        themeCase,
        input.viewport,
        'focused',
      );

      const helpCases: readonly {
        action: 'click' | 'focus' | 'hover';
        button: string;
        state: string;
        text: string;
      }[] = [
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
      ];
      for (const helpCase of helpCases) {
        const button: Locator = input.page.getByRole('button', { name: helpCase.button });
        await button[helpCase.action]();
        const tooltip: Locator = input.page.getByRole('tooltip').filter({
          hasText: helpCase.text,
        });
        await expectWithinViewport(tooltip);
        await input.capture.capture(
          input.page,
          'popup',
          helpCase.state,
          themeCase,
          input.viewport,
          'full',
        );
        await input.capture.capture(
          tooltip,
          'popup',
          helpCase.state,
          themeCase,
          input.viewport,
          'focused',
        );
        if (helpCase.action === 'hover') await input.page.mouse.move(0, 0);
        else await input.page.keyboard.press('Escape');
        await expect(tooltip).toHaveCount(0);
      }

      await input.page.getByRole('radio', { name: /Allow selected sites only/ }).check();
      await input.page.getByLabel('Add an allowed domain').fill('https://user@example.com/private');
      await input.page.getByRole('button', { name: 'Add allowed domain' }).click();
      const invalidDomain: Locator = input.page.getByRole('alert');
      await expect(invalidDomain).toHaveText('Enter a valid domain such as docs.example.com.');
      await expectWithinViewport(invalidDomain);
      await input.capture.capture(
        input.page,
        'popup',
        'allow-invalid',
        themeCase,
        input.viewport,
        'full',
        true,
      );
      await input.capture.capture(
        invalidDomain,
        'popup',
        'allow-invalid',
        themeCase,
        input.viewport,
        'focused',
      );
      const documentGeometry = await input.page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(documentGeometry.scrollWidth).toBe(documentGeometry.clientWidth);
      geometry.push({
        document: documentGeometry,
        ruleScroll: scrollGeometry,
        themeCase: themeCase.id,
        viewport: input.viewport,
      });
    });
  }
  return geometry;
}

interface Task7Rectangle {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

function task7RectanglesIntersect(left: Task7Rectangle, right: Task7Rectangle): boolean {
  return (
    left.left < right.right &&
    left.right > right.left &&
    left.top < right.bottom &&
    left.bottom > right.top
  );
}

async function captureTask7OptionsMatrix(input: {
  capture: Task7CaptureContext;
  extensionId: string;
  page: Page;
  viewports: readonly { height: number; width: number }[];
}): Promise<Record<string, unknown>[]> {
  const geometry: Record<string, unknown>[] = [];
  for (const themeCase of TASK7_THEME_CASES) {
    for (const viewport of input.viewports) {
      await test.step(`options ${themeCase.id} ${String(viewport.width)} category and save states`, async () => {
        await input.page.setViewportSize(viewport);
        await input.page.goto(
          `chrome-extension://${input.extensionId}/src/options/options.html#blocking`,
        );
        await applyTask7ThemeCase(input.page, themeCase, 'options');
        const socialRow: Locator = input.page
          .locator('.cat-row')
          .filter({ hasText: 'Social media' });
        const socialContainer: Locator = socialRow.locator('xpath=..');
        const showSocial: Locator = socialRow.getByRole('button', {
          name: 'Show Social media sites',
        });
        const saveBar: Locator = input.page.locator('.dirty-save-bar');
        await expect(saveBar.getByText('No unsaved changes')).toBeVisible();
        await expect(saveBar).not.toHaveClass(/dirty-save-bar--sticky/);
        const cleanPosition: string = await saveBar.evaluate(
          (element: Element): string => getComputedStyle(element).position,
        );
        expect(cleanPosition).not.toBe('sticky');
        const cleanSaveBarBounds: Task7Rectangle = await saveBar.evaluate(
          (element: Element): Task7Rectangle => {
            const rect: DOMRect = element.getBoundingClientRect();
            return { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top };
          },
        );
        const categoryBounds: Task7Rectangle[] = await input.page
          .locator('.cat-row, .category-state')
          .evaluateAll((elements: Element[]): Task7Rectangle[] =>
            elements.map((element: Element): Task7Rectangle => {
              const rect: DOMRect = element.getBoundingClientRect();
              return { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top };
            }),
          );
        expect(
          categoryBounds.some((bounds: Task7Rectangle): boolean =>
            task7RectanglesIntersect(cleanSaveBarBounds, bounds),
          ),
        ).toBe(false);
        await showSocial.focus();
        await input.capture.capture(
          input.page,
          'options',
          'category-off-focus',
          themeCase,
          viewport,
          'full',
          true,
        );
        await input.capture.capture(
          socialContainer,
          'options',
          'category-off-focus',
          themeCase,
          viewport,
          'focused',
        );

        const categoryStateGaps: number[] = await input.page
          .locator('.category-state')
          .evaluateAll((states: Element[]): number[] =>
            states.map((state: Element): number => {
              const row: Element | null = state.previousElementSibling;
              if (row === null) throw new Error('Category state has no preceding category row.');
              return state.getBoundingClientRect().top - row.getBoundingClientRect().bottom;
            }),
          );
        expect(categoryStateGaps).toHaveLength(7);
        for (const gap of categoryStateGaps) expect(gap).toBeGreaterThanOrEqual(0);

        await showSocial.click();
        await input.page.getByRole('checkbox', { name: 'facebook.com' }).uncheck();
        await socialRow.getByRole('checkbox', { name: 'Social media' }).check();
        await expect(saveBar.getByText('Unsaved changes')).toBeVisible();
        await expect(saveBar).toHaveClass(/dirty-save-bar--sticky/);
        expect(
          await saveBar.evaluate((element: Element): string => getComputedStyle(element).position),
        ).toBe('sticky');
        await socialRow.scrollIntoViewIfNeeded();
        const dirtyBounds: { bar: Task7Rectangle; target: Task7Rectangle } =
          await input.page.evaluate((): { bar: Task7Rectangle; target: Task7Rectangle } => {
            const bar: Element | null = document.querySelector('.dirty-save-bar');
            const target: Element | undefined = [...document.querySelectorAll('.cat-row')].find(
              (row: Element): boolean => row.textContent?.includes('Social media') ?? false,
            );
            if (bar === null || target === undefined)
              throw new Error('Save bar target unavailable.');
            const toBounds = (element: Element): Task7Rectangle => {
              const rect: DOMRect = element.getBoundingClientRect();
              return { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top };
            };
            return { bar: toBounds(bar), target: toBounds(target) };
          });
        expect(task7RectanglesIntersect(dirtyBounds.bar, dirtyBounds.target)).toBe(false);
        await expectWithinViewport(saveBar);
        await input.capture.capture(
          input.page,
          'options',
          'partial-dirty',
          themeCase,
          viewport,
          'full',
          true,
        );
        await input.capture.capture(
          socialRow,
          'options',
          'partial-category',
          themeCase,
          viewport,
          'focused',
        );
        await input.capture.capture(
          saveBar,
          'options',
          'sticky-save',
          themeCase,
          viewport,
          'focused',
        );
        const documentGeometry = await input.page.evaluate(() => ({
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        }));
        expect(documentGeometry.scrollWidth).toBe(documentGeometry.clientWidth);
        geometry.push({
          categoryStateGaps,
          cleanSaveBar: { bounds: cleanSaveBarBounds, position: cleanPosition },
          clientWidth: documentGeometry.clientWidth,
          dirtySaveBar: { ...dirtyBounds.bar, position: 'sticky' },
          dirtyTarget: dirtyBounds.target,
          intersections: { cleanCategories: false, dirtyTarget: false },
          scrollWidth: documentGeometry.scrollWidth,
          themeCase: themeCase.id,
          viewport,
        });
        await saveBar.getByRole('button', { name: 'Discard changes' }).click();
        await expect(saveBar).not.toHaveClass(/dirty-save-bar--sticky/);
      });
    }
  }
  return geometry;
}

const TASK7_SYNC_FILLER_PREFIX: string = '__focusLockTask7EvidenceQuota:';

async function fillTask7SyncQuota(worker: Worker): Promise<{
  bytes: number;
  keys: string[];
  quota: number;
}> {
  return await worker.evaluate(
    async (prefix: string): Promise<{ bytes: number; keys: string[]; quota: number }> => {
      const quota: number = chrome.storage.sync.QUOTA_BYTES;
      const itemQuota: number = chrome.storage.sync.QUOTA_BYTES_PER_ITEM;
      const target: number = quota - 128;
      const keys: string[] = [];
      let bytes: number = await chrome.storage.sync.getBytesInUse(null);
      let index: number = 0;
      while (bytes < target) {
        const key: string = `${prefix}${String(index).padStart(2, '0')}`;
        const remaining: number = target - bytes;
        const valueLength: number = Math.max(1, Math.min(itemQuota - 256, remaining - 64));
        await chrome.storage.sync.set({ [key]: 'q'.repeat(valueLength) });
        keys.push(key);
        bytes = await chrome.storage.sync.getBytesInUse(null);
        index += 1;
      }
      return { bytes, keys, quota };
    },
    TASK7_SYNC_FILLER_PREFIX,
  );
}

async function clearTask7SyncQuota(worker: Worker): Promise<void> {
  await worker.evaluate(async (prefix: string): Promise<void> => {
    const stored: Record<string, unknown> = await chrome.storage.sync.get(null);
    const keys: string[] = Object.keys(stored).filter((key: string): boolean =>
      key.startsWith(prefix),
    );
    if (keys.length > 0) await chrome.storage.sync.remove(keys);
  }, TASK7_SYNC_FILLER_PREFIX);
}

async function prepareTask7PrivacySyncError(input: {
  extensionId: string;
  page: Page;
  policyPage: Page;
  themeCase: Task7ThemeCase;
  viewport: { height: number; width: number };
}): Promise<Locator> {
  expect(
    await sendExtensionRequest(input.policyPage, {
      type: 'setStorageMode',
      storageMode: 'local',
      deleteRemote: false,
    }),
  ).toEqual({ ok: true });
  await input.page.setViewportSize(input.viewport);
  await input.page.goto(`chrome-extension://${input.extensionId}/src/options/options.html#privacy`);
  await applyTask7ThemeCase(input.page, input.themeCase, 'privacy');
  const syncSwitch: Locator = input.page.getByRole('switch', {
    name: 'Sync Focus Lock data across Chrome devices',
  });
  await expect(syncSwitch).not.toBeChecked();
  expect(
    await input.policyPage.evaluate(async (): Promise<boolean> => {
      const settings: unknown = await chrome.runtime.sendMessage({ type: 'getSettings' });
      if (typeof settings !== 'object' || settings === null || Array.isArray(settings))
        return false;
      await chrome.storage.sync.set({ settings });
      return true;
    }),
  ).toBe(true);
  await syncSwitch.click();
  await expect(input.page.getByRole('alert')).toContainText('SyncQuotaError: Cannot sync batch:');
  await expect
    .poll(async (): Promise<unknown> => {
      const setup: unknown = await sendExtensionRequest(input.policyPage, {
        type: 'getSetupState',
      });
      return typeof setup === 'object' && setup !== null
        ? (setup as Record<string, unknown>).syncWriteStatus
        : null;
    })
    .toBe('error');
  expect(await sendExtensionRequest(input.policyPage, { type: 'getSetupState' })).toMatchObject({
    storageError: 'sync-publish-failed',
    storageMode: 'local',
    syncWriteStatus: 'error',
  });
  await input.page.emulateMedia({ colorScheme: input.themeCase.colorScheme });
  await input.page.reload();
  await expect(input.page.locator('html')).toHaveAttribute('data-theme', input.themeCase.theme);
  await expectTask7ResolvedPageTheme(input.page, input.themeCase, 'privacy');
  const syncError: Locator = input.page.getByRole('alert');
  await expect(syncError).toHaveText(
    'Chrome Sync could not save your latest changes. Your local save is safe.',
  );
  return syncError;
}

async function captureTask7PrivacyMatrix(input: {
  capture: Task7CaptureContext;
  extensionId: string;
  page: Page;
  policyPage: Page;
  viewports: readonly { height: number; width: number }[];
}): Promise<Record<string, unknown>[]> {
  const geometry: Record<string, unknown>[] = [];
  for (const themeCase of TASK7_THEME_CASES) {
    for (const viewport of input.viewports) {
      await test.step(`privacy ${themeCase.id} ${String(viewport.width)} error and confirmations`, async () => {
        const syncError: Locator = await prepareTask7PrivacySyncError({
          extensionId: input.extensionId,
          page: input.page,
          policyPage: input.policyPage,
          themeCase,
          viewport,
        });
        await expect(input.page.getByRole('heading', { name: 'Privacy and data' })).toBeVisible();
        await input.capture.capture(
          input.page,
          'privacy',
          'sync-error',
          themeCase,
          viewport,
          'full',
          true,
        );
        await input.capture.capture(
          syncError,
          'privacy',
          'sync-error',
          themeCase,
          viewport,
          'focused',
        );

        const deleteLocal: Locator = input.page.getByRole('button', {
          name: 'Delete local history',
        });
        await deleteLocal.click();
        const localDialog: Locator = input.page.getByRole('dialog', {
          name: 'Delete local history?',
        });
        await expect(localDialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
        await expectWithinViewport(localDialog);
        await input.capture.capture(
          input.page,
          'privacy',
          'local-confirm',
          themeCase,
          viewport,
          'full',
          true,
        );
        await input.capture.capture(
          localDialog,
          'privacy',
          'local-confirm',
          themeCase,
          viewport,
          'focused',
        );
        const localBounds = await localDialog.boundingBox();
        await input.page.keyboard.press('Escape');
        await expect(deleteLocal).toBeFocused();

        const deleteRemote: Locator = input.page.getByRole('button', {
          name: 'Delete remote Sync data',
        });
        await deleteRemote.click();
        const remoteDialog: Locator = input.page.getByRole('dialog', {
          name: 'Delete remote Sync data?',
        });
        await expect(remoteDialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
        await expectWithinViewport(remoteDialog);
        await input.capture.capture(
          input.page,
          'privacy',
          'remote-confirm',
          themeCase,
          viewport,
          'full',
          true,
        );
        await input.capture.capture(
          remoteDialog,
          'privacy',
          'remote-confirm',
          themeCase,
          viewport,
          'focused',
        );
        const remoteBounds = await remoteDialog.boundingBox();
        await input.page.keyboard.press('Escape');
        await expect(deleteRemote).toBeFocused();
        const documentGeometry = await input.page.evaluate(() => ({
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        }));
        expect(documentGeometry.scrollWidth).toBe(documentGeometry.clientWidth);
        geometry.push({
          document: documentGeometry,
          localDialog: localBounds,
          remoteDialog: remoteBounds,
          themeCase: themeCase.id,
          viewport,
        });
      });
    }
  }
  return geometry;
}

async function captureTask7OverlayMatrix(input: {
  capture: Task7CaptureContext;
  controlPage: Page;
  page: Page;
  viewports: readonly { height: number; width: number }[];
}): Promise<Record<string, unknown>[]> {
  const geometry: Record<string, unknown>[] = [];
  for (const themeCase of TASK7_THEME_CASES) {
    for (const viewport of input.viewports) {
      await test.step(`overlay ${themeCase.id} ${String(viewport.width)} provenance`, async () => {
        await input.page.setViewportSize(viewport);
        await input.page.emulateMedia({ colorScheme: themeCase.colorScheme });
        await input.controlPage.bringToFront();
        await applyTask7ThemeCase(input.controlPage, themeCase, 'popup');
        const overlay: Locator = input.page.locator('focus-lock-overlay');
        const handle: ElementHandle<HTMLElement | SVGElement> = await overlayHandle(input.page);
        await expectOverlayTheme(handle, themeCase.theme);
        const resolved: Task7ResolvedTheme = await handle.evaluate(
          (host: HTMLElement | SVGElement): Task7ResolvedTheme => {
            const style: CSSStyleDeclaration = getComputedStyle(host);
            return {
              backgroundColor: style.getPropertyValue('--overlay-bg').trim(),
              color: style.getPropertyValue('--overlay-text').trim(),
              colorScheme: style.colorScheme,
            };
          },
        );
        expect((): void => assertTask7ResolvedTheme(resolved, themeCase, 'overlay')).not.toThrow();
        await input.page.bringToFront();
        await input.capture.capture(
          input.page,
          'overlay',
          'provenance',
          themeCase,
          viewport,
          'full',
          true,
        );
        const clipWidth: number = Math.min(viewport.width, 600);
        const clipHeight: number = Math.min(viewport.height, 560);
        appendTask7Record(
          input.capture.records,
          await captureTask7ClipEvidence(
            input.capture.evidenceDir,
            input.page,
            `task7-production-overlay-${themeCase.id}-${String(viewport.width)}-provenance-focused`,
            task7Metadata(themeCase, viewport, 'overlay', 'provenance', 'focused'),
            {
              height: clipHeight,
              width: clipWidth,
              x: (viewport.width - clipWidth) / 2,
              y: (viewport.height - clipHeight) / 2,
            },
          ),
        );
        const bounds = await overlay.boundingBox();
        expect(bounds).toEqual({ height: viewport.height, width: viewport.width, x: 0, y: 0 });
        geometry.push({ bounds, resolvedTheme: resolved, themeCase: themeCase.id, viewport });
      });
    }
  }
  return geometry;
}

async function captureTask7UnsupportedMatrix(input: {
  capture: Task7CaptureContext;
  page: Page;
  viewport: { height: number; width: number };
}): Promise<void> {
  await input.page.setViewportSize(input.viewport);
  for (const themeCase of TASK7_THEME_CASES) {
    await test.step(`popup ${themeCase.id} ${String(input.viewport.width)} unsupported-tab reason`, async () => {
      await input.page.bringToFront();
      await applyTask7ThemeCase(input.page, themeCase, 'popup');
      const unsupported: Locator = input.page
        .locator('.spend-button')
        .filter({ hasText: 'Unlock this site' });
      await expect(unsupported).toBeDisabled();
      await expect(unsupported).toContainText('Open a regular website to unlock it');
      await expectWithinViewport(unsupported);
      await input.capture.capture(
        input.page,
        'popup',
        'unsupported-tab',
        themeCase,
        input.viewport,
        'full',
        true,
      );
      await input.capture.capture(
        unsupported,
        'popup',
        'unsupported-tab',
        themeCase,
        input.viewport,
        'focused',
      );
    });
  }
}

async function seedTask7Stats(worker: Worker): Promise<void> {
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
        attempts: {
          'blocked.example': 7,
          'research.example.org': 3,
        },
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

async function captureTask7StatsMatrix(input: {
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
        await applyTask7ThemeCase(input.page, themeCase, 'stats');
        await expect(
          input.page.getByRole('heading', { level: 1, name: 'Your focus record' }),
        ).toBeVisible();
        await expect(
          input.page.getByText(/Totals from this machine|Synced totals from this Chrome account/),
        ).toBeVisible();
        await expect(
          input.page.getByRole('heading', { name: 'Focus, last 14 days' }),
        ).toBeVisible();
        await expect(
          input.page.getByRole('heading', { name: 'Top blocked sites, last 30 days' }),
        ).toBeVisible();
        await expect(
          input.page.getByRole('heading', { name: 'Attempts by hour, this machine only' }),
        ).toBeVisible();
        await expect(
          input.page.getByRole('heading', { name: 'Recent sessions on this machine' }),
        ).toBeVisible();
        const seededIntention: Locator = input.page.getByText('Review example.com release notes');
        await expect(seededIntention).toHaveCount(2);
        expect(
          await seededIntention.evaluateAll((elements: Element[]): boolean =>
            elements.some((element: Element): boolean => {
              const style: CSSStyleDeclaration = getComputedStyle(element);
              return style.display !== 'none' && style.visibility !== 'hidden';
            }),
          ),
        ).toBe(true);
        await input.capture.capture(
          input.page,
          'stats',
          'current-language',
          themeCase,
          viewport,
          'full',
          true,
        );
        const chartCard: Locator = input.page.locator('.card').filter({
          has: input.page.getByRole('heading', { name: 'Focus, last 14 days' }),
        });
        await chartCard.scrollIntoViewIfNeeded();
        const tableDisclosure: Locator = chartCard.locator('summary', {
          hasText: 'View as table',
        });
        await tableDisclosure.focus();
        await expect(tableDisclosure).toBeFocused();
        await expect(chartCard).toBeVisible();
        await input.capture.capture(
          chartCard,
          'stats',
          'current-language',
          themeCase,
          viewport,
          'focused',
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
        geometry.push({ metrics, themeCase: themeCase.id, viewport });
      });
    }
  }
  return geometry;
}

async function configureTask7Gate(page: Page, requireTypedPhrase: boolean): Promise<void> {
  const settings: Settings = await sendExtensionRequest(page, { type: 'getSettings' });
  expect(
    await sendExtensionRequest(page, {
      type: 'updateSettings',
      settings: {
        ...settings,
        gate: { delayMs: 30_000, requireTypedPhrase },
      },
    }),
  ).toEqual({ ok: true });
}

async function captureTask7GateState(input: {
  capture: Task7CaptureContext;
  page: Page;
  state: 'force-end-removed' | 'typed-gate' | 'untyped-gate';
  viewports: readonly { height: number; width: number }[];
}): Promise<Record<string, unknown>[]> {
  const geometry: Record<string, unknown>[] = [];
  const panel: Locator = input.page.locator('.gate-panel');
  const focusTarget: Locator =
    input.state === 'typed-gate'
      ? panel.locator('input[type="text"]')
      : input.page.getByRole('button', { name: 'Never mind, back to work' });
  for (const themeCase of TASK7_THEME_CASES) {
    for (const viewport of input.viewports) {
      await test.step(`gate ${input.state} ${themeCase.id} ${String(viewport.width)}`, async () => {
        await input.page.setViewportSize(viewport);
        await applyTask7ThemeCase(input.page, themeCase, 'gate');
        await expect(panel).toBeVisible();
        await expect(panel).toContainText('A moment to decide');
        await expect(panel.getByRole('button', { name: 'End the session' })).toBeVisible();
        await expect(input.page.getByText('Ignore timeout and end anyway')).toHaveCount(0);
        await focusTarget.focus();
        await expectWithinViewport(panel);
        await input.capture.capture(
          input.page,
          'gate',
          input.state,
          themeCase,
          viewport,
          'full',
          true,
        );
        await input.capture.capture(panel, 'gate', input.state, themeCase, viewport, 'focused');
        const bounds = await panel.boundingBox();
        const documentGeometry = await input.page.evaluate(() => ({
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        }));
        expect(documentGeometry.scrollWidth).toBe(documentGeometry.clientWidth);
        geometry.push({
          bounds,
          document: documentGeometry,
          state: input.state,
          themeCase: themeCase.id,
          viewport,
        });
      });
    }
  }
  return geometry;
}

async function captureTask7StoppedOverlayMatrix(input: {
  capture: Task7CaptureContext;
  controlPage: Page;
  page: Page;
  viewports: readonly { height: number; width: number }[];
}): Promise<Record<string, unknown>[]> {
  const geometry: Record<string, unknown>[] = [];
  for (const themeCase of TASK7_THEME_CASES) {
    for (const viewport of input.viewports) {
      await test.step(`stopped overlay ${themeCase.id} ${String(viewport.width)} current document-stop language`, async () => {
        await input.page.setViewportSize(viewport);
        await input.page.emulateMedia({ colorScheme: themeCase.colorScheme });
        await input.controlPage.bringToFront();
        await applyTask7ThemeCase(input.controlPage, themeCase, 'popup');
        const handle: ElementHandle<HTMLElement | SVGElement> = await overlayHandle(input.page);
        await expectOverlayTheme(handle, themeCase.theme);
        const resolved: Task7ResolvedTheme = await handle.evaluate(
          (host: HTMLElement | SVGElement): Task7ResolvedTheme => {
            const style: CSSStyleDeclaration = getComputedStyle(host);
            return {
              backgroundColor: style.getPropertyValue('--overlay-bg').trim(),
              color: style.getPropertyValue('--overlay-text').trim(),
              colorScheme: style.colorScheme,
            };
          },
        );
        expect((): void =>
          assertTask7ResolvedTheme(resolved, themeCase, 'stopped-overlay'),
        ).not.toThrow();
        await expectClosedOverlayText(
          input.page.context(),
          input.page,
          'This page did not load. It will load by itself when the session ends.',
        );
        await input.page.bringToFront();
        await input.capture.capture(
          input.page,
          'stopped-overlay',
          'stopped-document',
          themeCase,
          viewport,
          'full',
        );
        const clipWidth: number = Math.min(viewport.width, 600);
        const clipHeight: number = Math.min(viewport.height, 560);
        appendTask7Record(
          input.capture.records,
          await captureTask7ClipEvidence(
            input.capture.evidenceDir,
            input.page,
            `task7-production-stopped-overlay-${themeCase.id}-${String(viewport.width)}-stopped-document-focused`,
            task7Metadata(themeCase, viewport, 'stopped-overlay', 'stopped-document', 'focused'),
            {
              height: clipHeight,
              width: clipWidth,
              x: (viewport.width - clipWidth) / 2,
              y: (viewport.height - clipHeight) / 2,
            },
          ),
        );
        const bounds = await input.page.locator('focus-lock-overlay').boundingBox();
        expect(bounds).toEqual({ height: viewport.height, width: viewport.width, x: 0, y: 0 });
        geometry.push({ bounds, resolvedTheme: resolved, themeCase: themeCase.id, viewport });
      });
    }
  }
  return geometry;
}

test('Task 7 production evidence matrix is reproducible', async ({
  context,
  extPage,
  extensionId,
  siteUrl,
  worker,
}, testInfo) => {
  test.setTimeout(360_000);
  const persistentEvidenceDir: string | undefined = process.env.TASK7_EVIDENCE_DIR;
  const evidenceDir: string =
    persistentEvidenceDir ?? testInfo.outputPath('task7-production-evidence');
  await mkdir(evidenceDir, { recursive: true });
  const capture: Task7CaptureContext = createTask7CaptureContext(evidenceDir);
  const diagnostics: BrowserDiagnostics = browserDiagnosticsFor(context);
  const repositoryRoot: string = path.resolve(import.meta.dirname, '../..');
  const repositoryDist: string = path.join(repositoryRoot, 'dist');
  const explicitDist: string | null =
    persistentEvidenceDir === undefined ? null : (process.env.FOCUS_LOCK_E2E_DIST ?? null);
  let provenanceBefore: Task7BuildProvenance | null = null;
  if (persistentEvidenceDir !== undefined) {
    if (explicitDist === null) {
      throw new Error(
        'Persistent Task 7 evidence requires an explicit isolated FOCUS_LOCK_E2E_DIST.',
      );
    }
    const initial = await readTask7BuildProvenance(repositoryRoot, explicitDist);
    provenanceBefore = initial.observed;
    assertTask7BuildProvenance({
      after: initial.observed,
      before: initial.observed,
      currentApplicationSourceTreeSha256: initial.currentApplicationSourceTreeSha256,
      currentGitCommit: initial.currentGitCommit,
      explicitDist,
      repositoryDist,
    });
  }

  const lists: ListsConfig = await sendExtensionRequest(extPage, { type: 'getLists' });
  const longLists: ListsConfig = task7LongLists(lists);
  expect(await sendExtensionRequest(extPage, { type: 'updateLists', lists: longLists })).toEqual({
    ok: true,
  });
  const popupViewport = { height: 760, width: 340 };
  const pageViewports: readonly { height: number; width: number }[] = [
    { height: 667, width: 375 },
    { height: 800, width: 768 },
    { height: 800, width: 1280 },
  ];
  const popupGeometry: Record<string, unknown>[] = await captureTask7PopupMatrix({
    capture,
    page: extPage,
    viewport: popupViewport,
  });
  expect(await sendExtensionRequest(extPage, { type: 'updateLists', lists })).toEqual({
    ok: true,
  });

  const optionsPage: Page = await context.newPage();
  const statsPage: Page = await context.newPage();
  let blockedPage: Page | null = null;
  let stoppedPage: Page | null = null;
  let syncFiller: { bytes: number; keys: string[]; quota: number } | null = null;
  const gateGeometry: Record<string, unknown>[] = [];
  let optionsGeometry: Record<string, unknown>[] = [];
  let privacyGeometry: Record<string, unknown>[] = [];
  let statsGeometry: Record<string, unknown>[] = [];
  let overlayGeometry: Record<string, unknown>[] = [];
  let stoppedOverlayGeometry: Record<string, unknown>[] = [];
  try {
    optionsGeometry = await captureTask7OptionsMatrix({
      capture,
      extensionId,
      page: optionsPage,
      viewports: pageViewports,
    });
    await seedTask7Stats(worker);
    statsGeometry = await captureTask7StatsMatrix({
      capture,
      extensionId,
      page: statsPage,
      viewports: pageViewports,
    });
    expect(
      await sendExtensionRequest(extPage, {
        type: 'setStorageMode',
        storageMode: 'local',
        deleteRemote: false,
      }),
    ).toEqual({ ok: true });
    expect(
      await extPage.evaluate(
        async (): Promise<unknown> => await chrome.runtime.sendMessage({ type: 'getSetupState' }),
      ),
    ).toMatchObject({ storageMode: 'local', syncWriteStatus: 'idle' });
    expect(await sendExtensionRequest(extPage, { type: 'updateLists', lists: longLists })).toEqual({
      ok: true,
    });
    syncFiller = await fillTask7SyncQuota(worker);
    expect(syncFiller.bytes).toBeGreaterThanOrEqual(syncFiller.quota - 128);
    privacyGeometry = await captureTask7PrivacyMatrix({
      capture,
      extensionId,
      page: optionsPage,
      policyPage: extPage,
      viewports: pageViewports,
    });

    blockedPage = await context.newPage();
    await blockedPage.goto(siteUrl('/plain.html'));
    await configureTask7Gate(extPage, true);
    await extPage.bringToFront();
    await startTestSession(extPage, { durationMin: 10, strictness: 'friction' });
    await expect(blockedPage.locator('focus-lock-overlay')).toBeAttached();
    await expectClosedOverlayText(
      context,
      blockedPage,
      'Blocked by your block list: blocked.example',
    );
    expect(await sendExtensionRequest(extPage, { type: 'requestSessionEnd' })).toEqual({
      ok: true,
    });
    gateGeometry.push(
      ...(await captureTask7GateState({
        capture,
        page: extPage,
        state: 'typed-gate',
        viewports: pageViewports,
      })),
    );
    expect(await sendExtensionRequest(extPage, { type: 'abandonGate' })).toEqual({ ok: true });
    await configureTask7Gate(extPage, false);
    expect(await sendExtensionRequest(extPage, { type: 'requestSessionEnd' })).toEqual({
      ok: true,
    });
    gateGeometry.push(
      ...(await captureTask7GateState({
        capture,
        page: extPage,
        state: 'untyped-gate',
        viewports: pageViewports,
      })),
    );
    gateGeometry.push(
      ...(await captureTask7GateState({
        capture,
        page: extPage,
        state: 'force-end-removed',
        viewports: pageViewports,
      })),
    );
    expect(await sendExtensionRequest(extPage, { type: 'abandonGate' })).toEqual({ ok: true });
    overlayGeometry = await captureTask7OverlayMatrix({
      capture,
      controlPage: extPage,
      page: blockedPage,
      viewports: pageViewports,
    });
    stoppedPage = await context.newPage();
    await stoppedPage.goto(siteUrl('/plain.html'), { waitUntil: 'commit' });
    await expect(stoppedPage.locator('#marker')).toHaveCount(0);
    stoppedOverlayGeometry = await captureTask7StoppedOverlayMatrix({
      capture,
      controlPage: extPage,
      page: stoppedPage,
      viewports: pageViewports,
    });
    await captureTask7UnsupportedMatrix({ capture, page: extPage, viewport: popupViewport });
  } finally {
    await clearTask7SyncQuota(worker);
    await Promise.all([
      optionsPage.close(),
      statsPage.close(),
      ...(blockedPage === null ? [] : [blockedPage.close()]),
      ...(stoppedPage === null ? [] : [stoppedPage.close()]),
    ]);
    await sendExtensionRequest(extPage, { type: 'updateLists', lists });
  }

  expect((): void => assertTask7CurrentSurfaceCoverage(capture.records)).not.toThrow();
  expect(capture.records).toHaveLength(332);
  let provenanceAfter: Task7BuildProvenance | null = null;
  if (persistentEvidenceDir !== undefined && explicitDist !== null && provenanceBefore !== null) {
    const final = await readTask7BuildProvenance(repositoryRoot, explicitDist);
    provenanceAfter = final.observed;
    assertTask7BuildProvenance({
      after: final.observed,
      before: provenanceBefore,
      currentApplicationSourceTreeSha256: final.currentApplicationSourceTreeSha256,
      currentGitCommit: final.currentGitCommit,
      explicitDist,
      repositoryDist,
    });
  }
  await context.close();
  expect((): void => assertNoUnexpectedBrowserDiagnostics(diagnostics)).not.toThrow();
  const diagnosticCounts: Record<keyof BrowserDiagnostics, number> = {
    blockedRequests: diagnostics.blockedRequests.length,
    consoleErrors: diagnostics.consoleErrors.length,
    intentionalWorkerStopMessages: diagnostics.intentionalWorkerStopMessages.length,
    pageErrors: diagnostics.pageErrors.length,
    requestErrors: diagnostics.requestErrors.length,
    shutdownWorkerMessages: diagnostics.shutdownWorkerMessages.length,
    workerErrors: diagnostics.workerErrors.length,
  };
  await writeFile(
    path.join(evidenceDir, 'production-run-report.json'),
    `${JSON.stringify(
      {
        buildSource: 'production',
        diagnosticBoundary: {
          contextClosedBeforeAudit: true,
          fixtureContextTeardownAsserted: true,
          ownedPagesClosedBeforeAudit: true,
        },
        diagnosticCounts,
        extensionId,
        geometryAssertions: {
          gate: gateGeometry,
          options: optionsGeometry,
          overlay: overlayGeometry,
          popup: popupGeometry,
          privacy: privacyGeometry,
          stats: statsGeometry,
          stoppedOverlay: stoppedOverlayGeometry,
        },
        inventory: capture.records,
        matrix: { pageViewports, popupViewport, themeCases: TASK7_THEME_CASES },
        persistentEvidence: persistentEvidenceDir !== undefined,
        provenance: { after: provenanceAfter, before: provenanceBefore },
        syncQuotaFiller: syncFiller,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
});
test('completion clears browser effects and reaches sound and notification APIs', async ({
  context,
  extPage,
  siteUrl,
  worker,
}) => {
  const existingPage: Page = await context.newPage();
  await existingPage.goto(siteUrl('/plain.html'));
  await existingPage.locator('#keep').fill('completion keeps state');
  await existingPage.evaluate((): void => {
    (
      globalThis as typeof globalThis & { __focusLockCompletionAlive?: boolean }
    ).__focusLockCompletionAlive = true;
  });
  const scrollY: number = await existingPage.evaluate((): number => {
    window.scrollTo(0, 900);
    return window.scrollY;
  });
  expect(scrollY).toBeGreaterThan(0);
  await clearNotifications(worker);
  await observeSoundMessages(extPage);

  const settings: Settings = await sendExtensionRequest(extPage, { type: 'getSettings' });
  const settingsAck = await sendExtensionRequest(extPage, {
    type: 'updateSettings',
    settings: {
      ...settings,
      sounds: {
        ...settings.sounds,
        masterVolume: 0.1,
        sessionComplete: true,
        breakStart: true,
        breakEnd: true,
      },
    },
  });
  expect(settingsAck).toEqual({ ok: true });

  await startTestSession(extPage, {
    durationMin: 0.6,
    cycling: {
      focusMin: 0.25,
      shortBreakMin: 0.05,
      longBreakMin: 0.05,
      longEvery: 4,
    },
  });
  await expect(existingPage.locator('focus-lock-overlay')).toBeAttached();
  const stoppedPage: Page = await context.newPage();
  await stoppedPage.goto(siteUrl('/plain.html'), { waitUntil: 'commit' });
  await expect(stoppedPage.locator('focus-lock-overlay')).toBeAttached();
  await expect(stoppedPage.locator('#marker')).toHaveCount(0);
  await expect
    .poll(
      async (): Promise<string> =>
        await worker.evaluate(async (): Promise<string> => await chrome.action.getBadgeText({})),
    )
    .not.toBe('');

  await expect
    .poll(
      async (): Promise<SessionSnapshot['phase']> => {
        const snapshot: SessionSnapshot = await sendExtensionRequest(extPage, {
          type: 'getSnapshot',
        });
        return snapshot.phase;
      },
      { timeout: 50_000 },
    )
    .toBe('idle');
  await expect(existingPage.locator('focus-lock-overlay')).toHaveCount(0);
  await expect(existingPage.locator('#keep')).toHaveValue('completion keeps state');
  expect(
    await existingPage.evaluate(
      (): boolean =>
        (globalThis as typeof globalThis & { __focusLockCompletionAlive?: boolean })
          .__focusLockCompletionAlive === true,
    ),
  ).toBe(true);
  expect(await existingPage.evaluate((): number => window.scrollY)).toBe(scrollY);
  await expect(stoppedPage.locator('#marker')).toHaveText('plain page');
  await expect(stoppedPage).toHaveTitle('Plain test page');
  await expect
    .poll(
      async (): Promise<string> =>
        await worker.evaluate(async (): Promise<string> => await chrome.action.getBadgeText({})),
    )
    .toBe('');

  await expect
    .poll(
      async (): Promise<ObservedSound['sound'][]> =>
        (await observedSounds(extPage)).map(
          (message: ObservedSound): ObservedSound['sound'] => message.sound,
        ),
    )
    .toEqual(expect.arrayContaining(['breakStart', 'breakEnd', 'sessionComplete']));
  expect(await hasOffscreenAudioDocument(worker)).toBe(true);
  await expect
    .poll(async (): Promise<string[]> => await notificationIds(worker))
    .not.toHaveLength(0);
});

test('hard-session Options rejects weakening and saves a stronger rule', async ({
  context,
  extPage,
  extensionId,
}) => {
  await startTestSession(extPage, { durationMin: 0.3, strictness: 'hard' });
  const optionsPage: Page = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await expect
    .poll(async (): Promise<string> => {
      const text: string | null = await optionsPage.locator('.hard-banner').textContent();
      return text?.trim() ?? '';
    })
    .toMatch(/^Changes that weaken blocking will be rejected until \d{2}:\d{2}\.$/);

  await optionsPage.getByRole('button', { name: 'Remove blocked.example' }).click();
  await optionsPage.getByRole('button', { name: 'Save changes' }).click();
  await expect(optionsPage.getByRole('alert')).toContainText(
    /hard session.*removing blocked sites.*unlocks when it ends/i,
  );

  await optionsPage.reload();
  const customEditor = optionsPage.locator('.rules-editor').filter({ hasText: 'Custom blacklist' });
  await customEditor.getByLabel('Pattern').fill('extra.example');
  await customEditor.getByRole('button', { name: 'Add rule' }).click();
  await optionsPage.getByRole('button', { name: 'Save changes' }).click();
  await expect(optionsPage.locator('.dirty-save-state')).toHaveText('No unsaved changes');

  const lists: ListsConfig = await sendExtensionRequest(extPage, { type: 'getLists' });
  expect(lists.custom).toEqual([
    { kind: 'host', pattern: 'blocked.example' },
    { kind: 'host', pattern: 'extra.example' },
  ]);
});

test('theme cycle persists across extension pages and live overlay hosts without reloads', async ({
  context,
  extPage,
  extensionId,
  siteUrl,
}) => {
  await expectPageTheme(extPage, 'auto');
  let popupNavigations: number = 0;
  extPage.on('framenavigated', (frame: Frame): void => {
    if (frame === extPage.mainFrame()) popupNavigations += 1;
  });

  const normalPage: Page = await context.newPage();
  await normalPage.goto(siteUrl('/plain.html'));
  await normalPage.locator('#keep').fill('theme keeps page state');
  await startTestSession(extPage, { durationMin: 0.8 });
  const normalOverlay: ElementHandle<HTMLElement | SVGElement> = await overlayHandle(normalPage);
  let normalNavigations: number = 0;
  normalPage.on('framenavigated', (frame: Frame): void => {
    if (frame === normalPage.mainFrame()) normalNavigations += 1;
  });

  const stoppedPage: Page = await context.newPage();
  await stoppedPage.goto(siteUrl('/plain.html'), { waitUntil: 'commit' });
  await expect(stoppedPage.locator('#marker')).toHaveCount(0);
  await expect(stoppedPage).toHaveTitle('Locked - Focus Lock');
  const stoppedOverlay: ElementHandle<HTMLElement | SVGElement> = await overlayHandle(stoppedPage);
  let stoppedNavigations: number = 0;
  stoppedPage.on('framenavigated', (frame: Frame): void => {
    if (frame === stoppedPage.mainFrame()) stoppedNavigations += 1;
  });

  await expectOverlayTheme(normalOverlay, 'auto');
  await expectOverlayTheme(stoppedOverlay, 'auto');

  await extPage.getByRole('button', { name: 'Theme: Auto. Switch to Light' }).click();
  await expectPageTheme(extPage, 'light');
  await expectOverlayTheme(normalOverlay, 'light');
  await expectOverlayTheme(stoppedOverlay, 'light');

  const optionsPage: Page = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await expectPageTheme(optionsPage, 'light');
  let optionsNavigations: number = 0;
  optionsPage.on('framenavigated', (frame: Frame): void => {
    if (frame === optionsPage.mainFrame()) optionsNavigations += 1;
  });

  await optionsPage.getByRole('button', { name: 'Theme: Light. Switch to Dark' }).click();
  await expectPageTheme(optionsPage, 'dark');
  await expectPageTheme(extPage, 'dark');
  await expectOverlayTheme(normalOverlay, 'dark');
  await expectOverlayTheme(stoppedOverlay, 'dark');

  const statsPage: Page = await context.newPage();
  await statsPage.goto(`chrome-extension://${extensionId}/src/stats/stats.html`);
  await expectPageTheme(statsPage, 'dark');
  let statsNavigations: number = 0;
  statsPage.on('framenavigated', (frame: Frame): void => {
    if (frame === statsPage.mainFrame()) statsNavigations += 1;
  });

  await statsPage.getByRole('button', { name: 'Theme: Dark. Switch to Auto' }).click();
  await expectPageTheme(statsPage, 'auto');
  await expectPageTheme(optionsPage, 'auto');
  await expectPageTheme(extPage, 'auto');
  await expectOverlayTheme(normalOverlay, 'auto');
  await expectOverlayTheme(stoppedOverlay, 'auto');

  await expect(normalPage.locator('#keep')).toHaveValue('theme keeps page state');
  expect(popupNavigations).toBe(0);
  expect(normalNavigations).toBe(0);
  expect(stoppedNavigations).toBe(0);
  expect(optionsNavigations).toBe(0);
  expect(statsNavigations).toBe(0);
});

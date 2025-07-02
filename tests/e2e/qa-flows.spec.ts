import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  BrowserContext,
  CDPSession,
  ElementHandle,
  Frame,
  Locator,
  Page,
} from '@playwright/test';
import type { ListsConfig, SessionSnapshot, Settings, ThemeMode } from '../../src/shared/types';
import {
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

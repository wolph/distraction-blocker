import type { ElementHandle, Frame, Page } from '@playwright/test';
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
  await optionsPage.getByRole('button', { name: 'Save lists and categories' }).click();
  await expect(optionsPage.getByRole('alert')).toContainText(
    /hard session.*removing blocked sites.*unlocks when it ends/i,
  );

  await optionsPage.reload();
  const customEditor = optionsPage.locator('.rules-editor').filter({ hasText: 'Custom blacklist' });
  await customEditor.getByLabel('Pattern').fill('extra.example');
  await customEditor.getByRole('button', { name: 'Add rule' }).click();
  await optionsPage.getByRole('button', { name: 'Save lists and categories' }).click();
  await expect(optionsPage.locator('.save-ok')).toHaveText('Saved.');

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

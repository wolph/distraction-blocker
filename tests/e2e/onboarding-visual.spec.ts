import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { DEFAULT_LISTS, DEFAULT_SETTINGS } from '../../src/shared/constants';
import { LOCAL_ONBOARDING_DRAFT, LOCAL_SETTINGS } from '../../src/shared/storage-keys';
import type {
  OnboardingDraft,
  OnboardingStep,
  ThemeMode,
  WebsiteAccessChoice,
} from '../../src/shared/types';
import {
  assertNoUnexpectedBrowserDiagnostics,
  type BrowserDiagnostics,
} from './browser-diagnostics';
import { expect, type FreshInstallLaunch, sendExtensionRequest, test } from './fixtures';

test.setTimeout(300_000);

interface ThemeCase {
  expectedBackground: string;
  media: 'light' | 'dark';
  mode: ThemeMode;
  slug: string;
}

interface ViewportCase {
  height: number;
  width: number;
}

interface VisualState {
  choice: WebsiteAccessChoice;
  focusSelector: string;
  name: string;
  step: OnboardingStep;
  syncEnabled: boolean;
}

const THEMES: readonly ThemeCase[] = [
  {
    slug: 'auto-light',
    mode: 'auto',
    media: 'light',
    expectedBackground: 'rgb(242, 247, 243)',
  },
  {
    slug: 'auto-dark',
    mode: 'auto',
    media: 'dark',
    expectedBackground: 'rgb(17, 26, 20)',
  },
  {
    slug: 'light-dark-media',
    mode: 'light',
    media: 'dark',
    expectedBackground: 'rgb(242, 247, 243)',
  },
  {
    slug: 'dark-light-media',
    mode: 'dark',
    media: 'light',
    expectedBackground: 'rgb(17, 26, 20)',
  },
];

const VIEWPORTS: readonly ViewportCase[] = [
  { width: 375, height: 844 },
  { width: 768, height: 900 },
  { width: 1280, height: 900 },
];

const VISUAL_STATES: readonly VisualState[] = [
  {
    name: 'step-1-expanded-gaming',
    step: 1,
    choice: 'pending',
    syncEnabled: true,
    focusSelector: '.category-domains-scroll',
  },
  {
    name: 'step-2-permission-explanation',
    step: 2,
    choice: 'pending',
    syncEnabled: true,
    focusSelector: '.button-row',
  },
  {
    name: 'step-2-denied-retry',
    step: 2,
    choice: 'denied',
    syncEnabled: true,
    focusSelector: '[role="status"]',
  },
  {
    name: 'step-2-registration-error',
    step: 2,
    choice: 'registration-error',
    syncEnabled: true,
    focusSelector: '[role="status"]',
  },
  {
    name: 'step-3-sync-on',
    step: 3,
    choice: 'deferred',
    syncEnabled: true,
    focusSelector: '.sync-choice',
  },
  {
    name: 'step-3-sync-off',
    step: 3,
    choice: 'deferred',
    syncEnabled: false,
    focusSelector: '.sync-choice',
  },
  {
    name: 'step-3-pending-completion',
    step: 3,
    choice: 'deferred',
    syncEnabled: true,
    focusSelector: '.primary-button',
  },
];

function draftFor(state: VisualState, theme: ThemeMode): OnboardingDraft {
  return {
    version: 1,
    revision: 41,
    step: state.step,
    settings: { ...structuredClone(DEFAULT_SETTINGS), theme },
    lists: structuredClone(DEFAULT_LISTS),
    websiteAccessChoice: state.choice,
    syncEnabled: state.syncEnabled,
  };
}

async function seedDraft(
  launch: FreshInstallLaunch,
  state: VisualState,
  theme: ThemeMode,
): Promise<void> {
  await launch.worker.evaluate(
    async ({ draft, settingsKey, draftKey }): Promise<void> => {
      await chrome.storage.local.set({
        [draftKey]: draft,
        [settingsKey]: draft.settings,
      });
    },
    {
      draft: draftFor(state, theme),
      settingsKey: LOCAL_SETTINGS,
      draftKey: LOCAL_ONBOARDING_DRAFT,
    },
  );
  const updated = await sendExtensionRequest(launch.extPage, { type: 'updateTheme', theme });
  if (!updated.ok) throw new Error(updated.error);
}

async function seedInvalidDraft(launch: FreshInstallLaunch, theme: ThemeMode): Promise<void> {
  await launch.worker.evaluate(
    async ({ settings, settingsKey, draftKey }): Promise<void> => {
      await chrome.storage.local.set({
        [draftKey]: { version: 99, step: 'lost' },
        [settingsKey]: settings,
      });
    },
    {
      settings: { ...structuredClone(DEFAULT_SETTINGS), theme },
      settingsKey: LOCAL_SETTINGS,
      draftKey: LOCAL_ONBOARDING_DRAFT,
    },
  );
  const updated = await sendExtensionRequest(launch.extPage, { type: 'updateTheme', theme });
  if (!updated.ok) throw new Error(updated.error);
}

async function holdCompletion(page: Page): Promise<void> {
  await page.evaluate((): void => {
    const sendMessage: typeof chrome.runtime.sendMessage = chrome.runtime.sendMessage.bind(
      chrome.runtime,
    );
    Object.defineProperty(chrome.runtime, 'sendMessage', {
      configurable: true,
      value: async (...args: Parameters<typeof chrome.runtime.sendMessage>): Promise<unknown> => {
        const request: unknown = args[0];
        if (
          typeof request === 'object' &&
          request !== null &&
          'type' in request &&
          request.type === 'completeOnboarding'
        ) {
          return await new Promise<never>(() => undefined);
        }
        return await sendMessage(...args);
      },
    });
  });
  const button: Locator = page.getByRole('button', { name: 'Finish setup with sync enabled' });
  await button.click();
  await expect(button).toBeDisabled();
}

async function assertThemeAndLayout(
  page: Page,
  theme: ThemeCase,
  viewport: ViewportCase,
): Promise<void> {
  await expect
    .poll(async (): Promise<string | null> => await page.locator('html').getAttribute('data-theme'))
    .toBe(theme.mode);
  const metrics: {
    cardLeft: number;
    cardRight: number;
    clientWidth: number;
    pageBackground: string;
    scrollWidth: number;
  } = await page.evaluate(() => {
    const card: HTMLElement | null = document.querySelector<HTMLElement>('.onboarding-card');
    if (card === null) throw new Error('onboarding card is missing');
    const bounds: DOMRect = card.getBoundingClientRect();
    return {
      cardLeft: bounds.left,
      cardRight: bounds.right,
      clientWidth: document.documentElement.clientWidth,
      pageBackground: getComputedStyle(document.body).backgroundColor,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  expect(metrics.pageBackground).toBe(theme.expectedBackground);
  expect(metrics.clientWidth).toBe(viewport.width);
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
  expect(metrics.cardLeft).toBeGreaterThanOrEqual(0);
  expect(metrics.cardRight).toBeLessThanOrEqual(metrics.clientWidth);
}

async function captureState(
  page: Page,
  testInfo: TestInfo,
  evidenceDir: string,
  state: VisualState,
  theme: ThemeCase,
  viewport: ViewportCase,
): Promise<void> {
  const stem: string = `${state.name}-${theme.slug}-${viewport.width}`;
  const heading: Locator = page.getByRole('heading', { level: 1 });
  await heading.focus();
  await page.screenshot({
    path: path.join(evidenceDir, `${stem}-full.png`),
    fullPage: true,
    animations: 'disabled',
  });
  await heading.screenshot({
    path: path.join(evidenceDir, `${stem}-heading.png`),
    animations: 'disabled',
  });
  const component: Locator = page.locator(state.focusSelector).first();
  await expect(component).toBeVisible();
  await component.screenshot({
    path: path.join(evidenceDir, `${stem}-component.png`),
    animations: 'disabled',
  });
  await testInfo.attach(`${stem}-viewport-edges`, {
    body: Buffer.from(
      JSON.stringify(
        await page.evaluate(() => ({
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        })),
      ),
    ),
    contentType: 'application/json',
  });
}

test('production onboarding states fit every viewport and theme', async ({
  freshInstallExtension,
}, testInfo: TestInfo) => {
  const launch: FreshInstallLaunch = await freshInstallExtension.launch();
  const page: Page = launch.onboardingPage;
  const evidenceDir: string = testInfo.outputPath('onboarding-visual-evidence');
  await mkdir(evidenceDir, { recursive: true });

  for (const state of VISUAL_STATES) {
    for (const theme of THEMES) {
      await page.emulateMedia({ colorScheme: theme.media });
      for (const viewport of VIEWPORTS) {
        await page.setViewportSize(viewport);
        await seedDraft(launch, state, theme.mode);
        await page.reload();
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        if (state.name === 'step-1-expanded-gaming') {
          await page.getByRole('button', { name: 'Show Gaming sites' }).click();
          const longestBundledDomain: Locator = page.getByText('store.steampowered.com', {
            exact: true,
          });
          await expect(longestBundledDomain).toBeVisible();
          const domainMetrics: { right: number; width: number } =
            await longestBundledDomain.evaluate(
              (element: HTMLElement): { right: number; width: number } => {
                const bounds: DOMRect = element.getBoundingClientRect();
                return { right: bounds.right, width: bounds.width };
              },
            );
          expect(domainMetrics.right).toBeLessThanOrEqual(viewport.width);
          expect(domainMetrics.width).toBeGreaterThan(0);
        }
        if (state.name === 'step-3-pending-completion') await holdCompletion(page);
        if (state.name === 'step-2-permission-explanation') {
          await expect(page.getByText('read and change data on all websites')).toBeVisible();
          await expect(page.getByRole('button', { name: 'Enable website blocking' })).toBeVisible();
          await expect(page.getByRole('button', { name: 'Not now' })).toBeVisible();
        }
        if (state.name === 'step-2-denied-retry') {
          await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
        }
        if (state.step === 3) {
          await expect(
            page.getByRole('switch', { name: 'Sync across Chrome devices' }),
          ).toBeChecked({
            checked: state.syncEnabled,
          });
        }
        await assertThemeAndLayout(page, theme, viewport);
        await captureState(page, testInfo, evidenceDir, state, theme, viewport);
      }
    }
  }

  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme.media });
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await seedInvalidDraft(launch, theme.mode);
      await page.reload();
      await expect(page.getByRole('status')).toContainText(
        'Your saved setup progress could not be restored.',
      );
      const recovery: VisualState = {
        name: 'step-1-load-recovery',
        step: 1,
        choice: 'pending',
        syncEnabled: true,
        focusSelector: '.recovery-notice',
      };
      await assertThemeAndLayout(page, theme, viewport);
      await captureState(page, testInfo, evidenceDir, recovery, theme, viewport);
    }
  }

  await page.addInitScript((): void => {
    const sendMessage: typeof chrome.runtime.sendMessage = chrome.runtime.sendMessage.bind(
      chrome.runtime,
    );
    let failed: boolean = false;
    Object.defineProperty(chrome.runtime, 'sendMessage', {
      configurable: true,
      value: async (...args: Parameters<typeof chrome.runtime.sendMessage>): Promise<unknown> => {
        const request: unknown = args[0];
        if (
          !failed &&
          typeof request === 'object' &&
          request !== null &&
          'type' in request &&
          request.type === 'getSetupState'
        ) {
          failed = true;
          throw new Error('seeded load failure');
        }
        return await sendMessage(...args);
      },
    });
  });
  const loadErrorState: VisualState = {
    name: 'load-error-retry',
    step: 1,
    choice: 'pending',
    syncEnabled: true,
    focusSelector: '[role="alert"]',
  };
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme.media });
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await seedDraft(launch, loadErrorState, theme.mode);
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Setup unavailable' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
      await assertThemeAndLayout(page, theme, viewport);
      await captureState(page, testInfo, evidenceDir, loadErrorState, theme, viewport);
      await page.getByRole('button', { name: 'Retry' }).click();
      await expect(
        page.getByRole('heading', { name: 'Choose your starting block list' }),
      ).toBeVisible();
    }
  }

  const diagnostics: BrowserDiagnostics = freshInstallExtension.diagnostics;
  expect((): void => assertNoUnexpectedBrowserDiagnostics(diagnostics)).not.toThrow();
});

import type { Locator, Page } from '@playwright/test';
import type { Settings } from '../../src/shared/types';
import { expect, sendExtensionRequest, test } from './fixtures';
import type { Task7ThemeCase } from './task7-evidence';
import { TASK7_THEME_CASES, type Task7CaptureContext } from './task7-matrix-support';

export type ApplyTask7GateTheme = (page: Page, themeCase: Task7ThemeCase) => Promise<void>;

async function expectGateWithinViewport(locator: Locator): Promise<void> {
  const bounds = await locator.boundingBox();
  const viewport = locator.page().viewportSize();
  expect(bounds).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (bounds === null || viewport === null) return;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
}

export async function configureTask7Gate(page: Page, requireTypedPhrase: boolean): Promise<void> {
  const settings: Settings = await sendExtensionRequest(page, { type: 'getSettings' });
  expect(
    await sendExtensionRequest(page, {
      type: 'updateSettings',
      settings: {
        ...settings,
        gate: { delayMs: 30_000, requireTypedPhrase, allowForceEnd: false },
      },
    }),
  ).toEqual({ ok: true });
}

export async function captureTask7GateState(input: {
  applyTheme: ApplyTask7GateTheme;
  capture: Task7CaptureContext;
  page: Page;
  state: 'typed-gate' | 'untyped-gate';
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
        await input.applyTheme(input.page, themeCase);
        await expect(panel).toBeVisible();
        await expect(panel).toContainText('A moment to decide');
        await expect(panel.getByRole('button', { name: 'End the session' })).toBeVisible();
        const forceEndControlCount: number = await input.page
          .getByText('Ignore timeout and end anyway')
          .count();
        expect(forceEndControlCount).toBe(0);
        await focusTarget.focus();
        await expectGateWithinViewport(panel);
        await input.capture.capture(
          input.page,
          'gate',
          input.state,
          themeCase,
          viewport,
          'full',
          true,
          { forceEndControlCount },
        );
        await input.capture.capture(
          panel,
          'gate',
          input.state,
          themeCase,
          viewport,
          'focused',
          false,
          { forceEndControlCount },
        );
        const bounds = await panel.boundingBox();
        const documentGeometry = await input.page.evaluate(() => ({
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        }));
        expect(documentGeometry.scrollWidth).toBe(documentGeometry.clientWidth);
        geometry.push({
          bounds,
          document: documentGeometry,
          forceEndControlCount,
          state: input.state,
          themeCase: themeCase.id,
          viewport,
        });
      });
    }
  }
  return geometry;
}

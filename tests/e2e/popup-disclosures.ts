import type { Locator, Page } from '@playwright/test';
import { expect } from './fixtures';

/** Open the same disclosure a person uses before interacting with its controls. */
export async function openPopupSection(
  page: Page,
  label: 'Session settings' | 'Session actions',
): Promise<void> {
  const summary: Locator = page.locator('summary').filter({ hasText: new RegExp(`^${label}$`) });
  await expect(summary).toBeVisible();
  const details: Locator = summary.locator('..');
  if ((await details.getAttribute('open')) === null) await summary.click();
  await expect(details).toHaveAttribute('open', '');
}

/** Starting and recovery states expose their permitted End action directly. */
export async function revealSessionActions(page: Page): Promise<void> {
  await expect(page.locator('.active-view, .lifecycle-view')).toBeVisible();
  if ((await page.locator('.active-view').count()) > 0) {
    await openPopupSection(page, 'Session actions');
  }
}

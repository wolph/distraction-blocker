import type { Locator, Page } from '@playwright/test';
import type { SessionSnapshotV2, Settings } from '../../src/shared/types';
import { expect, sendExtensionRequest, test, waitForLifecycle } from './fixtures';

/** Copy the spec fixes, spelled out here rather than imported, so a wording change fails loudly. */
const TOTAL_SESSION_CLOCK_LABEL: string = 'total session';
const FOCUS_PHASE_CLOCK_LABEL: string = 'focus phase';

function clockValue(page: Page, label: string): Locator {
  return page
    .locator('.clock-stack__row')
    .filter({
      has: page.locator('.clock-stack__label').filter({ hasText: new RegExp(`^${label}$`) }),
    })
    .locator('.clock-stack__value');
}

test('50 deep work starts one uninterrupted 50 minute block', async ({ extPage }) => {
  await extPage.getByRole('button', { name: '50 min', exact: true }).click();
  await expect(extPage.locator('.session-timing')).toHaveText('50 min uninterrupted focus');

  await extPage.getByRole('button', { name: /^Start 50 min focus$/ }).click();
  const snapshot: SessionSnapshotV2 = await waitForLifecycle(extPage, 'active');

  expect(snapshot.config?.duration).toEqual({ kind: 'timed', minutes: 50 });
  expect(snapshot.config?.cycling).toBeNull();
  expect(snapshot.phase).toBe('focus');
  expect(snapshot.phaseEndsAt).toBe(snapshot.sessionEndsAt);
  expect((snapshot.sessionEndsAt ?? 0) - (snapshot.startedAt ?? 0)).toBe(50 * 60_000);
  await expect(clockValue(extPage, TOTAL_SESSION_CLOCK_LABEL)).toHaveText(/^(50:00|49:5\d)$/);
  await expect(extPage.locator('.clock-stack__row--secondary')).toHaveCount(0);
});

test('25 focus keeps cycling and shows the focus phase beside the total session', async ({
  extPage,
}) => {
  const settings: Settings = await sendExtensionRequest(extPage, { type: 'getSettings' });
  expect(
    await sendExtensionRequest(extPage, {
      type: 'updateSettings',
      settings: {
        ...settings,
        cyclingOnByDefault: true,
        defaultCycling: { ...settings.defaultCycling, focusMin: 10 },
      },
    }),
  ).toEqual({ ok: true });
  await extPage.reload();

  await extPage.getByRole('button', { name: '25 min', exact: true }).click();
  await expect(extPage.locator('.session-timing')).toHaveText(
    '25 min total, with 10 min focus blocks',
  );

  await extPage.getByRole('button', { name: /^Start 25 min focus$/ }).click();
  const snapshot: SessionSnapshotV2 = await waitForLifecycle(extPage, 'active');

  expect(snapshot.config?.duration).toEqual({ kind: 'timed', minutes: 25 });
  expect(snapshot.config?.cycling?.focusMin).toBe(10);
  expect(snapshot.phaseEndsAt).toBe((snapshot.startedAt ?? 0) + 10 * 60_000);
  expect(snapshot.sessionEndsAt).toBe((snapshot.startedAt ?? 0) + 25 * 60_000);
  await expect(clockValue(extPage, TOTAL_SESSION_CLOCK_LABEL)).toHaveText(/^(25:00|24:5\d)$/);
  await expect(clockValue(extPage, FOCUS_PHASE_CLOCK_LABEL)).toHaveText(/^(10:00|9:5\d)$/);
});

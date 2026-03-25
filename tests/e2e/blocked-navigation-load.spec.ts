/**
 * The load guard for the defect that made blocking stop working silently.
 *
 * Every fresh navigation to a blocked page writes to the projected runtime domain, and while a
 * commit was in flight those writes were refused. A few seconds of ordinary browsing was enough:
 * the worker stopped serving the pull that mounts the overlay, so pages loaded normally, the
 * statistics page waited forever, and a session could not be ended, while nothing on screen said
 * anything was wrong.
 *
 * So this asserts the thing that matters rather than the absence of errors. A worker that had
 * stopped doing anything would pass an empty log. It would not mount the fortieth overlay, and it
 * would not answer afterwards.
 */

import type { Page } from '@playwright/test';
import type { SessionSnapshotV2 } from '../../src/shared/types';
import {
  browserDiagnosticsFor,
  expect,
  sendExtensionRequest,
  startUntilStoppedSession,
  test,
} from './fixtures';

/** Forty navigations plus their overlays, with room for a slow machine. */
test.setTimeout(180_000);

const NAVIGATIONS: number = 40;
/** The budget one overlay gets. A worker that has stopped serving misses it by a mile. */
const OVERLAY_BUDGET_MS: number = 5_000;

test('blocking still works after forty blocked navigations', async ({
  context,
  extPage,
  siteUrl,
}) => {
  await startUntilStoppedSession(extPage);
  const page: Page = await context.newPage();

  for (let index: number = 0; index < NAVIGATIONS; index += 1) {
    await page
      .goto(siteUrl(`/plain.html?visit=${String(index)}`), { waitUntil: 'commit' })
      .catch((): null => null);
    // The overlay is the product working. It is asserted on every navigation rather than only at
    // the end, so a run that degrades names the visit it degraded on.
    await expect(
      page.locator('focus-lock-overlay'),
      `overlay on visit ${String(index)}`,
    ).toBeAttached({
      timeout: OVERLAY_BUDGET_MS,
    });
    // A route change inside the document, which is what makes the worker refreeze a view while a
    // commit may still be in flight. This is the write the defect refused.
    await page.evaluate((visit: number): void => {
      history.pushState(null, '', `/plain.html?visit=${String(visit)}&route=1`);
    }, index);
  }

  // The worker is still serving, which is what a page and a popup both depend on.
  const stats: unknown = await sendExtensionRequest(extPage, { type: 'getStats', days: 7 });
  expect(stats).toMatchObject({ days: expect.any(Array) });
  const snapshot: SessionSnapshotV2 = await sendExtensionRequest(extPage, { type: 'getSnapshot' });
  expect(snapshot.lifecycle.kind).toBe('active');

  // The log is the weakest of these assertions and it comes last on purpose: a worker that had
  // stopped doing anything would leave it empty too.
  expect(browserDiagnosticsFor(context).workerErrors).toEqual([]);
});

import type { SessionSnapshot } from '../../src/shared/types';
import { expect, sendExtensionRequest, test } from './fixtures';

test('50 deep work starts one uninterrupted 50-minute focus phase', async ({ extPage }) => {
  await extPage.getByRole('button', { name: '50 deep work', exact: true }).click();
  await extPage.getByRole('button', { name: 'Start focusing', exact: true }).click();
  await expect(extPage.locator('.clock')).toHaveText(/^(50:00|49:5\d)$/);
  const snapshot: SessionSnapshot = await sendExtensionRequest(extPage, { type: 'getSnapshot' });
  expect(snapshot.config?.durationMin).toBe(50);
  expect(snapshot.config?.cycling).toBeNull();
  expect(snapshot.phase).toBe('focus');
  expect(snapshot.phaseEndsAt).toBe(snapshot.sessionEndsAt);
  expect((snapshot.sessionEndsAt as number) - (snapshot.startedAt as number)).toBe(50 * 60_000);
  await expect(extPage.locator('.cycle-note')).toHaveCount(0);
});

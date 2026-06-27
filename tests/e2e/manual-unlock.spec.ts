import type { Page } from '@playwright/test';
import type { SessionSnapshot } from '../../src/shared/types';
import { expect, sendExtensionRequest, test } from './fixtures';

test('manual lock survives browser restart and unlocks only after confirmation', async ({
  restartableExtension,
  siteUrl,
}) => {
  const original = await restartableExtension.launch();
  await original.extPage.setViewportSize({ width: 1280, height: 1000 });
  const settings = await sendExtensionRequest(original.extPage, { type: 'getSettings' });
  expect(
    await sendExtensionRequest(original.extPage, {
      type: 'updateSettings',
      settings: {
        ...settings,
        gate: { ...settings.gate, delayMs: 1000, requireTypedPhrase: false },
        cyclingOnByDefault: true,
        defaultStrictness: 'hard',
      },
    }),
  ).toEqual({ ok: true });
  const lists = await sendExtensionRequest(original.extPage, { type: 'getLists' });
  expect(
    await sendExtensionRequest(original.extPage, {
      type: 'updateLists',
      lists: { ...lists, custom: [{ kind: 'host', pattern: 'blocked.example' }] },
    }),
  ).toEqual({ ok: true });
  await original.extPage.reload();
  await expect(original.extPage.locator('body')).toHaveCSS('width', '480px');
  await original.extPage.getByRole('button', { name: 'Until manual unlock', exact: true }).click();
  await original.extPage
    .getByRole('button', { name: 'Lock until manual unlock', exact: true })
    .click();
  await expect
    .poll(
      async (): Promise<SessionSnapshot['phase']> =>
        (await sendExtensionRequest(original.extPage, { type: 'getSnapshot' })).phase,
    )
    .toBe('focus');
  const before: SessionSnapshot = await sendExtensionRequest(original.extPage, {
    type: 'getSnapshot',
  });
  expect(before).toMatchObject({
    phase: 'focus',
    config: { durationMin: null, strictness: 'friction', cycling: null },
    phaseEndsAt: null,
    sessionEndsAt: null,
  });
  await expect(original.extPage.getByRole('button', { name: 'Unlock', exact: true })).toBeVisible();
  const blocked: Page = await original.context.newPage();
  await blocked.goto(siteUrl('/plain.html'), { waitUntil: 'commit' });
  await expect(blocked.locator('focus-lock-overlay')).toBeAttached();
  await restartableExtension.close();
  const restored = await restartableExtension.launch();
  const snapshot: SessionSnapshot = await sendExtensionRequest(restored.extPage, {
    type: 'getSnapshot',
  });
  expect(snapshot).toMatchObject({
    phase: 'focus',
    startedAt: before.startedAt,
    config: { durationMin: null },
    phaseEndsAt: null,
    sessionEndsAt: null,
  });
  const stillBlocked: Page = await restored.context.newPage();
  await stillBlocked.goto(siteUrl('/plain.html'), { waitUntil: 'commit' });
  await expect(stillBlocked.locator('focus-lock-overlay')).toBeAttached();
  await restored.extPage.getByRole('button', { name: 'Unlock', exact: true }).click();
  const confirm = restored.extPage.getByRole('button', { name: 'Unlock', exact: true });
  await expect(confirm).toBeDisabled();
  expect(
    (await sendExtensionRequest(restored.extPage, { type: 'confirmGate', typedPhrase: null })).ok,
  ).toBe(false);
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect
    .poll(
      async (): Promise<SessionSnapshot['phase']> =>
        (await sendExtensionRequest(restored.extPage, { type: 'getSnapshot' })).phase,
    )
    .toBe('idle');
  await expect(stillBlocked.locator('focus-lock-overlay')).not.toBeAttached();
});

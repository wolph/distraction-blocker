import type { SessionSnapshot, Settings } from '../../src/shared/types';
import { expect, sendExtensionRequest, startTestSession, test } from './fixtures';

test('badge shows a countdown during focus and clears on completion', async ({
  extPage,
  worker,
}) => {
  await startTestSession(extPage, { durationMin: 0.1 });
  await expect
    .poll(
      async (): Promise<string> =>
        await worker.evaluate(async (): Promise<string> => await chrome.action.getBadgeText({})),
    )
    .not.toBe('');

  await expect
    .poll(
      async (): Promise<string> => {
        const snapshot: SessionSnapshot = await sendExtensionRequest(extPage, {
          type: 'getSnapshot',
        });
        return snapshot.phase;
      },
      { timeout: 15_000 },
    )
    .toBe('idle');
  await expect
    .poll(
      async (): Promise<string> =>
        await worker.evaluate(async (): Promise<string> => await chrome.action.getBadgeText({})),
    )
    .toBe('');
});

test('sync and local storage keep their documented split and quota', async ({
  extPage,
  worker,
}) => {
  const settings: Settings = await sendExtensionRequest(extPage, { type: 'getSettings' });
  expect(
    await sendExtensionRequest(extPage, {
      type: 'updateSettings',
      settings: { ...settings, badgeCountdown: !settings.badgeCountdown },
    }),
  ).toEqual({ ok: true });
  await startTestSession(extPage, { durationMin: 0.1 });
  await expect
    .poll(
      async (): Promise<string> => {
        const snapshot: SessionSnapshot = await sendExtensionRequest(extPage, {
          type: 'getSnapshot',
        });
        return snapshot.phase;
      },
      { timeout: 15_000 },
    )
    .toBe('idle');

  let syncItems: Record<string, unknown> = {};
  await expect
    .poll(
      async (): Promise<boolean> => {
        syncItems = await worker.evaluate(
          async (): Promise<Record<string, unknown>> => await chrome.storage.sync.get(null),
        );
        return (
          'settings' in syncItems &&
          'lists' in syncItems &&
          'bank' in syncItems &&
          'streak' in syncItems &&
          Object.keys(syncItems).some((key: string): boolean => key.startsWith('agg:'))
        );
      },
      { timeout: 20_000, intervals: [250, 500, 1_000] },
    )
    .toBe(true);

  const syncUsage: { quota: number; usage: Record<string, number> } = await worker.evaluate(
    async (): Promise<{ quota: number; usage: Record<string, number> }> => {
      const items: Record<string, unknown> = await chrome.storage.sync.get(null);
      const usage: Record<string, number> = {};
      for (const key of Object.keys(items)) {
        usage[key] = await chrome.storage.sync.getBytesInUse(key);
      }
      return { quota: chrome.storage.sync.QUOTA_BYTES_PER_ITEM, usage };
    },
  );
  for (const [key, bytes] of Object.entries(syncUsage.usage)) {
    expect(bytes, `${key} exceeds the sync item quota`).toBeLessThanOrEqual(syncUsage.quota);
  }
  const localItems: Record<string, unknown> = await worker.evaluate(
    async (): Promise<Record<string, unknown>> => await chrome.storage.local.get(null),
  );
  expect(localItems).toHaveProperty('runtime');
  expect(localItems).toHaveProperty('events');
  expect(syncItems).not.toHaveProperty('events');
  expect(syncItems).not.toHaveProperty('runtime');
});

test('an active schedule window starts a scheduled focus session', async ({ extPage }) => {
  const settings: Settings = await sendExtensionRequest(extPage, { type: 'getSettings' });
  const today: number = new Date().getDay();
  expect(
    await sendExtensionRequest(extPage, {
      type: 'updateSettings',
      settings: {
        ...settings,
        schedule: [
          {
            id: 'e2e-active-window',
            days: [today],
            start: '00:00',
            end: '23:59',
            mode: 'blacklist',
            strictness: 'friction',
            cycling: null,
            intention: 'scheduled e2e run',
            enabled: true,
          },
        ],
      },
    }),
  ).toEqual({ ok: true });

  await expect
    .poll(async (): Promise<string> => {
      const snapshot: SessionSnapshot = await sendExtensionRequest(extPage, {
        type: 'getSnapshot',
      });
      return snapshot.phase;
    })
    .toBe('focus');
  const snapshot: SessionSnapshot = await sendExtensionRequest(extPage, {
    type: 'getSnapshot',
  });
  expect(snapshot.config?.source).toBe('schedule');
  expect(snapshot.config?.scheduleEntryId).toBe('e2e-active-window');
});

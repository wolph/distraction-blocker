import type { Worker } from '@playwright/test';
import type { ListsConfig, SessionSnapshot, Settings } from '../../src/shared/types';
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

const PROJECTED_QUOTA_PREFIX: string = 'task7-system-quota:';

async function fillSyncForProjectedQuota(worker: Worker): Promise<{
  bytes: number;
  quota: number;
}> {
  return await worker.evaluate(
    async (prefix: string): Promise<{ bytes: number; quota: number }> => {
      const quota: number = chrome.storage.sync.QUOTA_BYTES;
      const itemQuota: number = chrome.storage.sync.QUOTA_BYTES_PER_ITEM;
      const target: number = quota - 128;
      let bytes: number = await chrome.storage.sync.getBytesInUse(null);
      let index: number = 0;
      while (bytes < target) {
        const key: string = `${prefix}${String(index).padStart(2, '0')}`;
        const remaining: number = target - bytes;
        const valueLength: number = Math.max(1, Math.min(itemQuota - 256, remaining - 64));
        await chrome.storage.sync.set({ [key]: 'q'.repeat(valueLength) });
        bytes = await chrome.storage.sync.getBytesInUse(null);
        index += 1;
      }
      return { bytes, quota };
    },
    PROJECTED_QUOTA_PREFIX,
  );
}

async function clearProjectedQuotaFiller(worker: Worker): Promise<void> {
  await worker.evaluate(async (prefix: string): Promise<void> => {
    const stored: Record<string, unknown> = await chrome.storage.sync.get(null);
    const keys: string[] = Object.keys(stored).filter((key: string): boolean =>
      key.startsWith(prefix),
    );
    if (keys.length > 0) await chrome.storage.sync.remove(keys);
  }, PROJECTED_QUOTA_PREFIX);
}

test('badge shows a countdown during focus and clears on completion', async ({
  extPage,
  worker,
}) => {
  await startTestSession(extPage, { duration: { kind: 'timed', minutes: 0.1 } });
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
  await startTestSession(extPage, { duration: { kind: 'timed', minutes: 0.1 } });
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
  expect(syncItems).not.toHaveProperty('streak');
});

test('projected first-Sync publication rejects total quota overflow and preserves local policy', async ({
  extPage,
  worker,
}) => {
  expect(
    await sendExtensionRequest(extPage, {
      type: 'setStorageMode',
      storageMode: 'local',
      deleteRemote: false,
    }),
  ).toEqual({ ok: true });
  const originalLists: ListsConfig = await sendExtensionRequest(extPage, { type: 'getLists' });
  const expandedLists: ListsConfig = {
    ...originalLists,
    custom: Array.from(
      { length: 48 },
      (_value: unknown, index: number): ListsConfig['custom'][number] => ({
        kind: 'host',
        pattern: `projected-quota-${String(index).padStart(2, '0')}.example`,
      }),
    ),
  };
  expect(
    await sendExtensionRequest(extPage, { type: 'updateLists', lists: expandedLists }),
  ).toEqual({ ok: true });

  try {
    const filled: { bytes: number; quota: number } = await fillSyncForProjectedQuota(worker);
    expect(filled.bytes).toBeGreaterThanOrEqual(filled.quota - 128);
    expect(filled.bytes).toBeLessThanOrEqual(filled.quota);

    expect(
      await sendExtensionRequest(extPage, {
        type: 'setStorageMode',
        storageMode: 'sync',
        deleteRemote: false,
      }),
    ).toEqual({
      error: expect.stringMatching(
        /^SyncQuotaError: Cannot sync batch: \d+ bytes exceeds the 102400-byte limit/,
      ),
      ok: false,
    });
    await expect
      .poll(async (): Promise<unknown> => {
        const setup: unknown = await sendExtensionRequest(extPage, { type: 'getSetupState' });
        return typeof setup === 'object' && setup !== null
          ? (setup as Record<string, unknown>).syncWriteStatus
          : null;
      })
      .toBe('error');
    expect(await sendExtensionRequest(extPage, { type: 'getSetupState' })).toMatchObject({
      storageError: 'sync-publish-failed',
      storageMode: 'local',
      syncWriteStatus: 'error',
    });
    expect(await sendExtensionRequest(extPage, { type: 'getLists' })).toEqual(expandedLists);
    expect(
      await worker.evaluate(
        async (): Promise<number> => await chrome.storage.sync.getBytesInUse(null),
      ),
    ).toBeLessThanOrEqual(filled.quota);
  } finally {
    await clearProjectedQuotaFiller(worker);
    await sendExtensionRequest(extPage, { type: 'updateLists', lists: originalLists });
  }
});

test('an active schedule window starts a scheduled focus session', async ({ extPage, worker }) => {
  await clearNotifications(worker);
  await observeSoundMessages(extPage);
  const settings: Settings = await sendExtensionRequest(extPage, { type: 'getSettings' });
  const scheduleClock: { at: number; day: number } = await worker.evaluate(
    (): { at: number; day: number } => {
      const fixed: Date = new Date();
      fixed.setHours(12, 0, 0, 0);
      const at: number = fixed.getTime();
      Date.now = (): number => at;
      return { at, day: fixed.getDay() };
    },
  );
  expect(
    await sendExtensionRequest(extPage, {
      type: 'updateSettings',
      settings: {
        ...settings,
        sounds: {
          ...settings.sounds,
          masterVolume: 0.1,
          scheduleStart: true,
        },
        schedule: [
          {
            id: 'e2e-active-window',
            days: [scheduleClock.day],
            start: '11:59',
            end: '12:01',
            duration: { kind: 'window' },
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

  // The minute tick owns the schedule check, and nothing else in v2 runs one, so the test wakes it
  // instead of waiting out a real minute inside a sixty-second budget.
  await worker.evaluate(async (): Promise<void> => {
    // biome-ignore lint/complexity/useDateNow: the worker's Date.now is frozen to the schedule's
    // noon above, and the alarm has to land on the real clock to fire at all.
    await chrome.alarms.create('tick', { when: new Date().getTime() });
  });
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
    .toBe('focus');
  const snapshot: SessionSnapshot = await sendExtensionRequest(extPage, {
    type: 'getSnapshot',
  });
  expect(snapshot.config?.source).toBe('schedule');
  expect(snapshot.config?.scheduleOccurrence?.entryId).toBe('e2e-active-window');
  expect(snapshot.phaseStartedAt).toBe(scheduleClock.at);
  await expect
    .poll(
      async (): Promise<ObservedSound['sound'][]> =>
        (await observedSounds(extPage)).map(
          (message: ObservedSound): ObservedSound['sound'] => message.sound,
        ),
    )
    .toContain('scheduleStart');
  expect(await hasOffscreenAudioDocument(worker)).toBe(true);
  await expect
    .poll(async (): Promise<string[]> => await notificationIds(worker))
    .not.toHaveLength(0);
});

test('privacy data deletion keeps local and remote scopes separate', async ({
  extPage,
  worker,
}) => {
  await worker.evaluate(async (): Promise<void> => {
    await chrome.storage.local.set({
      events: [
        {
          at: Date.now(),
          kind: 'attempt',
          domain: 'private.example',
          intention: 'private intention',
        },
      ],
    });
  });
  const syncBefore: Record<string, unknown> = await worker.evaluate(
    async (): Promise<Record<string, unknown>> => await chrome.storage.sync.get(null),
  );
  expect(syncBefore).toHaveProperty('settings');
  expect(syncBefore).toHaveProperty('lists');

  expect(
    await sendExtensionRequest(extPage, {
      type: 'clearFocusLockData',
      scope: 'local-history',
    }),
  ).toEqual({ ok: true, scope: 'local-history', status: 'cleared' });
  const localAfterHistoryClear: Record<string, unknown> = await worker.evaluate(
    async (): Promise<Record<string, unknown>> => await chrome.storage.local.get(null),
  );
  expect(localAfterHistoryClear).not.toHaveProperty('events');
  const syncAfterHistoryClear: Record<string, unknown> = await worker.evaluate(
    async (): Promise<Record<string, unknown>> => await chrome.storage.sync.get(null),
  );
  expect(syncAfterHistoryClear.settings).toEqual(syncBefore.settings);
  expect(syncAfterHistoryClear.lists).toEqual(syncBefore.lists);

  expect(
    await sendExtensionRequest(extPage, {
      type: 'setStorageMode',
      storageMode: 'local',
      deleteRemote: false,
    }),
  ).toEqual({ ok: true });
  expect(
    await sendExtensionRequest(extPage, {
      type: 'clearFocusLockData',
      scope: 'synced-policy',
    }),
  ).toEqual({ ok: true, scope: 'synced-policy', status: 'cleared' });
  const syncAfterRemoteClear: Record<string, unknown> = await worker.evaluate(
    async (): Promise<Record<string, unknown>> => await chrome.storage.sync.get(null),
  );
  expect(syncAfterRemoteClear).not.toHaveProperty('settings');
  expect(syncAfterRemoteClear).not.toHaveProperty('lists');
  expect(syncAfterRemoteClear).not.toHaveProperty('bank');
  expect(syncAfterRemoteClear).not.toHaveProperty('streak');
  const localAfterRemoteClear: Record<string, unknown> = await worker.evaluate(
    async (): Promise<Record<string, unknown>> => await chrome.storage.local.get(null),
  );
  expect(localAfterRemoteClear).toHaveProperty('settings');
  expect(localAfterRemoteClear).toHaveProperty('lists');
  expect(localAfterRemoteClear).toHaveProperty('runtime');
});

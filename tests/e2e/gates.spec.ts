import type { BrowserContext, CDPSession, Page } from '@playwright/test';
import { cancelPhrase } from '../../src/shared/constants';
import type { SessionSnapshot, Settings } from '../../src/shared/types';
import { expect, sendExtensionRequest, startTestSession, test } from './fixtures';

interface FastEconomyOptions {
  pauseMs?: number;
  unlockMs?: number;
  gateDelayMs?: number;
  requireTypedPhrase?: boolean;
}

async function configureFastEconomy(
  extPage: Page,
  options: FastEconomyOptions = {},
): Promise<void> {
  const pauseMs: number = options.pauseMs ?? 1_000;
  const unlockMs: number = options.unlockMs ?? 1_000;
  const settings: Settings = await sendExtensionRequest(extPage, { type: 'getSettings' });
  const ack = await sendExtensionRequest(extPage, {
    type: 'updateSettings',
    settings: {
      ...settings,
      pause: {
        earnRatio: 10,
        capMs: Math.max(60_000, pauseMs, unlockMs),
        pauseMs,
        unlockMs,
      },
      gate: {
        delayMs: options.gateDelayMs ?? 500,
        requireTypedPhrase: options.requireTypedPhrase ?? false,
      },
    },
  });
  if (!ack.ok) throw new Error(ack.error);
}

async function waitForBank(
  extPage: Page,
  amountMs: number,
  timeoutMs: number = 5_000,
): Promise<void> {
  await expect
    .poll(
      async (): Promise<number> => {
        const snapshot: SessionSnapshot = await sendExtensionRequest(extPage, {
          type: 'getSnapshot',
        });
        return snapshot.bankMs;
      },
      { timeout: timeoutMs },
    )
    .toBeGreaterThanOrEqual(amountMs);
}

async function clickClosedShadowButton(
  context: BrowserContext,
  page: Page,
  accessibleName: string,
): Promise<void> {
  const session: CDPSession = await context.newCDPSession(page);
  try {
    const tree = await session.send('Accessibility.getFullAXTree');
    let backendNodeId: number | undefined;
    for (const node of tree.nodes) {
      if (node.role?.value === 'button' && node.name?.value?.startsWith(accessibleName)) {
        backendNodeId = node.backendDOMNodeId;
        break;
      }
    }
    if (backendNodeId === undefined) throw new Error(`button not found: ${accessibleName}`);
    const box = await session.send('DOM.getBoxModel', { backendNodeId });
    const [left, top, right, , , bottom] = box.model.content;
    if (left === undefined || top === undefined || right === undefined || bottom === undefined) {
      throw new Error(`button has no content box: ${accessibleName}`);
    }
    await page.mouse.click((left + right) / 2, (top + bottom) / 2);
  } finally {
    await session.detach();
  }
}

async function closedShadowButtonNames(context: BrowserContext, page: Page): Promise<string[]> {
  const session: CDPSession = await context.newCDPSession(page);
  try {
    const tree = await session.send('Accessibility.getFullAXTree');
    return tree.nodes
      .filter((node): boolean => node.role?.value === 'button')
      .map((node): string => String(node.name?.value ?? ''));
  } finally {
    await session.detach();
  }
}

test('pause gate rejects an early confirmation and unblocks after its delay', async ({
  context,
  extPage,
  siteUrl,
}) => {
  const pauseMs: number = 10_000;
  await configureFastEconomy(extPage, { pauseMs });
  const page = await context.newPage();
  await page.goto(siteUrl('/plain.html'));
  await startTestSession(extPage, { durationMin: 0.3 });
  await expect(page.locator('focus-lock-overlay')).toBeAttached();
  await waitForBank(extPage, pauseMs);
  await expect
    .poll(async (): Promise<string> => {
      const names: string[] = await closedShadowButtonNames(context, page);
      return names.find((name: string): boolean => name.startsWith('Unlock this site')) ?? '';
    })
    .toBe('Unlock this site 0 min');

  expect(
    await sendExtensionRequest(extPage, { type: 'openGate', gate: 'pause', host: null }),
  ).toEqual({ ok: true });
  const early = await sendExtensionRequest(extPage, {
    type: 'confirmGate',
    typedPhrase: null,
  });
  expect(early.ok).toBe(false);

  await expect
    .poll(async (): Promise<boolean> => {
      const ack = await sendExtensionRequest(extPage, {
        type: 'confirmGate',
        typedPhrase: null,
      });
      return ack.ok;
    })
    .toBe(true);
  const snapshot: SessionSnapshot = await sendExtensionRequest(extPage, {
    type: 'getSnapshot',
  });
  expect(snapshot.phase).toBe('paused');
  await expect(page.locator('focus-lock-overlay')).toHaveCount(0);
});

test('pause gate supports back to work, taking a pause, and resuming now', async ({
  context,
  extPage,
  siteUrl,
}) => {
  const pauseMs: number = 10_000;
  await configureFastEconomy(extPage, { pauseMs });
  const page: Page = await context.newPage();
  await page.goto(siteUrl('/plain.html'));
  await startTestSession(extPage, { durationMin: 0.3 });
  await expect(page.locator('focus-lock-overlay')).toBeAttached();
  await waitForBank(extPage, pauseMs);

  const pauseButton = extPage.getByRole('button', { name: 'Pause everything 0 min' });
  await expect(pauseButton).toBeEnabled();
  await pauseButton.click();
  await extPage.getByRole('button', { name: 'Never mind, back to work' }).click();
  await expect(pauseButton).toBeEnabled();

  await pauseButton.click();
  const takePause = extPage.getByRole('button', { name: 'Take the pause' });
  await expect(takePause).toBeEnabled();
  await takePause.click();
  await expect(extPage.getByRole('button', { name: 'Resume now' })).toBeVisible();
  await expect(page.locator('focus-lock-overlay')).toHaveCount(0);

  await extPage.getByRole('button', { name: 'Resume now' }).click();
  await expect
    .poll(async (): Promise<SessionSnapshot['phase']> => {
      const snapshot: SessionSnapshot = await sendExtensionRequest(extPage, {
        type: 'getSnapshot',
      });
      return snapshot.phase;
    })
    .toBe('focus');
  await expect(page.locator('focus-lock-overlay')).toBeAttached();
});

test('abandoning a gate records a resisted temptation', async ({ extPage }) => {
  await configureFastEconomy(extPage);
  await startTestSession(extPage, { durationMin: 0.3 });
  await waitForBank(extPage, 1_000);
  expect(
    await sendExtensionRequest(extPage, { type: 'openGate', gate: 'pause', host: null }),
  ).toEqual({ ok: true });
  expect(await sendExtensionRequest(extPage, { type: 'abandonGate' })).toEqual({ ok: true });

  await expect
    .poll(async (): Promise<number> => {
      const stats = await sendExtensionRequest(extPage, { type: 'getStats', days: 14 });
      return stats.totals.resistedToday;
    })
    .toBe(1);
});

test('hard sessions reject weakening list changes', async ({ extPage }) => {
  await startTestSession(extPage, { strictness: 'hard', durationMin: 0.2 });
  const lists = await sendExtensionRequest(extPage, { type: 'getLists' });
  const ack = await sendExtensionRequest(extPage, {
    type: 'updateLists',
    lists: { ...lists, custom: [] },
  });

  expect(ack.ok).toBe(false);
  if (!ack.ok) expect(ack.error).toMatch(/hard/i);
});

test('friction cancellation without typing uses the configured delay', async ({ extPage }) => {
  const gateDelayMs: number = 3_000;
  await configureFastEconomy(extPage, { gateDelayMs, requireTypedPhrase: false });
  await startTestSession(extPage, { durationMin: 0.3 });
  expect(
    await sendExtensionRequest(extPage, { type: 'openGate', gate: 'cancel', host: null }),
  ).toEqual({ ok: true });

  const early = await sendExtensionRequest(extPage, {
    type: 'confirmGate',
    typedPhrase: null,
  });
  expect(early.ok).toBe(false);

  const opened: SessionSnapshot = await sendExtensionRequest(extPage, { type: 'getSnapshot' });
  expect(opened.gate?.readyAt).toBe((opened.gate?.openedAt ?? 0) + gateDelayMs);
  expect(opened.gate?.requiredPhrase).toBeNull();

  await expect
    .poll(
      async (): Promise<boolean> => {
        const snapshot: SessionSnapshot = await sendExtensionRequest(extPage, {
          type: 'getSnapshot',
        });
        return snapshot.gate !== null && snapshot.at >= snapshot.gate.readyAt;
      },
      { timeout: 6_000, intervals: [100] },
    )
    .toBe(true);

  expect(
    await sendExtensionRequest(extPage, {
      type: 'confirmGate',
      typedPhrase: null,
    }),
  ).toEqual({ ok: true });
  const ended: SessionSnapshot = await sendExtensionRequest(extPage, { type: 'getSnapshot' });
  expect(ended.phase).toBe('idle');
});

test('friction cancellation with typing requires the configured phrase after its delay', async ({
  extPage,
}) => {
  const gateDelayMs: number = 3_000;
  const requiredPhrase: string = cancelPhrase('e2e test run');
  await configureFastEconomy(extPage, { gateDelayMs, requireTypedPhrase: true });
  await startTestSession(extPage, { durationMin: 0.3 });
  expect(
    await sendExtensionRequest(extPage, { type: 'openGate', gate: 'cancel', host: null }),
  ).toEqual({ ok: true });

  const early = await sendExtensionRequest(extPage, {
    type: 'confirmGate',
    typedPhrase: requiredPhrase,
  });
  expect(early.ok).toBe(false);

  const opened: SessionSnapshot = await sendExtensionRequest(extPage, { type: 'getSnapshot' });
  expect(opened.gate?.readyAt).toBe((opened.gate?.openedAt ?? 0) + gateDelayMs);
  expect(opened.gate?.requiredPhrase).toBe(requiredPhrase);

  await expect
    .poll(
      async (): Promise<number> => {
        const snapshot: SessionSnapshot = await sendExtensionRequest(extPage, {
          type: 'getSnapshot',
        });
        return snapshot.at;
      },
      { timeout: 6_000, intervals: [100] },
    )
    .toBeGreaterThanOrEqual(opened.gate?.readyAt ?? Number.POSITIVE_INFINITY);

  const missing = await sendExtensionRequest(extPage, {
    type: 'confirmGate',
    typedPhrase: null,
  });
  expect(missing.ok).toBe(false);
  const wrong = await sendExtensionRequest(extPage, {
    type: 'confirmGate',
    typedPhrase: 'let me out',
  });
  expect(wrong.ok).toBe(false);
  expect(
    await sendExtensionRequest(extPage, {
      type: 'confirmGate',
      typedPhrase: requiredPhrase,
    }),
  ).toEqual({ ok: true });

  const ended: SessionSnapshot = await sendExtensionRequest(extPage, { type: 'getSnapshot' });
  expect(ended.phase).toBe('idle');
});

test('hard sessions reject cancellation gates', async ({ extPage }) => {
  await startTestSession(extPage, { durationMin: 0.3, strictness: 'hard' });

  const ack = await sendExtensionRequest(extPage, {
    type: 'openGate',
    gate: 'cancel',
    host: null,
  });

  expect(ack.ok).toBe(false);
  if (!ack.ok) expect(ack.error).toMatch(/hard sessions cannot be canceled/i);
  const snapshot: SessionSnapshot = await sendExtensionRequest(extPage, { type: 'getSnapshot' });
  expect(snapshot.phase).toBe('focus');
  expect(snapshot.gate).toBeNull();
});

test('overlay unlock isolates another site and reblocks after expiry', async ({
  context,
  extPage,
  siteUrl,
  worker,
}) => {
  const unlockMs: number = 35_000;
  await configureFastEconomy(extPage, { pauseMs: 1_000, unlockMs });
  const page = await context.newPage();
  const otherPage = await context.newPage();
  const subdomainUrl: string = siteUrl('/plain.html').replace(
    'blocked.example',
    'm.blocked.example',
  );
  const otherUrl: string = siteUrl('/plain.html').replace('blocked.example', 'other.example');
  await page.goto(subdomainUrl);
  await otherPage.goto(otherUrl);
  await startTestSession(extPage, { durationMin: 1.5 }, [
    { kind: 'host', pattern: 'blocked.example' },
    { kind: 'host', pattern: 'other.example' },
  ]);
  await expect(page.locator('focus-lock-overlay')).toBeAttached();
  await expect(otherPage.locator('focus-lock-overlay')).toBeAttached();
  await waitForBank(extPage, unlockMs, 15_000);

  await expect
    .poll(async (): Promise<boolean> => {
      await clickClosedShadowButton(context, page, 'Unlock this site');
      const opened: SessionSnapshot = await sendExtensionRequest(extPage, {
        type: 'getSnapshot',
      });
      return opened.gate?.kind === 'unlockSite';
    })
    .toBe(true);
  await expect
    .poll(async (): Promise<boolean> => {
      const ack = await sendExtensionRequest(extPage, {
        type: 'confirmGate',
        typedPhrase: null,
      });
      return ack.ok;
    })
    .toBe(true);

  const snapshot: SessionSnapshot = await sendExtensionRequest(extPage, {
    type: 'getSnapshot',
  });
  expect(snapshot.activeUnlocks[0]?.host).toBe('blocked.example');
  const phaseAlarm: chrome.alarms.Alarm | undefined = await worker.evaluate(
    async (): Promise<chrome.alarms.Alarm | undefined> => await chrome.alarms.get('phase'),
  );
  expect(phaseAlarm?.scheduledTime).toBe(snapshot.activeUnlocks[0]?.until);
  await expect(page.locator('focus-lock-overlay')).toHaveCount(0);
  await expect(page.locator('#marker')).toHaveText('plain page');
  await expect(otherPage.locator('focus-lock-overlay')).toBeAttached();

  await expect
    .poll(
      async (): Promise<number> => {
        const current: SessionSnapshot = await sendExtensionRequest(extPage, {
          type: 'getSnapshot',
        });
        return current.activeUnlocks.length;
      },
      { timeout: 50_000 },
    )
    .toBe(0);
  await expect(page.locator('focus-lock-overlay')).toBeAttached();
  await expect(otherPage.locator('focus-lock-overlay')).toBeAttached();
});

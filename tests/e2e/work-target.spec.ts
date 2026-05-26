import type { BrowserContext, CDPSession, Page, Worker } from '@playwright/test';
import type { SessionSnapshot } from '../../src/shared/types';
import type { WorkTargetResult } from '../../src/shared/work-target';
import { expect, sendExtensionRequest, startTestSession, test } from './fixtures';

interface TabIdentity {
  tabId: number;
  windowId: number;
}

async function identity(worker: Worker, page: Page): Promise<TabIdentity> {
  return worker.evaluate(async (url: string): Promise<TabIdentity> => {
    const tabs: chrome.tabs.Tab[] = await chrome.tabs.query({ url });
    const tab: chrome.tabs.Tab | undefined = tabs[0];
    if (tab?.id === undefined) throw new Error('Test tab is missing');
    return { tabId: tab.id, windowId: tab.windowId };
  }, page.url());
}

async function target(extPage: Page, windowId: number): Promise<WorkTargetResult> {
  return sendExtensionRequest(extPage, { type: 'getWorkTarget', windowId });
}

async function selectTarget(extPage: Page, work: TabIdentity): Promise<string> {
  const current: WorkTargetResult = await target(extPage, work.windowId);
  if (!current.ok || current.sessionId === null) throw new Error('No active test session');
  expect(
    await sendExtensionRequest(extPage, {
      type: 'setWorkTarget',
      sessionId: current.sessionId,
      tabId: work.tabId,
      windowId: work.windowId,
    }),
  ).toEqual({ ok: true });
  return current.sessionId;
}

async function clickOverlay(
  context: BrowserContext,
  page: Page,
  name: string,
  role: string = 'button',
): Promise<void> {
  const session: CDPSession = await context.newCDPSession(page);
  try {
    await expect
      .poll(async (): Promise<boolean> => {
        const tree = await session.send('Accessibility.getFullAXTree');
        return tree.nodes.some(
          (node): boolean => node.role?.value === role && String(node.name?.value).startsWith(name),
        );
      })
      .toBe(true);
    const tree = await session.send('Accessibility.getFullAXTree');
    const node = tree.nodes.find(
      (entry): boolean => entry.role?.value === role && String(entry.name?.value).startsWith(name),
    );
    if (node?.backendDOMNodeId === undefined) throw new Error(`Missing button: ${name}`);
    await session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node.backendDOMNodeId });
    const box = await session.send('DOM.getBoxModel', { backendNodeId: node.backendDOMNodeId });
    const [left, top, right, , , bottom] = box.model.content;
    if (left === undefined || top === undefined || right === undefined || bottom === undefined) {
      throw new Error('Missing button coordinates');
    }
    await page.mouse.click((left + right) / 2, (top + bottom) / 2);
  } finally {
    await session.detach();
  }
}

test('the lockscreen returns to the chosen work tab without changing either loaded page', async ({
  context,
  extPage,
  worker,
  siteUrl,
}) => {
  const workPage: Page = await context.newPage();
  await workPage.goto(siteUrl('/plain.html').replace('blocked.example', 'other.example'));
  await workPage.evaluate((): void => {
    document.body.innerHTML =
      '<label>Draft<input id="draft"></label><div style="height:3000px"></div>';
  });
  await workPage.locator('#draft').fill('Keep this draft');
  await workPage.evaluate((): void => window.scrollTo(0, 300));
  const work: TabIdentity = await identity(worker, workPage);
  const blockedPage: Page = await context.newPage();
  await blockedPage.goto(siteUrl('/plain.html'));
  await blockedPage.evaluate((): void => {
    (window as unknown as { preserved: string }).preserved = 'existing page';
  });
  await startTestSession(extPage, { durationMin: 2, intention: 'Write the next example' });
  await selectTarget(extPage, work);
  await worker.evaluate(async (tabId: number): Promise<void> => {
    await chrome.windows.create({ tabId, focused: false });
  }, work.tabId);
  await expect(blockedPage.locator('focus-lock-overlay')).toBeAttached();
  await blockedPage.bringToFront();
  await clickOverlay(context, blockedPage, 'Back to work');
  await expect
    .poll(
      async (): Promise<boolean> =>
        worker.evaluate(async (id: number): Promise<boolean> => {
          const tab: chrome.tabs.Tab = await chrome.tabs.get(id);
          const win: chrome.windows.Window = await chrome.windows.get(tab.windowId);
          return tab.active && win.focused;
        }, work.tabId),
    )
    .toBe(true);
  await expect(workPage.locator('#draft')).toHaveValue('Keep this draft');
  expect(await workPage.evaluate((): number => window.scrollY)).toBe(300);
  expect(
    await blockedPage.evaluate(
      (): string => (window as unknown as { preserved: string }).preserved,
    ),
  ).toBe('existing page');
  await expect(blockedPage.locator('focus-lock-overlay')).toBeAttached();
});

test('returning abandons an open gate without spending access credit', async ({
  context,
  extPage,
  worker,
  siteUrl,
}) => {
  const workPage: Page = await context.newPage();
  await workPage.goto(siteUrl('/plain.html').replace('blocked.example', 'other.example'));
  await startTestSession(extPage, { durationMin: 2 });
  const work: TabIdentity = await identity(worker, workPage);
  await selectTarget(extPage, work);
  const blockedPage: Page = await context.newPage();
  await blockedPage.goto(siteUrl('/plain.html'), { waitUntil: 'commit' });
  await expect(blockedPage.locator('focus-lock-overlay')).toBeAttached();
  expect(
    await sendExtensionRequest(extPage, { type: 'openGate', gate: 'cancel', host: null }),
  ).toEqual({ ok: true });
  await clickOverlay(context, blockedPage, 'Back to work');
  await expect
    .poll(async (): Promise<boolean> => {
      const current: SessionSnapshot = await sendExtensionRequest(extPage, {
        type: 'getSnapshot',
      });
      return current.gate === null;
    })
    .toBe(true);
  const snapshot: SessionSnapshot = await sendExtensionRequest(extPage, { type: 'getSnapshot' });
  expect(snapshot.gate).toBeNull();
  expect(snapshot.phase).toBe('focus');
  const events = await sendExtensionRequest(extPage, { type: 'exportEvents' });
  expect(events.json).toContain('gateResisted');
  expect(events.json).not.toContain('pauseTaken');
  expect(events.json).not.toContain('unlockTaken');
});

test('a closed work tab can be replaced and stale session actions are rejected', async ({
  context,
  extPage,
  worker,
  siteUrl,
}) => {
  const workPage: Page = await context.newPage();
  await workPage.goto(siteUrl('/plain.html').replace('blocked.example', 'other.example'));
  await startTestSession(extPage, { durationMin: 2 });
  const work: TabIdentity = await identity(worker, workPage);
  const sessionId: string = await selectTarget(extPage, work);
  await workPage.close();
  await expect
    .poll(async (): Promise<string> => {
      const result: WorkTargetResult = await target(extPage, work.windowId);
      return result.ok ? result.state : result.error;
    })
    .toBe('unavailable');
  const failed = await sendExtensionRequest(extPage, {
    type: 'returnToWork',
    sessionId,
    windowId: work.windowId,
  });
  expect(failed.ok).toBe(false);
  const replacement: Page = await context.newPage();
  await replacement.goto(siteUrl('/plain.html').replace('blocked.example', 'other.example'));
  await selectTarget(extPage, await identity(worker, replacement));
  const stale = await sendExtensionRequest(extPage, {
    type: 'returnToWork',
    sessionId: 'previous-session',
    windowId: work.windowId,
  });
  expect(stale.ok).toBe(false);
  const current: WorkTargetResult = await target(extPage, work.windowId);
  expect(current.ok && current.state).toBe('ready');
  const lists = await sendExtensionRequest(extPage, { type: 'getLists' });
  expect(
    await sendExtensionRequest(extPage, {
      type: 'updateLists',
      lists: { ...lists, custom: [...lists.custom, { kind: 'host', pattern: 'other.example' }] },
    }),
  ).toEqual({ ok: true });
  const blocked: WorkTargetResult = await target(extPage, work.windowId);
  expect(blocked.ok && blocked.state).toBe('unavailable');
  expect(
    (
      await sendExtensionRequest(extPage, {
        type: 'returnToWork',
        sessionId,
        windowId: work.windowId,
      })
    ).ok,
  ).toBe(false);
});

test('browser restart restores the focus session but clears its work-tab reference', async ({
  restartableExtension,
  siteUrl,
}) => {
  const original = await restartableExtension.launch();
  const workPage: Page = await original.context.newPage();
  await workPage.goto(siteUrl('/plain.html').replace('blocked.example', 'other.example'));
  await startTestSession(original.extPage, { durationMin: 5 });
  const sessionId: string = await selectTarget(
    original.extPage,
    await identity(original.worker, workPage),
  );
  await restartableExtension.close();
  const restored = await restartableExtension.launch();
  const popup: TabIdentity = await identity(restored.worker, restored.extPage);
  const current: WorkTargetResult = await target(restored.extPage, popup.windowId);
  expect(current.ok && current.sessionId).toBe(sessionId);
  expect(current.ok && current.state).toBe('missing');
  const snapshot: SessionSnapshot = await sendExtensionRequest(restored.extPage, {
    type: 'getSnapshot',
  });
  expect(snapshot.phase).toBe('focus');
});

test('the popup defaults to the current work tab and can replace a closed target', async ({
  context,
  extPage,
  worker,
  siteUrl,
}) => {
  const workPage: Page = await context.newPage();
  await workPage.goto(siteUrl('/plain.html').replace('blocked.example', 'other.example'));
  await workPage.evaluate((): void => {
    document.title = 'Write the generator example';
  });
  const work: TabIdentity = await identity(worker, workPage);
  await workPage.bringToFront();
  await extPage.reload();
  await expect(extPage.getByLabel('Work tab', { exact: true })).toHaveValue(String(work.tabId));
  await extPage.getByLabel("What's your next small step?").fill('Write the first assertion');
  await extPage.getByRole('button', { name: 'Start focusing' }).click();
  await expect(extPage.getByRole('button', { name: 'Back to work', exact: true })).toBeEnabled();
  const selected: WorkTargetResult = await target(extPage, work.windowId);
  expect(selected.ok && selected.title).toBe('Write the generator example');
  const snapshot: SessionSnapshot = await sendExtensionRequest(extPage, { type: 'getSnapshot' });
  expect(snapshot.config?.intention).toBe('Write the first assertion');

  await workPage.close();
  const replacement: Page = await context.newPage();
  await replacement.goto(siteUrl('/plain.html').replace('blocked.example', 'other.example'));
  await replacement.evaluate((): void => {
    document.title = 'Finish the example';
  });
  const replacementTab: TabIdentity = await identity(worker, replacement);
  await extPage.getByLabel('Work tab', { exact: true }).selectOption(String(replacementTab.tabId));
  await expect
    .poll(async (): Promise<string | null> => {
      const current: WorkTargetResult = await target(extPage, work.windowId);
      return current.ok ? current.title : null;
    })
    .toBe('Finish the example');
  await extPage.getByRole('button', { name: 'Back to work', exact: true }).click();
  await expect
    .poll(
      async (): Promise<boolean> =>
        worker.evaluate(async (tabId: number): Promise<boolean> => {
          const tab: chrome.tabs.Tab = await chrome.tabs.get(tabId);
          return tab.active;
        }, replacementTab.tabId),
    )
    .toBe(true);
});

test('typed gate confirmation survives theme and work-tab status updates', async ({
  context,
  extPage,
  worker,
  siteUrl,
}) => {
  const settings = await sendExtensionRequest(extPage, { type: 'getSettings' });
  expect(
    await sendExtensionRequest(extPage, {
      type: 'updateSettings',
      settings: { ...settings, gate: { ...settings.gate, requireTypedPhrase: true } },
    }),
  ).toEqual({ ok: true });
  const workPage: Page = await context.newPage();
  await workPage.goto(siteUrl('/plain.html').replace('blocked.example', 'other.example'));
  await startTestSession(extPage, { durationMin: 2 });
  await selectTarget(extPage, await identity(worker, workPage));
  const page: Page = await context.newPage();
  await page.goto(siteUrl('/plain.html'), { waitUntil: 'commit' });
  await clickOverlay(context, page, 'Need a break or site access?', 'DisclosureTriangle');
  await clickOverlay(context, page, 'End session');
  const cdp: CDPSession = await context.newCDPSession(page);
  try {
    await expect
      .poll(async (): Promise<boolean> => {
        const tree = await cdp.send('Accessibility.getFullAXTree');
        return tree.nodes.some(
          (entry): boolean =>
            entry.role?.value === 'textbox' && entry.name?.value === 'Confirmation phrase',
        );
      })
      .toBe(true);
    const tree = await cdp.send('Accessibility.getFullAXTree');
    const input = tree.nodes.find(
      (entry): boolean =>
        entry.role?.value === 'textbox' && entry.name?.value === 'Confirmation phrase',
    );
    if (input?.backendDOMNodeId === undefined) throw new Error('Gate input missing');
    await cdp.send('DOM.focus', { backendNodeId: input.backendDOMNodeId });
    await page.keyboard.type('Keep this partial phrase');
    expect(await sendExtensionRequest(extPage, { type: 'updateTheme', theme: 'dark' })).toEqual({
      ok: true,
    });
    await workPage.evaluate((): void => {
      document.title = 'Updated work title';
    });
    await expect
      .poll(async (): Promise<string> => {
        const latest = await cdp.send('Accessibility.getFullAXTree');
        const field = latest.nodes.find(
          (entry): boolean => entry.name?.value === 'Confirmation phrase',
        );
        return String(field?.value?.value ?? '');
      })
      .toBe('Keep this partial phrase');
    await page.keyboard.type(' still focused');
    await expect
      .poll(async (): Promise<string> => {
        const latest = await cdp.send('Accessibility.getFullAXTree');
        const field = latest.nodes.find(
          (entry): boolean => entry.name?.value === 'Confirmation phrase',
        );
        return String(field?.value?.value ?? '');
      })
      .toBe('Keep this partial phrase still focused');
  } finally {
    await cdp.detach();
  }
});

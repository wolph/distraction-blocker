import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { type WorkTabIconPorts, WorkTabIconService } from '../../../src/background/work-tab-icons';
import {
  type WorkSession,
  type WorkTargetEngine,
  type WorkTargetPorts,
  WorkTargetService,
} from '../../../src/background/work-target';
import type { Ack } from '../../../src/shared/messages';
import type { SessionConfig } from '../../../src/shared/types';
import type { WorkTabsResult } from '../../../src/shared/work-target';

const popup: chrome.runtime.MessageSender = {
  id: 'extension',
  url: 'chrome-extension://extension/src/popup/popup.html',
};
const config: SessionConfig = {
  mode: 'blacklist',
  strictness: 'friction',
  durationMin: 25,
  cycling: null,
  intention: '',
  source: 'manual',
  scheduleEntryId: null,
};
function tab(id: number, url: string, incognito: boolean = false): chrome.tabs.Tab {
  return { id, url, title: `Tab ${id}`, incognito, windowId: incognito ? 2 : 1 } as chrome.tabs.Tab;
}

describe('work targets', (): void => {
  let session: WorkSession | null;
  let stored: unknown;
  let tabs: chrome.tabs.Tab[];
  let calls: string[];
  let engine: WorkTargetEngine;
  let ports: WorkTargetPorts;
  let service: WorkTargetService;
  beforeEach((): void => {
    session = { sessionId: 'session-1', mode: 'blacklist' };
    stored = undefined;
    tabs = [
      tab(1, 'https://work.example'),
      tab(2, 'https://blocked.example'),
      tab(3, 'chrome://settings'),
      tab(4, 'https://private.example', true),
    ];
    calls = [];
    engine = {
      workTargetSession: (): WorkSession | null => session,
      workTargetAllowed: (url: string, mode: SessionConfig['mode']): boolean =>
        mode === 'blacklist' ? !url.includes('blocked') : url.includes('work'),
      runWorkTargetAction: async (_id: string, action: () => Promise<Ack>): Promise<Ack> =>
        action(),
      abandonGate: async (): Promise<Ack> => {
        calls.push('gate');
        return { ok: true };
      },
      startSession: async (
        _config: SessionConfig,
        afterStart?: (id: string) => Promise<Ack>,
      ): Promise<Ack> => {
        session = { sessionId: 'session-new', mode: _config.mode };
        return afterStart === undefined ? { ok: true } : afterStart('session-new');
      },
    };
    ports = {
      extensionId: 'extension',
      popupUrl: popup.url as string,
      read: async (): Promise<unknown> => stored,
      write: async (value: unknown): Promise<void> => {
        stored = value;
      },
      tabs: async (): Promise<chrome.tabs.Tab[]> => tabs,
      tab: async (id: number): Promise<chrome.tabs.Tab> => {
        const found: chrome.tabs.Tab | undefined = tabs.find(
          (item: chrome.tabs.Tab): boolean => item.id === id,
        );
        if (found === undefined) throw new Error('missing');
        return found;
      },
      window: async (id: number): Promise<chrome.windows.Window> =>
        ({ id, incognito: id === 2 }) as chrome.windows.Window,
      activate: async (id: number): Promise<void> => {
        calls.push(`tab:${id}`);
      },
      focus: async (id: number): Promise<void> => {
        calls.push(`window:${id}`);
      },
      broadcast: vi.fn(),
    };
    service = new WorkTargetService(engine, ports);
  });
  it('serves icons only to current trusted content for a suitable tab without activation', async (): Promise<void> => {
    const encoded: string =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Tf8AAAAASUVORK5CYII=';
    const fetch: Mock<WorkTabIconPorts['fetch']> = vi.fn(
      async (): Promise<Response> =>
        new Response(
          Uint8Array.from(atob(encoded), (value: string): number => value.charCodeAt(0)),
        ),
    );
    const icons: WorkTabIconService = new WorkTabIconService({
      url: (url: string): string => url,
      fetch,
    });
    service = new WorkTargetService(engine, ports, icons);
    const content: chrome.runtime.MessageSender = {
      id: 'extension',
      url: tabs[1]?.url,
      tab: { ...tabs[1] } as chrome.tabs.Tab,
      frameId: 0,
    };
    expect(await service.getWorkTabIcon('session-1', 1, content)).toEqual({
      ok: true,
      icon: `data:image/png;base64,${encoded}`,
    });
    for (const sender of [
      popup,
      { ...content, id: 'other' },
      { ...content, frameId: 1 },
      { ...content, url: 'https://changed.example' },
    ])
      expect(await service.getWorkTabIcon('session-1', 1, sender)).toMatchObject({ ok: false });
    for (const id of [2, 3, 4, 99])
      expect(await service.getWorkTabIcon('session-1', id, content)).toMatchObject({ ok: false });
    expect(await service.getWorkTabIcon('old', 1, content)).toMatchObject({ ok: false });
    expect(fetch).toHaveBeenCalledOnce();
    expect(calls).toEqual([]);
    expect(stored).toBeUndefined();
    expect(ports.broadcast).not.toHaveBeenCalled();
  });
  it.each(['source', 'session', 'policy', 'privacy', 'destination'])(
    'revalidates %s after fetching an icon',
    async (changed: string): Promise<void> => {
      const content: chrome.runtime.MessageSender = {
        id: 'extension',
        url: tabs[1]?.url,
        tab: { ...tabs[1] } as chrome.tabs.Tab,
        frameId: 0,
      };
      const icons: WorkTabIconService = new WorkTabIconService({
        url: (url: string): string => url,
        fetch: async (): Promise<Response> => {
          if (changed === 'source') tabs[1] = tab(2, 'https://changed.example');
          if (changed === 'session') session = null;
          if (changed === 'policy') session = { sessionId: 'session-1', mode: 'whitelist' };
          if (changed === 'policy') engine.workTargetAllowed = (): boolean => false;
          if (changed === 'privacy') tabs[0] = tab(1, 'https://work.example', true);
          if (changed === 'destination') tabs[0] = tab(1, 'https://changed.example');
          return new Response(new Uint8Array([1, 2, 3]));
        },
      });
      service = new WorkTargetService(engine, ports, icons);
      expect(await service.getWorkTabIcon('session-1', 1, content)).toMatchObject({ ok: false });
      expect(calls).toEqual([]);
    },
  );
  it('lists only eligible HTTP tabs in the popup context', async (): Promise<void> => {
    expect(await service.getWorkTabs('blacklist', 1, popup)).toEqual({
      ok: true,
      tabs: [{ tabId: 1, title: 'Tab 1', hostname: 'work.example' }],
    });
    expect(await service.getWorkTabs('whitelist', 2, popup)).toEqual({ ok: true, tabs: [] });
  });
  it('orders eligible tabs by MRU with unknown timestamps last and stable ties', async (): Promise<void> => {
    tabs = [
      tab(1, 'https://work.example'),
      { ...tab(5, 'https://five.example'), lastAccessed: 20 },
      { ...tab(6, 'https://six.example'), lastAccessed: 10 },
      { ...tab(7, 'https://seven.example'), lastAccessed: 20 },
    ];
    const result: WorkTabsResult = await service.getWorkTabs('blacklist', 1, popup);
    expect(result).toEqual({
      ok: true,
      tabs: [
        { tabId: 5, title: 'Tab 5', hostname: 'five.example', lastAccessed: 20 },
        { tabId: 7, title: 'Tab 7', hostname: 'seven.example', lastAccessed: 20 },
        { tabId: 6, title: 'Tab 6', hostname: 'six.example', lastAccessed: 10 },
        { tabId: 1, title: 'Tab 1', hostname: 'work.example' },
      ],
    });
    stored = { sessionId: 'session-1', tabId: 1, incognito: false };
    expect(await service.getWorkTarget(1, popup)).toEqual({
      ok: true,
      sessionId: 'session-1',
      state: 'ready',
      title: 'Tab 1',
      hostname: 'work.example',
    });
  });
  it('projects only hostname alongside the title and tab identity', async (): Promise<void> => {
    tabs[0] = tab(1, 'https://work.example/private/report?token=private#section');
    expect(await service.getWorkTabs('blacklist', 1, popup)).toEqual({
      ok: true,
      tabs: [{ tabId: 1, title: 'Tab 1', hostname: 'work.example' }],
    });
  });
  it('rejects popup-shaped content requests and other extension pages', async (): Promise<void> => {
    const content: chrome.runtime.MessageSender = {
      id: 'extension',
      url: tabs[0]?.url,
      tab: tabs[0],
    };
    expect(await service.getWorkTabs('blacklist', 1, content)).toMatchObject({ ok: false });
    expect(await service.setWorkTarget('session-1', 1, 1, content)).toMatchObject({ ok: false });
    expect(
      await service.getWorkTabs('blacklist', 1, {
        ...popup,
        url: 'chrome-extension://extension/src/options/options.html',
      }),
    ).toMatchObject({ ok: false });
  });
  it('lists and selects from trusted content using the live session policy', async (): Promise<void> => {
    const content: chrome.runtime.MessageSender = {
      id: 'extension',
      url: tabs[1]?.url,
      tab: tabs[1],
      frameId: 0,
    };
    tabs.push(tab(5, 'https://other.example'));
    session = { sessionId: 'session-1', mode: 'whitelist' };
    expect(await service.getContentWorkTabs('session-1', content)).toEqual({
      ok: true,
      tabs: [{ tabId: 1, title: 'Tab 1', hostname: 'work.example' }],
    });
    expect(await service.setWorkTarget('session-1', 1, undefined, content)).toEqual({ ok: true });
    expect(stored).toEqual({ sessionId: 'session-1', tabId: 1, incognito: false });
    expect(await service.setWorkTarget('session-1', 5, undefined, content)).toMatchObject({
      ok: false,
    });
    expect(await service.setWorkTarget('old', 1, undefined, content)).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });
  it('rejects stale content lists and untrusted frame or privacy contexts', async (): Promise<void> => {
    const content: chrome.runtime.MessageSender = {
      id: 'extension',
      url: tabs[1]?.url,
      tab: tabs[1],
      frameId: 0,
    };
    expect(await service.getContentWorkTabs('old', content)).toMatchObject({ ok: false });
    for (const unsafe of [
      { ...content, frameId: 1 },
      { ...content, id: 'other' },
      { ...content, url: 'https://changed.example' },
      { ...content, tab: { ...(tabs[1] as chrome.tabs.Tab), incognito: true } },
      popup,
    ]) {
      expect(await service.getContentWorkTabs('session-1', unsafe)).toMatchObject({ ok: false });
      expect(await service.setWorkTarget('session-1', 1, undefined, unsafe)).toMatchObject({
        ok: false,
      });
    }
    expect(await service.setWorkTarget('session-1', 4, undefined, content)).toMatchObject({
      ok: false,
    });
    ports.tabs = async (): Promise<chrome.tabs.Tab[]> => {
      session = { sessionId: 'replacement', mode: 'blacklist' };
      return tabs;
    };
    expect(await service.getContentWorkTabs('session-1', content)).toMatchObject({ ok: false });
    expect(stored).toBeUndefined();
  });
  it('persists only session identity, tab identity and privacy context across worker wake', async (): Promise<void> => {
    expect(await service.setWorkTarget('session-1', 1, 1, popup)).toEqual({ ok: true });
    expect(stored).toEqual({ sessionId: 'session-1', tabId: 1, incognito: false });
    const restarted: WorkTargetService = new WorkTargetService(engine, ports);
    expect(await restarted.getWorkTarget(1, popup)).toEqual({
      ok: true,
      sessionId: 'session-1',
      state: 'ready',
      title: 'Tab 1',
      hostname: 'work.example',
    });
    stored = undefined;
    expect(await restarted.getWorkTarget(1, popup)).toMatchObject({ state: 'missing' });
  });
  it('clears a gate then activates the existing target and its window without navigation', async (): Promise<void> => {
    await service.setWorkTarget('session-1', 1, 1, popup);
    const content: chrome.runtime.MessageSender = {
      id: 'extension',
      url: tabs[1]?.url,
      tab: tabs[1],
      frameId: 0,
    };
    expect(await service.returnToWork('session-1', undefined, content)).toEqual({ ok: true });
    expect(calls).toEqual(['gate', 'tab:1', 'window:1']);
  });
  it('rejects stale sessions, blocked targets, closed tabs and crossed privacy contexts', async (): Promise<void> => {
    await service.setWorkTarget('session-1', 1, 1, popup);
    expect(await service.returnToWork('old', 1, popup)).toMatchObject({ ok: false });
    expect(await service.returnToWork('session-1', 2, popup)).toMatchObject({ ok: false });
    tabs[0] = tab(1, 'https://blocked.example');
    expect(await service.getWorkTarget(1, popup)).toMatchObject({ state: 'unavailable' });
    expect(await service.returnToWork('session-1', 1, popup)).toMatchObject({ ok: false });
    tabs.shift();
    expect(await service.returnToWork('session-1', 1, popup)).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });
  it('does not leak a selected private title into normal content', async (): Promise<void> => {
    await service.setWorkTarget('session-1', 4, 2, popup);
    expect(await service.getWorkTarget(1, popup)).toMatchObject({
      state: 'unavailable',
      title: null,
    });
  });
  it('reports a started session accurately when target persistence fails', async (): Promise<void> => {
    ports.write = async (): Promise<void> => {
      throw new Error('storage failed');
    };
    expect(await service.startSession(config, 1, 1, popup)).toMatchObject({
      ok: false,
      sessionStarted: true,
    });
    expect(session?.sessionId).toBe('session-new');
  });
  it('rejects a stale selection after asynchronous tab lookup changes the session', async (): Promise<void> => {
    ports.tab = async (): Promise<chrome.tabs.Tab> => {
      session = { sessionId: 'other', mode: 'blacklist' };
      return tabs[0] as chrome.tabs.Tab;
    };
    expect(await service.setWorkTarget('session-1', 1, 1, popup)).toMatchObject({ ok: false });
    expect(stored).toBeUndefined();
  });
  it('reports a stale return when the session changes during window focus', async (): Promise<void> => {
    await service.setWorkTarget('session-1', 1, 1, popup);
    ports.focus = async (): Promise<void> => {
      session = null;
    };
    expect(await service.returnToWork('session-1', 1, popup)).toMatchObject({ ok: false });
  });
  it('returns the current session after a target lookup fails during a session change', async (): Promise<void> => {
    await service.setWorkTarget('session-1', 1, 1, popup);
    ports.tab = async (): Promise<chrome.tabs.Tab> => {
      session = { sessionId: 'replacement', mode: 'blacklist' };
      throw new Error('tab closed');
    };
    expect(await service.getWorkTarget(1, popup)).toEqual({
      ok: true,
      sessionId: 'replacement',
      state: 'missing',
      title: null,
    });
  });
  it('explains a closed selection without exposing browser tab identifiers', async (): Promise<void> => {
    ports.tab = async (): Promise<chrome.tabs.Tab> => {
      throw new Error('No tab with id: 7.');
    };
    expect(await service.setWorkTarget('session-1', 7, 1, popup)).toEqual({
      ok: false,
      error: 'That tab is no longer available. Choose another work tab.',
    });
    expect(stored).toBeUndefined();
    expect(calls).toEqual([]);
  });
  it('serialises competing selections so the last request wins', async (): Promise<void> => {
    tabs.push(tab(5, 'https://second.example'));
    const results: Ack[] = await Promise.all([
      service.setWorkTarget('session-1', 1, 1, popup),
      service.setWorkTarget('session-1', 5, 1, popup),
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(stored).toMatchObject({ tabId: 5 });
  });
});

describe('Chrome work target ports', (): void => {
  it('uses only session storage and pushes refresh messages without enforcement sweeps', async (): Promise<void> => {
    const set: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);
    const get: ReturnType<typeof vi.fn> = vi
      .fn()
      .mockResolvedValue({ workTarget: { sessionId: 's', tabId: 7, incognito: false } });
    const sendMessage: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'extension',
        getURL: (path: string): string => `chrome-extension://extension/${path}`,
        sendMessage,
      },
      storage: { session: { get, set } },
      tabs: { query: vi.fn().mockResolvedValue([tab(7, 'https://work.example')]), sendMessage },
    });
    const { chromeWorkTargetPorts }: typeof import('../../../src/background/work-target') =
      await import('../../../src/background/work-target');
    const browserPorts: WorkTargetPorts = chromeWorkTargetPorts({
      workTargetSession: (): WorkSession => ({ sessionId: 's', mode: 'blacklist' }),
    });
    expect(await browserPorts.read()).toMatchObject({ tabId: 7 });
    await browserPorts.write({ sessionId: 's', tabId: 7, incognito: false });
    expect(set).toHaveBeenCalledWith({
      workTarget: { sessionId: 's', tabId: 7, incognito: false },
    });
    browserPorts.broadcast();
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 35);
    });
    expect(sendMessage).toHaveBeenCalledWith({ type: 'workTargetChanged' });
    expect(sendMessage).toHaveBeenCalledWith(7, { type: 'workTargetChanged' });
    vi.unstubAllGlobals();
  });
});

it('refreshes mounted interfaces for relevant tab changes only', async (): Promise<void> => {
  const events: Record<string, (...args: unknown[]) => void> = {};
  const broadcast: ReturnType<typeof vi.fn<() => void>> = vi.fn<() => void>();
  const event: (name: string) => { addListener: (listener: (...args: unknown[]) => void) => void } =
    (name: string): { addListener: (listener: (...args: unknown[]) => void) => void } => ({
      addListener: (listener: (...args: unknown[]) => void): void => {
        events[name] = listener;
      },
    });
  vi.stubGlobal('chrome', {
    tabs: {
      onUpdated: event('updated'),
      onCreated: event('created'),
      onRemoved: event('removed'),
      onReplaced: event('replaced'),
    },
  });
  const { registerWorkTargetListeners }: typeof import('../../../src/background/work-target') =
    await import('../../../src/background/work-target');
  registerWorkTargetListeners((): string => 's', broadcast);
  events.updated?.(1, { status: 'loading' });
  expect(broadcast).not.toHaveBeenCalled();
  events.updated?.(1, { url: 'https://work.example' });
  events.updated?.(1, { title: 'New title' });
  events.created?.(tab(1, 'https://work.example'));
  events.removed?.(1);
  events.replaced?.(2, 1);
  expect(broadcast).toHaveBeenCalledTimes(5);
  vi.unstubAllGlobals();
});

describe('work target notification fanout', (): void => {
  it.each([
    { label: 'idle', sessionId: null, storedSessionId: null, changedTabId: 7, expectedFanout: 0 },
    {
      label: 'active without a target',
      sessionId: 'active',
      storedSessionId: null,
      changedTabId: 7,
      expectedFanout: 0,
    },
    {
      label: 'stale stored target',
      sessionId: 'active',
      storedSessionId: 'old',
      changedTabId: 7,
      expectedFanout: 0,
    },
    {
      label: 'unrelated tab',
      sessionId: 'active',
      storedSessionId: 'active',
      changedTabId: 8,
      expectedFanout: 0,
    },
    {
      label: 'selected tab',
      sessionId: 'active',
      storedSessionId: 'active',
      changedTabId: 7,
      expectedFanout: 100,
    },
  ])(
    'coalesces title updates for $label',
    async ({
      sessionId,
      storedSessionId,
      changedTabId,
      expectedFanout,
    }: {
      sessionId: string | null;
      storedSessionId: string | null;
      changedTabId: number;
      expectedFanout: number;
    }): Promise<void> => {
      let onUpdated: ((tabId: number, change: chrome.tabs.OnUpdatedInfo) => void) | undefined;
      const runtimeMessage: ReturnType<typeof vi.fn<() => Promise<void>>> = vi
        .fn<() => Promise<void>>()
        .mockResolvedValue(undefined);
      const contentMessage: ReturnType<typeof vi.fn<() => Promise<void>>> = vi
        .fn<() => Promise<void>>()
        .mockResolvedValue(undefined);
      const query: ReturnType<typeof vi.fn<() => Promise<chrome.tabs.Tab[]>>> = vi
        .fn<() => Promise<chrome.tabs.Tab[]>>()
        .mockResolvedValue(
          Array.from(
            { length: 100 },
            (_: unknown, index: number): chrome.tabs.Tab => tab(index, 'https://work.example'),
          ),
        );
      vi.stubGlobal('chrome', {
        runtime: { sendMessage: runtimeMessage },
        storage: {
          session: {
            get: vi.fn().mockResolvedValue({
              workTarget:
                storedSessionId === null
                  ? undefined
                  : { sessionId: storedSessionId, tabId: 7, incognito: false },
            }),
          },
        },
        tabs: {
          query,
          sendMessage: contentMessage,
          onUpdated: {
            addListener: (
              listener: (tabId: number, change: chrome.tabs.OnUpdatedInfo) => void,
            ): void => {
              onUpdated = listener;
            },
          },
          onCreated: { addListener: vi.fn() },
          onRemoved: { addListener: vi.fn() },
          onReplaced: { addListener: vi.fn() },
        },
      });
      const { registerWorkTargetListeners }: typeof import('../../../src/background/work-target') =
        await import('../../../src/background/work-target');
      registerWorkTargetListeners((): string | null => sessionId);
      for (let index: number = 0; index < 3; index++)
        onUpdated?.(changedTabId, { title: `Title ${index}` });
      await new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, 35);
      });
      expect(runtimeMessage).toHaveBeenCalledTimes(3);
      expect(contentMessage).toHaveBeenCalledTimes(expectedFanout);
      expect(query).toHaveBeenCalledTimes(expectedFanout === 0 ? 0 : 1);
      vi.unstubAllGlobals();
    },
  );
});

it('coalesces policy notifications and drops a pending fanout when the session ends', async (): Promise<void> => {
  const contentMessage: ReturnType<typeof vi.fn<() => Promise<void>>> = vi
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);
  const query: ReturnType<typeof vi.fn<() => Promise<chrome.tabs.Tab[]>>> = vi
    .fn<() => Promise<chrome.tabs.Tab[]>>()
    .mockResolvedValue([tab(7, 'https://work.example')]);
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: vi.fn().mockResolvedValue(undefined) },
    storage: {
      session: {
        get: vi
          .fn()
          .mockResolvedValue({ workTarget: { sessionId: 'active', tabId: 7, incognito: false } }),
      },
    },
    tabs: { query, sendMessage: contentMessage },
  });
  const { broadcastWorkTargetChanged }: typeof import('../../../src/background/work-target') =
    await import('../../../src/background/work-target');
  broadcastWorkTargetChanged('active');
  await Promise.resolve();
  broadcastWorkTargetChanged('active');
  await new Promise<void>((resolve: () => void): void => {
    setTimeout(resolve, 35);
  });
  expect(query).toHaveBeenCalledTimes(1);
  expect(contentMessage).toHaveBeenCalledTimes(1);
  broadcastWorkTargetChanged('active');
  broadcastWorkTargetChanged(null);
  await new Promise<void>((resolve: () => void): void => {
    setTimeout(resolve, 35);
  });
  expect(query).toHaveBeenCalledTimes(1);
  expect(contentMessage).toHaveBeenCalledTimes(1);
  vi.unstubAllGlobals();
});

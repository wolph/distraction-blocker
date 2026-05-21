import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type WorkSession,
  type WorkTargetEngine,
  type WorkTargetPorts,
  WorkTargetService,
} from '../../../src/background/work-target';
import type { Ack } from '../../../src/shared/messages';
import type { SessionConfig } from '../../../src/shared/types';

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
  it('lists only eligible HTTP tabs in the popup context', async (): Promise<void> => {
    expect(await service.getWorkTabs('blacklist', 1, popup)).toEqual({
      ok: true,
      tabs: [{ tabId: 1, title: 'Tab 1' }],
    });
    expect(await service.getWorkTabs('whitelist', 2, popup)).toEqual({ ok: true, tabs: [] });
  });
  it('rejects content scripts and other extension pages from listing or choosing', async (): Promise<void> => {
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
  it('persists only session identity, tab identity and privacy context across worker wake', async (): Promise<void> => {
    expect(await service.setWorkTarget('session-1', 1, 1, popup)).toEqual({ ok: true });
    expect(stored).toEqual({ sessionId: 'session-1', tabId: 1, incognito: false });
    const restarted: WorkTargetService = new WorkTargetService(engine, ports);
    expect(await restarted.getWorkTarget(1, popup)).toEqual({
      ok: true,
      sessionId: 'session-1',
      state: 'ready',
      title: 'Tab 1',
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
    const browserPorts: WorkTargetPorts = chromeWorkTargetPorts();
    expect(await browserPorts.read()).toMatchObject({ tabId: 7 });
    await browserPorts.write({ sessionId: 's', tabId: 7, incognito: false });
    expect(set).toHaveBeenCalledWith({
      workTarget: { sessionId: 's', tabId: 7, incognito: false },
    });
    browserPorts.broadcast();
    await Promise.resolve();
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
  registerWorkTargetListeners(broadcast);
  events.updated?.(1, { status: 'loading' });
  expect(broadcast).not.toHaveBeenCalled();
  events.updated?.(1, { url: 'https://work.example' });
  events.updated?.(1, { title: 'New title' });
  events.created?.();
  events.removed?.();
  events.replaced?.();
  expect(broadcast).toHaveBeenCalledTimes(5);
  vi.unstubAllGlobals();
});

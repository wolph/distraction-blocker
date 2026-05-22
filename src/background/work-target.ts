import type { Ack, StartSessionResult } from '../shared/messages';
import type { SessionConfig } from '../shared/types';
import {
  parseStoredWorkTarget,
  type StoredWorkTarget,
  type WorkTab,
  type WorkTabsResult,
  type WorkTargetResult,
} from '../shared/work-target';

export interface WorkSession {
  sessionId: string;
  mode: SessionConfig['mode'];
}

export interface WorkTargetEngine {
  workTargetSession(): WorkSession | null;
  workTargetAllowed(url: string, mode: SessionConfig['mode']): boolean;
  runWorkTargetAction(sessionId: string, action: () => Promise<Ack>): Promise<Ack>;
  startSession(
    config: SessionConfig,
    afterStart?: (sessionId: string) => Promise<Ack>,
  ): Promise<Ack>;
  abandonGate(expectedSessionId?: string): Promise<Ack>;
}

export interface WorkTargetPorts {
  extensionId: string;
  popupUrl: string;
  read(): Promise<unknown>;
  write(value: StoredWorkTarget): Promise<void>;
  tabs(): Promise<chrome.tabs.Tab[]>;
  tab(tabId: number): Promise<chrome.tabs.Tab>;
  window(windowId: number): Promise<chrome.windows.Window>;
  activate(tabId: number): Promise<void>;
  focus(windowId: number): Promise<void>;
  broadcast(): void;
}

const SESSION_WORK_TARGET: string = 'workTarget';
const CHOOSE_TARGET: string = 'Choose an available work tab in the Focus Lock popup.';

function failure(error: string): Ack & { ok: false } {
  return { ok: false, error };
}

/** Tab destinations are local to this browser lifetime, independent of session persistence. */
export class WorkTargetService {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly engine: WorkTargetEngine,
    private readonly ports: WorkTargetPorts,
  ) {}

  private serialise<T>(action: () => Promise<T>): Promise<T> {
    const result: Promise<T> = this.queue.then(action, action);
    this.queue = result.then(
      (): void => undefined,
      (): void => undefined,
    );
    return result;
  }

  private isPopup(sender: chrome.runtime.MessageSender): boolean {
    return sender.id === this.ports.extensionId && sender.url === this.ports.popupUrl;
  }

  private async context(
    windowId: number | undefined,
    sender: chrome.runtime.MessageSender,
    popupOnly: boolean = false,
  ): Promise<boolean> {
    if (sender.id !== this.ports.extensionId) throw new Error('Untrusted request.');
    if (this.isPopup(sender)) {
      if (windowId === undefined || (sender.tab !== undefined && sender.tab.windowId !== windowId))
        throw new Error('Open the popup in the browser window containing your work.');
      return (await this.ports.window(windowId)).incognito;
    }
    if (
      popupOnly ||
      windowId !== undefined ||
      sender.tab?.id === undefined ||
      (sender.frameId !== undefined && sender.frameId !== 0)
    )
      throw new Error('Use the Focus Lock popup to choose a work tab.');
    const source: chrome.tabs.Tab = await this.ports.tab(sender.tab.id);
    if (
      source.url !== sender.url ||
      source.incognito !== sender.tab.incognito ||
      !this.http(source.url)
    )
      throw new Error('The requesting page has changed. Reload the page.');
    return source.incognito;
  }

  private http(url: string | undefined): url is string {
    if (url === undefined) return false;
    try {
      return ['http:', 'https:'].includes(new URL(url).protocol);
    } catch {
      return false;
    }
  }

  private suitable(tab: chrome.tabs.Tab, mode: SessionConfig['mode'], incognito: boolean): boolean {
    return (
      tab.id !== undefined &&
      tab.incognito === incognito &&
      this.http(tab.url) &&
      this.engine.workTargetAllowed(tab.url, mode) &&
      (tab.pendingUrl === undefined ||
        (this.http(tab.pendingUrl) && this.engine.workTargetAllowed(tab.pendingUrl, mode)))
    );
  }

  private current(sessionId: string): WorkSession {
    const session: WorkSession | null = this.engine.workTargetSession();
    if (session?.sessionId !== sessionId)
      throw new Error('The focus session has changed. Reopen the popup.');
    return session;
  }

  async getWorkTabs(
    mode: SessionConfig['mode'],
    windowId: number,
    sender: chrome.runtime.MessageSender,
  ): Promise<WorkTabsResult> {
    try {
      const incognito: boolean = await this.context(windowId, sender, true);
      const tabs: chrome.tabs.Tab[] = await this.ports.tabs();
      return {
        ok: true,
        tabs: tabs
          .filter((tab: chrome.tabs.Tab): boolean => this.suitable(tab, mode, incognito))
          .map(
            (tab: chrome.tabs.Tab): WorkTab => ({
              tabId: tab.id as number,
              title: tab.title || new URL(tab.url as string).hostname,
            }),
          ),
      };
    } catch (error: unknown) {
      return failure(this.error(error));
    }
  }

  async getWorkTarget(
    windowId: number | undefined,
    sender: chrome.runtime.MessageSender,
  ): Promise<WorkTargetResult> {
    try {
      const incognito: boolean = await this.context(windowId, sender);
      const stored: StoredWorkTarget | null = parseStoredWorkTarget(await this.ports.read());
      const session: WorkSession | null = this.engine.workTargetSession();
      const base: { ok: true; sessionId: string | null; title: null } = {
        ok: true,
        sessionId: session?.sessionId ?? null,
        title: null,
      };
      if (session === null || stored?.sessionId !== session.sessionId)
        return { ...base, state: 'missing' };
      if (stored.incognito !== incognito) return { ...base, state: 'unavailable' };
      let tab: chrome.tabs.Tab | null = null;
      try {
        tab = await this.ports.tab(stored.tabId);
      } catch {
        // A closed tab is unavailable, but its session may also have ended during the lookup.
      }
      if (this.engine.workTargetSession()?.sessionId !== session.sessionId)
        return this.getWorkTarget(windowId, sender);
      return tab !== null && this.suitable(tab, session.mode, incognito)
        ? { ...base, state: 'ready', title: tab.title || new URL(tab.url as string).hostname }
        : { ...base, state: 'unavailable' };
    } catch (error: unknown) {
      return failure(this.error(error));
    }
  }

  setWorkTarget(
    sessionId: string,
    tabId: number,
    windowId: number,
    sender: chrome.runtime.MessageSender,
  ): Promise<Ack> {
    return this.serialise(async (): Promise<Ack> => {
      try {
        const incognito: boolean = await this.context(windowId, sender, true);
        return await this.engine.runWorkTargetAction(
          sessionId,
          (): Promise<Ack> => this.select(sessionId, tabId, incognito),
        );
      } catch (error: unknown) {
        return failure(this.error(error));
      }
    });
  }

  private async select(sessionId: string, tabId: number, incognito: boolean): Promise<Ack> {
    this.current(sessionId);
    const tab: chrome.tabs.Tab = await this.ports.tab(tabId);
    if (!this.suitable(tab, this.current(sessionId).mode, incognito)) return failure(CHOOSE_TARGET);
    await this.ports.write({ sessionId, tabId, incognito });
    this.current(sessionId);
    this.ports.broadcast();
    return { ok: true };
  }

  startSession(
    config: SessionConfig,
    workTabId: number,
    windowId: number,
    sender: chrome.runtime.MessageSender,
  ): Promise<StartSessionResult> {
    return this.serialise(async (): Promise<StartSessionResult> => {
      let started: boolean = false;
      try {
        const incognito: boolean = await this.context(windowId, sender, true);
        const tab: chrome.tabs.Tab = await this.ports.tab(workTabId);
        if (!this.suitable(tab, config.mode, incognito)) return failure(CHOOSE_TARGET);
        const result: Ack = await this.engine.startSession(
          config,
          async (sessionId: string): Promise<Ack> => {
            started = true;
            return this.select(sessionId, workTabId, incognito);
          },
        );
        return !result.ok && started ? { ...result, sessionStarted: true } : result;
      } catch (error: unknown) {
        const result: Ack & { ok: false } = failure(
          started
            ? `Session started, but the work tab could not be saved. ${CHOOSE_TARGET}`
            : this.error(error),
        );
        return started ? { ...result, sessionStarted: true } : result;
      }
    });
  }

  returnToWork(
    sessionId: string,
    windowId: number | undefined,
    sender: chrome.runtime.MessageSender,
  ): Promise<Ack> {
    return this.serialise(async (): Promise<Ack> => {
      try {
        const incognito: boolean = await this.context(windowId, sender);
        return await this.engine.runWorkTargetAction(sessionId, async (): Promise<Ack> => {
          const stored: StoredWorkTarget | null = parseStoredWorkTarget(await this.ports.read());
          this.current(sessionId);
          if (stored?.sessionId !== sessionId || stored.incognito !== incognito)
            return failure(CHOOSE_TARGET);
          const tab: chrome.tabs.Tab = await this.ports.tab(stored.tabId);
          if (!this.suitable(tab, this.current(sessionId).mode, incognito))
            return failure(CHOOSE_TARGET);
          const cleared: Ack = await this.engine.abandonGate(sessionId);
          if (!cleared.ok) return cleared;
          this.current(sessionId);
          const latest: chrome.tabs.Tab = await this.ports.tab(stored.tabId);
          if (!this.suitable(latest, this.current(sessionId).mode, incognito))
            return failure(CHOOSE_TARGET);
          await this.ports.activate(stored.tabId);
          this.current(sessionId);
          await this.ports.focus(latest.windowId);
          this.current(sessionId);
          return { ok: true };
        });
      } catch (error: unknown) {
        return failure(`${this.error(error)} ${CHOOSE_TARGET}`);
      }
    });
  }

  private error(error: unknown): string {
    return error instanceof Error ? error.message : 'The work tab is unavailable.';
  }
}

export function chromeWorkTargetPorts(): WorkTargetPorts {
  return {
    extensionId: chrome.runtime.id,
    popupUrl: chrome.runtime.getURL('src/popup/popup.html'),
    read: async (): Promise<unknown> =>
      (await chrome.storage.session.get(SESSION_WORK_TARGET))[SESSION_WORK_TARGET],
    write: (value: StoredWorkTarget): Promise<void> =>
      chrome.storage.session.set({ [SESSION_WORK_TARGET]: value }),
    tabs: (): Promise<chrome.tabs.Tab[]> => chrome.tabs.query({}),
    tab: (tabId: number): Promise<chrome.tabs.Tab> => chrome.tabs.get(tabId),
    window: (windowId: number): Promise<chrome.windows.Window> => chrome.windows.get(windowId),
    activate: async (tabId: number): Promise<void> => {
      await chrome.tabs.update(tabId, { active: true });
    },
    focus: async (windowId: number): Promise<void> => {
      await chrome.windows.update(windowId, { focused: true });
    },
    broadcast: broadcastWorkTargetChanged,
  };
}

export function broadcastWorkTargetChanged(): void {
  void chrome.runtime.sendMessage({ type: 'workTargetChanged' }).catch((): void => undefined);
  void chrome.tabs
    .query({})
    .then(async (tabs: chrome.tabs.Tab[]): Promise<void> => {
      await Promise.all(
        tabs
          .filter((tab: chrome.tabs.Tab): boolean => tab.id !== undefined)
          .map(async (tab: chrome.tabs.Tab): Promise<void> => {
            await chrome.tabs
              .sendMessage(tab.id as number, { type: 'workTargetChanged' })
              .catch((): void => undefined);
          }),
      );
    })
    .catch((): void => undefined);
}

export function registerWorkTargetListeners(
  broadcast: () => void = broadcastWorkTargetChanged,
): void {
  chrome.tabs.onUpdated.addListener((_tabId: number, change: chrome.tabs.OnUpdatedInfo): void => {
    if (change.url !== undefined || change.title !== undefined || change.status === 'complete')
      broadcast();
  });
  chrome.tabs.onCreated.addListener(broadcast);
  chrome.tabs.onRemoved.addListener(broadcast);
  chrome.tabs.onReplaced.addListener(broadcast);
}

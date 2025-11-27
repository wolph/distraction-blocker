import { beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../../src/background/main';
import type { RuntimeStateV2 } from '../../../src/background/runtime-v2-types';
import { parseRuntimeStateV2 } from '../../../src/background/runtime-v2-validation';
import { DEFAULT_LISTS, DEFAULT_SETTINGS, DEFAULT_SETUP } from '../../../src/shared/constants';
import type { DocumentContentCommand } from '../../../src/shared/enforcement-v2';
import type { Request } from '../../../src/shared/messages';
import {
  LOCAL_EVENTS,
  LOCAL_INSTALL_MARKER,
  LOCAL_LISTS,
  LOCAL_RUNTIME,
  LOCAL_RUNTIME_MIGRATION,
  LOCAL_RUNTIME_SCHEMA,
  LOCAL_SETTINGS,
  LOCAL_SETUP,
} from '../../../src/shared/storage-keys';
import type { SessionConfigV2, SessionSnapshotV2 } from '../../../src/shared/types';
import { appliedResponseFor, epochResetResponseFor } from './runtime-ports-fake';

// The worker imports the content script as a built asset. Under vitest that module would evaluate
// against a document that does not exist here, so the asset is stubbed with its built path.
vi.mock('../../../src/content/index.iife.ts?script&iife', () => ({
  default: 'assets/index.iife-test.js',
}));

/** One document the fake browser is showing, which answers enforcement commands like the real one. */
interface FakeDocument {
  tabId: number;
  documentId: string;
  url: string;
  /** Every command the worker sent to this document, in order. */
  received: DocumentContentCommand[];
}

interface AlarmRow {
  name: string;
  when: number | null;
  periodInMinutes: number | null;
}

interface WorkerHarness {
  local: Record<string, unknown>;
  sync: Record<string, unknown>;
  syncWrites: Array<Record<string, unknown>>;
  documents: FakeDocument[];
  alarms: Map<string, AlarmRow>;
  broadcasts: SessionSnapshotV2[];
  badges: string[];
  sounds: string[];
  notices: Array<{ title: string; body: string }>;
  send(request: Request, sender?: chrome.runtime.MessageSender): Promise<unknown>;
  fireAlarm(name: string): Promise<void>;
  navigate(document: FakeDocument, kind: 'committed' | 'history'): Promise<void>;
  runtime(): RuntimeStateV2;
  settle(): Promise<void>;
}

const NOW: number = new Date(2026, 8, 3, 9, 0, 0, 0).getTime();
const CONTENT_SENDER: string = 'https://facebook.com/feed';

let clock: number = NOW;

function tabSender(document: FakeDocument): chrome.runtime.MessageSender {
  return {
    tab: { id: document.tabId } as chrome.tabs.Tab,
    documentId: document.documentId,
    url: document.url,
  } as chrome.runtime.MessageSender;
}

/** Boots one worker over an in-memory browser and returns the handles a scenario drives it with. */
async function bootWorker(seed: Record<string, unknown> = {}): Promise<WorkerHarness> {
  clock = NOW;
  const local: Record<string, unknown> = structuredClone(seed);
  const sync: Record<string, unknown> = {};
  const syncWrites: Array<Record<string, unknown>> = [];
  const documents: FakeDocument[] = [];
  const alarms: Map<string, AlarmRow> = new Map<string, AlarmRow>();
  const broadcasts: SessionSnapshotV2[] = [];
  const badges: string[] = [];
  const sounds: string[] = [];
  const notices: Array<{ title: string; body: string }> = [];
  let messageListener:
    | ((
        request: unknown,
        sender: chrome.runtime.MessageSender,
        respond: (response: unknown) => void,
      ) => boolean)
    | null = null;
  let alarmListener: ((alarm: chrome.alarms.Alarm) => void) | null = null;
  let committedListener: ((details: unknown) => void) | null = null;
  let historyListener: ((details: unknown) => void) | null = null;

  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      getContext(): Record<string, unknown> {
        const noop = (): void => undefined;
        return new Proxy(
          { canvas: {} },
          {
            get: (target: Record<string, unknown>, key: string): unknown =>
              key === 'getImageData'
                ? (): { data: Uint8ClampedArray } => ({ data: new Uint8ClampedArray(4) })
                : (target[key] ?? noop),
            set: (): boolean => true,
          },
        );
      }
    },
  );
  vi.stubGlobal('chrome', {
    action: {
      setBadgeText: vi.fn(async (details: { text: string }): Promise<void> => {
        badges.push(details.text);
      }),
      setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
      setIcon: vi.fn().mockResolvedValue(undefined),
      setTitle: vi.fn().mockResolvedValue(undefined),
    },
    alarms: {
      create: vi.fn(
        async (name: string, info: { when?: number; periodInMinutes?: number }): Promise<void> => {
          alarms.set(name, {
            name,
            when: info.when ?? null,
            periodInMinutes: info.periodInMinutes ?? null,
          });
        },
      ),
      get: vi.fn(async (name: string): Promise<chrome.alarms.Alarm | undefined> => {
        const row: AlarmRow | undefined = alarms.get(name);
        return row === undefined
          ? undefined
          : ({
              name: row.name,
              scheduledTime: row.when ?? clock,
              periodInMinutes: row.periodInMinutes ?? undefined,
            } as chrome.alarms.Alarm);
      }),
      clear: vi.fn(async (name: string): Promise<boolean> => alarms.delete(name)),
      onAlarm: {
        addListener: vi.fn((listener: (alarm: chrome.alarms.Alarm) => void): void => {
          alarmListener = listener;
        }),
      },
    },
    notifications: {
      create: vi.fn(
        async (_id: string, options: { title: string; message: string }): Promise<void> => {
          notices.push({ title: options.title, body: options.message });
        },
      ),
    },
    offscreen: {
      hasDocument: vi.fn().mockResolvedValue(false),
      createDocument: vi.fn().mockResolvedValue(undefined),
      Reason: { AUDIO_PLAYBACK: 'AUDIO_PLAYBACK' },
    },
    permissions: {
      contains: vi.fn().mockResolvedValue(true),
      onAdded: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    runtime: {
      id: 'test-extension',
      getURL: vi.fn((path: string): string => `chrome-extension://test/${path}`),
      getManifest: vi.fn(() => ({ version: '1.0.0' })),
      onInstalled: { addListener: vi.fn() },
      onMessage: {
        addListener: vi.fn(
          (
            listener: (
              request: unknown,
              sender: chrome.runtime.MessageSender,
              respond: (response: unknown) => void,
            ) => boolean,
          ): void => {
            messageListener = listener;
          },
        ),
      },
      sendMessage: vi.fn(async (message: unknown): Promise<void> => {
        const broadcast = message as { type?: string; snapshot?: SessionSnapshotV2 };
        if (broadcast.type === 'stateChanged' && broadcast.snapshot !== undefined) {
          broadcasts.push(structuredClone(broadcast.snapshot));
        }
      }),
    },
    scripting: {
      executeScript: vi.fn().mockResolvedValue([]),
      getRegisteredContentScripts: vi.fn().mockResolvedValue([]),
      registerContentScripts: vi.fn().mockResolvedValue(undefined),
      unregisterContentScripts: vi.fn().mockResolvedValue(undefined),
    },
    storage: {
      onChanged: { addListener: vi.fn() },
      local: {
        get: vi.fn(async (keys: string | string[] | null): Promise<Record<string, unknown>> => {
          if (keys === null) return structuredClone(local);
          const requested: string[] = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            requested
              .filter((key: string): boolean => Object.hasOwn(local, key))
              .map((key: string): [string, unknown] => [key, structuredClone(local[key])]),
          );
        }),
        set: vi.fn(async (items: Record<string, unknown>): Promise<void> => {
          Object.assign(local, structuredClone(items));
        }),
        remove: vi.fn(async (keys: string | string[]): Promise<void> => {
          for (const key of typeof keys === 'string' ? [keys] : keys) delete local[key];
        }),
      },
      sync: {
        get: vi.fn(async (keys: string | string[] | null): Promise<Record<string, unknown>> => {
          if (keys === null) return structuredClone(sync);
          const requested: string[] = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            requested
              .filter((key: string): boolean => Object.hasOwn(sync, key))
              .map((key: string): [string, unknown] => [key, structuredClone(sync[key])]),
          );
        }),
        set: vi.fn(async (items: Record<string, unknown>): Promise<void> => {
          syncWrites.push(structuredClone(items));
          Object.assign(sync, structuredClone(items));
        }),
        remove: vi.fn(async (keys: string | string[]): Promise<void> => {
          for (const key of typeof keys === 'string' ? [keys] : keys) delete sync[key];
        }),
        getBytesInUse: vi.fn().mockResolvedValue(0),
      },
    },
    tabs: {
      create: vi.fn().mockResolvedValue({}),
      get: vi.fn(async (tabId: number): Promise<chrome.tabs.Tab> => {
        const row: FakeDocument | undefined = documents.find(
          (candidate: FakeDocument): boolean => candidate.tabId === tabId,
        );
        if (row === undefined) throw new Error(`no tab ${tabId}`);
        return { id: row.tabId, url: row.url } as chrome.tabs.Tab;
      }),
      query: vi.fn(
        async (): Promise<chrome.tabs.Tab[]> =>
          documents.map(
            (row: FakeDocument): chrome.tabs.Tab =>
              ({ id: row.tabId, url: row.url }) as chrome.tabs.Tab,
          ),
      ),
      reload: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn(
        async (
          tabId: number,
          message: DocumentContentCommand,
          options?: { documentId?: string },
        ): Promise<unknown> => {
          const row: FakeDocument | undefined = documents.find(
            (candidate: FakeDocument): boolean =>
              candidate.tabId === tabId && candidate.documentId === options?.documentId,
          );
          if (row === undefined) throw new Error('Could not establish connection.');
          row.received.push(structuredClone(message));
          return message.command === 'apply-enforcement'
            ? appliedResponseFor(message, clock)
            : epochResetResponseFor(message, clock);
        },
      ),
      update: vi.fn().mockResolvedValue({}),
      onRemoved: { addListener: vi.fn() },
    },
    webNavigation: {
      getFrame: vi.fn(
        async (details: { tabId: number }): Promise<{ documentId: string } | null> => {
          const row: FakeDocument | undefined = documents.find(
            (candidate: FakeDocument): boolean => candidate.tabId === details.tabId,
          );
          return row === undefined ? null : { documentId: row.documentId };
        },
      ),
      onCommitted: {
        addListener: vi.fn((listener: (details: unknown) => void): void => {
          committedListener = listener;
        }),
      },
      onHistoryStateUpdated: {
        addListener: vi.fn((listener: (details: unknown) => void): void => {
          historyListener = listener;
        }),
      },
    },
    windows: { update: vi.fn().mockResolvedValue({}) },
  });

  main();
  const settle = async (): Promise<void> => {
    for (let turn: number = 0; turn < 400; turn += 1) await Promise.resolve();
  };
  await settle();

  return {
    local,
    sync,
    syncWrites,
    documents,
    alarms,
    broadcasts,
    badges,
    sounds,
    notices,
    settle,
    runtime: (): RuntimeStateV2 => {
      const stored: RuntimeStateV2 | null = parseRuntimeStateV2(local[LOCAL_RUNTIME]);
      if (stored === null) throw new Error('the worker persisted no valid v2 runtime');
      return stored;
    },
    send: async (request: Request, sender?: chrome.runtime.MessageSender): Promise<unknown> => {
      if (messageListener === null) throw new Error('the worker registered no message listener');
      return await new Promise<unknown>((resolve: (value: unknown) => void): void => {
        const handled: boolean = (messageListener as NonNullable<typeof messageListener>)(
          request,
          sender ?? ({} as chrome.runtime.MessageSender),
          resolve,
        );
        if (!handled) resolve(undefined);
      });
    },
    fireAlarm: async (name: string): Promise<void> => {
      if (alarmListener === null) throw new Error('the worker registered no alarm listener');
      alarmListener({ name, scheduledTime: clock } as chrome.alarms.Alarm);
      await settle();
    },
    navigate: async (document: FakeDocument, kind: 'committed' | 'history'): Promise<void> => {
      const listener = kind === 'committed' ? committedListener : historyListener;
      if (listener === null) throw new Error('the worker registered no navigation listener');
      listener({
        tabId: document.tabId,
        frameId: 0,
        url: document.url,
        documentId: document.documentId,
      });
      await settle();
    },
  };
}

function indefiniteConfig(): SessionConfigV2 {
  return {
    mode: 'blacklist',
    strictness: 'flexible',
    duration: { kind: 'until-stopped' },
    cycling: null,
    intention: 'Ship the cutover',
    source: 'manual',
    scheduleOccurrence: null,
    rules: {
      baselineRevision: 'baseline-1',
      baselineCategories: DEFAULT_LISTS.categories,
      categories: { ...DEFAULT_LISTS.categories, social: true },
      exclusions: {},
      permanentBlacklist: [],
      permanentAllowlist: [],
      sessionBlacklist: [],
      sessionAllowlist: [],
    },
  };
}

/** A profile that finished setup with website blocking live, which is what a session needs. */
function installedSeed(): Record<string, unknown> {
  return {
    [LOCAL_INSTALL_MARKER]: { installedAt: NOW - 86_400_000, version: '1.0.0' },
    [LOCAL_SETTINGS]: DEFAULT_SETTINGS,
    [LOCAL_LISTS]: DEFAULT_LISTS,
    [LOCAL_SETUP]: {
      ...DEFAULT_SETUP,
      completed: true,
      websiteAccess: 'granted',
      blockingRegistration: 'ready',
      storageMode: 'local',
    },
  };
}

describe('worker cutover to v2 session authority', (): void => {
  beforeEach((): void => {
    vi.unstubAllGlobals();
  });

  it('boots an empty v2 runtime with the schema marker and the tick alarm', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());

    expect(worker.runtime().session).toBeNull();
    expect(worker.runtime().runtimeSchemaVersion).toBe(2);
    expect(worker.local[LOCAL_RUNTIME_SCHEMA]).toEqual({ runtimeSchemaVersion: 2 });
    expect(worker.alarms.get('tick')?.periodInMinutes).toBe(1);

    const snapshot = (await worker.send({ type: 'getSnapshot' } as Request)) as SessionSnapshotV2;
    expect(snapshot.lifecycle.kind).toBe('idle');
  });

  it('refuses a v1 duration config with invalid-request', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    const response = await worker.send({
      type: 'startSession',
      config: { ...indefiniteConfig(), durationMin: 25 },
    } as unknown as Request);

    expect(response).toEqual({ ok: false, code: 'invalid-request' });
  });

  it('walks the start transition, sends both views, and publishes an indefinite session', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    worker.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });

    const response = await worker.send({
      type: 'startSession',
      config: indefiniteConfig(),
    } as Request);
    await worker.settle();

    expect(response).toEqual({ ok: true, code: 'ok' });
    const runtime: RuntimeStateV2 = worker.runtime();
    expect(runtime.session?.config.duration).toEqual({ kind: 'until-stopped' });
    expect(runtime.pendingEnforcementTransition).toBeNull();
    // An indefinite session has no phase boundary, so it owns no phase alarm.
    expect(worker.alarms.has('phase')).toBe(false);
    const presentations: string[] =
      worker.documents[0]?.received
        .filter((command): boolean => command.command === 'apply-enforcement')
        .map((command): string =>
          command.command === 'apply-enforcement' ? command.presentation : 'reset',
        ) ?? [];
    expect(presentations).toContain('starting');
    expect(presentations).toContain('active');
    const published: SessionSnapshotV2 | undefined = worker.broadcasts.at(-1);
    expect(published?.lifecycle.kind).toBe('active');
    // An indefinite session has no countdown, so the badge says it is on and nothing more.
    expect(worker.badges).toContain('ON');
  });

  it('ends an indefinite session as manual-completed with no sound or notice', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();
    const sessionId: string = worker.runtime().session?.sessionId ?? '';

    const response = await worker.send({ type: 'requestSessionEnd' } as Request);
    await worker.settle();

    expect(response).toEqual({ ok: true, code: 'ok' });
    expect(worker.runtime().session).toBeNull();
    const events = worker.local[LOCAL_EVENTS] as Array<Record<string, unknown>>;
    expect(
      events.some(
        (event: Record<string, unknown>): boolean => event.eventId === `${sessionId}:end`,
      ),
    ).toBe(true);
    expect(worker.sounds).toHaveLength(0);
    expect(worker.notices).toHaveLength(0);
    expect(worker.broadcasts.at(-1)?.lifecycle.kind).toBe('idle');
  });

  it('answers getBlockState with the reset before the enforcement command', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    const document: FakeDocument = {
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    };
    worker.documents.push(document);
    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();

    // A document the start never reached has not acknowledged the epoch, so it is reset first.
    const fresh: FakeDocument = {
      tabId: 12,
      documentId: 'document-2',
      url: CONTENT_SENDER,
      received: [],
    };
    worker.documents.push(fresh);
    const first = (await worker.send(
      { type: 'getBlockState', url: fresh.url, docState: 'fresh' } as Request,
      tabSender(fresh),
    )) as { commands: DocumentContentCommand[] };
    // A push is what records the epoch acknowledgement, so the pull after it carries no reset.
    await worker.navigate(fresh, 'committed');
    const second = (await worker.send(
      { type: 'getBlockState', url: fresh.url, docState: 'loaded' } as Request,
      tabSender(fresh),
    )) as { commands: DocumentContentCommand[] };
    const stranger = (await worker.send(
      { type: 'getBlockState', url: document.url, docState: 'fresh' } as Request,
      { url: 'https://other.example/' } as chrome.runtime.MessageSender,
    )) as { commands: DocumentContentCommand[] };

    expect(first.commands.map((command): string => command.command)).toEqual([
      'reset-enforcement-epoch',
      'apply-enforcement',
    ]);
    expect(second.commands.map((command): string => command.command)).toEqual([
      'apply-enforcement',
    ]);
    expect(stranger.commands).toEqual([]);
  });

  it('never writes runtime or event keys into sync', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();
    await worker.send({ type: 'requestSessionEnd' } as Request);
    await worker.settle();

    const forbidden: string[] = [
      LOCAL_RUNTIME,
      LOCAL_EVENTS,
      LOCAL_RUNTIME_SCHEMA,
      LOCAL_RUNTIME_MIGRATION,
    ];
    for (const write of worker.syncWrites) {
      for (const key of Object.keys(write)) expect(forbidden).not.toContain(key);
      expect(JSON.stringify(write)).not.toContain('pendingEnforcementTransition');
    }
  });
});

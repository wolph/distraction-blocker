import { beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../../src/background/main';
import type { RuntimeStateV2 } from '../../../src/background/runtime-v2-types';
import { parseRuntimeStateV2 } from '../../../src/background/runtime-v2-validation';
import { emptyRuntime } from '../../../src/background/stores';
import { startSession as startLegacySession } from '../../../src/core/session';
import {
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  DEFAULT_SETUP,
  rulesFromLists,
} from '../../../src/shared/constants';
import type { DocumentContentCommand } from '../../../src/shared/enforcement-v2';
import type { Request } from '../../../src/shared/messages';
import { isEventRecord } from '../../../src/shared/runtime-validation';
import {
  LOCAL_BANK,
  LOCAL_EVENTS,
  LOCAL_INSTALL_MARKER,
  LOCAL_LISTS,
  LOCAL_RUNTIME,
  LOCAL_RUNTIME_MIGRATION,
  LOCAL_RUNTIME_SCHEMA,
  LOCAL_SETTINGS,
  LOCAL_SETUP,
} from '../../../src/shared/storage-keys';
import type {
  NormalizedSessionConfigV1,
  SessionConfigV2,
  SessionSnapshotV2,
} from '../../../src/shared/types';
import { appliedResponseFor, epochResetResponseFor } from './runtime-ports-fake';
import { pendingTransition, timedFocusSession, transitionRuntime } from './runtime-v2-fixtures';

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

interface BootOptions {
  /** False makes the icon draw fail, which is what a worker without a canvas looks like. */
  canvas?: boolean;
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
  /** Every transition stage that became durable, in write order. */
  stages(): string[];
  /** The stored event log, newest last. */
  events(): Array<Record<string, unknown>>;
  /** Takes website access away, the way a revoked permission does. */
  revokeWebsiteAccess(): void;
  /** How many times the worker has written local storage, which is how a no-op wake is read. */
  writes(): number;
  /** Every mute the worker set, which is the sweep's own effect. */
  mutes(): Array<{ tabId: number; muted: boolean }>;
  settle(): Promise<void>;
}

const NOW: number = new Date(2026, 8, 3, 9, 0, 0, 0).getTime();
const CONTENT_SENDER: string = 'https://facebook.com/feed';
const SESSION_UUID: string = '10000000-0000-4000-8000-000000000001';
const DEFAULT_LISTS_BASELINE: string = rulesFromLists(DEFAULT_LISTS).baselineRevision;

let clock: number = NOW;

function tabSender(document: FakeDocument): chrome.runtime.MessageSender {
  return {
    tab: { id: document.tabId } as chrome.tabs.Tab,
    documentId: document.documentId,
    url: document.url,
  } as chrome.runtime.MessageSender;
}

/** Boots one worker over an in-memory browser and returns the handles a scenario drives it with. */
async function bootWorker(
  seed: Record<string, unknown> = {},
  options: BootOptions = {},
): Promise<WorkerHarness> {
  clock = NOW;
  const stages: string[] = [];
  let websiteAccess: boolean = true;
  let localWrites: number = 0;
  const muteCalls: Array<{ tabId: number; muted: boolean }> = [];
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
      constructor() {
        if (options.canvas === false) throw new Error('no canvas in this worker');
      }

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
      contains: vi.fn(async (): Promise<boolean> => websiteAccess),
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
        const broadcast = message as {
          type?: string;
          snapshot?: SessionSnapshotV2;
          sound?: string;
        };
        if (broadcast.type === 'stateChanged' && broadcast.snapshot !== undefined) {
          broadcasts.push(structuredClone(broadcast.snapshot));
        }
        // The offscreen page is the audience for a sound, and this stub is standing in for it.
        if (broadcast.type === 'playSound' && broadcast.sound !== undefined) {
          sounds.push(broadcast.sound);
        }
      }),
    },
    scripting: {
      executeScript: vi.fn().mockResolvedValue([]),
      getRegisteredContentScripts: vi.fn(
        async (): Promise<chrome.scripting.RegisteredContentScript[]> =>
          websiteAccess
            ? [{ id: 'focus-lock-content' } as chrome.scripting.RegisteredContentScript]
            : [],
      ),
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
          localWrites += 1;
          Object.assign(local, structuredClone(items));
          const runtime: RuntimeStateV2 | null = parseRuntimeStateV2(local[LOCAL_RUNTIME]);
          const stage: string | undefined = runtime?.pendingEnforcementTransition?.stage;
          if (stage !== undefined && stages.at(-1) !== stage) stages.push(stage);
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
      update: vi.fn(async (tabId: number, props: { muted?: boolean }): Promise<unknown> => {
        if (props.muted !== undefined) muteCalls.push({ tabId, muted: props.muted });
        return {};
      }),
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
    stages: (): string[] => [...stages],
    revokeWebsiteAccess: (): void => {
      websiteAccess = false;
    },
    writes: (): number => localWrites,
    mutes: (): Array<{ tabId: number; muted: boolean }> => [...muteCalls],
    events: (): Array<Record<string, unknown>> =>
      (local[LOCAL_EVENTS] as Array<Record<string, unknown>> | undefined) ?? [],
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

/** The attempts the stored day has counted, which is what the popup and the overlay report. */
function attemptsOf(worker: WorkerHarness): number {
  const agg = worker.runtime().todayAgg;
  if (agg === null) return 0;
  return Object.values(agg.attempts).reduce(
    (total: number, count: number): number => total + count,
    0,
  );
}

/** The command map key one document owns. */
function documentKeyOf(document: FakeDocument): string {
  return `${document.tabId}:${document.documentId}`;
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
    // The pull records the acknowledgement the same way a push does, so no second reset goes out.
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
    // The page is on a blocked host, so what it is handed blocks it.
    const enforcement = first.commands.find(
      (command): boolean => command.command === 'apply-enforcement',
    );
    expect(enforcement?.command === 'apply-enforcement' ? enforcement.verdict.blocked : null).toBe(
      true,
    );
    expect(enforcement?.command === 'apply-enforcement' ? enforcement.presentation : null).toBe(
      'active',
    );
    expect(second.commands.map((command): string => command.command)).toEqual([
      'apply-enforcement',
    ]);
    expect(stranger.commands).toEqual([]);
  });

  it('records the stage sequence and the events one start and end produce', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    worker.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });

    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();
    const sessionId: string = worker.runtime().session?.sessionId ?? '';
    const stages: string[] = worker.stages();

    // Every stage the machine passes through is durable, in order, and publication clears it.
    expect(stages).toEqual([
      'prepared',
      'registration-audited',
      'starting-verified',
      'committed-pending-verification',
      'alarm-ready',
      'active-verified',
    ]);
    expect(worker.runtime().pendingEnforcementTransition).toBeNull();

    await worker.send({ type: 'requestSessionEnd' } as Request);
    await worker.settle();

    // One start event and one end event, each with the id the session owns.
    const started = worker.events().filter((event): boolean => event.t === 'sessionStarted');
    const ended = worker.events().filter((event): boolean => event.t === 'sessionEnded');
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ eventId: `${sessionId}:start`, sessionId });
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      eventId: `${sessionId}:end`,
      outcome: 'completed',
      reason: 'manual-completed',
    });
  });

  it('publishes both clocks and the phase alarm for a timed cycling start', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    worker.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });
    const config: SessionConfigV2 = {
      ...indefiniteConfig(),
      duration: { kind: 'timed', minutes: 50 },
      cycling: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 },
    };

    await worker.send({ type: 'startSession', config } as Request);
    await worker.settle();

    const published: SessionSnapshotV2 | undefined = worker.broadcasts.at(-1);
    const activatedAt: number = published?.phaseStartedAt ?? 0;
    expect(published?.lifecycle.kind).toBe('active');
    expect(published?.phaseEndsAt).toBe(activatedAt + 1_500_000);
    expect(published?.sessionEndsAt).toBe(activatedAt + 3_000_000);
    // The phase boundary owns an alarm, and it is the boundary the snapshot reports.
    expect(worker.alarms.get('phase')?.when).toBe(activatedAt + 1_500_000);
  });

  it('records one attempt per blocked navigation and honors the debounce', async (): Promise<void> => {
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

    await worker.send(
      { type: 'getBlockState', url: document.url, docState: 'fresh' } as Request,
      tabSender(document),
    );
    await worker.settle();
    const afterFirst: number = attemptsOf(worker);
    // The same document again inside the debounce window records nothing more.
    await worker.send(
      { type: 'getBlockState', url: document.url, docState: 'fresh' } as Request,
      tabSender(document),
    );
    await worker.settle();

    expect(afterFirst).toBe(1);
    expect(attemptsOf(worker)).toBe(1);
    expect(worker.events().filter((event): boolean => event.t === 'attempt')).toHaveLength(1);
  });

  it('keeps the badge when the icon cannot be drawn', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed(), { canvas: false });
    worker.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });

    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();

    // Drawing needs a canvas and the badge needs nothing, so one failing must not take the other.
    expect(worker.badges).toContain('ON');
  });

  it('validates a long mixed event log without recursing', async (): Promise<void> => {
    const legacy: unknown = {
      t: 'sessionStarted',
      at: NOW,
      source: 'manual',
      mode: 'blacklist',
      strictness: 'flexible',
      durationMin: 25,
      intention: 'legacy',
    };
    const started: unknown = {
      version: 2,
      t: 'sessionStarted',
      eventId: `${SESSION_UUID}:start`,
      at: NOW,
      sessionId: SESSION_UUID,
      source: 'manual',
      mode: 'blacklist',
      strictness: 'flexible',
      duration: { kind: 'until-stopped' },
      intention: 'v2',
      scheduleOccurrence: null,
    };
    const ended: unknown = {
      version: 2,
      t: 'sessionEnded',
      eventId: `${SESSION_UUID}:end`,
      at: NOW + 1_000,
      sessionId: SESSION_UUID,
      outcome: 'completed',
      reason: 'manual-completed',
      focusedMs: 1_000,
      duration: { kind: 'until-stopped' },
      source: 'manual',
      scheduleOccurrence: null,
    };
    const log: unknown[] = [];
    for (let index: number = 0; index < 10_000; index += 1) {
      log.push([legacy, started, ended][index % 3]);
    }

    expect(log.every(isEventRecord)).toBe(true);
    // A legacy shape wearing the v2 version but no id is still not a v2 record.
    expect(isEventRecord({ ...(legacy as Record<string, unknown>), version: 2 })).toBe(false);
  });

  it('migrates a stored v1 session and publishes it as active', async (): Promise<void> => {
    // The worker reads the real clock, so the stored session is seeded against it: a session that
    // already ran out would migrate straight into its closure instead.
    const startedAt: number = Date.now() - 300_000;
    const legacyConfig: NormalizedSessionConfigV1 = {
      mode: 'blacklist',
      strictness: 'friction',
      durationMin: 25,
      cycling: null,
      intention: 'migrated session',
      source: 'manual',
      scheduleEntryId: null,
      rules: {
        baselineRevision: DEFAULT_LISTS_BASELINE,
        baselineCategories: DEFAULT_LISTS.categories,
        categories: { ...DEFAULT_LISTS.categories, social: true },
        exclusions: {},
        permanentBlacklist: [],
        permanentAllowlist: [],
        sessionBlacklist: [],
        sessionAllowlist: [],
      },
    };
    const legacyRuntime: Record<string, unknown> = {
      ...emptyRuntime(Date.now()),
      session: startLegacySession(legacyConfig, startedAt, SESSION_UUID),
    };
    const worker: WorkerHarness = await bootWorker({
      ...installedSeed(),
      [LOCAL_RUNTIME]: legacyRuntime,
    });

    // The stored v1 session is the authority the boot migrates, and recovery publishes it.
    const runtime: RuntimeStateV2 = worker.runtime();
    expect(runtime.runtimeSchemaVersion).toBe(2);
    expect(runtime.session?.config.duration).toEqual({ kind: 'timed', minutes: 25 });
    expect(runtime.session?.config.intention).toBe('migrated session');
    expect(runtime.session?.sessionId).toBe(SESSION_UUID);
    // The migration checkpoint is cleared once the migration it recorded is finished.
    expect(worker.local[LOCAL_RUNTIME_MIGRATION]).toBeUndefined();
    expect(worker.local[LOCAL_RUNTIME_SCHEMA]).toEqual({ runtimeSchemaVersion: 2 });
  });

  it('refreshes every live view when the theme changes', async (): Promise<void> => {
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
    const before: RuntimeStateV2 = worker.runtime();
    const beforeCommand = before.documentCommands[documentKeyOf(document)];
    const sentBefore: number = document.received.length;

    await worker.send({ type: 'updateTheme', theme: 'dark' } as Request);
    await worker.settle();

    // A theme change is a live update: new operation, higher revision, and the documents get it.
    const after: RuntimeStateV2 = worker.runtime();
    const afterCommand = after.documentCommands[documentKeyOf(document)];
    expect(after.runtimeRevision).toBeGreaterThan(before.runtimeRevision);
    expect(afterCommand?.operationId).not.toBe(beforeCommand?.operationId);
    expect(afterCommand?.runtimeRevision).toBe(after.runtimeRevision);
    expect(document.received.length).toBeGreaterThan(sentBefore);
  });

  it('dispatches each alarm to the owner its name names', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    worker.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });
    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();
    const sessionId: string | undefined = worker.runtime().session?.sessionId;

    // A name no alarm owns is ignored: nothing settles and nothing publishes.
    const beforeUnknown: number = worker.broadcasts.length;
    const writesBefore: number = worker.writes();
    await worker.fireAlarm('not-an-alarm');
    expect(worker.broadcasts.length).toBe(beforeUnknown);
    expect(worker.writes()).toBe(writesBefore);

    // The tick settles and publishes, and the cleanup alarms find no journal of their own.
    await worker.fireAlarm('tick');
    expect(worker.broadcasts.length).toBeGreaterThan(beforeUnknown);
    await worker.fireAlarm('transition-cleanup');
    await worker.fireAlarm('closure-cleanup');

    expect(worker.runtime().session?.sessionId).toBe(sessionId);
    expect(worker.runtime().pendingClosure).toBeNull();
    expect(parseRuntimeStateV2(worker.runtime())).not.toBeNull();
  });

  it('closes the session when website access is revoked', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    worker.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });
    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();

    worker.revokeWebsiteAccess();
    await worker.send({ type: 'reconcileWebsiteAccess' } as Request);
    await worker.settle();

    expect(worker.runtime().session).toBeNull();
    const ended = worker
      .events()
      .filter((event): boolean => event.t === 'sessionEnded')
      .at(-1);
    expect(ended).toMatchObject({ reason: 'website-access-lost', outcome: 'canceled' });
  });

  it('never broadcasts a config for a lifecycle that is not active', async (): Promise<void> => {
    // A committed transition is the case that matters: the session is durable while the lifecycle
    // is not active, so a projection that read the session would leak its config to every page.
    const worker: WorkerHarness = await bootWorker({
      ...installedSeed(),
      [LOCAL_RUNTIME]: transitionRuntime(pendingTransition('start', 'alarm-ready'), {
        session: timedFocusSession(),
      }),
    });
    worker.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });
    await worker.fireAlarm('tick');

    expect(worker.broadcasts.length).toBeGreaterThan(0);
    for (const snapshot of worker.broadcasts) {
      if (snapshot.lifecycle.kind === 'active') continue;
      expect(snapshot.config).toBeNull();
      expect(snapshot.phase).toBe('idle');
      expect(snapshot.sessionEndsAt).toBeNull();
    }
    expect(
      worker.broadcasts.some((snapshot): boolean => snapshot.lifecycle.kind !== 'active'),
    ).toBe(true);
  });

  it('keeps the v2 start event when a v1 attempt is appended after it', async (): Promise<void> => {
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
    const sessionId: string = worker.runtime().session?.sessionId ?? '';

    // The attempt rides the retained engine's writer, which must be the v2 one.
    await worker.send(
      { type: 'getBlockState', url: document.url, docState: 'fresh' } as Request,
      tabSender(document),
    );
    await worker.settle();

    const events = worker.events();
    expect(events.filter((event): boolean => event.t === 'attempt')).toHaveLength(1);
    expect(
      events.filter(
        (event): boolean => event.t === 'sessionStarted' && event.eventId === `${sessionId}:start`,
      ),
    ).toHaveLength(1);
  });

  it('recovers a restarted worker without repeating the start event', async (): Promise<void> => {
    const first: WorkerHarness = await bootWorker(installedSeed());
    first.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });
    await first.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await first.settle();
    const sessionId: string = first.runtime().session?.sessionId ?? '';
    const storedAfterStart: Record<string, unknown> = structuredClone(first.local);

    // The same storage, a new worker: recovery resumes the session it finds.
    const second: WorkerHarness = await bootWorker(storedAfterStart);

    expect(second.runtime().session?.sessionId).toBe(sessionId);
    expect(second.broadcasts.at(-1)?.lifecycle.kind).toBe('active');
    expect(second.events().filter((event): boolean => event.t === 'sessionStarted')).toHaveLength(
      1,
    );
  });

  it('mutes a blocked tab through the sweep', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    worker.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });

    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();

    // A blocked page is muted by the sweep, which is the effect the frozen command does not carry.
    expect(worker.mutes()).toContainEqual({ tabId: 11, muted: true });
  });

  it('earns pause budget as focus settles', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    worker.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });
    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();

    // The worker reads the real clock, so the test moves it: a minute of focus, then a tick.
    const startedAt: number = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(startedAt + 60_000);
    try {
      await worker.fireAlarm('tick');
    } finally {
      vi.useRealTimers();
    }

    const runtime: RuntimeStateV2 = worker.runtime();
    expect(runtime.accruedFocusMs).toBeGreaterThan(0);
    expect(runtime.todayAgg?.focusMs ?? 0).toBeGreaterThan(0);
    expect(worker.events().some((event): boolean => event.t === 'budgetEarned')).toBe(true);
    expect(
      (worker.local[LOCAL_BANK] as { balanceMs: number } | undefined)?.balanceMs ?? 0,
    ).toBeGreaterThan(0);
  });

  it('reports the bank the read instant has earned', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    worker.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });
    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();

    const started: number = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(started + 120_000);
    let snapshot: SessionSnapshotV2;
    try {
      snapshot = (await worker.send({ type: 'getSnapshot' } as Request)) as SessionSnapshotV2;
    } finally {
      vi.useRealTimers();
    }

    // The read settles the core state through its instant, and the bank is what that focus earns,
    // so the balance the popup reads is the balance the user has, not the last settled one.
    expect(snapshot.bankMs).toBeGreaterThan(0);
    expect((worker.local[LOCAL_BANK] as { balanceMs: number } | undefined)?.balanceMs ?? 0).toBe(0);
  });

  it('clears the badge when a timed session completes', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    worker.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });
    await worker.send({
      type: 'startSession',
      config: {
        ...indefiniteConfig(),
        duration: { kind: 'timed', minutes: 30 },
        cycling: { focusMin: 10, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 },
      },
    } as Request);
    await worker.settle();
    expect(worker.badges.at(-1)).not.toBe('');

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // Every boundary the session plans, in order, the way the alarm would deliver them.
      for (let boundary: number = 0; boundary < 10; boundary += 1) {
        const when: number | null | undefined = worker.alarms.get('phase')?.when;
        if (when === undefined || when === null) break;
        vi.setSystemTime(when + 1_000);
        await worker.fireAlarm('phase');
        await worker.settle();
        if (worker.runtime().session === null) break;
      }
    } finally {
      vi.useRealTimers();
    }

    // The session is over, so the toolbar says nothing: a stale countdown outlives the session it
    // was counting and tells the user they are still locked.
    expect(worker.runtime().session).toBeNull();
    expect(worker.badges.at(-1)).toBe('');
    // Every boundary it crossed is in the log and was heard.
    expect(
      worker.events().filter((event): boolean => event.t === 'phase').length,
    ).toBeGreaterThanOrEqual(2);
    expect(worker.sounds).toContain('breakStart');
    expect(worker.sounds).toContain('breakEnd');
    expect(worker.sounds).toContain('sessionComplete');
  });

  it('reblocks an expired unlock on the next tick', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker({
      ...installedSeed(),
      [LOCAL_BANK]: { balanceMs: 10 * 60_000 },
    });
    const document: FakeDocument = {
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    };
    worker.documents.push(document);
    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();
    expect(worker.runtime().documentCommands[documentKeyOf(document)]?.presentation).toBe('active');

    const started: number = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await worker.send({
        type: 'openGate',
        gate: 'unlockSite',
        host: 'facebook.com',
      } as Request);
      vi.setSystemTime(started + DEFAULT_SETTINGS.gate.delayMs + 1_000);
      expect(
        (await worker.send({ type: 'confirmGate', typedPhrase: null } as Request)) as {
          ok: boolean;
        },
      ).toMatchObject({ ok: true });
      await worker.settle();
      expect(worker.runtime().documentCommands[documentKeyOf(document)]?.presentation).toBe(
        'clear',
      );
      // Indefinite focus owns no phase alarm, and an unlock expiry is not a boundary, so a commit
      // taken while the unlock is live leaves the singleton absent instead of filling it with a
      // time no session asked for.
      vi.setSystemTime(started + DEFAULT_SETTINGS.gate.delayMs + 60_000);
      await worker.fireAlarm('tick');
      await worker.settle();
      expect(worker.runtime().unlocks).toHaveLength(1);
      expect(worker.alarms.get('phase')).toBeUndefined();

      // No alarm owns the expiry: `phase` belongs to the session boundary alone, so the unlock ends
      // by instant and the minute tick is what puts the page back behind the overlay.
      vi.setSystemTime(started + DEFAULT_SETTINGS.pause.unlockMs + 120_000);
      await worker.fireAlarm('tick');
      await worker.settle();
    } finally {
      vi.useRealTimers();
    }

    expect(worker.runtime().documentCommands[documentKeyOf(document)]?.presentation).toBe('active');
  });

  it('counts a resisted gate in the day it happened on', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    worker.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });
    await worker.send({
      type: 'startSession',
      config: {
        ...indefiniteConfig(),
        strictness: 'friction',
        duration: { kind: 'timed', minutes: 25 },
      },
    } as Request);
    await worker.settle();

    expect(
      (await worker.send({ type: 'openEndGate' } as Request)) as { ok: boolean },
    ).toMatchObject({
      ok: true,
    });
    await worker.send({ type: 'abandonGate' } as Request);
    await worker.settle();

    // Stats read the day, not the log, so an event a commit carries is folded into it.
    expect(worker.runtime().todayAgg?.resisted ?? 0).toBe(1);
    expect(worker.runtime().todayAgg?.sessionsStarted ?? 0).toBe(1);
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

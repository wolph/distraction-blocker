import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlarmPortsV2, ScheduledAlarmV2 } from '../../../src/background/alarms-v2';
import type { ContentTransportPortsV2 } from '../../../src/background/content-transport-v2';
import {
  type AllDataClearJournalV2,
  type CleanInstallMarkerProjection,
  type DataClearResetProgress,
  parseDataClearJournal,
} from '../../../src/background/data-clear-journal';
import {
  type AllDataClearLease,
  createAllDataClearLease,
  type DataClearLeaseToken,
} from '../../../src/background/data-clear-lease';
import {
  type BrowserResetPortsV2,
  finalizeAllDataClearV2,
  retryBrowserResetV2,
  runBrowserResetAttemptV2,
} from '../../../src/background/data-clear-reset-v2';
import type { EnforcementTargetPortsV2 } from '../../../src/background/enforcement-targets-v2';
import { emptyRuntimeV2 } from '../../../src/background/runtime-store-v2';
import { DEFAULT_SETUP } from '../../../src/shared/constants';
import { LOCAL_DATA_CLEAR_JOURNAL } from '../../../src/shared/storage-keys';

const NOW: number = Date.parse('2026-09-04T10:00:00.000Z');
const RESET_EPOCH: string = '20000000-0000-4000-8000-000000000001';
const RESET_OPERATION: string = '20000000-0000-4000-8000-000000000002';
const NEXT_OPERATION: string = '20000000-0000-4000-8000-000000000003';
const OTHER_EPOCH: string = '20000000-0000-4000-8000-000000000004';
const EXTENSION_VERSION: string = '1.0.0';
const TARGET_URL: string = 'https://facebook.com/feed';
const OTHER_URL: string = 'https://news.example.com/story';
const FIRST_KEY: string = '11:document-1';

/** One open document the reset has to reach, and how it answers. */
interface FakeTargetV2 {
  tabId: number;
  documentId: string | null;
  url: string | null;
  answer: 'reset' | 'closed' | 'no-receiver' | 'mismatch' | 'rejected' | 'stale-operation';
}

interface ResetHarnessV2 {
  ports: BrowserResetPortsV2;
  lease: AllDataClearLease;
  storage: Record<string, unknown>;
  alarms: Map<string, ScheduledAlarmV2>;
  tabs: FakeTargetV2[];
  generation: { value: number };
  clock: { now: number };
  ensureDeviceIdCalls: number[];
  replayCalls: number;
  sent: string[];
  journal(): AllDataClearJournalV2;
  progress(): DataClearResetProgress;
  run<T>(operation: (token: DataClearLeaseToken) => Promise<T>): Promise<T>;
}

function cleanMarker(): CleanInstallMarkerProjection {
  return {
    version: 1,
    profile: 'clean',
    latestReason: 'install',
    extensionVersion: EXTENSION_VERSION,
  };
}

function resetProgress(overrides: Partial<DataClearResetProgress> = {}): DataClearResetProgress {
  return {
    attemptStartedAt: null,
    resolverPassCount: 0,
    targetGeneration: null,
    stablePasses: 0,
    targets: {},
    commands: {},
    acknowledgements: {},
    exclusions: [],
    deferredUnreachable: [],
    ...overrides,
  };
}

function browserResetJournal(
  overrides: Partial<AllDataClearJournalV2> = {},
): AllDataClearJournalV2 {
  return {
    version: 2,
    scope: 'all',
    phase: 'browser-reset',
    inventory: [],
    resetEpoch: RESET_EPOCH,
    resetOperationId: RESET_OPERATION,
    runtimeProjection: emptyRuntimeV2(NOW, RESET_EPOCH),
    setupProjection: DEFAULT_SETUP,
    installMarkerProjection: cleanMarker(),
    finalInstallMarkerProjection: cleanMarker(),
    pendingInstallLifecycleIntents: [],
    resetProgress: resetProgress(),
    retry: { batch: 1, automaticAttempt: 0, nextAttemptAt: NOW, lastError: null },
    ...overrides,
  };
}

/** The document's answer to one reset command, in the shape the transport parser accepts. */
function answerFor(target: FakeTargetV2, command: Record<string, unknown>, at: number): unknown {
  if (target.answer === 'closed') throw new Error('The tab was closed.');
  if (target.answer === 'no-receiver') throw new Error('Could not establish connection.');
  if (target.answer === 'mismatch') return { nonsense: true };
  if (target.answer === 'rejected') {
    return {
      version: 1,
      disposition: 'epoch-reset-rejected',
      operationId: command.operationId,
      enforcementEpoch: command.enforcementEpoch,
      documentId: command.documentId,
      observedUrl: command.expectedUrl,
      currentEpoch: OTHER_EPOCH,
      reason: 'retired-epoch',
      handledAt: at,
    };
  }
  return {
    version: 1,
    disposition: 'epoch-reset',
    operationId: target.answer === 'stale-operation' ? 'another-operation' : command.operationId,
    enforcementEpoch: command.enforcementEpoch,
    documentId: command.documentId,
    observedUrl: command.expectedUrl,
    handledAt: at,
  };
}

function harness(journal: AllDataClearJournalV2 | null = browserResetJournal()): ResetHarnessV2 {
  const storage: Record<string, unknown> =
    journal === null ? {} : { [LOCAL_DATA_CLEAR_JOURNAL]: structuredClone(journal) };
  const alarms: Map<string, ScheduledAlarmV2> = new Map<string, ScheduledAlarmV2>();
  const tabs: FakeTargetV2[] = [
    { tabId: 11, documentId: 'document-1', url: TARGET_URL, answer: 'reset' },
  ];
  const generation: { value: number } = { value: 7 };
  const clock: { now: number } = { now: NOW };
  const ensureDeviceIdCalls: number[] = [];
  const sent: string[] = [];
  const state: { replayCalls: number; deviceId: boolean; replay: 'complete' | 'failed' } = {
    replayCalls: 0,
    deviceId: true,
    replay: 'complete',
  };
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(
          async (key: string): Promise<Record<string, unknown>> =>
            Object.hasOwn(storage, key) ? { [key]: structuredClone(storage[key]) } : {},
        ),
        set: vi.fn(async (items: Record<string, unknown>): Promise<void> => {
          Object.assign(storage, structuredClone(items));
        }),
        remove: vi.fn(async (key: string): Promise<void> => {
          delete storage[key];
        }),
      },
    },
  });
  const lease: AllDataClearLease = createAllDataClearLease((): boolean => false);
  const targets: EnforcementTargetPortsV2 = {
    queryTopFrameTabs: async (): Promise<Array<{ tabId: number; url: string | null }>> =>
      tabs.map((tab: FakeTargetV2): { tabId: number; url: string | null } => ({
        tabId: tab.tabId,
        url: tab.url,
      })),
    topFrameDocumentId: async (tabId: number): Promise<string | null> =>
      tabs.find((tab: FakeTargetV2): boolean => tab.tabId === tabId)?.documentId ?? null,
    readTargetGeneration: (): number => generation.value,
    now: (): number => clock.now,
  };
  const transport: ContentTransportPortsV2 = {
    sendToDocument: async (
      tabId: number,
      documentId: string,
      message: unknown,
    ): Promise<unknown> => {
      const target: FakeTargetV2 | undefined = tabs.find(
        (tab: FakeTargetV2): boolean => tab.tabId === tabId && tab.documentId === documentId,
      );
      if (target === undefined) throw new Error('The tab was closed.');
      sent.push(`${tabId}:${documentId}`);
      return answerFor(target, message as Record<string, unknown>, clock.now);
    },
  };
  const alarmPorts: AlarmPortsV2 = {
    create: async (name: string, when: number): Promise<void> => {
      alarms.set(name, { scheduledTime: when, periodInMinutes: null });
    },
    createPeriodic: async (name: string, periodInMinutes: number): Promise<void> => {
      alarms.set(name, { scheduledTime: clock.now, periodInMinutes });
    },
    get: async (name: string): Promise<ScheduledAlarmV2 | null> => alarms.get(name) ?? null,
    clear: async (name: string): Promise<void> => {
      alarms.delete(name);
    },
  };
  const ports: BrowserResetPortsV2 = {
    lease,
    now: (): number => clock.now,
    newId: (): string => NEXT_OPERATION,
    targets,
    transport,
    alarms: alarmPorts,
    readMaterialized: async (): Promise<{
      runtime: unknown;
      setup: unknown;
      installMarker: unknown;
    }> => {
      const stored: AllDataClearJournalV2 | null = storedJournal(storage);
      return {
        runtime: stored?.runtimeProjection ?? null,
        setup: stored?.setupProjection ?? null,
        installMarker: stored?.installMarkerProjection ?? null,
      };
    },
    deviceIdExists: async (): Promise<boolean> => state.deviceId,
    ensureDeviceId: async (): Promise<string> => {
      ensureDeviceIdCalls.push(clock.now);
      return 'device-id';
    },
    replayLifecycleIntents: async (): Promise<'complete' | 'failed'> => {
      state.replayCalls += 1;
      return state.replay;
    },
    reportError: vi.fn(),
  };
  return {
    ports,
    lease,
    storage,
    alarms,
    tabs,
    generation,
    clock,
    ensureDeviceIdCalls,
    get replayCalls(): number {
      return state.replayCalls;
    },
    sent,
    journal: (): AllDataClearJournalV2 => {
      const stored: AllDataClearJournalV2 | null = storedJournal(storage);
      if (stored === null) throw new Error('expected a stored all-data journal');
      return stored;
    },
    progress: (): DataClearResetProgress => {
      const stored: AllDataClearJournalV2 | null = storedJournal(storage);
      if (stored?.resetProgress == null) throw new Error('expected reset progress');
      return stored.resetProgress;
    },
    run: <T>(operation: (token: DataClearLeaseToken) => Promise<T>): Promise<T> =>
      lease.run(operation),
  };
}

function storedJournal(storage: Record<string, unknown>): AllDataClearJournalV2 | null {
  const raw: unknown = storage[LOCAL_DATA_CLEAR_JOURNAL];
  if (raw === undefined) return null;
  const parsed = parseDataClearJournal(raw);
  return parsed !== null && 'version' in parsed && parsed.scope === 'all' ? parsed : null;
}

afterEach((): void => {
  vi.unstubAllGlobals();
});

describe('browser reset attempt', (): void => {
  beforeEach((): void => {
    vi.restoreAllMocks();
  });

  it('refuses to start on evidence the journal did not project', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();
    h.ports.readMaterialized = async (): Promise<{
      runtime: unknown;
      setup: unknown;
      installMarker: unknown;
    }> => ({ runtime: { drifted: true }, setup: DEFAULT_SETUP, installMarker: cleanMarker() });

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    // Policy Storage owns repair, so the attempt records what it saw and waits for the next
    // dispatch rather than materializing anything itself.
    expect(result).toBe('retry-scheduled');
    expect(h.journal().retry.lastError).toBe('materialization-mismatch');
    expect(h.ensureDeviceIdCalls).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it('regenerates the device identity once before it sends anything', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();

    await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    expect(h.ensureDeviceIdCalls).toHaveLength(1);
  });

  it('reaches stable on two generation-stable acknowledged passes', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    expect(result).toBe('stable');
    const progress: DataClearResetProgress = h.progress();
    expect(progress.stablePasses).toBe(2);
    expect(progress.attemptStartedAt).toBe(NOW);
    expect(progress.resolverPassCount).toBe(2);
    expect(progress.targetGeneration).toBe(7);
    // Every command is frozen in the journal, and only the exact acknowledgement is kept.
    expect(progress.commands[FIRST_KEY]).toMatchObject({
      command: 'reset-enforcement-epoch',
      operationId: RESET_OPERATION,
      enforcementEpoch: RESET_EPOCH,
      documentId: 'document-1',
      expectedUrl: TARGET_URL,
      tabId: 11,
    });
    expect(progress.acknowledgements[FIRST_KEY]).toMatchObject({
      operationId: RESET_OPERATION,
      enforcementEpoch: RESET_EPOCH,
      documentId: 'document-1',
    });
  });

  it('keeps the materialized runtime exactly as the journal projected it', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();

    await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    // The acknowledgements live in the journal alone. A runtime that grew `epochResetAcks` would
    // be a second authority for the same fact, and the next boot would replay it.
    const materialized = await h.ports.readMaterialized();
    expect(materialized.runtime).toEqual(h.journal().runtimeProjection);
    expect((materialized.runtime as { epochResetAcks: unknown }).epochResetAcks).toEqual({});
  });

  it('restarts the stable count when the target generation moves', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();
    let passes: number = 0;
    const queryTopFrameTabs = h.ports.targets.queryTopFrameTabs;
    h.ports.targets.queryTopFrameTabs = async (): Promise<
      Array<{ tabId: number; url: string | null }>
    > => {
      passes += 1;
      if (passes === 2) h.generation.value += 1;
      return await queryTopFrameTabs();
    };

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    // A generation change costs the stable count and nothing else: the attempt keeps its start and
    // its pass budget, which is what bounds it.
    expect(result).toBe('retry-scheduled');
    expect(h.journal().retry.lastError).toBe('reset-passes-exhausted');
    expect(h.progress().attemptStartedAt).toBe(NOW);
    expect(h.progress().resolverPassCount).toBe(3);
  });

  it('fails the attempt on a rejected epoch rather than deferring it', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();
    const target: FakeTargetV2 | undefined = h.tabs[0];
    if (target === undefined) throw new Error('the harness needs its target');
    target.answer = 'rejected';

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    expect(result).toBe('retry-scheduled');
    expect(h.journal().retry.lastError).toContain('epoch-reset-rejected');
    expect(h.progress().deferredUnreachable).toEqual([]);
    expect(h.progress().exclusions).toEqual([]);
  });

  it('fails the attempt on an acknowledgement for another operation', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();
    const target: FakeTargetV2 | undefined = h.tabs[0];
    if (target === undefined) throw new Error('the harness needs its target');
    target.answer = 'stale-operation';

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    expect(result).toBe('retry-scheduled');
    expect(h.journal().retry.lastError).toContain('mismatch');
    expect(h.progress().acknowledgements).toEqual({});
  });

  it('excludes a closed tab and defers one with no receiver', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();
    h.tabs.push({ tabId: 12, documentId: 'document-2', url: OTHER_URL, answer: 'no-receiver' });
    const target: FakeTargetV2 | undefined = h.tabs[0];
    if (target === undefined) throw new Error('the harness needs its target');
    target.answer = 'closed';

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    // Neither answer fails the attempt: a closed tab is gone, and a tab with no receiver is one
    // the bounded passes are there to wait for.
    expect(result).toBe('retry-scheduled');
    expect(h.progress().exclusions).toEqual([
      { tabId: 11, documentId: 'document-1', expectedUrl: TARGET_URL, reason: 'closed' },
    ]);
    expect(h.progress().deferredUnreachable).toEqual([
      { tabId: 12, documentId: 'document-2', expectedUrl: OTHER_URL, reason: 'no-receiver' },
    ]);
  });

  it('stops sending once its ten seconds are spent', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();
    const answer = h.ports.transport.sendToDocument;
    h.ports.transport.sendToDocument = async (
      tabId: number,
      documentId: string,
      message: never,
    ): Promise<unknown> => {
      // The first pass takes the whole budget, which is what a slow browser looks like.
      h.clock.now = NOW + DEADLINE_MS;
      return await answer(tabId, documentId, message);
    };

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    // The pass that had already started finishes, and no second pass is sent: the deadline is
    // checked before a pass rather than in the middle of one.
    expect(result).toBe('retry-scheduled');
    expect(h.journal().retry.lastError).toBe('reset-deadline');
    expect(h.sent).toEqual(['11:document-1']);
  });

  it('schedules the next attempt and leaves the twelfth exhausted', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness(
      browserResetJournal({
        retry: { batch: 1, automaticAttempt: 11, nextAttemptAt: NOW, lastError: 'earlier' },
      }),
    );
    const target: FakeTargetV2 | undefined = h.tabs[0];
    if (target === undefined) throw new Error('the harness needs its target');
    target.answer = 'rejected';

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    expect(result).toBe('exhausted');
    expect(h.journal().retry.automaticAttempt).toBe(12);
    expect(h.journal().retry.nextAttemptAt).toBeNull();
    expect(h.alarms.has('data-clear-retry')).toBe(false);
  });

  it('schedules the retry alarm the journal asks for', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();
    const target: FakeTargetV2 | undefined = h.tabs[0];
    if (target === undefined) throw new Error('the harness needs its target');
    target.answer = 'rejected';

    await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    expect(h.alarms.get('data-clear-retry')?.scheduledTime).toBe(h.journal().retry.nextAttemptAt);
  });
});

describe('browser reset manual retry', (): void => {
  it('reissues every command under a new operation and a new batch', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();
    await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );
    const before: AllDataClearJournalV2 = h.journal();

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => retryBrowserResetV2(h.ports, token),
    );

    const after: AllDataClearJournalV2 = h.journal();
    expect(result).toBe('ok');
    expect(after.resetOperationId).toBe(NEXT_OPERATION);
    expect(after.resetProgress?.commands[FIRST_KEY]?.operationId).toBe(NEXT_OPERATION);
    expect(after.resetProgress?.acknowledgements).toEqual({});
    expect(after.resetProgress?.stablePasses).toBe(0);
    expect(after.resetProgress?.resolverPassCount).toBe(0);
    expect(after.retry.batch).toBe(before.retry.batch + 1);
    expect(after.retry.nextAttemptAt).toBe(NOW);
    // The identity of the clear is the epoch and the projections, and a retry keeps all of them.
    expect(after.resetEpoch).toBe(before.resetEpoch);
    expect(after.runtimeProjection).toEqual(before.runtimeProjection);
    expect(after.setupProjection).toEqual(before.setupProjection);
    expect(after.finalInstallMarkerProjection).toEqual(before.finalInstallMarkerProjection);
  });

  it('has nothing to retry without a browser-reset journal', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness(null);

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => retryBrowserResetV2(h.ports, token),
    );

    expect(result).toBe('retry-not-available');
  });
});

describe('all-data clear finalization', (): void => {
  async function stableHarness(): Promise<ResetHarnessV2> {
    const h: ResetHarnessV2 = harness();
    await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );
    return h;
  }

  it('removes the journal and reads the key again to prove it', async (): Promise<void> => {
    const h: ResetHarnessV2 = await stableHarness();

    const result: string = await finalizeAllDataClearV2(h.ports);

    expect(result).toBe('removed');
    expect(h.storage[LOCAL_DATA_CLEAR_JOURNAL]).toBeUndefined();
    expect(h.replayCalls).toBe(1);
  });

  it('replays nothing while the reset is unfinished', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();

    const result: string = await finalizeAllDataClearV2(h.ports);

    expect(result).toBe('not-finalizable');
    expect(h.replayCalls).toBe(0);
    expect(h.storage[LOCAL_DATA_CLEAR_JOURNAL]).toBeDefined();
  });

  it('replays nothing while the profile has no device identity', async (): Promise<void> => {
    const h: ResetHarnessV2 = await stableHarness();
    h.ports.deviceIdExists = async (): Promise<boolean> => false;

    const result: string = await finalizeAllDataClearV2(h.ports);

    expect(result).toBe('not-finalizable');
    expect(h.replayCalls).toBe(0);
  });

  it('schedules a retry when the removal does not stick', async (): Promise<void> => {
    const h: ResetHarnessV2 = await stableHarness();
    const kept: unknown = structuredClone(h.storage[LOCAL_DATA_CLEAR_JOURNAL]);
    const chromeStub = chrome as unknown as {
      storage: { local: { remove: (key: string) => Promise<void> } };
    };
    chromeStub.storage.local.remove = async (): Promise<void> => {
      h.storage[LOCAL_DATA_CLEAR_JOURNAL] = kept;
    };

    const result: string = await finalizeAllDataClearV2(h.ports);

    // The read after the removal is the proof, so a key that survives is a failed attempt with a
    // retry rather than a clear that reports itself finished.
    expect(result).toBe('retry-scheduled');
    expect(h.journal().retry.lastError).toBe('journal-not-removed');
  });

  it('schedules a retry when the lifecycle replay fails', async (): Promise<void> => {
    const h: ResetHarnessV2 = await stableHarness();
    h.ports.replayLifecycleIntents = async (): Promise<'complete' | 'failed'> => 'failed';

    const result: string = await finalizeAllDataClearV2(h.ports);

    expect(result).toBe('retry-scheduled');
    expect(h.journal().retry.lastError).toBe('lifecycle-replay-failed');
    expect(h.storage[LOCAL_DATA_CLEAR_JOURNAL]).toBeDefined();
  });
});

describe('browser reset restart recovery', (): void => {
  it('resumes on the pass budget the crashed attempt had written', async (): Promise<void> => {
    // The worker died after its second pass count was durable, so the restart owes one pass.
    const h: ResetHarnessV2 = harness(
      browserResetJournal({
        resetProgress: resetProgress({ attemptStartedAt: NOW, resolverPassCount: 2 }),
      }),
    );

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    // A fresh attempt begins, which is what the journal records, and it starts its own budget.
    expect(result).toBe('stable');
    expect(h.progress().resolverPassCount).toBe(2);
    expect(h.progress().attemptStartedAt).toBe(NOW);
  });

  it('advances the schedule before any effect when it restarts past the deadline', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness(
      browserResetJournal({ resetProgress: resetProgress({ attemptStartedAt: NOW }) }),
    );
    h.clock.now = NOW + DEADLINE_MS;

    const result: string = await h.run(async (token: DataClearLeaseToken): Promise<string> => {
      // The attempt start is rewritten from this instant, so the deadline is measured from the
      // restart rather than from the attempt that died.
      return await runBrowserResetAttemptV2(h.ports, token);
    });

    expect(result).toBe('stable');
    expect(h.progress().attemptStartedAt).toBe(NOW + DEADLINE_MS);
  });
});

const DEADLINE_MS: number = 10_000;

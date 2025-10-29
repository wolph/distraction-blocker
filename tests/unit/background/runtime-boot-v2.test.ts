import { describe, expect, it } from 'vitest';
import { mergeEventLogV2 } from '../../../src/background/event-log-v2';
import {
  bootRuntimeAuthorityV2,
  migrationStoragePayload,
  type RuntimeBootPortsV2,
  type RuntimeBootResultV2,
} from '../../../src/background/runtime-boot-v2';
import {
  applyRuntimeCheckpointV2,
  projectRuntimeDomainV2,
} from '../../../src/background/runtime-checkpoint-v2';
import {
  classifyStoredRuntime,
  emptyRuntimeV2,
  isRuntimeSchemaMarkerV2,
  type StoredRuntimeAuthority,
} from '../../../src/background/runtime-store-v2';
import type {
  RuntimeCommitCheckpointV2,
  RuntimeMigrationCheckpointV1ToV2,
  RuntimeStateV2,
} from '../../../src/background/runtime-v2-types';
import type { RuntimeCommitCheckpoint, RuntimeState } from '../../../src/background/stores';
import { DEFAULT_LISTS, rulesFromLists } from '../../../src/shared/constants';
import { CoreError } from '../../../src/shared/errors';
import {
  LOCAL_RUNTIME_MIGRATION,
  LOCAL_RUNTIME_SCHEMA,
  syncAggKey,
} from '../../../src/shared/storage-keys';
import { localDateStr } from '../../../src/shared/time';
import type {
  BankState,
  DailyAgg,
  LegacyEventRecord,
  ListsConfig,
  NormalizedSessionConfigV1,
  NormalizedSessionStateV1,
  PauseEconomy,
  SessionEventRecordV2,
} from '../../../src/shared/types';

interface BootStorage {
  runtime: unknown;
  marker: unknown;
  migration: unknown;
  events: SessionEventRecordV2[];
  bank: BankState;
  aggregates: Record<string, DailyAgg>;
  syncJournalWrites: number;
}

interface BootHarness {
  ports: RuntimeBootPortsV2;
  storage: BootStorage;
  calls: string[];
  errors: unknown[];
  aggregateKeyReads: string[][];
  bankWrites: Array<{ bank: BankState; syncBank: boolean }>;
  issuedIds: string[];
}

const DEVICE_ID: string = 'device-1';
const SESSION_ID: string = '10000000-0000-4000-8000-000000000001';
const EPOCH_ID: string = '30000000-0000-4000-8000-000000000009';
const ENTRY_ID: string = 'entry-1';
const MINUTE_MS: number = 60_000;
const DAY_MS: number = 86_400_000;
const DURATION_MIN: number = 50;
/** Local 2026-09-03 09:00, so every derived local date is stable in any test timezone. */
const START_AT: number = new Date(2026, 8, 3, 9, 0, 0, 0).getTime();
const NOW: number = START_AT + 30 * MINUTE_MS;
const LOCAL_DATE: string = '2026-09-03';
const MARKER: string = `${ENTRY_ID}@${LOCAL_DATE}`;
const PAUSE_ECONOMY: PauseEconomy = {
  earnRatio: 5 / 30,
  capMs: 3_600_000,
  pauseMs: 5 * MINUTE_MS,
  unlockMs: 5 * MINUTE_MS,
};
const V2_WRITE_PORTS: readonly string[] = [
  'saveRuntime',
  'appendEvents',
  'saveBank',
  'saveAggregate',
  'removeAggregate',
  'writeMigrationCheckpointAndMarker',
  'clearMigrationCheckpoint',
];
/**
 * Every write the legacy migration branch performs, in the order the boot reader issues them. No
 * path removes an aggregate: a legacy checkpoint may carry removals, and migration never does, so
 * `removeAggregate` has no crash row here.
 */
const MIGRATION_WRITE_PORTS: readonly string[] = [
  'appendLegacyEvents',
  'saveBank',
  'persistSyncJournal',
  'saveLegacyRuntime',
  'writeMigrationCheckpointAndMarker',
  'saveRuntime',
  'appendEvents',
  'saveAggregate',
  'clearMigrationCheckpoint',
];

function emptyStorage(overrides: Partial<BootStorage> = {}): BootStorage {
  return {
    runtime: undefined,
    marker: undefined,
    migration: undefined,
    events: [],
    bank: { balanceMs: 0 },
    aggregates: {},
    syncJournalWrites: 0,
    ...overrides,
  };
}

function harness(
  storage: BootStorage,
  failing: string | null = null,
  lists: ListsConfig = DEFAULT_LISTS,
): BootHarness {
  const calls: string[] = [];
  const errors: unknown[] = [];
  const aggregateKeyReads: string[][] = [];
  const bankWrites: Array<{ bank: BankState; syncBank: boolean }> = [];
  const issuedIds: string[] = [];
  let nextId: number = 0;

  function record(name: string): void {
    calls.push(name);
    if (name === failing) throw new CoreError('invalid-rule', `port ${name} failed`);
  }

  const ports: RuntimeBootPortsV2 = {
    now: (): number => NOW,
    newId: (): string => {
      nextId += 1;
      const id: string = `40000000-0000-4000-8000-00000000000${nextId}`;
      issuedIds.push(id);
      calls.push('newId');
      return id;
    },
    loadRuntimeAuthority: async (): Promise<StoredRuntimeAuthority> => {
      calls.push('loadRuntimeAuthority');
      return classifyStoredRuntime(
        storage.runtime,
        isRuntimeSchemaMarkerV2(storage.marker) ? { runtimeSchemaVersion: 2 } : null,
      );
    },
    readMigrationCheckpoint: async (): Promise<unknown> => {
      calls.push('readMigrationCheckpoint');
      return storage.migration;
    },
    writeMigrationCheckpointAndMarker: async (
      checkpoint: RuntimeMigrationCheckpointV1ToV2,
    ): Promise<void> => {
      record('writeMigrationCheckpointAndMarker');
      const payload: Record<string, unknown> = migrationStoragePayload(checkpoint);
      storage.migration = payload[LOCAL_RUNTIME_MIGRATION];
      storage.marker = payload[LOCAL_RUNTIME_SCHEMA];
    },
    clearMigrationCheckpoint: async (): Promise<void> => {
      record('clearMigrationCheckpoint');
      storage.migration = undefined;
    },
    loadAggregates: async (keys: readonly string[]): Promise<Record<string, DailyAgg>> => {
      calls.push('loadAggregates');
      aggregateKeyReads.push([...keys]);
      const loaded: Record<string, DailyAgg> = {};
      for (const key of keys) {
        const stored: DailyAgg | undefined = storage.aggregates[key];
        if (stored !== undefined) loaded[key] = structuredClone(stored);
      }
      return loaded;
    },
    saveRuntime: async (runtime: RuntimeStateV2): Promise<void> => {
      record('saveRuntime');
      storage.runtime = structuredClone(runtime);
    },
    saveLegacyRuntime: async (runtime: RuntimeState): Promise<void> => {
      record('saveLegacyRuntime');
      storage.runtime = structuredClone(runtime);
    },
    appendEvents: async (events: readonly SessionEventRecordV2[]): Promise<void> => {
      record('appendEvents');
      storage.events = mergeEventLogV2(storage.events, events);
    },
    appendLegacyEvents: async (events: readonly LegacyEventRecord[]): Promise<void> => {
      record('appendLegacyEvents');
      storage.events = mergeEventLogV2(storage.events, events);
    },
    saveBank: async (bank: BankState, syncBank: boolean): Promise<void> => {
      record('saveBank');
      storage.bank = { ...bank };
      bankWrites.push({ bank: { ...bank }, syncBank });
    },
    saveAggregate: async (key: string, value: DailyAgg): Promise<void> => {
      record('saveAggregate');
      storage.aggregates[key] = structuredClone(value);
    },
    removeAggregate: async (key: string): Promise<void> => {
      record('removeAggregate');
      Reflect.deleteProperty(storage.aggregates, key);
    },
    persistSyncJournal: async (): Promise<void> => {
      record('persistSyncJournal');
      storage.syncJournalWrites += 1;
    },
    lists: (): ListsConfig => lists,
    bank: (): BankState => storage.bank,
    pauseEconomy: (): PauseEconomy => PAUSE_ECONOMY,
    deviceId: (): string => DEVICE_ID,
    reportError: (error: unknown): void => {
      calls.push('reportError');
      errors.push(error);
    },
  };

  return { ports, storage, calls, errors, aggregateKeyReads, bankWrites, issuedIds };
}

function legacyConfig(
  overrides: Partial<NormalizedSessionConfigV1> = {},
): NormalizedSessionConfigV1 {
  return {
    mode: 'blacklist',
    strictness: 'friction',
    durationMin: DURATION_MIN,
    cycling: null,
    intention: 'Ship the release',
    source: 'manual',
    scheduleEntryId: null,
    rules: rulesFromLists(DEFAULT_LISTS),
    ...overrides,
  };
}

function legacySession(
  overrides: Partial<NormalizedSessionStateV1> = {},
): NormalizedSessionStateV1 {
  return {
    sessionId: SESSION_ID,
    config: legacyConfig(),
    startedAt: START_AT,
    sessionEndsAt: START_AT + DURATION_MIN * MINUTE_MS,
    phase: 'focus',
    phaseStartedAt: START_AT,
    phaseEndsAt: START_AT + DURATION_MIN * MINUTE_MS,
    cycleIndex: 0,
    pausedFrom: null,
    focusedMs: 0,
    ...overrides,
  };
}

function storedAggregate(date: string, focusMs: number): DailyAgg {
  return {
    date,
    focusMs,
    sessionsStarted: 1,
    sessionsCompleted: 0,
    attempts: {},
    attemptsOther: 0,
    pausesTaken: 0,
    pauseMsSpent: 0,
    unlocksTaken: 0,
    resisted: 0,
  };
}

function legacyRuntime(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    session: null,
    gate: null,
    unlocks: [],
    tabStates: { 11: { muteUrl: null, priorMuted: null, stoppedDocumentId: 'document-1' } },
    accruedFocusMs: 0,
    attemptDebounce: {},
    deferredBlockClaims: {},
    removedTabTombstones: {},
    scheduleActiveEntryId: null,
    scheduleUnavailableNoticeToken: null,
    date: LOCAL_DATE,
    todayAgg: null,
    lastPruneDate: null,
    commitCheckpoint: null,
    ...overrides,
  };
}

/** The one legacy shape that migrates into a cleanup-stage closure: a scheduled session with no date. */
function invalidScheduledRuntime(): RuntimeState {
  return legacyRuntime({
    session: legacySession({
      config: legacyConfig({ source: 'schedule', scheduleEntryId: ENTRY_ID }),
    }),
    scheduleActiveEntryId: ENTRY_ID,
  });
}

function storedV2Runtime(overrides: Partial<RuntimeStateV2> = {}): RuntimeStateV2 {
  return { ...emptyRuntimeV2(NOW, EPOCH_ID), ...overrides };
}

function storedV2WithCheckpoint(): RuntimeStateV2 {
  const runtime: RuntimeStateV2 = storedV2Runtime();
  const checkpoint: RuntimeCommitCheckpointV2 = {
    version: 2,
    checkpointId: 'boot-checkpoint',
    projection: projectRuntimeDomainV2({ ...runtime, accruedFocusMs: 5 * MINUTE_MS }),
    bank: { balanceMs: 1_000 },
    events: [{ t: 'budgetEarned', at: NOW, ms: 1_000 }],
    syncBank: true,
    aggregateSets: {},
    aggregateRemoves: [],
  };
  return applyRuntimeCheckpointV2(runtime, checkpoint);
}

function legacyCheckpoint(): RuntimeCommitCheckpoint {
  return {
    bank: { balanceMs: 2_000 },
    events: [{ t: 'budgetEarned', at: START_AT, ms: 2_000, sessionId: SESSION_ID }],
    syncBank: true,
    aggregateSets: {},
    aggregateRemoves: [],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function callsAfter(calls: readonly string[], name: string): string[] {
  const index: number = calls.indexOf(name);
  return index < 0 ? [] : calls.slice(index + 1);
}

function storedMigrationCheckpoint(storage: BootStorage): RuntimeMigrationCheckpointV1ToV2 {
  return storage.migration as RuntimeMigrationCheckpointV1ToV2;
}

/** True once the stored runtime is a v2 value rather than the unversioned legacy shape. */
function storedRuntimeIsLegacy(storage: BootStorage): boolean {
  return classifyStoredRuntime(storage.runtime, { runtimeSchemaVersion: 2 }).kind === 'legacy';
}

describe('v2 boot authority', (): void => {
  it('boots a clean install into an empty v2 runtime without a marker', async (): Promise<void> => {
    const test: BootHarness = harness(emptyStorage());

    const result: RuntimeBootResultV2 = await bootRuntimeAuthorityV2(test.ports);

    expect(result.kind).toBe('v2');
    expect(result.runtime.session).toBeNull();
    expect(result.runtime.runtimeSchemaVersion).toBe(2);
    expect(result.runtime.enforcementEpoch).toBe(test.issuedIds[0]);
    expect(result.runtime.basePolicyRevision).toBe(0);
    expect(result.runtime.runtimeRevision).toBe(0);
    expect(test.calls.filter((name: string): boolean => name === 'saveRuntime')).toHaveLength(1);
    expect(test.storage.marker).toBeUndefined();
    expect(test.storage.migration).toBeUndefined();
    expect(test.errors).toEqual([]);
  });

  it('replays a stored v2 commit checkpoint and returns the cleared runtime', async (): Promise<void> => {
    const test: BootHarness = harness(emptyStorage({ runtime: storedV2WithCheckpoint() }));

    const result: RuntimeBootResultV2 = await bootRuntimeAuthorityV2(test.ports);

    expect(result.kind).toBe('v2');
    expect(result.runtime.commitCheckpoint).toBeNull();
    expect(result.runtime.accruedFocusMs).toBe(5 * MINUTE_MS);
    expect(test.storage.bank).toEqual({ balanceMs: 1_000 });
    expect(test.storage.events).toHaveLength(1);
    expect(test.calls).toContain('appendEvents');
  });

  it('returns a journal-free v2 runtime without writing anything', async (): Promise<void> => {
    const stored: RuntimeStateV2 = storedV2Runtime({ accruedFocusMs: 90_000 });
    const test: BootHarness = harness(emptyStorage({ runtime: stored }));

    const result: RuntimeBootResultV2 = await bootRuntimeAuthorityV2(test.ports);

    expect(result).toEqual({ kind: 'v2', runtime: stored, migrated: false });
    expect(test.calls.filter((name: string): boolean => V2_WRITE_PORTS.includes(name))).toEqual([]);
  });
});

describe('v2 boot legacy migration', (): void => {
  it('replays the legacy checkpoint before any v2 port and then migrates', async (): Promise<void> => {
    const test: BootHarness = harness(
      emptyStorage({
        runtime: legacyRuntime({
          session: legacySession(),
          commitCheckpoint: legacyCheckpoint(),
        }),
      }),
    );

    const result: RuntimeBootResultV2 = await bootRuntimeAuthorityV2(test.ports);
    const afterLegacy: string[] = callsAfter(test.calls, 'appendLegacyEvents');

    expect(result.kind).toBe('migrated');
    expect(test.calls.indexOf('appendLegacyEvents')).toBeLessThan(
      test.calls.indexOf('writeMigrationCheckpointAndMarker'),
    );
    expect(afterLegacy).toContain('persistSyncJournal');
    expect(afterLegacy).toContain('saveLegacyRuntime');
    expect(test.storage.bank).toEqual({ balanceMs: 2_000 });
  });

  it('writes the checkpoint and marker once, replays it, and clears it', async (): Promise<void> => {
    const test: BootHarness = harness(
      emptyStorage({ runtime: legacyRuntime({ session: legacySession() }) }),
    );

    const result: RuntimeBootResultV2 = await bootRuntimeAuthorityV2(test.ports);
    const writes: string[] = test.calls.filter((name: string): boolean =>
      V2_WRITE_PORTS.includes(name),
    );

    expect(result.kind).toBe('migrated');
    expect(result.runtime.session?.sessionId).toBe(SESSION_ID);
    expect(result.runtime.basePolicyRevision).toBe(1);
    expect(result.runtime.runtimeRevision).toBe(1);
    expect(
      writes.filter((name: string): boolean => name === 'writeMigrationCheckpointAndMarker'),
    ).toHaveLength(1);
    expect(writes.indexOf('writeMigrationCheckpointAndMarker')).toBeLessThan(
      writes.indexOf('saveRuntime'),
    );
    expect(writes[writes.length - 1]).toBe('clearMigrationCheckpoint');
    expect(test.storage.migration).toBeUndefined();
    expect(isRuntimeSchemaMarkerV2(test.storage.marker)).toBe(true);
    expect(test.storage.runtime).toEqual(result.runtime);
  });

  it('assigns one UUID and announces it when the legacy session has none', async (): Promise<void> => {
    const session: NormalizedSessionStateV1 = legacySession();
    Reflect.deleteProperty(session, 'sessionId');
    const test: BootHarness = harness(emptyStorage({ runtime: legacyRuntime({ session }) }));

    const result: RuntimeBootResultV2 = await bootRuntimeAuthorityV2(test.ports);
    const assigned: string | undefined = result.runtime.session?.sessionId;

    expect(assigned).toBeDefined();
    expect(test.issuedIds).toContain(assigned);
    expect(test.storage.events).toContainEqual({
      t: 'sessionIdentityAssigned',
      at: NOW,
      startedAt: START_AT,
      sessionId: assigned,
    });
  });

  it('migrates a scheduled session with a local-date marker without a cleanup plan', async (): Promise<void> => {
    const test: BootHarness = harness(
      emptyStorage({
        runtime: legacyRuntime({
          session: legacySession({
            config: legacyConfig({ source: 'schedule', scheduleEntryId: ENTRY_ID }),
          }),
          scheduleActiveEntryId: MARKER,
        }),
      }),
    );

    const result: RuntimeBootResultV2 = await bootRuntimeAuthorityV2(test.ports);

    expect(result.runtime.session?.config.scheduleOccurrence?.token).toBe(MARKER);
    expect(result.runtime.pendingClosure).toBeNull();
    expect(test.storage.events).toEqual([]);
  });

  it('closes an invalid scheduled session and flushes its settled writes', async (): Promise<void> => {
    const test: BootHarness = harness(emptyStorage({ runtime: invalidScheduledRuntime() }));

    const result: RuntimeBootResultV2 = await bootRuntimeAuthorityV2(test.ports);
    const aggregateKey: string = syncAggKey(DEVICE_ID, LOCAL_DATE);

    expect(result.runtime.session).toBeNull();
    expect(result.runtime.pendingClosure?.stage).toBe('cleanup');
    expect(test.storage.events.at(-1)).toMatchObject({
      t: 'sessionEnded',
      reason: 'invalid-active-state',
      outcome: 'canceled',
    });
    expect(test.bankWrites).toHaveLength(1);
    expect(test.bankWrites[0]?.syncBank).toBe(true);
    expect(test.storage.bank.balanceMs).toBeGreaterThan(0);
    expect(test.storage.aggregates[aggregateKey]?.focusMs).toBe(30 * MINUTE_MS);
  });

  it('loads every stored aggregate from the session start through the migration instant', async (): Promise<void> => {
    const startedAt: number = START_AT - 2 * DAY_MS;
    const test: BootHarness = harness(
      emptyStorage({
        runtime: legacyRuntime({
          session: legacySession({
            config: legacyConfig({ source: 'schedule', scheduleEntryId: ENTRY_ID }),
            startedAt,
            sessionEndsAt: startedAt + DURATION_MIN * MINUTE_MS,
            phaseStartedAt: startedAt,
            phaseEndsAt: startedAt + DURATION_MIN * MINUTE_MS,
          }),
          scheduleActiveEntryId: ENTRY_ID,
          date: localDateStr(startedAt),
        }),
      }),
    );

    await bootRuntimeAuthorityV2(test.ports);

    expect(test.aggregateKeyReads).toHaveLength(1);
    expect(test.aggregateKeyReads[0]).toEqual([
      syncAggKey(DEVICE_ID, localDateStr(startedAt)),
      syncAggKey(DEVICE_ID, localDateStr(startedAt + DAY_MS)),
      syncAggKey(DEVICE_ID, LOCAL_DATE),
    ]);
  });

  it('hands the loaded aggregates to the legacy settlement', async (): Promise<void> => {
    const key: string = syncAggKey(DEVICE_ID, LOCAL_DATE);
    // A backward clock leaves the runtime dated ahead of the date this settlement has to split, so
    // the settlement refuses to seed that date empty and needs the stored aggregate the reader loads.
    const storage: BootStorage = emptyStorage({
      runtime: { ...invalidScheduledRuntime(), date: '2026-09-04' },
      aggregates: { [key]: storedAggregate(LOCAL_DATE, 5 * MINUTE_MS) },
    });
    const test: BootHarness = harness(storage);

    const result: RuntimeBootResultV2 = await bootRuntimeAuthorityV2(test.ports);

    expect(result.kind).toBe('migrated');
    expect(test.aggregateKeyReads[0]).toEqual([key]);
    expect(storage.aggregates[key]?.focusMs).toBe(35 * MINUTE_MS);
    expect(storage.aggregates[key]?.sessionsStarted).toBe(1);
  });

  it('completes absent captured rules from the persisted lists snapshot', async (): Promise<void> => {
    const config: Record<string, unknown> = { ...legacyConfig() };
    Reflect.deleteProperty(config, 'rules');
    const raw: unknown = { ...legacyRuntime(), session: { ...legacySession(), config } };
    const blockedLists: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, social: false, video: false },
    };
    const test: BootHarness = harness(emptyStorage({ runtime: raw }), null, blockedLists);

    const result: RuntimeBootResultV2 = await bootRuntimeAuthorityV2(test.ports);

    expect(result.kind).toBe('migrated');
    expect(result.runtime.session?.config.rules.categories.social).toBe(false);
    expect(result.runtime.session?.config.rules.categories.video).toBe(false);
    expect(result.runtime.session?.config.rules.baselineRevision).toEqual(
      rulesFromLists(blockedLists).baselineRevision,
    );
  });

  it('migrates an unreadable legacy value into an idle v2 runtime', async (): Promise<void> => {
    const test: BootHarness = harness(emptyStorage({ runtime: { session: 'broken' } }));

    const result: RuntimeBootResultV2 = await bootRuntimeAuthorityV2(test.ports);

    expect(result.kind).toBe('migrated');
    expect(result.runtime.session).toBeNull();
    expect(result.runtime.basePolicyRevision).toBe(0);
    expect(result.runtime.runtimeRevision).toBe(0);
    expect(test.aggregateKeyReads).toEqual([]);
  });
});

describe('v2 boot stored migration checkpoint', (): void => {
  it('replays a stored checkpoint without rebuilding it or reading the legacy raw', async (): Promise<void> => {
    const storage: BootStorage = emptyStorage({
      runtime: legacyRuntime({ session: legacySession() }),
    });
    const crashed: BootHarness = harness(storage, 'saveRuntime');
    await expect(bootRuntimeAuthorityV2(crashed.ports)).rejects.toThrow(CoreError);
    const stored: RuntimeMigrationCheckpointV1ToV2 = storedMigrationCheckpoint(storage);
    const test: BootHarness = harness(storage);

    const result: RuntimeBootResultV2 = await bootRuntimeAuthorityV2(test.ports);

    // The legacy runtime is still the stored raw value, and the stored checkpoint outranks it.
    expect(storedRuntimeIsLegacy(crashed.storage)).toBe(false);
    expect(result.kind).toBe('migrated');
    expect(result.runtime).toEqual(stored.projectedRuntime);
    expect(test.calls).not.toContain('newId');
    expect(test.calls).not.toContain('writeMigrationCheckpointAndMarker');
    expect(test.calls).toContain('clearMigrationCheckpoint');
    expect(storage.migration).toBeUndefined();
  });

  it('rejects a stored checkpoint that no longer parses', async (): Promise<void> => {
    const test: BootHarness = harness(
      emptyStorage({
        runtime: legacyRuntime({ session: legacySession() }),
        marker: { runtimeSchemaVersion: 2 },
        migration: { version: 1, broken: true },
      }),
    );

    const result: RuntimeBootResultV2 = await bootRuntimeAuthorityV2(test.ports);

    expect(result.kind).toBe('rejected');
    expect(result.kind === 'rejected' && result.reason).toBe('marker-without-v2');
    expect(test.errors[0]).toBeInstanceOf(CoreError);
    expect(test.calls).not.toContain('writeMigrationCheckpointAndMarker');
    expect(test.calls.filter((name: string): boolean => name === 'saveRuntime')).toHaveLength(1);
  });

  it('treats a hostile stored checkpoint as an invalid one', async (): Promise<void> => {
    // A promise resolves by reading `then`, so only that key answers. Every other read throws,
    // which is what the exact-data snapshot behind the parser has to survive.
    const hostile: unknown = new Proxy(
      {},
      {
        get: (_target: object, key: string | symbol): undefined => {
          if (key === 'then') return undefined;
          throw new Error('hostile checkpoint');
        },
      },
    );
    const test: BootHarness = harness(
      emptyStorage({
        runtime: legacyRuntime({ session: legacySession() }),
        marker: { runtimeSchemaVersion: 2 },
        migration: hostile,
      }),
    );

    const result: RuntimeBootResultV2 = await bootRuntimeAuthorityV2(test.ports);

    expect(result.kind).toBe('rejected');
    expect(test.errors[0]).toBeInstanceOf(CoreError);
  });
});

describe('v2 boot rejected authority', (): void => {
  it('boots empty under a fresh epoch and overwrites nothing else', async (): Promise<void> => {
    const test: BootHarness = harness(
      emptyStorage({ runtime: { runtimeSchemaVersion: 2, session: 'broken' } }),
    );

    const result: RuntimeBootResultV2 = await bootRuntimeAuthorityV2(test.ports);

    expect(result.kind).toBe('rejected');
    expect(result.kind === 'rejected' && result.reason).toBe('invalid-v2');
    expect(result.runtime.enforcementEpoch).toBe(test.issuedIds[0]);
    expect(result.runtime.session).toBeNull();
    expect(test.calls.filter((name: string): boolean => name === 'saveRuntime')).toHaveLength(1);
    expect(test.storage.runtime).toEqual(result.runtime);
    expect(test.errors).toHaveLength(1);
    expect(test.errors[0]).toBeInstanceOf(CoreError);
    expect(errorMessage(test.errors[0])).toContain('invalid-v2');
    expect(errorMessage(test.errors[0])).toContain('"session":"broken"');
  });

  it('reports the refused value truncated and never parks it elsewhere', async (): Promise<void> => {
    const oversized: unknown = {
      runtimeSchemaVersion: 2,
      session: 'x'.repeat(8_192),
    };
    const test: BootHarness = harness(emptyStorage({ runtime: oversized }));

    await bootRuntimeAuthorityV2(test.ports);
    const message: string = errorMessage(test.errors[0]);

    expect(message.length).toBeLessThan(4_400);
    expect(message.endsWith('...')).toBe(true);
    expect(test.storage.migration).toBeUndefined();
    expect(test.storage.marker).toBeUndefined();
  });

  it('reports the marker cutoff when no checkpoint explains it', async (): Promise<void> => {
    const test: BootHarness = harness(
      emptyStorage({
        runtime: legacyRuntime({ session: legacySession() }),
        marker: { runtimeSchemaVersion: 2 },
      }),
    );

    const result: RuntimeBootResultV2 = await bootRuntimeAuthorityV2(test.ports);

    expect(result.kind === 'rejected' && result.reason).toBe('marker-without-v2');
    expect(test.calls).not.toContain('saveLegacyRuntime');
    expect(test.calls).not.toContain('writeMigrationCheckpointAndMarker');
  });
});

describe('v2 boot storage payload', (): void => {
  it('pairs the checkpoint and the marker in one object', async (): Promise<void> => {
    const storage: BootStorage = emptyStorage({
      runtime: legacyRuntime({ session: legacySession() }),
    });
    const test: BootHarness = harness(storage, 'saveRuntime');
    await expect(bootRuntimeAuthorityV2(test.ports)).rejects.toThrow(CoreError);
    const checkpoint: RuntimeMigrationCheckpointV1ToV2 = storedMigrationCheckpoint(storage);
    const payload: Record<string, unknown> = migrationStoragePayload(checkpoint);

    expect(Object.keys(payload).sort()).toEqual(
      [LOCAL_RUNTIME_MIGRATION, LOCAL_RUNTIME_SCHEMA].sort(),
    );
    expect(payload[LOCAL_RUNTIME_MIGRATION]).toBe(checkpoint);
    expect(payload[LOCAL_RUNTIME_SCHEMA]).toEqual({ runtimeSchemaVersion: 2 });
  });
});

describe('v2 boot crash recovery', (): void => {
  it('finishes the migration on the next boot when the clear fails', async (): Promise<void> => {
    const storage: BootStorage = emptyStorage({
      runtime: legacyRuntime({ session: legacySession() }),
    });
    const first: BootHarness = harness(storage, 'clearMigrationCheckpoint');

    await expect(bootRuntimeAuthorityV2(first.ports)).rejects.toThrow(CoreError);
    expect(storage.migration).toBeDefined();

    const second: BootHarness = harness(storage);
    const resumed: RuntimeBootResultV2 = await bootRuntimeAuthorityV2(second.ports);

    expect(resumed.kind).toBe('migrated');
    expect(second.calls).not.toContain('writeMigrationCheckpointAndMarker');
    expect(storage.migration).toBeUndefined();

    const third: BootHarness = harness(storage);
    const settled: RuntimeBootResultV2 = await bootRuntimeAuthorityV2(third.ports);

    expect(settled.kind).toBe('v2');
    expect(third.calls.filter((name: string): boolean => V2_WRITE_PORTS.includes(name))).toEqual(
      [],
    );
  });

  it('converges after a crash at every write in the migration order', async (): Promise<void> => {
    for (const failing of MIGRATION_WRITE_PORTS) {
      const storage: BootStorage = emptyStorage({
        runtime: { ...invalidScheduledRuntime(), commitCheckpoint: legacyCheckpoint() },
      });
      const crashed: BootHarness = harness(storage, failing);

      await expect(bootRuntimeAuthorityV2(crashed.ports)).rejects.toThrow(CoreError);

      const resumed: BootHarness = harness(storage);
      const result: RuntimeBootResultV2 = await bootRuntimeAuthorityV2(resumed.ports);
      const ends: SessionEventRecordV2[] = storage.events.filter(
        (event: SessionEventRecordV2): boolean => event.t === 'sessionEnded',
      );

      expect(result.kind, `crash at ${failing}`).toBe('migrated');
      expect(result.runtime.pendingClosure?.stage, `crash at ${failing}`).toBe('cleanup');
      expect(ends, `crash at ${failing}`).toHaveLength(1);
      expect(storage.migration, `crash at ${failing}`).toBeUndefined();
      expect(storage.runtime, `crash at ${failing}`).toEqual(result.runtime);
    }
  });
});

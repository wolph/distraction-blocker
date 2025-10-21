import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { splitFocusByLocalDateV2 } from '../../../src/background/closure-projection-v2';
import {
  type LegacyReplayPortsV1,
  type LegacySettlementInputV1,
  type LegacySettlementResultV1,
  replayLegacyRuntimeCheckpointV1,
  settleLegacySessionV1,
} from '../../../src/background/legacy-runtime-v1';
import type { RuntimeState } from '../../../src/background/stores';
import { emptyRuntime, type RuntimeCommitCheckpoint } from '../../../src/background/stores';
import { accrue } from '../../../src/core/budget';
import { capAttempts, emptyDaily } from '../../../src/core/stats';
import { DEFAULT_LISTS, rulesFromLists, TOP_SITES_DAILY } from '../../../src/shared/constants';
import { CoreError } from '../../../src/shared/errors';
import { syncAggKey } from '../../../src/shared/storage-keys';
import { localDateStr } from '../../../src/shared/time';
import type {
  BankState,
  DailyAgg,
  LegacyEventRecord,
  NormalizedSessionConfigV1,
  NormalizedSessionStateV1,
  PauseEconomy,
} from '../../../src/shared/types';

const ERRATUM_COMMENT: string =
  '// Spec erratum pending sign-off: settledThrough is capped at phaseEndsAt and bank credit uses the accruedFocusMs watermark. Reverse here.';
const DEVICE_ID: string = 'device-1';
const SESSION_ID: string = '10000000-0000-4000-8000-000000000001';
const MINUTE_MS: number = 60_000;
const START_AT: number = new Date(2026, 8, 2, 9, 0, 0, 0).getTime();
const EVENING_START_AT: number = new Date(2026, 8, 2, 23, 30, 0, 0).getTime();
const LOCAL_MIDNIGHT: number = new Date(2026, 8, 3, 0, 0, 0, 0).getTime();
const LOCAL_DATE: string = localDateStr(START_AT);
const NEXT_DATE: string = localDateStr(LOCAL_MIDNIGHT);
const LOCAL_KEY: string = syncAggKey(DEVICE_ID, LOCAL_DATE);
const NEXT_KEY: string = syncAggKey(DEVICE_ID, NEXT_DATE);
const PAUSE_ECONOMY: PauseEconomy = {
  earnRatio: 5 / 30,
  capMs: 3_600_000,
  pauseMs: 5 * MINUTE_MS,
  unlockMs: 5 * MINUTE_MS,
};

type LegacyPortName =
  | 'appendLegacyEvents'
  | 'saveBank'
  | 'saveAggregate'
  | 'removeAggregate'
  | 'persistSyncJournal'
  | 'saveLegacyRuntime';

interface BankWrite {
  bank: BankState;
  syncBank: boolean;
}

interface AggregateWrite {
  key: string;
  value: DailyAgg;
}

interface LegacyHarness {
  ports: LegacyReplayPortsV1;
  names: LegacyPortName[];
  runtimeWrites: RuntimeState[];
  eventBatches: LegacyEventRecord[][];
  bankWrites: BankWrite[];
  aggregateWrites: AggregateWrite[];
  aggregateRemoves: string[];
  journalFlushes: number;
}

function harness(failPort: LegacyPortName | null = null): LegacyHarness {
  const names: LegacyPortName[] = [];
  const runtimeWrites: RuntimeState[] = [];
  const eventBatches: LegacyEventRecord[][] = [];
  const bankWrites: BankWrite[] = [];
  const aggregateWrites: AggregateWrite[] = [];
  const aggregateRemoves: string[] = [];
  const journal: { flushes: number } = { flushes: 0 };

  function record(name: LegacyPortName): void {
    names.push(name);
    if (name === failPort) throw new Error(`${name} rejected`);
  }

  const ports: LegacyReplayPortsV1 = {
    saveLegacyRuntime: async (runtime: RuntimeState): Promise<void> => {
      record('saveLegacyRuntime');
      runtimeWrites.push(runtime);
    },
    appendLegacyEvents: async (events: readonly LegacyEventRecord[]): Promise<void> => {
      record('appendLegacyEvents');
      eventBatches.push([...events]);
    },
    saveBank: async (bank: BankState, syncBank: boolean): Promise<void> => {
      record('saveBank');
      bankWrites.push({ bank, syncBank });
    },
    saveAggregate: async (key: string, value: DailyAgg): Promise<void> => {
      record('saveAggregate');
      aggregateWrites.push({ key, value });
    },
    removeAggregate: async (key: string): Promise<void> => {
      record('removeAggregate');
      aggregateRemoves.push(key);
    },
    persistSyncJournal: async (): Promise<void> => {
      record('persistSyncJournal');
      journal.flushes += 1;
    },
  };

  return {
    ports,
    names,
    runtimeWrites,
    eventBatches,
    bankWrites,
    aggregateWrites,
    aggregateRemoves,
    get journalFlushes(): number {
      return journal.flushes;
    },
  };
}

function legacyConfig(
  overrides: Partial<NormalizedSessionConfigV1> = {},
): NormalizedSessionConfigV1 {
  return {
    mode: 'blacklist',
    strictness: 'hard',
    durationMin: 50,
    cycling: null,
    intention: 'Ship the release',
    source: 'manual',
    scheduleEntryId: null,
    rules: rulesFromLists(DEFAULT_LISTS),
    ...overrides,
  };
}

function focusSession(overrides: Partial<NormalizedSessionStateV1> = {}): NormalizedSessionStateV1 {
  return {
    sessionId: SESSION_ID,
    config: legacyConfig(),
    startedAt: START_AT,
    sessionEndsAt: START_AT + 50 * MINUTE_MS,
    phase: 'focus',
    phaseStartedAt: START_AT,
    phaseEndsAt: START_AT + 50 * MINUTE_MS,
    cycleIndex: 0,
    pausedFrom: null,
    focusedMs: 0,
    ...overrides,
  };
}

function settlementInput(
  overrides: Partial<LegacySettlementInputV1> = {},
): LegacySettlementInputV1 {
  return {
    session: focusSession(),
    bank: { balanceMs: 0 },
    pauseEconomy: PAUSE_ECONOMY,
    accruedFocusMs: 0,
    todayAgg: null,
    runtimeDate: LOCAL_DATE,
    deviceId: DEVICE_ID,
    priorAggregates: {},
    migratedAt: START_AT + 30 * MINUTE_MS,
    ...overrides,
  };
}

function storedDay(date: string, overrides: Partial<DailyAgg> = {}): DailyAgg {
  return {
    ...emptyDaily(date),
    focusMs: 10 * MINUTE_MS,
    sessionsStarted: 2,
    attempts: { 'example.com': 3 },
    pauseMsEarned: 4_000,
    resisted: 1,
    ...overrides,
  };
}

function legacyEvents(): LegacyEventRecord[] {
  return [
    { t: 'budgetEarned', at: START_AT + MINUTE_MS, ms: 5_000, sessionId: SESSION_ID },
    { t: 'phase', at: START_AT + 2 * MINUTE_MS, from: 'focus', to: 'break', sessionId: SESSION_ID },
  ];
}

function legacyCheckpoint(
  overrides: Partial<RuntimeCommitCheckpoint> = {},
): RuntimeCommitCheckpoint {
  return {
    bank: { balanceMs: 120_000 },
    events: legacyEvents(),
    syncBank: true,
    aggregateSets: { [LOCAL_KEY]: storedDay(LOCAL_DATE) },
    aggregateRemoves: [NEXT_KEY],
    ...overrides,
  };
}

function checkpointRuntime(checkpoint: RuntimeCommitCheckpoint): RuntimeState {
  return {
    ...emptyRuntime(START_AT),
    todayAgg: storedDay(LOCAL_DATE),
    commitCheckpoint: checkpoint,
  };
}

function expectInvalidRule(run: () => unknown): void {
  expect(run).toThrow(CoreError);
  try {
    run();
    expect.unreachable('expected an invalid-rule CoreError');
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).code).toBe('invalid-rule');
  }
}

describe('legacy checkpoint replay', (): void => {
  it('does nothing without a stored checkpoint', async (): Promise<void> => {
    const runtime: RuntimeState = emptyRuntime(START_AT);
    const fake: LegacyHarness = harness();

    expect(await replayLegacyRuntimeCheckpointV1(fake.ports, runtime)).toBe(runtime);
    expect(fake.names).toEqual([]);
  });

  it('flushes events, bank, aggregates, removals, then the cleared runtime', async (): Promise<void> => {
    const checkpoint: RuntimeCommitCheckpoint = legacyCheckpoint();
    const runtime: RuntimeState = checkpointRuntime(checkpoint);
    const fake: LegacyHarness = harness();

    const replayed: RuntimeState = await replayLegacyRuntimeCheckpointV1(fake.ports, runtime);

    expect(fake.names).toEqual([
      'appendLegacyEvents',
      'saveBank',
      'saveAggregate',
      'removeAggregate',
      'persistSyncJournal',
      'saveLegacyRuntime',
    ]);
    expect(fake.eventBatches).toEqual([legacyEvents()]);
    expect(fake.bankWrites).toEqual([{ bank: { balanceMs: 120_000 }, syncBank: true }]);
    expect(fake.aggregateWrites).toEqual([
      { key: LOCAL_KEY, value: capAttempts(storedDay(LOCAL_DATE), TOP_SITES_DAILY) },
    ]);
    expect(fake.aggregateRemoves).toEqual([NEXT_KEY]);
    expect(replayed.commitCheckpoint).toBeNull();
    expect(fake.runtimeWrites).toEqual([replayed]);
    expect(replayed.todayAgg).toEqual(runtime.todayAgg);
    expect(runtime.commitCheckpoint).toEqual(checkpoint);
  });

  it('skips the bank write when the checkpoint did not mark it dirty', async (): Promise<void> => {
    const fake: LegacyHarness = harness();

    await replayLegacyRuntimeCheckpointV1(
      fake.ports,
      checkpointRuntime(legacyCheckpoint({ syncBank: false })),
    );

    expect(fake.names).toEqual([
      'appendLegacyEvents',
      'saveAggregate',
      'removeAggregate',
      'persistSyncJournal',
      'saveLegacyRuntime',
    ]);
    expect(fake.bankWrites).toEqual([]);
  });

  it('treats the optional v1 aggregate fields as empty', async (): Promise<void> => {
    const fake: LegacyHarness = harness();
    const runtime: RuntimeState = checkpointRuntime({
      bank: { balanceMs: 0 },
      events: [],
      syncBank: true,
    });

    await replayLegacyRuntimeCheckpointV1(fake.ports, runtime);

    expect(fake.names).toEqual([
      'appendLegacyEvents',
      'saveBank',
      'persistSyncJournal',
      'saveLegacyRuntime',
    ]);
    expect(fake.eventBatches).toEqual([[]]);
    expect(fake.aggregateWrites).toEqual([]);
    expect(fake.aggregateRemoves).toEqual([]);
  });

  it('caps every aggregate set before writing it', async (): Promise<void> => {
    const attempts: Record<string, number> = {};
    for (let index: number = 0; index < TOP_SITES_DAILY + 1; index++) {
      attempts[`host-${index}.example`] = index + 1;
    }
    const wide: DailyAgg = { ...emptyDaily(LOCAL_DATE), attempts };
    const fake: LegacyHarness = harness();

    await replayLegacyRuntimeCheckpointV1(
      fake.ports,
      checkpointRuntime(legacyCheckpoint({ aggregateSets: { [LOCAL_KEY]: wide } })),
    );

    expect(fake.aggregateWrites).toEqual([
      { key: LOCAL_KEY, value: capAttempts(wide, TOP_SITES_DAILY) },
    ]);
    expect(Object.keys(fake.aggregateWrites[0]?.value.attempts ?? {})).toHaveLength(
      TOP_SITES_DAILY,
    );
  });

  it('never reads a version or projection field from the legacy checkpoint', async (): Promise<void> => {
    const guarded: RuntimeCommitCheckpoint = new Proxy<RuntimeCommitCheckpoint>(
      legacyCheckpoint(),
      {
        get: (
          target: RuntimeCommitCheckpoint,
          property: PropertyKey,
          receiver: unknown,
        ): unknown => {
          if (property === 'version' || property === 'projection') {
            throw new Error(`legacy replay read ${String(property)}`);
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const fake: LegacyHarness = harness();

    const replayed: RuntimeState = await replayLegacyRuntimeCheckpointV1(
      fake.ports,
      checkpointRuntime(guarded),
    );

    expect(replayed.commitCheckpoint).toBeNull();
    expect(fake.names).toHaveLength(6);
  });

  it('issues the same calls when the same checkpoint replays twice', async (): Promise<void> => {
    const runtime: RuntimeState = checkpointRuntime(legacyCheckpoint());
    const first: LegacyHarness = harness();
    const second: LegacyHarness = harness();

    const firstRun: RuntimeState = await replayLegacyRuntimeCheckpointV1(first.ports, runtime);
    const secondRun: RuntimeState = await replayLegacyRuntimeCheckpointV1(second.ports, runtime);

    expect(secondRun).toEqual(firstRun);
    expect(second.names).toEqual(first.names);
    expect(second.eventBatches).toEqual(first.eventBatches);
    expect(second.eventBatches[0]).toEqual(legacyEvents());
    expect(second.bankWrites).toEqual(first.bankWrites);
    expect(second.aggregateWrites).toEqual(first.aggregateWrites);
    expect(second.aggregateRemoves).toEqual(first.aggregateRemoves);
    expect(second.runtimeWrites).toEqual(first.runtimeWrites);
  });

  it('flushes the sync journal before the write that clears the checkpoint', async (): Promise<void> => {
    const fake: LegacyHarness = harness();

    await replayLegacyRuntimeCheckpointV1(fake.ports, checkpointRuntime(legacyCheckpoint()));

    expect(fake.names.indexOf('persistSyncJournal')).toBeLessThan(
      fake.names.indexOf('saveLegacyRuntime'),
    );
    expect(fake.journalFlushes).toBe(1);
  });

  it('replays the whole flush after a crash in the journal barrier', async (): Promise<void> => {
    const runtime: RuntimeState = checkpointRuntime(legacyCheckpoint());
    const crashed: LegacyHarness = harness('persistSyncJournal');

    await expect(replayLegacyRuntimeCheckpointV1(crashed.ports, runtime)).rejects.toThrow(
      'persistSyncJournal rejected',
    );

    expect(crashed.runtimeWrites).toEqual([]);
    expect(runtime.commitCheckpoint).not.toBeNull();

    const recovered: LegacyHarness = harness();
    const replayed: RuntimeState = await replayLegacyRuntimeCheckpointV1(recovered.ports, runtime);

    expect(recovered.names).toEqual([
      'appendLegacyEvents',
      'saveBank',
      'saveAggregate',
      'removeAggregate',
      'persistSyncJournal',
      'saveLegacyRuntime',
    ]);
    expect(replayed.commitCheckpoint).toBeNull();
  });

  it('replays the journal again after a crash between the barrier and the clear', async (): Promise<void> => {
    const runtime: RuntimeState = checkpointRuntime(legacyCheckpoint());
    const crashed: LegacyHarness = harness('saveLegacyRuntime');

    await expect(replayLegacyRuntimeCheckpointV1(crashed.ports, runtime)).rejects.toThrow(
      'saveLegacyRuntime rejected',
    );

    expect(crashed.journalFlushes).toBe(1);
    expect(crashed.runtimeWrites).toEqual([]);
    expect(runtime.commitCheckpoint).not.toBeNull();

    const recovered: LegacyHarness = harness();
    await replayLegacyRuntimeCheckpointV1(recovered.ports, runtime);

    expect(recovered.journalFlushes).toBe(1);
    expect(recovered.names.indexOf('persistSyncJournal')).toBeLessThan(
      recovered.names.indexOf('saveLegacyRuntime'),
    );
    expect(recovered.runtimeWrites).toHaveLength(1);
  });

  it('fails with an invalid-rule error when the runtime cannot be detached', async (): Promise<void> => {
    const hostile: RuntimeState = checkpointRuntime(legacyCheckpoint());
    Object.assign(hostile, { attemptDebounce: { broken: ((): void => {}) as unknown as number } });
    const fake: LegacyHarness = harness();

    await replayLegacyRuntimeCheckpointV1(fake.ports, hostile).then(
      (): void => expect.unreachable('expected an invalid-rule CoreError'),
      (error: unknown): void => {
        expect(error).toBeInstanceOf(CoreError);
        expect((error as CoreError).code).toBe('invalid-rule');
      },
    );

    expect(fake.names).toEqual([
      'appendLegacyEvents',
      'saveBank',
      'saveAggregate',
      'removeAggregate',
      'persistSyncJournal',
    ]);
    expect(fake.runtimeWrites).toEqual([]);
  });

  it('detaches the runtime it returns from the runtime it read', async (): Promise<void> => {
    const runtime: RuntimeState = checkpointRuntime(legacyCheckpoint());
    const fake: LegacyHarness = harness();

    const replayed: RuntimeState = await replayLegacyRuntimeCheckpointV1(fake.ports, runtime);
    if (replayed.todayAgg !== null) replayed.todayAgg.focusMs = 1;

    expect(runtime.todayAgg).toEqual(storedDay(LOCAL_DATE));
  });
});

describe('legacy focus settlement', (): void => {
  it('credits a focus phase through the migration instant', (): void => {
    const result: LegacySettlementResultV1 = settleLegacySessionV1(settlementInput());

    expect(result.settlement).toEqual({
      settledAt: START_AT + 30 * MINUTE_MS,
      settledThrough: START_AT + 30 * MINUTE_MS,
      phaseAtMigration: 'focus',
      focusedMsBefore: 0,
      creditedFocusMs: 30 * MINUTE_MS,
      focusedMsAfter: 30 * MINUTE_MS,
    });
    expect(result.accruedFocusMsAfter).toBe(30 * MINUTE_MS);
  });

  it('returns the watermark the projected runtime adopts', (): void => {
    const settled: LegacySettlementResultV1 = settleLegacySessionV1(
      settlementInput({
        session: focusSession({ focusedMs: 10 * MINUTE_MS }),
        accruedFocusMs: 10 * MINUTE_MS,
      }),
    );

    expect(settled.accruedFocusMsAfter).toBe(settled.settlement.focusedMsAfter);

    // The migrated runtime carries the settled focus and this watermark, so settling it again at
    // the same instant credits nothing and banks nothing.
    const replayed: LegacySettlementResultV1 = settleLegacySessionV1(
      settlementInput({
        session: focusSession({
          focusedMs: settled.settlement.focusedMsAfter,
          phaseStartedAt: settled.settlement.settledThrough,
        }),
        accruedFocusMs: settled.accruedFocusMsAfter,
        bank: settled.bankAfter,
        migratedAt: START_AT + 30 * MINUTE_MS,
      }),
    );

    expect(replayed.settlement.creditedFocusMs).toBe(0);

    expect(replayed.bankAfter).toEqual(settled.bankAfter);
    expect(replayed.earnedMs).toBe(0);
    expect(replayed.aggregateSets).toEqual({});
  });

  it('credits only through the fixed session end', (): void => {
    const result: LegacySettlementResultV1 = settleLegacySessionV1(
      settlementInput({
        session: focusSession({
          sessionEndsAt: START_AT + 20 * MINUTE_MS,
          phaseEndsAt: START_AT + 20 * MINUTE_MS,
        }),
        migratedAt: START_AT + 45 * MINUTE_MS,
      }),
    );

    expect(result.settlement.settledThrough).toBe(START_AT + 20 * MINUTE_MS);
    expect(result.settlement.creditedFocusMs).toBe(20 * MINUTE_MS);
  });

  it('credits only through the end of the durable focus phase', (): void => {
    const result: LegacySettlementResultV1 = settleLegacySessionV1(
      settlementInput({
        session: focusSession({ phaseEndsAt: START_AT + 10 * MINUTE_MS }),
        migratedAt: START_AT + 45 * MINUTE_MS,
      }),
    );

    expect(result.settlement.settledThrough).toBe(START_AT + 10 * MINUTE_MS);
    expect(result.settlement.creditedFocusMs).toBe(10 * MINUTE_MS);
  });

  it.each([['break'], ['paused']] as const)(
    'credits nothing during %s',
    (phase: 'break' | 'paused'): void => {
      const result: LegacySettlementResultV1 = settleLegacySessionV1(
        settlementInput({
          session: focusSession({
            phase,
            phaseStartedAt: START_AT + 25 * MINUTE_MS,
            phaseEndsAt: START_AT + 30 * MINUTE_MS,
            focusedMs: 25 * MINUTE_MS,
            pausedFrom:
              phase === 'paused'
                ? { phase: 'focus', phaseEndsAt: START_AT + 50 * MINUTE_MS }
                : null,
          }),
          accruedFocusMs: 25 * MINUTE_MS,
        }),
      );

      expect(result.settlement.phaseAtMigration).toBe(phase);
      expect(result.settlement.creditedFocusMs).toBe(0);
      expect(result.settlement.focusedMsAfter).toBe(25 * MINUTE_MS);
      expect(result.aggregateSets).toEqual({});
      expect(result.earnedMs).toBe(0);
    },
  );

  it('banks focus a torn watermark never credited, even outside a focus phase', (): void => {
    const result: LegacySettlementResultV1 = settleLegacySessionV1(
      settlementInput({
        session: focusSession({
          phase: 'break',
          phaseStartedAt: START_AT + 25 * MINUTE_MS,
          phaseEndsAt: START_AT + 30 * MINUTE_MS,
          focusedMs: 25 * MINUTE_MS,
        }),
        accruedFocusMs: 5 * MINUTE_MS,
      }),
    );

    expect(result.settlement.creditedFocusMs).toBe(0);
    expect(result.settlement.settledThrough).toBe(START_AT + 30 * MINUTE_MS);
    expect(result.bankAfter).toEqual(accrue({ balanceMs: 0 }, 20 * MINUTE_MS, PAUSE_ECONOMY));
    expect(result.aggregateSets[LOCAL_KEY]?.focusMs).toBe(20 * MINUTE_MS);
  });

  it('ends a non-focus split window where the focus stopped, not where the phase did', (): void => {
    const stored: DailyAgg = storedDay(LOCAL_DATE);
    const result: LegacySettlementResultV1 = settleLegacySessionV1(
      settlementInput({
        session: focusSession({
          phase: 'break',
          startedAt: LOCAL_MIDNIGHT - 40 * MINUTE_MS,
          phaseStartedAt: LOCAL_MIDNIGHT + 10 * MINUTE_MS,
          phaseEndsAt: LOCAL_MIDNIGHT + 40 * MINUTE_MS,
          sessionEndsAt: LOCAL_MIDNIGHT + 90 * MINUTE_MS,
          focusedMs: 30 * MINUTE_MS,
        }),
        accruedFocusMs: 0,
        runtimeDate: NEXT_DATE,
        todayAgg: emptyDaily(NEXT_DATE),
        priorAggregates: { [LOCAL_KEY]: stored },
        migratedAt: LOCAL_MIDNIGHT + 60 * MINUTE_MS,
      }),
    );

    expect(result.settlement.settledThrough).toBe(LOCAL_MIDNIGHT + 40 * MINUTE_MS);
    expect(result.settlement.creditedFocusMs).toBe(0);
    expect(result.aggregateSets[LOCAL_KEY]?.focusMs).toBe(stored.focusMs + 20 * MINUTE_MS);
    expect(result.aggregateSets[NEXT_KEY]?.focusMs).toBe(10 * MINUTE_MS);
  });

  it('settles a pause whose end runs past the session end', (): void => {
    const result: LegacySettlementResultV1 = settleLegacySessionV1(
      settlementInput({
        session: focusSession({
          phase: 'paused',
          phaseStartedAt: START_AT + 48 * MINUTE_MS,
          phaseEndsAt: START_AT + 53 * MINUTE_MS,
          focusedMs: 48 * MINUTE_MS,
          pausedFrom: { phase: 'focus', phaseEndsAt: START_AT + 50 * MINUTE_MS },
        }),
        accruedFocusMs: 48 * MINUTE_MS,
        migratedAt: START_AT + 60 * MINUTE_MS,
      }),
    );

    expect(result.settlement.settledThrough).toBe(START_AT + 50 * MINUTE_MS);
    expect(result.settlement.creditedFocusMs).toBe(0);
    expect(result.bankAfter).toEqual({ balanceMs: 0 });
    expect(result.earnedMs).toBe(0);
  });

  it('banks only the focus the watermark has not credited yet', (): void => {
    const input: LegacySettlementInputV1 = settlementInput({
      session: focusSession({ focusedMs: 10 * MINUTE_MS, phaseStartedAt: START_AT }),
      accruedFocusMs: 10 * MINUTE_MS,
    });

    const result: LegacySettlementResultV1 = settleLegacySessionV1(input);

    expect(result.settlement.focusedMsAfter).toBe(40 * MINUTE_MS);
    expect(result.bankAfter).toEqual(accrue({ balanceMs: 0 }, 30 * MINUTE_MS, PAUSE_ECONOMY));
    expect(result.earnedMs).toBe(5 * MINUTE_MS);
    expect(result.aggregateSets[LOCAL_KEY]?.focusMs).toBe(30 * MINUTE_MS);
  });

  it.each([[30 * MINUTE_MS], [45 * MINUTE_MS]])(
    'banks nothing when the watermark already covers the settled focus (%#)',
    (accruedFocusMs: number): void => {
      const result: LegacySettlementResultV1 = settleLegacySessionV1(
        settlementInput({ accruedFocusMs, bank: { balanceMs: 42_000 } }),
      );

      expect(result.settlement.creditedFocusMs).toBe(30 * MINUTE_MS);
      expect(result.bankAfter).toEqual({ balanceMs: 42_000 });
      expect(result.earnedMs).toBe(0);
      expect(result.aggregateSets).toEqual({});
    },
  );

  it('reports only the balance growth the pause cap allowed', (): void => {
    const result: LegacySettlementResultV1 = settleLegacySessionV1(
      settlementInput({ bank: { balanceMs: PAUSE_ECONOMY.capMs - MINUTE_MS } }),
    );

    expect(result.bankAfter).toEqual({ balanceMs: PAUSE_ECONOMY.capMs });
    expect(result.earnedMs).toBe(MINUTE_MS);
  });

  it('splits the banked delta across every local date it covers', (): void => {
    const migratedAt: number = LOCAL_MIDNIGHT + 20 * MINUTE_MS;
    const result: LegacySettlementResultV1 = settleLegacySessionV1(
      settlementInput({
        session: focusSession({
          startedAt: EVENING_START_AT,
          phaseStartedAt: EVENING_START_AT,
          sessionEndsAt: EVENING_START_AT + 90 * MINUTE_MS,
          phaseEndsAt: EVENING_START_AT + 90 * MINUTE_MS,
        }),
        todayAgg: storedDay(LOCAL_DATE),
        migratedAt,
      }),
    );

    const splits: Array<{ date: string; ms: number }> = splitFocusByLocalDateV2(
      EVENING_START_AT,
      migratedAt,
    );
    expect(splits).toEqual([
      { date: LOCAL_DATE, ms: LOCAL_MIDNIGHT - EVENING_START_AT },
      { date: NEXT_DATE, ms: migratedAt - LOCAL_MIDNIGHT },
    ]);
    expect(Object.keys(result.aggregateSets)).toEqual([LOCAL_KEY, NEXT_KEY]);
    expect(result.aggregateSets[LOCAL_KEY]?.focusMs).toBe(
      storedDay(LOCAL_DATE).focusMs + (LOCAL_MIDNIGHT - EVENING_START_AT),
    );
    expect(result.aggregateSets[NEXT_KEY]).toEqual({
      ...emptyDaily(NEXT_DATE),
      focusMs: migratedAt - LOCAL_MIDNIGHT,
    });
    expect(result.todayAgg).toEqual(result.aggregateSets[LOCAL_KEY]);
  });

  it('keeps a finished day that the split reaches through the stored aggregate', (): void => {
    const migratedAt: number = LOCAL_MIDNIGHT + 20 * MINUTE_MS;
    const stored: DailyAgg = storedDay(LOCAL_DATE);
    const result: LegacySettlementResultV1 = settleLegacySessionV1(
      settlementInput({
        session: focusSession({
          startedAt: EVENING_START_AT,
          phaseStartedAt: EVENING_START_AT,
          sessionEndsAt: EVENING_START_AT + 90 * MINUTE_MS,
          phaseEndsAt: EVENING_START_AT + 90 * MINUTE_MS,
        }),
        runtimeDate: NEXT_DATE,
        todayAgg: emptyDaily(NEXT_DATE),
        priorAggregates: { [LOCAL_KEY]: stored },
        migratedAt,
      }),
    );

    expect(result.aggregateSets[LOCAL_KEY]).toEqual({
      ...stored,
      focusMs: stored.focusMs + (LOCAL_MIDNIGHT - EVENING_START_AT),
    });
    expect(result.aggregateSets[LOCAL_KEY]?.sessionsCompleted).toBe(0);
    expect(result.aggregateSets[NEXT_KEY]?.focusMs).toBe(migratedAt - LOCAL_MIDNIGHT);
  });

  it('refuses to settle a finished day the caller did not supply', (): void => {
    expectInvalidRule(
      (): LegacySettlementResultV1 =>
        settleLegacySessionV1(
          settlementInput({
            session: focusSession({
              startedAt: EVENING_START_AT,
              phaseStartedAt: EVENING_START_AT,
              sessionEndsAt: EVENING_START_AT + 90 * MINUTE_MS,
              phaseEndsAt: EVENING_START_AT + 90 * MINUTE_MS,
            }),
            runtimeDate: NEXT_DATE,
            todayAgg: emptyDaily(NEXT_DATE),
            migratedAt: LOCAL_MIDNIGHT + 20 * MINUTE_MS,
          }),
        ),
    );
  });

  it('returns the runtime aggregate even when the split misses it', (): void => {
    const result: LegacySettlementResultV1 = settleLegacySessionV1(
      settlementInput({ accruedFocusMs: 30 * MINUTE_MS, todayAgg: storedDay(LOCAL_DATE) }),
    );

    expect(result.aggregateSets).toEqual({});
    expect(result.todayAgg).toEqual(capAttempts(storedDay(LOCAL_DATE), TOP_SITES_DAILY));
  });

  it('detaches every returned value from the input', (): void => {
    const input: LegacySettlementInputV1 = settlementInput({ todayAgg: storedDay(LOCAL_DATE) });
    const before: LegacySettlementInputV1 = structuredClone(input);

    const result: LegacySettlementResultV1 = settleLegacySessionV1(input);
    result.todayAgg.focusMs = 1;
    result.bankAfter.balanceMs = 2;
    const local: DailyAgg | undefined = result.aggregateSets[LOCAL_KEY];
    if (local !== undefined) local.sessionsStarted = 3;

    expect(input).toEqual(before);
    expect(result.settlement.focusedMsAfter).toBe(30 * MINUTE_MS);
  });

  it.each([
    settlementInput({ migratedAt: START_AT - 1 }),
    settlementInput({ accruedFocusMs: Number.NaN }),
    settlementInput({ accruedFocusMs: Number.POSITIVE_INFINITY }),
    settlementInput({ accruedFocusMs: -1 }),
    settlementInput({ deviceId: '   ' }),
    settlementInput({ deviceId: '' }),
    settlementInput({ migratedAt: Number.MAX_SAFE_INTEGER + 1 }),
    settlementInput({ todayAgg: emptyDaily(NEXT_DATE) }),
    settlementInput({ runtimeDate: 'garbage', todayAgg: null }),
    settlementInput({ bank: { balanceMs: Number.NaN } }),
  ])('refuses the hostile settlement input %#', (input: LegacySettlementInputV1): void => {
    expectInvalidRule((): LegacySettlementResultV1 => settleLegacySessionV1(input));
  });
});

describe('legacy settlement source', (): void => {
  it('carries the reversible erratum comment exactly once', (): void => {
    const source: string = readFileSync(
      fileURLToPath(new URL('../../../src/background/legacy-runtime-v1.ts', import.meta.url)),
      'utf8',
    );

    expect(source.split(ERRATUM_COMMENT)).toHaveLength(2);
    expect(source).toContain('function legacySettlementBoundsV1(');
    expect(source.indexOf(ERRATUM_COMMENT)).toBeLessThan(
      source.indexOf('function legacySettlementBoundsV1('),
    );
  });
});

import { describe, expect, it } from 'vitest';
import { replaceCleanupBatchV2 } from '../../../src/background/cleanup-progress-v2';
import { mergeEventLogV2 } from '../../../src/background/event-log-v2';
import {
  applyRuntimeCheckpointV2,
  commitRuntimeCheckpointV2,
  projectRuntimeDomainV2,
  type RuntimeCheckpointPortsV2,
  type RuntimeCommitInputV2,
  replayRuntimeCheckpointV2,
  runtimeMatchesProjectionV2,
} from '../../../src/background/runtime-checkpoint-v2';
import type {
  CleanupProgress,
  RuntimeCommitCheckpointV2,
  RuntimeDomainProjectionV2,
  RuntimeStateV2,
} from '../../../src/background/runtime-v2-types';
import { parseRuntimeStateV2 } from '../../../src/background/runtime-v2-validation';
import { capAttempts, emptyDaily } from '../../../src/core/stats';
import { TOP_SITES_DAILY } from '../../../src/shared/constants';
import { CoreError } from '../../../src/shared/errors';
import type { BankState, DailyAgg, SessionEventRecordV2 } from '../../../src/shared/types';
import {
  AGGREGATE_KEY,
  bankState,
  budgetEarnedEvent,
  CLEAR_RUNTIME_REVISION,
  type CleanupClosureV2,
  cleanupClosureRuntime,
  commitCheckpointRuntime,
  dailyAgg,
  LOCAL_DATE,
  NOW,
  OTHER_OPERATION_ID,
  preparedClosureRuntime,
  publishedFocusRuntime,
  RUNTIME_CLOSED_AT,
  runtimeCommitCheckpoint,
  runtimeDomainProjection,
  sessionEndedEvent,
  sessionStartedEvent,
} from './runtime-v2-fixtures';

const PROJECTED_FIELDS: readonly string[] = [
  'session',
  'gate',
  'unlocks',
  'accruedFocusMs',
  'handledScheduleOccurrences',
  'enforcementEpoch',
  'epochResetAcks',
  'basePolicyRevision',
  'runtimeRevision',
  'documentCommands',
  'enforcementCheckpoint',
  'pendingEnforcementTransition',
  'pendingClosure',
];
const SECOND_AGGREGATE_KEY: string = 'agg:device-2:2026-09-02';
const REMOVED_AGGREGATE_KEY: string = 'agg:device-3:2026-09-01';

type PortName = 'saveRuntime' | 'appendEvents' | 'saveBank' | 'saveAggregate' | 'removeAggregate';

interface BankWrite {
  bank: BankState;
  syncBank: boolean;
}

interface AggregateWrite {
  key: string;
  value: DailyAgg;
}

interface HarnessOptions {
  failPort: PortName;
  failOccurrence: number;
  storedEvents: SessionEventRecordV2[];
}

interface Harness {
  ports: RuntimeCheckpointPortsV2;
  names: PortName[];
  runtimeWrites: RuntimeStateV2[];
  eventBatches: SessionEventRecordV2[][];
  log: { events: SessionEventRecordV2[] };
  bankWrites: BankWrite[];
  aggregateWrites: AggregateWrite[];
  aggregateRemoves: string[];
}

/** Fake ports that record call order, keep the durable writes, and merge events like the v2 log. */
function harness(options: Partial<HarnessOptions> = {}): Harness {
  const names: PortName[] = [];
  const runtimeWrites: RuntimeStateV2[] = [];
  const eventBatches: SessionEventRecordV2[][] = [];
  const log: { events: SessionEventRecordV2[] } = { events: options.storedEvents ?? [] };
  const bankWrites: BankWrite[] = [];
  const aggregateWrites: AggregateWrite[] = [];
  const aggregateRemoves: string[] = [];

  function record(name: PortName): void {
    names.push(name);
    const occurrence: number = names.filter((entry: PortName): boolean => entry === name).length;
    if (name === options.failPort && occurrence === (options.failOccurrence ?? 1)) {
      throw new Error(`${name} rejected`);
    }
  }

  const ports: RuntimeCheckpointPortsV2 = {
    saveRuntime: async (runtime: RuntimeStateV2): Promise<void> => {
      record('saveRuntime');
      runtimeWrites.push(runtime);
    },
    appendEvents: async (events: readonly SessionEventRecordV2[]): Promise<void> => {
      record('appendEvents');
      eventBatches.push([...events]);
      log.events = mergeEventLogV2(log.events, events);
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
  };

  return {
    ports,
    names,
    runtimeWrites,
    eventBatches,
    log,
    bankWrites,
    aggregateWrites,
    aggregateRemoves,
  };
}

function commitInput(
  checkpoint: RuntimeCommitCheckpointV2,
  overrides: Partial<RuntimeCommitInputV2> = {},
): RuntimeCommitInputV2 {
  return {
    checkpointId: checkpoint.checkpointId,
    projection: checkpoint.projection,
    bank: checkpoint.bank,
    events: checkpoint.events,
    syncBank: checkpoint.syncBank,
    aggregateSets: checkpoint.aggregateSets,
    aggregateRemoves: checkpoint.aggregateRemoves,
    ...overrides,
  };
}

function expectInvalidRule(error: unknown): void {
  expect(error).toBeInstanceOf(CoreError);
  expect((error as CoreError).code).toBe('invalid-rule');
}

function wideAggregate(): DailyAgg {
  const attempts: Record<string, number> = {};
  for (let index: number = 0; index < TOP_SITES_DAILY + 1; index++) {
    attempts[`host-${index}.example`] = index + 1;
  }
  return { ...emptyDaily(LOCAL_DATE), attempts };
}

describe('runtime domain projection', (): void => {
  it('copies exactly the thirteen projected fields', (): void => {
    const runtime: RuntimeStateV2 = publishedFocusRuntime();

    const projection: RuntimeDomainProjectionV2 = projectRuntimeDomainV2(runtime);

    expect(Object.keys(projection).sort()).toEqual([...PROJECTED_FIELDS].sort());
    expect(projection).toEqual(runtimeDomainProjection(runtime));
  });

  it('detaches the projection from the runtime it read', (): void => {
    const runtime: RuntimeStateV2 = publishedFocusRuntime();
    const projection: RuntimeDomainProjectionV2 = projectRuntimeDomainV2(runtime);
    const unlock: { until: number } | undefined = runtime.unlocks[0];
    if (unlock !== undefined) unlock.until += 1_000;

    expect(projection.unlocks).toEqual(publishedFocusRuntime().unlocks);
  });

  it('matches a runtime against its own projection', (): void => {
    const runtime: RuntimeStateV2 = publishedFocusRuntime();

    expect(runtimeMatchesProjectionV2(runtime, projectRuntimeDomainV2(runtime))).toBe(true);
  });

  it('rejects a single differing nested value', (): void => {
    const runtime: RuntimeStateV2 = publishedFocusRuntime();
    const projection: RuntimeDomainProjectionV2 = projectRuntimeDomainV2(runtime);
    const unlock: { until: number } | undefined = projection.unlocks[0];
    if (unlock !== undefined) unlock.until += 1;

    expect(runtimeMatchesProjectionV2(runtime, projection)).toBe(false);
  });

  it('rejects a differing top-level scalar', (): void => {
    const runtime: RuntimeStateV2 = publishedFocusRuntime();
    const projection: RuntimeDomainProjectionV2 = projectRuntimeDomainV2(runtime);

    expect(
      runtimeMatchesProjectionV2(runtime, {
        ...projection,
        accruedFocusMs: projection.accruedFocusMs + 1,
      }),
    ).toBe(false);
  });
});

describe('checkpoint application', (): void => {
  it('projects the checkpoint over the runtime and keeps every other field', (): void => {
    const before: RuntimeStateV2 = preparedClosureRuntime();
    const after: RuntimeStateV2 = cleanupClosureRuntime();
    const checkpoint: RuntimeCommitCheckpointV2 = runtimeCommitCheckpoint(after);

    const applied: RuntimeStateV2 = applyRuntimeCheckpointV2(before, checkpoint);

    expect(runtimeMatchesProjectionV2(applied, checkpoint.projection)).toBe(true);
    expect(applied.commitCheckpoint).toEqual(checkpoint);
    expect(applied.tabStates).toEqual(before.tabStates);
    expect(applied.attemptDebounce).toEqual(before.attemptDebounce);
    expect(applied.deferredBlockClaims).toEqual(before.deferredBlockClaims);
    expect(applied.removedTabTombstones).toEqual(before.removedTabTombstones);
    expect(applied.scheduleUnavailableNoticeToken).toBe(before.scheduleUnavailableNoticeToken);
    expect(applied.date).toBe(before.date);
    expect(applied.todayAgg).toEqual(before.todayAgg);
    expect(applied.lastPruneDate).toBe(before.lastPruneDate);
    expect(parseRuntimeStateV2(applied)).not.toBeNull();
  });

  it('never mutates the runtime or the checkpoint it read', (): void => {
    const before: RuntimeStateV2 = preparedClosureRuntime();
    const checkpoint: RuntimeCommitCheckpointV2 = runtimeCommitCheckpoint(cleanupClosureRuntime());

    const applied: RuntimeStateV2 = applyRuntimeCheckpointV2(before, checkpoint);
    applied.accruedFocusMs += 1;
    applied.unlocks.length = 0;

    expect(before).toEqual(preparedClosureRuntime());
    expect(checkpoint).toEqual(runtimeCommitCheckpoint(cleanupClosureRuntime()));
  });
});

describe('checkpoint commit', (): void => {
  it('writes the checkpoint, flushes in the fixed order, then clears it', async (): Promise<void> => {
    const before: RuntimeStateV2 = preparedClosureRuntime();
    const after: RuntimeStateV2 = cleanupClosureRuntime();
    const checkpoint: RuntimeCommitCheckpointV2 = runtimeCommitCheckpoint(after, {
      aggregateSets: { [SECOND_AGGREGATE_KEY]: dailyAgg(), [AGGREGATE_KEY]: dailyAgg() },
      aggregateRemoves: [REMOVED_AGGREGATE_KEY, AGGREGATE_KEY],
    });
    const fake: Harness = harness();

    const committed: RuntimeStateV2 = await commitRuntimeCheckpointV2(
      fake.ports,
      before,
      commitInput(checkpoint),
    );

    expect(fake.names).toEqual([
      'saveRuntime',
      'appendEvents',
      'saveBank',
      'saveAggregate',
      'saveAggregate',
      'removeAggregate',
      'removeAggregate',
      'saveRuntime',
    ]);
    expect(fake.runtimeWrites[0]).toEqual(applyRuntimeCheckpointV2(before, checkpoint));
    expect(fake.eventBatches).toEqual([checkpoint.events]);
    expect(fake.bankWrites).toEqual([{ bank: checkpoint.bank, syncBank: checkpoint.syncBank }]);
    expect(fake.aggregateWrites.map((write: AggregateWrite): string => write.key)).toEqual([
      AGGREGATE_KEY,
      SECOND_AGGREGATE_KEY,
    ]);
    expect(fake.aggregateRemoves).toEqual([REMOVED_AGGREGATE_KEY, AGGREGATE_KEY]);
    expect(fake.runtimeWrites[1]?.commitCheckpoint).toBeNull();
    expect(committed.commitCheckpoint).toBeNull();
    expect(runtimeMatchesProjectionV2(committed, checkpoint.projection)).toBe(true);
    expect(parseRuntimeStateV2(committed)).not.toBeNull();
  });

  it('caps every aggregate set before writing it', async (): Promise<void> => {
    const runtime: RuntimeStateV2 = cleanupClosureRuntime();
    const checkpoint: RuntimeCommitCheckpointV2 = runtimeCommitCheckpoint(runtime, {
      aggregateSets: { [AGGREGATE_KEY]: wideAggregate() },
      aggregateRemoves: [],
    });
    const fake: Harness = harness();

    await commitRuntimeCheckpointV2(fake.ports, runtime, commitInput(checkpoint));

    expect(fake.aggregateWrites).toEqual([
      { key: AGGREGATE_KEY, value: capAttempts(wideAggregate(), TOP_SITES_DAILY) },
    ]);
    expect(Object.keys(fake.aggregateWrites[0]?.value.attempts ?? {})).toHaveLength(
      TOP_SITES_DAILY,
    );
    expect(fake.runtimeWrites[0]?.commitCheckpoint?.aggregateSets).toEqual({
      [AGGREGATE_KEY]: wideAggregate(),
    });
  });

  it('keeps empty aggregate collections in the stored checkpoint', async (): Promise<void> => {
    const runtime: RuntimeStateV2 = cleanupClosureRuntime();
    const checkpoint: RuntimeCommitCheckpointV2 = runtimeCommitCheckpoint(runtime, {
      aggregateSets: {},
      aggregateRemoves: [],
    });
    const fake: Harness = harness();

    await commitRuntimeCheckpointV2(fake.ports, runtime, commitInput(checkpoint));

    expect(fake.runtimeWrites[0]?.commitCheckpoint?.aggregateSets).toEqual({});
    expect(fake.runtimeWrites[0]?.commitCheckpoint?.aggregateRemoves).toEqual([]);
    expect(fake.names).toEqual(['saveRuntime', 'appendEvents', 'saveBank', 'saveRuntime']);
  });

  it('propagates a first write rejection without calling a later port', async (): Promise<void> => {
    const runtime: RuntimeStateV2 = cleanupClosureRuntime();
    const fake: Harness = harness({ failPort: 'saveRuntime', failOccurrence: 1 });

    await expect(
      commitRuntimeCheckpointV2(fake.ports, runtime, commitInput(runtimeCommitCheckpoint(runtime))),
    ).rejects.toThrow('saveRuntime rejected');

    expect(fake.names).toEqual(['saveRuntime']);
    expect(fake.runtimeWrites).toEqual([]);
  });

  it('leaves the checkpoint durable when a flush rejects', async (): Promise<void> => {
    const runtime: RuntimeStateV2 = cleanupClosureRuntime();
    const checkpoint: RuntimeCommitCheckpointV2 = runtimeCommitCheckpoint(runtime);
    const fake: Harness = harness({ failPort: 'saveBank', failOccurrence: 1 });

    await expect(
      commitRuntimeCheckpointV2(fake.ports, runtime, commitInput(checkpoint)),
    ).rejects.toThrow('saveBank rejected');

    expect(fake.names).toEqual(['saveRuntime', 'appendEvents', 'saveBank']);
    expect(fake.runtimeWrites).toHaveLength(1);
    expect(fake.runtimeWrites[0]?.commitCheckpoint).toEqual(checkpoint);
  });

  it.each([
    [
      'a version 1 session shape',
      (checkpoint: RuntimeCommitCheckpointV2): RuntimeCommitCheckpointV2 => ({
        ...checkpoint,
        projection: {
          ...checkpoint.projection,
          session: { durationMin: 25 } as unknown as RuntimeDomainProjectionV2['session'],
        },
      }),
    ],
    [
      'a version 2 event without an event ID',
      (checkpoint: RuntimeCommitCheckpointV2): RuntimeCommitCheckpointV2 => ({
        ...checkpoint,
        events: [
          {
            ...sessionEndedEvent({ at: RUNTIME_CLOSED_AT }),
            eventId: undefined,
          } as unknown as SessionEventRecordV2,
        ],
      }),
    ],
    [
      'an aggregate value that is not a daily aggregate',
      (checkpoint: RuntimeCommitCheckpointV2): RuntimeCommitCheckpointV2 => ({
        ...checkpoint,
        aggregateSets: { [AGGREGATE_KEY]: 'not-an-aggregate' as unknown as DailyAgg },
      }),
    ],
  ])(
    'refuses %s before any write',
    async (_label: string, corrupt: (
      checkpoint: RuntimeCommitCheckpointV2,
    ) => RuntimeCommitCheckpointV2): Promise<void> => {
      const runtime: RuntimeStateV2 = cleanupClosureRuntime();
      const fake: Harness = harness();

      await commitRuntimeCheckpointV2(
        fake.ports,
        runtime,
        commitInput(corrupt(runtimeCommitCheckpoint(runtime))),
      ).then(
        (): void => expect.unreachable('expected an invalid-rule CoreError'),
        (error: unknown): void => expectInvalidRule(error),
      );

      expect(fake.names).toEqual([]);
    },
  );

  it('refuses a projection that lowers the runtime revision', async (): Promise<void> => {
    const runtime: RuntimeStateV2 = cleanupClosureRuntime();
    const checkpoint: RuntimeCommitCheckpointV2 = runtimeCommitCheckpoint(runtime);
    const fake: Harness = harness();

    await commitRuntimeCheckpointV2(fake.ports, runtime, {
      ...commitInput(checkpoint),
      projection: { ...checkpoint.projection, runtimeRevision: runtime.runtimeRevision - 1 },
    }).then(
      (): void => expect.unreachable('expected an invalid-rule CoreError'),
      (error: unknown): void => expectInvalidRule(error),
    );

    expect(fake.names).toEqual([]);
  });
});

describe('checkpoint replay', (): void => {
  it('does nothing without a stored checkpoint', async (): Promise<void> => {
    const runtime: RuntimeStateV2 = cleanupClosureRuntime();
    const fake: Harness = harness();

    const replayed: RuntimeStateV2 = await replayRuntimeCheckpointV2(fake.ports, runtime);

    expect(replayed).toBe(runtime);
    expect(fake.names).toEqual([]);
  });

  it('reapplies the projection when the stored runtime drifted from it', async (): Promise<void> => {
    const stored: RuntimeStateV2 = commitCheckpointRuntime();
    const drifted: RuntimeStateV2 = { ...stored, accruedFocusMs: stored.accruedFocusMs + 5_000 };
    const checkpoint: RuntimeCommitCheckpointV2 =
      stored.commitCheckpoint as RuntimeCommitCheckpointV2;
    const fake: Harness = harness();

    expect(runtimeMatchesProjectionV2(drifted, checkpoint.projection)).toBe(false);

    const replayed: RuntimeStateV2 = await replayRuntimeCheckpointV2(fake.ports, drifted);

    expect(runtimeMatchesProjectionV2(replayed, checkpoint.projection)).toBe(true);
    expect(replayed.commitCheckpoint).toBeNull();
    expect(fake.names).toEqual([
      'appendEvents',
      'saveBank',
      'saveAggregate',
      'removeAggregate',
      'saveRuntime',
    ]);
    expect(fake.runtimeWrites[0]).toEqual(replayed);
  });

  it('replays twice with the same calls and the same final runtime', async (): Promise<void> => {
    const stored: RuntimeStateV2 = commitCheckpointRuntime();
    const first: Harness = harness();
    const second: Harness = harness();

    const firstRun: RuntimeStateV2 = await replayRuntimeCheckpointV2(first.ports, stored);
    const secondRun: RuntimeStateV2 = await replayRuntimeCheckpointV2(second.ports, stored);

    expect(secondRun).toEqual(firstRun);
    expect(second.names).toEqual(first.names);
    expect(second.runtimeWrites).toEqual(first.runtimeWrites);
    expect(second.eventBatches).toEqual(first.eventBatches);
    expect(second.bankWrites).toEqual(first.bankWrites);
    expect(second.aggregateWrites).toEqual(first.aggregateWrites);
    expect(second.aggregateRemoves).toEqual(first.aggregateRemoves);
  });

  it('finishes the commit after a crash before the event append', async (): Promise<void> => {
    const runtime: RuntimeStateV2 = cleanupClosureRuntime();
    const checkpoint: RuntimeCommitCheckpointV2 = runtimeCommitCheckpoint(runtime);
    const crashed: Harness = harness({ failPort: 'appendEvents', failOccurrence: 1 });

    await expect(
      commitRuntimeCheckpointV2(crashed.ports, runtime, commitInput(checkpoint)),
    ).rejects.toThrow('appendEvents rejected');

    const durable: RuntimeStateV2 = crashed.runtimeWrites[0] as RuntimeStateV2;
    expect(durable.commitCheckpoint).toEqual(checkpoint);

    const recovered: Harness = harness();
    const replayed: RuntimeStateV2 = await replayRuntimeCheckpointV2(recovered.ports, durable);

    expect(recovered.names).toEqual([
      'appendEvents',
      'saveBank',
      'saveAggregate',
      'removeAggregate',
      'saveRuntime',
    ]);
    expect(recovered.log.events).toEqual(checkpoint.events);
    expect(recovered.bankWrites).toHaveLength(1);
    expect(replayed.commitCheckpoint).toBeNull();
  });

  it('keeps one copy of every event when the append repeats after a crash', async (): Promise<void> => {
    const runtime: RuntimeStateV2 = cleanupClosureRuntime();
    const checkpoint: RuntimeCommitCheckpointV2 = runtimeCommitCheckpoint(runtime);
    const stored: RuntimeStateV2 = { ...runtime, commitCheckpoint: checkpoint };
    const crashed: Harness = harness({ failPort: 'saveBank', failOccurrence: 1 });

    await expect(replayRuntimeCheckpointV2(crashed.ports, stored)).rejects.toThrow(
      'saveBank rejected',
    );
    expect(crashed.log.events).toEqual(checkpoint.events);

    const recovered: Harness = harness({ storedEvents: crashed.log.events });
    await replayRuntimeCheckpointV2(recovered.ports, stored);

    expect(recovered.log.events).toEqual(checkpoint.events);
    expect(recovered.log.events).toHaveLength(3);
    expect(recovered.eventBatches).toEqual([checkpoint.events]);
  });
});

describe('cleanup batch revisions', (): void => {
  it('advances the clear revision through one checkpoint and replays idempotently', async (): Promise<void> => {
    const base: RuntimeStateV2 = cleanupClosureRuntime();
    const closure: CleanupClosureV2 = base.pendingClosure as CleanupClosureV2;
    const replaced: CleanupProgress = replaceCleanupBatchV2(closure.cleanupProgress, {
      cleanupOperationId: OTHER_OPERATION_ID,
      clearRuntimeRevision: CLEAR_RUNTIME_REVISION + 1,
      at: NOW,
    });
    const projection: RuntimeDomainProjectionV2 = {
      ...runtimeDomainProjection(base),
      runtimeRevision: CLEAR_RUNTIME_REVISION + 1,
      documentCommands: replaced.clearCommands,
      pendingClosure: { ...closure, cleanupProgress: replaced },
    };
    const checkpoint: RuntimeCommitCheckpointV2 = runtimeCommitCheckpoint(base, {
      projection,
      events: [sessionStartedEvent(), sessionEndedEvent({ at: RUNTIME_CLOSED_AT })],
    });
    const fake: Harness = harness();

    const committed: RuntimeStateV2 = await commitRuntimeCheckpointV2(
      fake.ports,
      base,
      commitInput(checkpoint),
    );

    expect(committed.runtimeRevision).toBe(CLEAR_RUNTIME_REVISION + 1);
    expect(base.runtimeRevision).toBe(CLEAR_RUNTIME_REVISION);
    for (const command of Object.values(committed.documentCommands)) {
      expect(command.runtimeRevision).toBe(CLEAR_RUNTIME_REVISION + 1);
      expect(command.operationId).toBe(OTHER_OPERATION_ID);
    }
    const committedClosure: CleanupClosureV2 = committed.pendingClosure as CleanupClosureV2;
    expect(committedClosure.cleanupProgress.clearRuntimeRevision).toBe(CLEAR_RUNTIME_REVISION + 1);
    expect(committedClosure.cleanupProgress.retry.batch).toBe(
      closure.cleanupProgress.retry.batch + 1,
    );
    expect(parseRuntimeStateV2(committed)).not.toBeNull();

    const durable: RuntimeStateV2 = fake.runtimeWrites[0] as RuntimeStateV2;
    const recovered: Harness = harness({ storedEvents: fake.eventBatches[0] ?? [] });
    const replayed: RuntimeStateV2 = await replayRuntimeCheckpointV2(recovered.ports, durable);

    expect(replayed).toEqual(committed);
    expect(replayed.runtimeRevision).toBe(CLEAR_RUNTIME_REVISION + 1);
    expect(recovered.log.events).toEqual(checkpoint.events);
  });

  it('accepts a checkpoint that keeps the runtime revision', async (): Promise<void> => {
    const runtime: RuntimeStateV2 = cleanupClosureRuntime();
    const fake: Harness = harness();

    const committed: RuntimeStateV2 = await commitRuntimeCheckpointV2(
      fake.ports,
      runtime,
      commitInput(runtimeCommitCheckpoint(runtime)),
    );

    expect(committed.runtimeRevision).toBe(runtime.runtimeRevision);
    expect(fake.bankWrites).toEqual([{ bank: bankState(), syncBank: true }]);
    expect(fake.eventBatches[0]).toEqual([
      budgetEarnedEvent(),
      sessionStartedEvent(),
      sessionEndedEvent({ at: RUNTIME_CLOSED_AT }),
    ]);
  });
});

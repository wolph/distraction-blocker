import { describe, expect, it } from 'vitest';
import type { FrozenDocumentCommand } from '../../../src/background/enforcement-persistence-v2';
import type {
  CleanupProgress,
  ClosureProjection,
  MigrationCleanupPlan,
  RuntimeMigrationCheckpointV1ToV2,
} from '../../../src/background/runtime-v2-types';
import { parseRuntimeMigrationCheckpointV1ToV2 } from '../../../src/background/runtime-v2-validation';
import {
  CLEANUP_OPERATION_ID,
  cleanupProgress,
  cleanupRetryState,
  cleanupSeed,
  clearCommandMap,
  commitCheckpointRuntime,
  epochResetAckMap,
  handledOccurrence,
  MIGRATED_AT,
  MIGRATION_ACTIVE_REVISION,
  migrationActiveRuntime,
  migrationCheckpoint,
  migrationCleanupClosure,
  migrationCleanupPlan,
  migrationCleanupProgress,
  migrationCleanupRuntime,
  migrationClearCommandMap,
  migrationClosureProjection,
  migrationIdentityEvent,
  migrationIdleRuntime,
  migrationSettlement,
  OTHER_SESSION_ID,
  pendingTransition,
  preparedClosure,
  SESSION_ID,
  scheduleOccurrence,
  sessionEndedEvent,
  timedFocusSession,
  transitionActiveCheckpoint,
  transitionRuntime,
} from './runtime-v2-fixtures';

type UnknownRecord = Record<string, unknown>;

function withKey(value: object, key: string, replacement: unknown): UnknownRecord {
  return { ...value, [key]: replacement };
}

function withoutKey(value: object, key: string): UnknownRecord {
  const clone: UnknownRecord = { ...value };
  Reflect.deleteProperty(clone, key);
  return clone;
}

function expectRejected(values: readonly unknown[]): void {
  for (const value of values) {
    expect((): RuntimeMigrationCheckpointV1ToV2 | null =>
      parseRuntimeMigrationCheckpointV1ToV2(value),
    ).not.toThrow();
    expect(parseRuntimeMigrationCheckpointV1ToV2(value)).toBeNull();
  }
}

function expectAccepted(values: readonly RuntimeMigrationCheckpointV1ToV2[]): void {
  for (const value of values) {
    expect(parseRuntimeMigrationCheckpointV1ToV2(value)).toEqual(value);
  }
}

function cyclicRecord(): UnknownRecord {
  const cycle: UnknownRecord = {};
  cycle.self = cycle;
  return cycle;
}

function sparseArray(entry: unknown): unknown[] {
  const sparse: unknown[] = [entry];
  sparse.length = 3;
  return sparse;
}

/** The checkpoint an invalid v1 active state produces: a plan plus the runtime that carries it. */
function cleanupCheckpoint(
  overrides: Partial<RuntimeMigrationCheckpointV1ToV2> = {},
): RuntimeMigrationCheckpointV1ToV2 {
  return migrationCheckpoint({
    projectedRuntime: migrationCleanupRuntime(),
    cleanupPlan: migrationCleanupPlan(),
    ...overrides,
  });
}

/** Replaces one field of the cleanup plan a checkpoint carries. */
function withPlanKey(key: string, replacement: unknown): unknown {
  return withKey(
    cleanupCheckpoint(),
    'cleanupPlan',
    withKey(migrationCleanupPlan(), key, replacement),
  );
}

/** Replaces one field of the settlement inside the cleanup plan. */
function withSettlementKey(key: string, replacement: unknown): unknown {
  return withPlanKey('settlement', withKey(migrationSettlement(), key, replacement));
}

describe('migration checkpoint fixtures', (): void => {
  it('accepts the idle, active, and invalid-active migrations', (): void => {
    expectAccepted([
      migrationCheckpoint(),
      migrationCheckpoint({ projectedRuntime: migrationActiveRuntime() }),
      cleanupCheckpoint(),
    ]);
  });

  it('accepts a derived session UUID announced by its identity event', (): void => {
    expectAccepted([
      migrationCheckpoint({
        projectedRuntime: migrationActiveRuntime(),
        assignedSessionId: SESSION_ID,
        identityEvent: migrationIdentityEvent(),
      }),
      cleanupCheckpoint({
        assignedSessionId: SESSION_ID,
        identityEvent: migrationIdentityEvent(),
      }),
    ]);
  });

  it('accepts a checkpoint whose cleanup already retried after a crash', (): void => {
    const retried: MigrationCleanupPlan = migrationCleanupPlan({
      cleanupProgress: migrationCleanupProgress({
        retry: cleanupRetryState({ batch: 0, automaticAttempt: 3 }),
      }),
    });

    expectAccepted([
      cleanupCheckpoint({
        projectedRuntime: migrationCleanupRuntime({
          pendingClosure: migrationCleanupClosure({
            cleanupProgress: migrationCleanupProgress({
              retry: cleanupRetryState({ batch: 0, automaticAttempt: 3 }),
            }),
          }),
        }),
        cleanupPlan: retried,
      }),
    ]);
  });
});

describe('migration checkpoint leaves', (): void => {
  it('rejects non-record roots and inexact key sets', (): void => {
    expectRejected([
      null,
      undefined,
      'checkpoint',
      7,
      [migrationCheckpoint()],
      withKey(migrationCheckpoint(), 'extra', true),
      withoutKey(migrationCheckpoint(), 'marker'),
      withoutKey(migrationCheckpoint(), 'cleanupPlan'),
    ]);
  });

  it('pins the version, schema bounds, migration instant, and marker', (): void => {
    expectRejected([
      withKey(migrationCheckpoint(), 'version', 2),
      withKey(migrationCheckpoint(), 'fromRuntimeSchemaVersion', 2),
      withKey(migrationCheckpoint(), 'toRuntimeSchemaVersion', 1),
      withKey(migrationCheckpoint(), 'toRuntimeSchemaVersion', '2'),
      withKey(migrationCheckpoint(), 'migratedAt', -1),
      withKey(migrationCheckpoint(), 'migratedAt', 1.5),
      withKey(migrationCheckpoint(), 'migratedAt', null),
      withKey(migrationCheckpoint(), 'marker', { runtimeSchemaVersion: 1 }),
      withKey(migrationCheckpoint(), 'marker', { runtimeSchemaVersion: 2, extra: 1 }),
      withKey(migrationCheckpoint(), 'marker', null),
      withKey(migrationCheckpoint(), 'marker', 2),
    ]);
  });

  it('requires a projected runtime that parses as v2 and replays nothing else', (): void => {
    expectRejected([
      withKey(migrationCheckpoint(), 'projectedRuntime', null),
      withKey(
        migrationCheckpoint(),
        'projectedRuntime',
        withKey(migrationIdleRuntime(), 'date', 'today'),
      ),
      withKey(
        migrationCheckpoint(),
        'projectedRuntime',
        withKey(migrationIdleRuntime(), 'runtimeSchemaVersion', 1),
      ),
      migrationCheckpoint({
        projectedRuntime: migrationIdleRuntime({ epochResetAcks: { bad: 1 } as never }),
      }),
    ]);
  });

  it('rejects a projected runtime that carries authority migration never writes', (): void => {
    const emptyProgress: CleanupProgress = cleanupProgress({
      clearRuntimeRevision: 0,
      targets: {},
      clearCommands: {},
      tabClaims: [],
      resolvedTabIds: [],
    });

    expectRejected([
      // A nested commit checkpoint would replay a second time inside the migration replay.
      migrationCheckpoint({ projectedRuntime: commitCheckpointRuntime(migrationIdleRuntime()) }),
      // Migration allocates a fresh epoch and stores no reset acknowledgements.
      migrationCheckpoint({
        projectedRuntime: migrationActiveRuntime({ epochResetAcks: epochResetAckMap() }),
      }),
      // Migration never invents a pending transition.
      migrationCheckpoint({
        projectedRuntime: transitionRuntime(pendingTransition('start', 'prepared'), {
          accruedFocusMs: 0,
          basePolicyRevision: 0,
          handledScheduleOccurrences: [],
        }),
      }),
      // The only closure migration produces arrives with the plan that explains it.
      migrationCheckpoint({
        projectedRuntime: migrationIdleRuntime({
          pendingClosure: migrationCleanupClosure({
            cleanupSeed: cleanupSeed({ alarmNames: [], tabClaims: [] }),
            cleanupProgress: emptyProgress,
          }),
        }),
      }),
    ]);
  });

  it('requires the assigned UUID and its identity event to agree', (): void => {
    expectRejected([
      migrationCheckpoint({ assignedSessionId: SESSION_ID, identityEvent: null }),
      migrationCheckpoint({ assignedSessionId: null, identityEvent: migrationIdentityEvent() }),
      migrationCheckpoint({
        assignedSessionId: 'not-a-uuid',
        identityEvent: migrationIdentityEvent({ sessionId: 'not-a-uuid' }),
      }),
      migrationCheckpoint({
        assignedSessionId: SESSION_ID,
        identityEvent: migrationIdentityEvent({ sessionId: OTHER_SESSION_ID }),
      }),
      migrationCheckpoint({
        assignedSessionId: SESSION_ID,
        identityEvent: migrationIdentityEvent({ at: MIGRATED_AT + 1 }),
      }),
      withKey(migrationCheckpoint({ assignedSessionId: SESSION_ID }), 'identityEvent', {
        ...migrationIdentityEvent(),
        extra: 1,
      }),
      withKey(migrationCheckpoint({ assignedSessionId: SESSION_ID }), 'identityEvent', {
        t: 'sessionCanceled',
        at: MIGRATED_AT,
        focusedMs: 0,
      }),
      withKey(
        migrationCheckpoint({ assignedSessionId: SESSION_ID }),
        'identityEvent',
        withoutKey(migrationIdentityEvent(), 'startedAt'),
      ),
    ]);
  });
});

describe('migration checkpoint revision defaults', (): void => {
  it('keeps an idle projection at revision zero with nothing issued', (): void => {
    expectRejected([
      migrationCheckpoint({ projectedRuntime: migrationIdleRuntime({ basePolicyRevision: 1 }) }),
      migrationCheckpoint({ projectedRuntime: migrationIdleRuntime({ runtimeRevision: 1 }) }),
      migrationCheckpoint({
        projectedRuntime: migrationIdleRuntime({
          runtimeRevision: MIGRATION_ACTIVE_REVISION,
          documentCommands: migrationClearCommandMap(),
        }),
      }),
    ]);
  });

  it('reserves one base policy and one runtime revision for a migrated active session', (): void => {
    expectRejected([
      migrationCheckpoint({ projectedRuntime: migrationActiveRuntime({ basePolicyRevision: 0 }) }),
      migrationCheckpoint({
        projectedRuntime: migrationActiveRuntime({
          basePolicyRevision: 2,
          runtimeRevision: 2,
        }),
      }),
      migrationCheckpoint({
        projectedRuntime: migrationActiveRuntime({
          documentCommands: migrationClearCommandMap(),
        }),
      }),
      migrationCheckpoint({
        projectedRuntime: migrationActiveRuntime({
          enforcementCheckpoint: transitionActiveCheckpoint('start'),
        }),
      }),
    ]);
  });

  it('reserves base revision one and clear revision one for invalid-active cleanup', (): void => {
    const checkpoint: RuntimeMigrationCheckpointV1ToV2 = cleanupCheckpoint();

    expect(checkpoint.projectedRuntime.basePolicyRevision).toBe(MIGRATION_ACTIVE_REVISION);
    expect(checkpoint.projectedRuntime.runtimeRevision).toBe(MIGRATION_ACTIVE_REVISION);
    expect(checkpoint.cleanupPlan?.cleanupProgress.clearRuntimeRevision).toBe(
      MIGRATION_ACTIVE_REVISION,
    );
    const advanced: Record<string, FrozenDocumentCommand> = clearCommandMap({
      operationId: CLEANUP_OPERATION_ID,
      runtimeRevision: 2,
      basePolicyRevision: MIGRATION_ACTIVE_REVISION,
    });
    const advancedProgress: CleanupProgress = migrationCleanupProgress({
      clearRuntimeRevision: 2,
      clearCommands: advanced,
    });

    expectRejected([
      cleanupCheckpoint({
        projectedRuntime: migrationCleanupRuntime({ basePolicyRevision: 0 }),
      }),
      // The clear revision migration reserves is exactly one, whatever else agrees with it.
      cleanupCheckpoint({
        projectedRuntime: migrationCleanupRuntime({
          runtimeRevision: 2,
          documentCommands: advanced,
          pendingClosure: migrationCleanupClosure({ cleanupProgress: advancedProgress }),
        }),
        cleanupPlan: migrationCleanupPlan({ cleanupProgress: advancedProgress }),
      }),
    ]);
  });
});

describe('migration cleanup plan agreement', (): void => {
  it('requires the projected runtime to carry exactly the planned closure', (): void => {
    expectRejected([
      migrationCheckpoint({ cleanupPlan: migrationCleanupPlan() }),
      cleanupCheckpoint({
        projectedRuntime: migrationCleanupRuntime({ session: timedFocusSession() }),
      }),
      cleanupCheckpoint({
        projectedRuntime: migrationCleanupRuntime({
          pendingClosure: preparedClosure({ projection: migrationClosureProjection() }),
        }),
      }),
      cleanupCheckpoint({
        cleanupPlan: migrationCleanupPlan({
          projection: migrationClosureProjection({ handledOccurrences: [handledOccurrence()] }),
        }),
      }),
      cleanupCheckpoint({
        cleanupPlan: migrationCleanupPlan({
          cleanupSeed: cleanupSeed({ alarmNames: ['phase'] }),
        }),
      }),
      cleanupCheckpoint({
        cleanupPlan: migrationCleanupPlan({
          cleanupProgress: migrationCleanupProgress({ resolvedTabIds: [11] }),
        }),
      }),
      withPlanKey('version', 2),
      withPlanKey('projection', null),
      withPlanKey('cleanupSeed', { alarmNames: [], tabClaims: [], extra: 1 }),
      withPlanKey('cleanupProgress', null),
    ]);
  });

  it('closes an invalid legacy active state at the migration instant', (): void => {
    const ended: ClosureProjection = migrationClosureProjection();

    expectRejected([
      cleanupCheckpoint({
        cleanupPlan: migrationCleanupPlan({
          projection: migrationClosureProjection({
            endEvent: sessionEndedEvent({ at: MIGRATED_AT }),
          }),
        }),
      }),
      cleanupCheckpoint({ migratedAt: MIGRATED_AT + 1 }),
      withPlanKey('projection', withKey(ended, 'completionIncrement', 1)),
    ]);
  });

  it('accepts a scheduled invalid-active end with or without its occurrence', (): void => {
    const withOccurrence: ClosureProjection = migrationClosureProjection({
      endEvent: sessionEndedEvent({
        at: MIGRATED_AT,
        outcome: 'canceled',
        reason: 'invalid-active-state',
        duration: { kind: 'timed', minutes: 25 },
        source: 'schedule',
        scheduleOccurrence: scheduleOccurrence(),
      }),
    });

    expect(migrationClosureProjection().endEvent.scheduleOccurrence).toBeNull();
    expectAccepted([
      cleanupCheckpoint(),
      cleanupCheckpoint({
        projectedRuntime: migrationCleanupRuntime({
          pendingClosure: migrationCleanupClosure({ projection: withOccurrence }),
        }),
        cleanupPlan: migrationCleanupPlan({ projection: withOccurrence }),
      }),
    ]);
  });

  it('requires the settlement to add up to the projected focus', (): void => {
    expectRejected([
      withSettlementKey('settledAt', MIGRATED_AT - 1),
      withSettlementKey('settledThrough', MIGRATED_AT + 1),
      withSettlementKey('focusedMsAfter', 30_001),
      withSettlementKey('creditedFocusMs', 9_000),
      withSettlementKey('focusedMsBefore', -1),
      withSettlementKey('phaseAtMigration', 'idle'),
      withSettlementKey('settledThrough', 1.5),
      withPlanKey('settlement', withoutKey(migrationSettlement(), 'creditedFocusMs')),
    ]);
    expectAccepted([
      cleanupCheckpoint({
        cleanupPlan: migrationCleanupPlan({
          settlement: migrationSettlement({ settledThrough: MIGRATED_AT }),
        }),
      }),
    ]);
  });

  it('credits nothing for a legacy break or pause', (): void => {
    for (const phaseAtMigration of ['break', 'paused'] as const) {
      expectRejected([withSettlementKey('phaseAtMigration', phaseAtMigration)]);
      expectAccepted([
        cleanupCheckpoint({
          cleanupPlan: migrationCleanupPlan({
            settlement: migrationSettlement({
              phaseAtMigration,
              focusedMsBefore: 30_000,
              creditedFocusMs: 0,
            }),
          }),
        }),
      ]);
    }
  });
});

describe('migration checkpoint hostile input and detachment', (): void => {
  it('rejects hostile roots and nested journals', (): void => {
    const checkpoint: RuntimeMigrationCheckpointV1ToV2 = cleanupCheckpoint();
    const throwing: unknown = new Proxy<UnknownRecord>(
      {},
      {
        get: (): never => {
          throw new Error('get trap');
        },
        ownKeys: (): never => {
          throw new Error('ownKeys trap');
        },
      },
    );

    expectRejected([
      throwing,
      new Proxy(migrationCheckpoint(), {}),
      cyclicRecord(),
      withKey(checkpoint, 'cleanupPlan', cyclicRecord()),
      withKey(checkpoint, 'cleanupPlan', new Proxy(migrationCleanupPlan(), {})),
      withKey(migrationCheckpoint(), 'projectedRuntime', new Proxy(migrationIdleRuntime(), {})),
      { ...migrationCheckpoint(), [Symbol('extra')]: true },
      withKey(migrationCheckpoint(), 'marker', {
        runtimeSchemaVersion: 2,
        [Symbol('extra')]: true,
      }),
      withKey(
        migrationCheckpoint(),
        'projectedRuntime',
        withKey(migrationIdleRuntime(), 'unlocks', sparseArray({ host: 'a.example', until: 1 })),
      ),
    ]);
  });

  it('rejects an accessor migration instant without reading it', (): void => {
    let reads: number = 0;
    const accessor: UnknownRecord = { ...migrationCheckpoint() };
    Object.defineProperty(accessor, 'migratedAt', {
      configurable: true,
      enumerable: true,
      get: (): number => {
        reads += 1;
        return MIGRATED_AT;
      },
    });

    expectRejected([accessor]);
    expect(reads).toBe(0);
  });

  it('does not execute a getter installed by a sibling proxy during inspection', (): void => {
    let getterCalls: number = 0;
    const mutable: UnknownRecord = { ...migrationIdleRuntime() };
    const trap: unknown = new Proxy(migrationSettlement(), {
      getPrototypeOf: (target: object): object | null => {
        Object.defineProperty(mutable, 'runtimeRevision', {
          configurable: true,
          enumerable: true,
          get: (): number => {
            getterCalls += 1;
            return 0;
          },
        });
        return Reflect.getPrototypeOf(target);
      },
    });

    expectRejected([{ ...migrationCheckpoint(), projectedRuntime: mutable, cleanupPlan: trap }]);
    expect(getterCalls).toBe(0);
  });

  it('rejects over-deep nesting in every journal', (): void => {
    let deep: UnknownRecord = {};
    for (let level: number = 0; level < 200; level++) deep = { nested: deep };

    expectRejected([
      withKey(migrationCheckpoint(), 'cleanupPlan', deep),
      withKey(migrationCheckpoint(), 'marker', deep),
      withKey(
        migrationCheckpoint(),
        'projectedRuntime',
        withKey(migrationIdleRuntime(), 'todayAgg', deep),
      ),
    ]);
  });

  it('returns a detached checkpoint in both directions', (): void => {
    const source: RuntimeMigrationCheckpointV1ToV2 = cleanupCheckpoint();
    const parsed: RuntimeMigrationCheckpointV1ToV2 = parseRuntimeMigrationCheckpointV1ToV2(
      source,
    ) as RuntimeMigrationCheckpointV1ToV2;

    expect(parsed).toEqual(source);
    expect(parsed).not.toBe(source);
    expect(parsed.projectedRuntime).not.toBe(source.projectedRuntime);
    source.cleanupPlan?.cleanupProgress.resolvedTabIds.push(11);
    expect(parsed.cleanupPlan?.cleanupProgress.resolvedTabIds).toHaveLength(0);
    parsed.projectedRuntime.unlocks.push({ host: 'example.com', until: MIGRATED_AT });
    expect(source.projectedRuntime.unlocks).toHaveLength(0);
  });
});

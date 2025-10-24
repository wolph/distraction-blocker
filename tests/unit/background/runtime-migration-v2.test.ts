import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildRuntimeMigrationCheckpointV1ToV2,
  type MigrationInputV2,
  migrateLegacySessionConfigV1,
  migrateLegacySessionStateV1,
  parseLegacyScheduleOccurrenceMarkerV1,
} from '../../../src/background/runtime-migration-v2';
import type {
  CleanupProgress,
  MigrationCleanupPlan,
  PendingClosure,
  RuntimeMigrationCheckpointV1ToV2,
  RuntimeStateV2,
} from '../../../src/background/runtime-v2-types';
import { parseRuntimeMigrationCheckpointV1ToV2 } from '../../../src/background/runtime-v2-validation';
import type { DeferredBlockClaim, RuntimeState } from '../../../src/background/stores';
import { DEFAULT_LISTS, rulesFromLists } from '../../../src/shared/constants';
import { CoreError } from '../../../src/shared/errors';
import { syncAggKey } from '../../../src/shared/storage-keys';
import type {
  DailyAgg,
  GateState,
  NormalizedSessionConfigV1,
  NormalizedSessionStateV1,
  PauseEconomy,
  ScheduleOccurrenceRef,
  SessionConfigV2,
  SessionStateV2,
  SiteUnlock,
} from '../../../src/shared/types';

type LegacyActiveSession = NormalizedSessionStateV1 & { sessionId: string };

const MODULE_PATH: string = 'src/background/runtime-migration-v2.ts';
const DEVICE_ID: string = 'device-1';
const SESSION_ID: string = '10000000-0000-4000-8000-000000000001';
const ASSIGNED_SESSION_ID: string = '10000000-0000-4000-8000-000000000002';
const CLEANUP_OPERATION_ID: string = '20000000-0000-4000-8000-000000000001';
const EPOCH_ID: string = '30000000-0000-4000-8000-000000000001';
const ENTRY_ID: string = 'entry-1';
const MINUTE_MS: number = 60_000;
const DURATION_MIN: number = 50;
/** Local 2026-09-03 09:00, so the stored marker date is the same in any test timezone. */
const START_AT: number = new Date(2026, 8, 3, 9, 0, 0, 0).getTime();
const LOCAL_DATE: string = '2026-09-03';
const MARKER: string = `${ENTRY_ID}@${LOCAL_DATE}`;
const MIGRATED_AT: number = START_AT + 30 * MINUTE_MS;
const AGGREGATE_KEY: string = syncAggKey(DEVICE_ID, LOCAL_DATE);
const RETENTION_MS: number = 14 * 24 * 60 * 60_000;
const PAUSE_ECONOMY: PauseEconomy = {
  earnRatio: 5 / 30,
  capMs: 3_600_000,
  pauseMs: 5 * MINUTE_MS,
  unlockMs: 5 * MINUTE_MS,
};
const OCCURRENCE: ScheduleOccurrenceRef = {
  version: 1,
  token: MARKER,
  entryId: ENTRY_ID,
  localStartDate: LOCAL_DATE,
};

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

function scheduledConfig(
  overrides: Partial<NormalizedSessionConfigV1> = {},
): NormalizedSessionConfigV1 {
  return legacyConfig({ source: 'schedule', scheduleEntryId: ENTRY_ID, ...overrides });
}

function legacySession(overrides: Partial<NormalizedSessionStateV1> = {}): LegacyActiveSession {
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
  } as LegacyActiveSession;
}

function deferredClaim(): DeferredBlockClaim {
  return {
    attemptAt: START_AT,
    kind: 'existing',
    sessionId: SESSION_ID,
    stage: 'attempt',
    tabId: 11,
    url: 'https://example.com/',
  };
}

function liveGate(): GateState {
  return {
    kind: 'cancel',
    host: null,
    openedAt: START_AT + MINUTE_MS,
    readyAt: START_AT + 2 * MINUTE_MS,
    requiredPhrase: 'end my session',
  };
}

function liveUnlock(): SiteUnlock {
  return { host: 'example.com', until: MIGRATED_AT + MINUTE_MS };
}

function legacyRuntime(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    session: null,
    gate: null,
    unlocks: [],
    tabStates: {
      11: { muteUrl: 'https://example.com/muted', priorMuted: false, stoppedDocumentId: null },
      12: { muteUrl: null, priorMuted: null, stoppedDocumentId: 'document-2' },
    },
    accruedFocusMs: 0,
    attemptDebounce: { '11:https://example.com/': START_AT },
    deferredBlockClaims: { '11:https://example.com/': deferredClaim() },
    removedTabTombstones: { 13: true },
    scheduleActiveEntryId: null,
    scheduleUnavailableNoticeToken: 'entry-2@2026-09-01',
    date: LOCAL_DATE,
    todayAgg: null,
    lastPruneDate: null,
    commitCheckpoint: null,
    ...overrides,
  };
}

function migrationInput(overrides: Partial<MigrationInputV2> = {}): MigrationInputV2 {
  return {
    runtime: legacyRuntime(),
    bank: { balanceMs: 0 },
    pauseEconomy: PAUSE_ECONOMY,
    deviceId: DEVICE_ID,
    migratedAt: MIGRATED_AT,
    enforcementEpoch: EPOCH_ID,
    cleanupOperationId: CLEANUP_OPERATION_ID,
    assignedSessionId: null,
    ...overrides,
  };
}

/** The migration of one legacy active session. A caller that needs more v1 state passes it. */
function activeInput(
  session: NormalizedSessionStateV1,
  overrides: Partial<MigrationInputV2> = {},
): MigrationInputV2 {
  return migrationInput({ runtime: legacyRuntime({ session }), ...overrides });
}

function expectCoreError(build: () => unknown, message?: RegExp): void {
  expect(build).toThrow(CoreError);
  if (message !== undefined) expect(build).toThrow(message);
}

describe('legacy schedule occurrence marker', (): void => {
  it('accepts the exact entry and local-date token', (): void => {
    expect(parseLegacyScheduleOccurrenceMarkerV1(MARKER, ENTRY_ID)).toEqual(OCCURRENCE);
  });

  it('rejects every marker form the current v1 writer stores', (): void => {
    expect(parseLegacyScheduleOccurrenceMarkerV1(ENTRY_ID, ENTRY_ID)).toBeNull();
    expect(parseLegacyScheduleOccurrenceMarkerV1(`${ENTRY_ID}@1788480000000`, ENTRY_ID)).toBeNull();
  });

  it('rejects a mismatched entry, an unreal date, and a missing side', (): void => {
    expect(parseLegacyScheduleOccurrenceMarkerV1(`entry-2@${LOCAL_DATE}`, ENTRY_ID)).toBeNull();
    expect(parseLegacyScheduleOccurrenceMarkerV1(`${ENTRY_ID}@2026-02-30`, ENTRY_ID)).toBeNull();
    expect(parseLegacyScheduleOccurrenceMarkerV1(`${ENTRY_ID}@2026-9-3`, ENTRY_ID)).toBeNull();
    expect(parseLegacyScheduleOccurrenceMarkerV1(`${ENTRY_ID}@`, ENTRY_ID)).toBeNull();
    expect(parseLegacyScheduleOccurrenceMarkerV1(null, ENTRY_ID)).toBeNull();
    expect(parseLegacyScheduleOccurrenceMarkerV1(MARKER, null)).toBeNull();
    expect(parseLegacyScheduleOccurrenceMarkerV1(MARKER, '')).toBeNull();
  });
});

describe('legacy config and state migration', (): void => {
  it('maps a manual timed config to a tagged duration with no occurrence', (): void => {
    const config: NormalizedSessionConfigV1 = legacyConfig({
      cycling: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 },
    });

    expect(migrateLegacySessionConfigV1(config, null)).toEqual({
      mode: config.mode,
      strictness: config.strictness,
      duration: { kind: 'timed', minutes: DURATION_MIN },
      cycling: config.cycling,
      intention: config.intention,
      source: 'manual',
      scheduleOccurrence: null,
      rules: config.rules,
    });
  });

  it('maps a scheduled config only with its validated occurrence', (): void => {
    const migrated: SessionConfigV2 | null = migrateLegacySessionConfigV1(
      scheduledConfig(),
      OCCURRENCE,
    );

    expect(migrated?.source).toBe('schedule');
    expect(migrated?.scheduleOccurrence).toEqual(OCCURRENCE);
    expect(migrateLegacySessionConfigV1(scheduledConfig(), null)).toBeNull();
    expect(migrateLegacySessionConfigV1(legacyConfig(), OCCURRENCE)).toBeNull();
  });

  it('rejects a legacy duration outside the current manual range', (): void => {
    expect(migrateLegacySessionConfigV1(legacyConfig({ durationMin: 0 }), null)).toBeNull();
    expect(
      migrateLegacySessionConfigV1(legacyConfig({ durationMin: Number.NaN }), null),
    ).toBeNull();
  });

  it('keeps every absolute endpoint of a legacy state', (): void => {
    const session: LegacyActiveSession = legacySession({ focusedMs: 5 * MINUTE_MS });

    expect(migrateLegacySessionStateV1(session, null)).toEqual({
      version: 2,
      sessionId: SESSION_ID,
      config: migrateLegacySessionConfigV1(session.config, null),
      startedAt: session.startedAt,
      sessionEndsAt: session.sessionEndsAt,
      phase: 'focus',
      phaseStartedAt: session.phaseStartedAt,
      phaseEndsAt: session.phaseEndsAt,
      cycleIndex: 0,
      pausedFrom: null,
      focusedMs: 5 * MINUTE_MS,
    });
  });

  it('keeps a paused state and its saved phase end', (): void => {
    const paused: LegacyActiveSession = legacySession({
      phase: 'paused',
      phaseStartedAt: START_AT + 10 * MINUTE_MS,
      phaseEndsAt: START_AT + 15 * MINUTE_MS,
      pausedFrom: { phase: 'focus', phaseEndsAt: START_AT + DURATION_MIN * MINUTE_MS },
      focusedMs: 10 * MINUTE_MS,
    });
    const migrated: SessionStateV2 | null = migrateLegacySessionStateV1(paused, null);

    expect(migrated?.phase).toBe('paused');
    expect(migrated?.pausedFrom).toEqual(paused.pausedFrom);
  });

  it('rejects a legacy state that fails the v2 session contract', (): void => {
    expect(
      migrateLegacySessionStateV1(legacySession({ sessionEndsAt: START_AT + MINUTE_MS }), null),
    ).toBeNull();
    expect(
      migrateLegacySessionStateV1(legacySession({ phase: 'break', pausedFrom: null }), null),
    ).toBeNull();
    expect(
      migrateLegacySessionStateV1({ ...legacySession(), sessionId: 'session-1' }, null),
    ).toBeNull();
  });
});

describe('migration checkpoint builder', (): void => {
  it('projects an idle v1 runtime with nothing issued', (): void => {
    const input: MigrationInputV2 = migrationInput({
      runtime: legacyRuntime({
        gate: liveGate(),
        unlocks: [liveUnlock()],
        accruedFocusMs: 90_000,
        lastPruneDate: '2026-09-01',
      }),
    });
    const checkpoint: RuntimeMigrationCheckpointV1ToV2 =
      buildRuntimeMigrationCheckpointV1ToV2(input);
    const runtime: RuntimeStateV2 = checkpoint.projectedRuntime;

    expect(checkpoint.version).toBe(1);
    expect(checkpoint.fromRuntimeSchemaVersion).toBe(1);
    expect(checkpoint.toRuntimeSchemaVersion).toBe(2);
    expect(checkpoint.migratedAt).toBe(MIGRATED_AT);
    expect(checkpoint.marker).toEqual({ runtimeSchemaVersion: 2 });
    expect(checkpoint.assignedSessionId).toBeNull();
    expect(checkpoint.identityEvent).toBeNull();
    expect(checkpoint.cleanupPlan).toBeNull();
    expect(runtime.runtimeSchemaVersion).toBe(2);
    expect(runtime.session).toBeNull();
    expect(runtime.enforcementEpoch).toBe(EPOCH_ID);
    expect(runtime.epochResetAcks).toEqual({});
    expect(runtime.basePolicyRevision).toBe(0);
    expect(runtime.runtimeRevision).toBe(0);
    expect(runtime.documentCommands).toEqual({});
    expect(runtime.enforcementCheckpoint).toBeNull();
    expect(runtime.pendingEnforcementTransition).toBeNull();
    expect(runtime.pendingClosure).toBeNull();
    expect(runtime.commitCheckpoint).toBeNull();
  });

  it('carries every v1 runtime field the v2 runtime still owns', (): void => {
    const legacy: RuntimeState = legacyRuntime({
      gate: liveGate(),
      unlocks: [liveUnlock()],
      accruedFocusMs: 90_000,
      todayAgg: { ...emptyAggregate(), focusMs: 90_000 },
      lastPruneDate: '2026-09-01',
    });
    const runtime: RuntimeStateV2 = buildRuntimeMigrationCheckpointV1ToV2(
      migrationInput({ runtime: legacy }),
    ).projectedRuntime;

    expect(runtime.gate).toEqual(legacy.gate);
    expect(runtime.unlocks).toEqual(legacy.unlocks);
    expect(runtime.accruedFocusMs).toBe(90_000);
    expect(runtime.tabStates).toEqual(legacy.tabStates);
    expect(runtime.attemptDebounce).toEqual(legacy.attemptDebounce);
    expect(runtime.deferredBlockClaims).toEqual(legacy.deferredBlockClaims);
    expect(runtime.removedTabTombstones).toEqual(legacy.removedTabTombstones);
    expect(runtime.scheduleUnavailableNoticeToken).toBe(legacy.scheduleUnavailableNoticeToken);
    expect(runtime.date).toBe(LOCAL_DATE);
    expect(runtime.todayAgg).toEqual(legacy.todayAgg);
    expect(runtime.lastPruneDate).toBe('2026-09-01');
    expect(Object.hasOwn(runtime, 'scheduleActiveEntryId')).toBe(false);
  });

  it('reserves one base policy and one runtime revision for a manual active session', (): void => {
    const checkpoint: RuntimeMigrationCheckpointV1ToV2 = buildRuntimeMigrationCheckpointV1ToV2(
      activeInput(legacySession(), {
        runtime: legacyRuntime({
          session: legacySession(),
          gate: liveGate(),
          unlocks: [liveUnlock()],
          accruedFocusMs: 90_000,
        }),
      }),
    );
    const runtime: RuntimeStateV2 = checkpoint.projectedRuntime;

    expect(runtime.session).toEqual(migrateLegacySessionStateV1(legacySession(), null));
    expect(runtime.basePolicyRevision).toBe(1);
    expect(runtime.runtimeRevision).toBe(1);
    expect(runtime.documentCommands).toEqual({});
    expect(runtime.enforcementCheckpoint).toBeNull();
    expect(runtime.handledScheduleOccurrences).toEqual([]);
    expect(runtime.gate).toEqual(liveGate());
    expect(runtime.unlocks).toEqual([liveUnlock()]);
    expect(runtime.accruedFocusMs).toBe(90_000);
    expect(checkpoint.assignedSessionId).toBeNull();
    expect(checkpoint.identityEvent).toBeNull();
    expect(checkpoint.cleanupPlan).toBeNull();
  });

  it('announces a derived UUID for a legacy session that never had one', (): void => {
    const session: NormalizedSessionStateV1 = legacySessionWithoutId();
    const checkpoint: RuntimeMigrationCheckpointV1ToV2 = buildRuntimeMigrationCheckpointV1ToV2(
      activeInput(session, { assignedSessionId: ASSIGNED_SESSION_ID }),
    );

    expect(checkpoint.assignedSessionId).toBe(ASSIGNED_SESSION_ID);
    expect(checkpoint.identityEvent).toEqual({
      t: 'sessionIdentityAssigned',
      at: MIGRATED_AT,
      startedAt: START_AT,
      sessionId: ASSIGNED_SESSION_ID,
    });
    expect(checkpoint.projectedRuntime.session?.sessionId).toBe(ASSIGNED_SESSION_ID);
  });

  it('migrates a scheduled session whose stored marker carries its local date', (): void => {
    const session: NormalizedSessionStateV1 = legacySession({ config: scheduledConfig() });
    const checkpoint: RuntimeMigrationCheckpointV1ToV2 = buildRuntimeMigrationCheckpointV1ToV2(
      activeInput(session, {
        runtime: legacyRuntime({ session, scheduleActiveEntryId: MARKER }),
      }),
    );
    const runtime: RuntimeStateV2 = checkpoint.projectedRuntime;

    expect(runtime.session?.config.scheduleOccurrence).toEqual(OCCURRENCE);
    expect(runtime.handledScheduleOccurrences).toEqual([
      {
        version: 1,
        token: MARKER,
        entryId: ENTRY_ID,
        localStartDate: LOCAL_DATE,
        handledAt: START_AT,
        reason: 'started',
        expiresAt: START_AT + RETENTION_MS,
      },
    ]);
    expect(checkpoint.cleanupPlan).toBeNull();
  });
});

describe('invalid active state migration', (): void => {
  it('closes a scheduled session whose marker carries no local date', (): void => {
    for (const marker of [null, ENTRY_ID, `${ENTRY_ID}@1788480000000`]) {
      const session: NormalizedSessionStateV1 = legacySession({ config: scheduledConfig() });
      const checkpoint: RuntimeMigrationCheckpointV1ToV2 = buildRuntimeMigrationCheckpointV1ToV2(
        activeInput(session, {
          runtime: legacyRuntime({ session, scheduleActiveEntryId: marker }),
        }),
      );

      expect(checkpoint.projectedRuntime.session).toBeNull();
      expect(checkpoint.cleanupPlan).not.toBeNull();
    }
  });

  it('settles the legacy focus once into an immutable canceled projection', (): void => {
    const session: NormalizedSessionStateV1 = legacySession({
      config: scheduledConfig(),
      focusedMs: 10 * MINUTE_MS,
    });
    const plan: MigrationCleanupPlan = cleanupPlanOf(session);

    expect(plan.version).toBe(1);
    expect(plan.settlement).toEqual({
      settledAt: MIGRATED_AT,
      settledThrough: MIGRATED_AT,
      phaseAtMigration: 'focus',
      focusedMsBefore: 10 * MINUTE_MS,
      creditedFocusMs: 30 * MINUTE_MS,
      focusedMsAfter: 40 * MINUTE_MS,
    });
    expect(plan.projection.sessionId).toBe(SESSION_ID);
    expect(plan.projection.closureId).toBe(`${SESSION_ID}:close`);
    expect(plan.projection.reason).toBe('invalid-active-state');
    expect(plan.projection.outcome).toBe('canceled');
    expect(plan.projection.completionIncrement).toBe(0);
    expect(plan.projection.endedAt).toBe(MIGRATED_AT);
    expect(plan.projection.focusedMs).toBe(40 * MINUTE_MS);
    expect(plan.projection.handledOccurrences).toEqual([]);
    expect(plan.projection.aggregateRemoves).toEqual([]);
    expect(plan.projection.endEvent).toEqual({
      version: 2,
      t: 'sessionEnded',
      eventId: `${SESSION_ID}:end`,
      at: MIGRATED_AT,
      sessionId: SESSION_ID,
      outcome: 'canceled',
      reason: 'invalid-active-state',
      focusedMs: 40 * MINUTE_MS,
      duration: { kind: 'timed', minutes: DURATION_MIN },
      source: 'schedule',
      scheduleOccurrence: null,
    });
  });

  it('appends the exact legacy budget event before the end event', (): void => {
    const session: NormalizedSessionStateV1 = legacySession({ config: scheduledConfig() });
    const plan: MigrationCleanupPlan = cleanupPlanOf(session);
    // The fixture bank starts empty, so its whole balance is what this settlement earned.
    const earned: number = plan.projection.bankAfter.balanceMs;

    expect(earned).toBeGreaterThan(0);
    expect(plan.projection.events).toHaveLength(2);
    expect(plan.projection.events[0]).toEqual({
      t: 'budgetEarned',
      at: MIGRATED_AT,
      ms: earned,
      sessionId: SESSION_ID,
    });
    expect(plan.projection.events[1]).toEqual(plan.projection.endEvent);
    expect(plan.projection.aggregateSets[AGGREGATE_KEY]?.focusMs).toBe(30 * MINUTE_MS);
  });

  it('omits the budget event when the settlement banks nothing', (): void => {
    const session: NormalizedSessionStateV1 = legacySession({
      config: scheduledConfig(),
      phase: 'paused',
      phaseStartedAt: START_AT + 10 * MINUTE_MS,
      phaseEndsAt: START_AT + 15 * MINUTE_MS,
      pausedFrom: { phase: 'focus', phaseEndsAt: START_AT + DURATION_MIN * MINUTE_MS },
      focusedMs: 10 * MINUTE_MS,
    });
    const plan: MigrationCleanupPlan = cleanupPlanOf(session, {
      runtime: legacyRuntime({ session, accruedFocusMs: 10 * MINUTE_MS }),
    });

    expect(plan.settlement.creditedFocusMs).toBe(0);
    expect(plan.projection.events).toEqual([plan.projection.endEvent]);
  });

  it('adopts the settled watermark so the banked focus cannot be banked again', (): void => {
    const session: NormalizedSessionStateV1 = legacySession({ config: scheduledConfig() });
    const checkpoint: RuntimeMigrationCheckpointV1ToV2 = invalidActiveCheckpoint(session, {
      runtime: legacyRuntime({ session, accruedFocusMs: 5 * MINUTE_MS }),
    });
    const plan: MigrationCleanupPlan = checkpoint.cleanupPlan as MigrationCleanupPlan;

    expect(plan.settlement.focusedMsAfter).toBe(30 * MINUTE_MS);
    expect(checkpoint.projectedRuntime.accruedFocusMs).toBe(plan.settlement.focusedMsAfter);
    expect(checkpoint.projectedRuntime.accruedFocusMs).toBe(plan.projection.focusedMs);
  });

  it('carries the settled aggregate as the projected runtime aggregate', (): void => {
    const session: NormalizedSessionStateV1 = legacySession({ config: scheduledConfig() });
    const stored: DailyAgg = { ...emptyAggregate(), focusMs: 5 * MINUTE_MS, sessionsStarted: 1 };
    const checkpoint: RuntimeMigrationCheckpointV1ToV2 = invalidActiveCheckpoint(session, {
      runtime: legacyRuntime({ session, todayAgg: stored }),
    });
    const settled: DailyAgg | undefined =
      checkpoint.cleanupPlan?.projection.aggregateSets[AGGREGATE_KEY];

    expect(settled?.focusMs).toBe(35 * MINUTE_MS);
    expect(checkpoint.projectedRuntime.todayAgg).toEqual(settled);
  });

  it('seeds cleanup from the legacy tab claims and the phase alarm', (): void => {
    const session: NormalizedSessionStateV1 = legacySession({ config: scheduledConfig() });
    const plan: MigrationCleanupPlan = cleanupPlanOf(session);
    const progress: CleanupProgress = plan.cleanupProgress;

    expect(plan.cleanupSeed.alarmNames).toEqual(['phase']);
    expect(plan.cleanupSeed.tabClaims).toEqual([
      { tabId: 11, state: legacyRuntime().tabStates[11] },
      { tabId: 12, state: legacyRuntime().tabStates[12] },
    ]);
    expect(progress.cleanupOperationId).toBe(CLEANUP_OPERATION_ID);
    expect(progress.clearRuntimeRevision).toBe(1);
    expect(progress.targets).toEqual({});
    expect(progress.clearCommands).toEqual({});
    expect(progress.resolvedTabIds).toEqual([]);
    expect(progress.tabClaims).toEqual(plan.cleanupSeed.tabClaims);
    expect(progress.retry).toEqual({
      batch: 0,
      automaticAttempt: 0,
      nextAttemptAt: MIGRATED_AT,
      lastError: null,
    });
  });

  it('projects the closed session as a cleanup-stage closure', (): void => {
    const session: NormalizedSessionStateV1 = legacySession({ config: scheduledConfig() });
    const checkpoint: RuntimeMigrationCheckpointV1ToV2 = invalidActiveCheckpoint(session, {
      runtime: legacyRuntime({
        session,
        gate: liveGate(),
        unlocks: [liveUnlock()],
        accruedFocusMs: 5 * MINUTE_MS,
      }),
    });
    const runtime: RuntimeStateV2 = checkpoint.projectedRuntime;
    const plan: MigrationCleanupPlan = checkpoint.cleanupPlan as MigrationCleanupPlan;
    const closure: PendingClosure = runtime.pendingClosure as PendingClosure;

    expect(closure.stage).toBe('cleanup');
    expect(closure.projection).toEqual(plan.projection);
    expect(closure.cleanupSeed).toEqual(plan.cleanupSeed);
    expect(closure.cleanupProgress).toEqual(plan.cleanupProgress);
    expect(runtime.session).toBeNull();
    expect(runtime.basePolicyRevision).toBe(1);
    expect(runtime.runtimeRevision).toBe(1);
    expect(runtime.documentCommands).toEqual({});
    expect(runtime.enforcementCheckpoint).toBeNull();
    expect(runtime.gate).toBeNull();
    expect(runtime.unlocks).toEqual([]);
    expect(runtime.handledScheduleOccurrences).toEqual([]);
  });

  it('announces a derived UUID for an invalid active session that never had one', (): void => {
    const session: NormalizedSessionStateV1 = {
      ...legacySessionWithoutId(),
      config: scheduledConfig(),
    };
    const checkpoint: RuntimeMigrationCheckpointV1ToV2 = invalidActiveCheckpoint(session, {
      assignedSessionId: ASSIGNED_SESSION_ID,
    });

    expect(checkpoint.assignedSessionId).toBe(ASSIGNED_SESSION_ID);
    expect(checkpoint.identityEvent?.sessionId).toBe(ASSIGNED_SESSION_ID);
    expect(checkpoint.cleanupPlan?.projection.sessionId).toBe(ASSIGNED_SESSION_ID);
  });

  it('closes a manual session that cannot satisfy the v2 session contract', (): void => {
    const session: NormalizedSessionStateV1 = legacySession({
      sessionEndsAt: START_AT + MINUTE_MS,
    });
    const checkpoint: RuntimeMigrationCheckpointV1ToV2 = invalidActiveCheckpoint(session);

    expect(checkpoint.projectedRuntime.session).toBeNull();
    expect(checkpoint.cleanupPlan?.projection.endEvent.source).toBe('manual');
    expect(checkpoint.cleanupPlan?.projection.endEvent.scheduleOccurrence).toBeNull();
  });
});

describe('migration checkpoint boundary', (): void => {
  it('produces a checkpoint the storage parser accepts', (): void => {
    const scheduled: NormalizedSessionStateV1 = legacySession({ config: scheduledConfig() });
    const built: RuntimeMigrationCheckpointV1ToV2[] = [
      buildRuntimeMigrationCheckpointV1ToV2(migrationInput()),
      buildRuntimeMigrationCheckpointV1ToV2(activeInput(legacySession())),
      buildRuntimeMigrationCheckpointV1ToV2(
        activeInput(legacySessionWithoutId(), { assignedSessionId: ASSIGNED_SESSION_ID }),
      ),
      buildRuntimeMigrationCheckpointV1ToV2(
        activeInput(scheduled, {
          runtime: legacyRuntime({ session: scheduled, scheduleActiveEntryId: MARKER }),
        }),
      ),
      invalidActiveCheckpoint(scheduled),
    ];

    for (const checkpoint of built) {
      expect(parseRuntimeMigrationCheckpointV1ToV2(checkpoint)).toEqual(checkpoint);
    }
  });

  it('builds the same checkpoint twice from one input', (): void => {
    const session: NormalizedSessionStateV1 = legacySession({ config: scheduledConfig() });
    const input: MigrationInputV2 = activeInput(session);

    expect(buildRuntimeMigrationCheckpointV1ToV2(input)).toEqual(
      buildRuntimeMigrationCheckpointV1ToV2(input),
    );
    expect(buildRuntimeMigrationCheckpointV1ToV2(input)).not.toBe(
      buildRuntimeMigrationCheckpointV1ToV2(input),
    );
  });

  it('detaches the projected runtime from the legacy runtime it read', (): void => {
    const legacy: RuntimeState = legacyRuntime({ unlocks: [liveUnlock()] });
    const runtime: RuntimeStateV2 = buildRuntimeMigrationCheckpointV1ToV2(
      migrationInput({ runtime: legacy }),
    ).projectedRuntime;

    expect(runtime.unlocks).not.toBe(legacy.unlocks);
    expect(runtime.tabStates).not.toBe(legacy.tabStates);
    legacy.unlocks.pop();
    expect(runtime.unlocks).toHaveLength(1);
  });

  it('never reads Settings', (): void => {
    const source: string = readFileSync(resolve(process.cwd(), MODULE_PATH), 'utf8');
    const imports: string[] = source
      .split('\n')
      .filter((line: string): boolean => line.startsWith('import '));
    const valueImports: string[] = imports.filter(
      (line: string): boolean => !line.startsWith('import type '),
    );

    expect(valueImports.some((line: string): boolean => line.includes('./stores'))).toBe(false);
    expect(imports.some((line: string): boolean => line.includes('policy-storage'))).toBe(false);
    expect(source.includes('DEFAULT_SETTINGS')).toBe(false);
    expect(source.includes('loadSettings')).toBe(false);
  });

  it('rejects input the caller must normalize first', (): void => {
    const unruled: NormalizedSessionStateV1 = legacySession({
      config: { ...legacyConfig(), rules: undefined as never },
    });

    expectCoreError((): unknown => buildRuntimeMigrationCheckpointV1ToV2(activeInput(unruled)));
    expectCoreError(
      (): unknown =>
        buildRuntimeMigrationCheckpointV1ToV2(migrationInput({ enforcementEpoch: '  ' })),
      /fresh enforcement epoch UUID/,
    );
    expectCoreError(
      (): unknown =>
        buildRuntimeMigrationCheckpointV1ToV2(migrationInput({ enforcementEpoch: 'epoch-1' })),
      /fresh enforcement epoch UUID/,
    );
    expectCoreError((): unknown =>
      buildRuntimeMigrationCheckpointV1ToV2(migrationInput({ migratedAt: -1 })),
    );
  });

  it('rejects an assignment that does not match the legacy session', (): void => {
    expectCoreError(
      (): unknown =>
        buildRuntimeMigrationCheckpointV1ToV2(
          activeInput(legacySession(), { assignedSessionId: ASSIGNED_SESSION_ID }),
        ),
      /cannot receive an assigned one/,
    );
    expectCoreError(
      (): unknown => buildRuntimeMigrationCheckpointV1ToV2(activeInput(legacySessionWithoutId())),
      /needs one assigned by the caller/,
    );
    expectCoreError((): unknown =>
      buildRuntimeMigrationCheckpointV1ToV2(
        migrationInput({ assignedSessionId: ASSIGNED_SESSION_ID }),
      ),
    );
    expectCoreError((): unknown =>
      buildRuntimeMigrationCheckpointV1ToV2(
        activeInput(legacySessionWithoutId(), { assignedSessionId: 'session-2' }),
      ),
    );
  });
});

function emptyAggregate(): DailyAgg {
  return {
    date: LOCAL_DATE,
    focusMs: 0,
    sessionsStarted: 0,
    sessionsCompleted: 0,
    attempts: {},
    attemptsOther: 0,
    pausesTaken: 0,
    pauseMsSpent: 0,
    unlocksTaken: 0,
    resisted: 0,
  };
}

function legacySessionWithoutId(): NormalizedSessionStateV1 {
  const session: NormalizedSessionStateV1 = legacySession();
  Reflect.deleteProperty(session, 'sessionId');
  return session;
}

function invalidActiveCheckpoint(
  session: NormalizedSessionStateV1,
  overrides: Partial<MigrationInputV2> = {},
): RuntimeMigrationCheckpointV1ToV2 {
  return buildRuntimeMigrationCheckpointV1ToV2(activeInput(session, overrides));
}

function cleanupPlanOf(
  session: NormalizedSessionStateV1,
  overrides: Partial<MigrationInputV2> = {},
): MigrationCleanupPlan {
  const checkpoint: RuntimeMigrationCheckpointV1ToV2 = invalidActiveCheckpoint(session, overrides);
  const plan: MigrationCleanupPlan | null = checkpoint.cleanupPlan;
  if (plan === null) throw new Error('expected an invalid active migration to plan cleanup');
  return plan;
}

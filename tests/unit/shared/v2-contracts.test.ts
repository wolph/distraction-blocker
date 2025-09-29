import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  emptySnapshotV2,
  HANDLED_SCHEDULE_OCCURRENCE_RETENTION_MS,
  MAX_HANDLED_SCHEDULE_OCCURRENCES,
  RUNTIME_SCHEMA_VERSION_V2,
} from '../../../src/shared/constants';
import type {
  CommandResultCodeV2,
  RetryCleanupResultCodeV2,
  SessionCommandResultCodeV2,
  SessionStartRequestV2,
  StartSessionResponseV2,
  StartSessionResultCodeV2,
  TransitionFailureReasonV2,
} from '../../../src/shared/messages';
import { LOCAL_V2_SESSION_AUTHORITY_KEYS } from '../../../src/shared/storage-keys';
import type {
  EventRecord,
  HandledScheduleOccurrence,
  LegacyEventRecord,
  NormalizedScheduleEntryV1,
  NormalizedSessionConfigV1,
  NormalizedSessionSnapshotV1,
  NormalizedSessionStateV1,
  PersistedLegacySessionConfigV1,
  PersistedLegacySessionStateV1,
  PredecessorSessionRuleSnapshotV1,
  ScheduleEntry,
  ScheduleEntryV2,
  SessionConfig,
  SessionConfigV2,
  SessionEndedEventV2,
  SessionEventRecordV2,
  SessionLifecycleV2,
  SessionSnapshot,
  SessionSnapshotV2,
  SessionStartedEventV2,
  SessionState,
  SessionStateV2,
} from '../../../src/shared/types';

describe('additive v2 contracts', (): void => {
  it('keeps current public names pinned to explicit v1 aliases', (): void => {
    expectTypeOf<SessionConfig>().toEqualTypeOf<NormalizedSessionConfigV1>();
    expectTypeOf<SessionState>().toEqualTypeOf<NormalizedSessionStateV1>();
    expectTypeOf<SessionSnapshot>().toEqualTypeOf<NormalizedSessionSnapshotV1>();
    expectTypeOf<ScheduleEntry>().toEqualTypeOf<NormalizedScheduleEntryV1>();
    expectTypeOf<EventRecord>().toEqualTypeOf<LegacyEventRecord>();
  });

  it('separates normalized v1 runtime values from persisted migration input', (): void => {
    expectTypeOf<PersistedLegacySessionConfigV1['rules']>().toEqualTypeOf<
      NormalizedSessionConfigV1['rules'] | PredecessorSessionRuleSnapshotV1 | undefined
    >();
    expectTypeOf<
      PersistedLegacySessionStateV1['config']
    >().toEqualTypeOf<PersistedLegacySessionConfigV1>();
  });

  it('exposes separate v2 contracts without widening the v1 aliases', (): void => {
    expectTypeOf<SessionStartRequestV2['config']>().toEqualTypeOf<SessionConfigV2>();
    expectTypeOf<SessionStateV2['version']>().toEqualTypeOf<2>();
    expectTypeOf<SessionSnapshotV2['sessionFocusedMs']>().toEqualTypeOf<number>();
    expectTypeOf<ScheduleEntryV2['duration']>().toEqualTypeOf<
      { kind: 'window' } | { kind: 'until-stopped' }
    >();
    expectTypeOf<HandledScheduleOccurrence>().toEqualTypeOf<{
      version: 1;
      token: string;
      entryId: string;
      localStartDate: string;
      handledAt: number;
      reason: 'started' | 'closure-overlap';
      expiresAt: number;
    }>();
    expectTypeOf<SessionEventRecordV2>().toEqualTypeOf<
      LegacyEventRecord | SessionStartedEventV2 | SessionEndedEventV2
    >();
    expectTypeOf<SessionStartedEventV2>().toEqualTypeOf<{
      version: 2;
      t: 'sessionStarted';
      eventId: string;
      at: number;
      sessionId: string;
      source: 'manual' | 'schedule';
      mode: NormalizedSessionConfigV1['mode'];
      strictness: NormalizedSessionConfigV1['strictness'];
      duration: SessionConfigV2['duration'];
      intention: string;
      scheduleOccurrence: SessionConfigV2['scheduleOccurrence'];
    }>();
    expectTypeOf<SessionEndedEventV2>().toEqualTypeOf<{
      version: 2;
      t: 'sessionEnded';
      eventId: string;
      at: number;
      sessionId: string;
      outcome: 'completed' | 'canceled';
      reason:
        | 'timer-completed'
        | 'manual-completed'
        | 'manual-canceled'
        | TransitionFailureReasonV2
        | 'invalid-active-state';
      focusedMs: number;
      duration: SessionConfigV2['duration'];
      source: 'manual' | 'schedule';
      scheduleOccurrence: SessionConfigV2['scheduleOccurrence'];
    }>();
    expectTypeOf<Extract<SessionLifecycleV2, { kind: 'error' }>>().toEqualTypeOf<{
      kind: 'error';
      code: 'transition-cleanup-failed' | 'closure-cleanup-failed';
      retryAvailable: true;
      endAuthority: { kind: 'hidden' };
    }>();
    expectTypeOf<StartSessionResultCodeV2>().toEqualTypeOf<
      | 'ok'
      | 'invalid-request'
      | TransitionFailureReasonV2
      | 'transition-cleanup-pending'
      | 'closure-cleanup-pending'
      | 'data-clear-pending'
    >();
    expectTypeOf<TransitionFailureReasonV2>().toEqualTypeOf<
      | 'website-access-lost'
      | 'content-registration-failed'
      | 'alarm-failed'
      | 'tab-enforcement-failed'
    >();
    expectTypeOf<SessionCommandResultCodeV2>().toEqualTypeOf<
      | 'ok'
      | 'no-active-session'
      | 'end-not-allowed'
      | 'no-active-gate'
      | 'gate-not-ready'
      | 'confirmation-mismatch'
      | 'transition-cleanup-pending'
      | 'closure-cleanup-pending'
      | 'data-clear-pending'
    >();
    expectTypeOf<RetryCleanupResultCodeV2>().toEqualTypeOf<'ok' | 'retry-not-available'>();
    expectTypeOf<CommandResultCodeV2>().toEqualTypeOf<
      | 'ok'
      | 'invalid-request'
      | 'website-access-lost'
      | 'content-registration-failed'
      | 'alarm-failed'
      | 'tab-enforcement-failed'
      | 'no-active-session'
      | 'end-not-allowed'
      | 'no-active-gate'
      | 'gate-not-ready'
      | 'confirmation-mismatch'
      | 'transition-cleanup-pending'
      | 'closure-cleanup-pending'
      | 'data-clear-pending'
      | 'retry-not-available'
    >();
    expectTypeOf<
      Extract<StartSessionResponseV2, { ok: false; cleanupPending: true }>['code']
    >().toEqualTypeOf<TransitionFailureReasonV2>();
  });

  it('uses exact v2 schema and occurrence limits', (): void => {
    expect(RUNTIME_SCHEMA_VERSION_V2).toBe(2);
    expect(HANDLED_SCHEDULE_OCCURRENCE_RETENTION_MS).toBe(14 * 24 * 60 * 60 * 1_000);
    expect(MAX_HANDLED_SCHEDULE_OCCURRENCES).toBe(256);
  });

  it('keeps v2 runtime authority on existing local keys', (): void => {
    expect(LOCAL_V2_SESSION_AUTHORITY_KEYS).toEqual([
      'runtime',
      'events',
      'dataClearJournal',
      'runtimeSchema',
      'runtimeMigration',
    ]);
    expect(LOCAL_V2_SESSION_AUTHORITY_KEYS).not.toContain('settings');
    expect(LOCAL_V2_SESSION_AUTHORITY_KEYS).not.toContain('bank');
  });

  it('builds a non-active v2 snapshot with hidden End authority', (): void => {
    expect(emptySnapshotV2(1_700_000_000_000)).toMatchObject({
      at: 1_700_000_000_000,
      lifecycle: { kind: 'idle', endAuthority: { kind: 'hidden' } },
      phase: 'idle',
      config: null,
      sessionFocusedMs: 0,
      sessionEndsAt: null,
      cycleIndex: 0,
    });
  });
});

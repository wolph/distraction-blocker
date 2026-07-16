import { describe, expect, it } from 'vitest';
import { parseBank, parseStreak } from '../../../src/background/stores';
import { assertSyncItemWithinQuota } from '../../../src/background/sync-item-size';
import { isAuthoritativeSyncItem } from '../../../src/background/sync-item-validation';
import {
  isInstallMarker,
  isLegacyEventRecord,
  isListsConfig,
  isSettings,
  isSetupState,
} from '../../../src/shared/runtime-validation';
import {
  LOCAL_BANK,
  LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS,
  LOCAL_EVENTS,
  LOCAL_INSTALL_MARKER,
  LOCAL_LISTS,
  LOCAL_LISTS_SNAPSHOT,
  LOCAL_POLICY_COMMIT,
  LOCAL_RUNTIME,
  LOCAL_RUNTIME_SCHEMA,
  LOCAL_SETTINGS,
  LOCAL_SETUP,
  LOCAL_STREAK,
  SYNC_BANK,
  SYNC_LISTS,
  SYNC_SETTINGS,
  SYNC_STREAK,
  syncAggKey,
} from '../../../src/shared/storage-keys';
import type { GateState } from '../../../src/shared/types';
import {
  LEGACY_UPGRADE_BLOCKED_AGGREGATE_DATE,
  LEGACY_UPGRADE_DEVICE_ID,
  type LegacyUpgradeProfile,
  type LegacyUpgradeSessionV1,
  type LegacyUpgradeSettingsV1,
  type LegacyUpgradeStartedEventV1,
  legacyIndefiniteCancelGateV1,
  legacyIndefiniteSessionV1,
  legacyIndefiniteStartedEventV1,
  legacyUpgradeProfile,
  legacyUpgradeSettingsV1,
} from '../../fixtures/legacy-upgrade-profile';

const LEGACY_EVENT_KINDS: readonly string[] = [
  'attempt',
  'budgetEarned',
  'gateOpened',
  'gateResisted',
  'pauseTaken',
  'phase',
  'sessionCanceled',
  'sessionCompleted',
  'sessionIdentityAssigned',
  'sessionStarted',
  'unlockTaken',
];

const V1_RUNTIME_KEYS: readonly string[] = [
  'session',
  'gate',
  'unlocks',
  'tabStates',
  'accruedFocusMs',
  'attemptDebounce',
  'scheduleActiveEntryId',
  'date',
  'todayAgg',
  'lastPruneDate',
  'commitCheckpoint',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('expected a record');
  return value;
}

function aggregateEntries(area: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(area).filter(([key]: [string, unknown]): boolean => key.startsWith('agg:'));
}

describe('legacy upgrade profile fixture', (): void => {
  it('stores a completed Sync profile stuck in publish error', (): void => {
    const { local }: LegacyUpgradeProfile = legacyUpgradeProfile();

    expect(isSetupState(local[LOCAL_SETUP])).toBe(true);
    expect(local[LOCAL_SETUP]).toMatchObject({
      completed: true,
      legacyImported: true,
      storageMode: 'sync',
      syncWriteStatus: 'error',
      storageError: 'sync-publish-failed',
    });
    expect(isInstallMarker(local[LOCAL_INSTALL_MARKER])).toBe(true);
  });

  it('carries settings the strict validator refuses only because the gate predates allowForceEnd', (): void => {
    const { local, sync }: LegacyUpgradeProfile = legacyUpgradeProfile();
    const settings: LegacyUpgradeSettingsV1 = legacyUpgradeSettingsV1();

    expect(local[LOCAL_SETTINGS]).toEqual(settings);
    expect(sync[SYNC_SETTINGS]).toEqual(settings);
    expect(settings.gate).not.toHaveProperty('allowForceEnd');
    expect(isSettings(settings)).toBe(false);
    expect(isSettings({ ...settings, gate: { ...settings.gate, allowForceEnd: false } })).toBe(
      true,
    );
  });

  it('carries lists, bank, and streak that pass the strict validators in both areas', (): void => {
    const { local, sync }: LegacyUpgradeProfile = legacyUpgradeProfile();

    expect(isListsConfig(local[LOCAL_LISTS])).toBe(true);
    expect(isListsConfig(sync[SYNC_LISTS])).toBe(true);
    expect(local[LOCAL_LISTS_SNAPSHOT]).toEqual(local[LOCAL_LISTS]);
    expect(parseBank(local[LOCAL_BANK])).toEqual(local[LOCAL_BANK]);
    expect(parseBank(sync[SYNC_BANK])).toEqual(local[LOCAL_BANK]);
    expect(parseStreak(local[LOCAL_STREAK])).toEqual(local[LOCAL_STREAK]);
    expect(parseStreak(sync[SYNC_STREAK])).toEqual(local[LOCAL_STREAK]);
  });

  it('commits policy directly with a revision that embeds the pre-force-end settings', (): void => {
    const { local }: LegacyUpgradeProfile = legacyUpgradeProfile();
    const commit: Record<string, unknown> = record(local[LOCAL_POLICY_COMMIT]);
    const revision: unknown = commit.revision;

    expect(commit.source).toBe('direct');
    expect(typeof revision).toBe('string');
    expect(String(revision).startsWith('policy-v1:')).toBe(true);
    expect(JSON.parse(String(revision).slice('policy-v1:'.length))).toEqual({
      settings: local[LOCAL_SETTINGS],
      lists: local[LOCAL_LISTS],
      bank: local[LOCAL_BANK],
      streak: local[LOCAL_STREAK],
    });
  });

  it('logs one record per v1 event kind and each passes the legacy validator', (): void => {
    const { local }: LegacyUpgradeProfile = legacyUpgradeProfile();
    const events: unknown = local[LOCAL_EVENTS];

    expect(Array.isArray(events)).toBe(true);
    const records: unknown[] = events as unknown[];
    expect(records.map((event: unknown): unknown => record(event).t).sort()).toEqual(
      LEGACY_EVENT_KINDS,
    );
    for (const event of records) {
      expect(isLegacyEventRecord(event)).toBe(true);
      expect(event).not.toHaveProperty('version');
    }
  });

  it('keeps the v1 runtime under a v2 schema marker with exactly the eleven v1 keys', (): void => {
    const { local }: LegacyUpgradeProfile = legacyUpgradeProfile();
    const runtime: Record<string, unknown> = record(local[LOCAL_RUNTIME]);

    expect(Object.keys(runtime)).toEqual(V1_RUNTIME_KEYS);
    expect(runtime.session).toBeNull();
    expect(runtime.date).toBe('2026-09-09');
    expect(record(runtime.todayAgg).date).toBe('2026-09-09');
    expect(runtime.lastPruneDate).toBe('2026-09-07');
    expect(local[LOCAL_RUNTIME_SCHEMA]).toEqual({ runtimeSchemaVersion: 2 });
  });

  it('stores authoritative aggregates under this device and one blocked publication that fits Sync', (): void => {
    const { local, sync }: LegacyUpgradeProfile = legacyUpgradeProfile();
    const localAggregates: Array<[string, unknown]> = aggregateEntries(local);
    const syncAggregates: Array<[string, unknown]> = aggregateEntries(sync);
    const blockedKey: string = syncAggKey(
      LEGACY_UPGRADE_DEVICE_ID,
      LEGACY_UPGRADE_BLOCKED_AGGREGATE_DATE,
    );

    expect(localAggregates).toHaveLength(9);
    expect(syncAggregates).toHaveLength(12);
    for (const [key, value] of [...localAggregates, ...syncAggregates]) {
      expect(key.startsWith(`agg:${LEGACY_UPGRADE_DEVICE_ID}:`)).toBe(true);
      expect(isAuthoritativeSyncItem(key, value)).toBe(true);
    }
    expect(local[LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]).toEqual({
      version: 1,
      items: { [blockedKey]: local[blockedKey] },
    });
    expect((): void => assertSyncItemWithinQuota(blockedKey, local[blockedKey])).not.toThrow();
  });

  it('returns fresh objects from every call', (): void => {
    const first: LegacyUpgradeProfile = legacyUpgradeProfile();
    const second: LegacyUpgradeProfile = legacyUpgradeProfile();

    expect(second).toEqual(first);
    expect(second.local[LOCAL_SETTINGS]).not.toBe(first.local[LOCAL_SETTINGS]);
    record(record(first.local[LOCAL_SETTINGS]).gate).delayMs = 1;
    expect(record(record(second.local[LOCAL_SETTINGS]).gate).delayMs).toBe(10_000);
    expect(record(record(legacyUpgradeProfile().local[LOCAL_SETTINGS]).gate).delayMs).toBe(10_000);
  });

  it('describes a v1 until-stopped session by null duration and null deadlines', (): void => {
    const startedAt: number = 1_700_000_000_000;
    const session: LegacyUpgradeSessionV1 = legacyIndefiniteSessionV1(startedAt);
    const gate: GateState = legacyIndefiniteCancelGateV1(startedAt + 60_000);
    const started: LegacyUpgradeStartedEventV1 = legacyIndefiniteStartedEventV1(startedAt);

    expect(session).toMatchObject({
      startedAt,
      sessionEndsAt: null,
      phase: 'focus',
      phaseStartedAt: startedAt,
      phaseEndsAt: null,
      cycleIndex: 0,
      pausedFrom: null,
      config: { durationMin: null, cycling: null, strictness: 'friction' },
    });
    expect(gate).toEqual({
      kind: 'cancel',
      host: null,
      openedAt: startedAt + 60_000,
      readyAt: startedAt + 70_000,
      requiredPhrase: null,
      forceEndAvailable: true,
    });
    expect(started).toMatchObject({ t: 'sessionStarted', at: startedAt, durationMin: null });
    expect(started.sessionId).toBe(session.sessionId);
  });
});

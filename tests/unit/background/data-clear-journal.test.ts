import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { freshCleanupRetryStateV2 } from '../../../src/background/cleanup-progress-v2';
import {
  type AllDataClearJournalV2,
  type AllDataClearPublicState,
  appendInstallLifecycleIntent,
  type CleanInstallMarkerProjection,
  cleanInstallMarkerProjection,
  createAllDataClearJournalV2,
  DATA_CLEAR_RESET_DEADLINE_MS,
  type DataClearJournal,
  type DataClearResetProgress,
  type FinalInstallMarkerProjection,
  isLegacyAllDataClearJournal,
  type LegacyAllDataClearJournal,
  type LocalHistoryClearJournal,
  MAX_DATA_CLEAR_RESOLVER_PASSES,
  MAX_PENDING_INSTALL_LIFECYCLE_INTENTS,
  nextFinalMarkerProjection,
  type PendingInstallLifecycleIntent,
  parseDataClearJournal,
  projectAllDataClearPublicState,
  type SyncedPolicyClearJournal,
  upgradeLegacyAllDataClearJournal,
} from '../../../src/background/data-clear-journal';
import type {
  DocumentEpochResetAck,
  FrozenEpochResetCommand,
} from '../../../src/background/enforcement-persistence-v2';
import { emptyRuntimeV2 as emptyStoreRuntimeV2 } from '../../../src/background/runtime-store-v2';
import type { CleanupRetryState, RuntimeStateV2 } from '../../../src/background/runtime-v2-types';
import { parseRuntimeStateV2 } from '../../../src/background/runtime-v2-validation';
import { DEFAULT_SETUP } from '../../../src/shared/constants';
import { CoreError } from '../../../src/shared/errors';
import { isSetupState } from '../../../src/shared/runtime-validation';
import {
  ATTEMPT_DEBOUNCE_KEY,
  CLEANUP_OPERATION_ID,
  cancelGateState,
  cleanupClosureRuntime,
  cleanupRetryState,
  cleanupTransition,
  clearCommandMap,
  dailyAgg,
  deferredBlockClaimMap,
  documentKey,
  ENTRY_ID,
  emptyRuntimeV2,
  epochResetAck,
  handledOccurrence,
  LOCAL_DATE,
  NOW,
  publishedFocusRuntime,
  runtimeCommitCheckpoint,
  runtimeTabState,
  SECOND_TARGET_URL,
  TARGET_URL,
  timedFocusSession,
  transitionRuntime,
} from './runtime-v2-fixtures';

type UnknownRecord = Record<string, unknown>;

const RESET_EPOCH: string = '60000000-0000-4000-8000-000000000001';
const RESET_OPERATION: string = '60000000-0000-4000-8000-000000000002';
const OTHER_OPERATION: string = '60000000-0000-4000-8000-000000000003';
const INTENT_A: string = '70000000-0000-4000-8000-000000000001';
const INTENT_B: string = '70000000-0000-4000-8000-000000000002';
const INTENT_C: string = '70000000-0000-4000-8000-000000000003';
const PROBE_INTENT: string = '80000000-0000-4000-8000-000000000001';
const FIRST_KEY: string = documentKey(11, 'document-1');
const SECOND_KEY: string = documentKey(12, 'document-2');
const EXTENSION_VERSION: string = '1.4.2';
const RETRYING_RETRY: CleanupRetryState = {
  batch: 1,
  automaticAttempt: 3,
  nextAttemptAt: NOW,
  lastError: 'failed',
};
const EXHAUSTED_RETRY: CleanupRetryState = {
  batch: 1,
  automaticAttempt: 12,
  nextAttemptAt: null,
  lastError: 'failed',
};

function withKey(value: object, key: string, replacement: unknown): UnknownRecord {
  return { ...value, [key]: replacement };
}

function withoutKey(value: object, key: string): UnknownRecord {
  const clone: UnknownRecord = { ...value };
  Reflect.deleteProperty(clone, key);
  return clone;
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

function expectRejected(values: readonly unknown[]): void {
  for (const value of values) {
    expect((): unknown => parseDataClearJournal(value)).not.toThrow();
    expect(parseDataClearJournal(value)).toBeNull();
  }
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

function cleanMarker(
  overrides: Partial<CleanInstallMarkerProjection> = {},
): CleanInstallMarkerProjection {
  return {
    version: 1,
    profile: 'clean',
    latestReason: 'install',
    extensionVersion: EXTENSION_VERSION,
    ...overrides,
  };
}

function intent(
  overrides: Partial<PendingInstallLifecycleIntent> = {},
): PendingInstallLifecycleIntent {
  return {
    version: 1,
    eventId: INTENT_A,
    reason: 'install',
    currentVersion: EXTENSION_VERSION,
    previousVersion: null,
    observedAt: NOW,
    ...overrides,
  };
}

function resetCommand(overrides: Partial<FrozenEpochResetCommand> = {}): FrozenEpochResetCommand {
  return {
    version: 1,
    command: 'reset-enforcement-epoch',
    operationId: RESET_OPERATION,
    enforcementEpoch: RESET_EPOCH,
    documentId: 'document-1',
    expectedUrl: TARGET_URL,
    tabId: 11,
    ...overrides,
  };
}

function resetAck(overrides: Partial<DocumentEpochResetAck> = {}): DocumentEpochResetAck {
  return epochResetAck({
    operationId: RESET_OPERATION,
    enforcementEpoch: RESET_EPOCH,
    tabId: 11,
    documentId: 'document-1',
    url: TARGET_URL,
    ...overrides,
  });
}

function resetProgress(overrides: Partial<DataClearResetProgress> = {}): DataClearResetProgress {
  return {
    attemptStartedAt: NOW,
    resolverPassCount: 1,
    targetGeneration: 3,
    stablePasses: 1,
    targets: { [FIRST_KEY]: { tabId: 11, documentId: 'document-1', expectedUrl: TARGET_URL } },
    commands: { [FIRST_KEY]: resetCommand() },
    acknowledgements: { [FIRST_KEY]: resetAck() },
    exclusions: [],
    deferredUnreachable: [],
    ...overrides,
  };
}

function resetRuntime(overrides: Partial<RuntimeStateV2> = {}): RuntimeStateV2 {
  return emptyRuntimeV2({
    enforcementEpoch: RESET_EPOCH,
    basePolicyRevision: 0,
    runtimeRevision: 0,
    ...overrides,
  });
}

function remoteJournal(overrides: Partial<AllDataClearJournalV2> = {}): AllDataClearJournalV2 {
  return {
    version: 2,
    scope: 'all',
    phase: 'remote',
    inventory: ['sync:bank', 'sync:settings'],
    resetEpoch: RESET_EPOCH,
    resetOperationId: RESET_OPERATION,
    runtimeProjection: null,
    setupProjection: null,
    installMarkerProjection: null,
    finalInstallMarkerProjection: null,
    pendingInstallLifecycleIntents: [],
    resetProgress: null,
    retry: cleanupRetryState(),
    ...overrides,
  };
}

function browserResetJournal(
  overrides: Partial<AllDataClearJournalV2> = {},
): AllDataClearJournalV2 {
  return remoteJournal({
    phase: 'browser-reset',
    inventory: [],
    runtimeProjection: resetRuntime(),
    setupProjection: DEFAULT_SETUP,
    installMarkerProjection: cleanMarker(),
    finalInstallMarkerProjection: cleanMarker(),
    resetProgress: resetProgress(),
    ...overrides,
  });
}

function legacyJournal(
  overrides: Partial<LegacyAllDataClearJournal> = {},
): LegacyAllDataClearJournal {
  return { scope: 'all', phase: 'remote', inventory: ['sync:settings'], ...overrides };
}

describe('data clear journal parsing', (): void => {
  it('accepts every all-data phase', (): void => {
    expect(parseDataClearJournal(remoteJournal())).toEqual(remoteJournal());
    expect(parseDataClearJournal(remoteJournal({ phase: 'local' }))).toEqual(
      remoteJournal({ phase: 'local' }),
    );
    expect(parseDataClearJournal(browserResetJournal())).toEqual(browserResetJournal());
  });

  it.each([
    [
      'a remote journal with a runtime projection',
      withKey(remoteJournal(), 'runtimeProjection', resetRuntime()),
    ],
    [
      'a remote journal with a setup projection',
      withKey(remoteJournal(), 'setupProjection', DEFAULT_SETUP),
    ],
    [
      'a local journal with a clean marker',
      withKey(remoteJournal({ phase: 'local' }), 'installMarkerProjection', cleanMarker()),
    ],
    [
      'a local journal with a final marker',
      withKey(remoteJournal({ phase: 'local' }), 'finalInstallMarkerProjection', cleanMarker()),
    ],
    [
      'a remote journal with reset progress',
      withKey(remoteJournal(), 'resetProgress', resetProgress()),
    ],
    [
      'a browser reset without a runtime projection',
      withKey(browserResetJournal(), 'runtimeProjection', null),
    ],
    [
      'a browser reset without a setup projection',
      withKey(browserResetJournal(), 'setupProjection', null),
    ],
    [
      'a browser reset without a clean marker',
      withKey(browserResetJournal(), 'installMarkerProjection', null),
    ],
    [
      'a browser reset without a final marker',
      withKey(browserResetJournal(), 'finalInstallMarkerProjection', null),
    ],
    [
      'a browser reset without reset progress',
      withKey(browserResetJournal(), 'resetProgress', null),
    ],
  ])('rejects %s', (_label: string, value: unknown): void => {
    expectRejected([value]);
  });

  it('keeps the intent list in every phase', (): void => {
    const intents: PendingInstallLifecycleIntent[] = [intent()];

    expect(
      parseDataClearJournal(remoteJournal({ pendingInstallLifecycleIntents: intents })),
    ).toEqual(remoteJournal({ pendingInstallLifecycleIntents: intents }));
    expect(
      parseDataClearJournal(browserResetJournal({ pendingInstallLifecycleIntents: intents })),
    ).toEqual(browserResetJournal({ pendingInstallLifecycleIntents: intents }));
    expectRejected([withoutKey(remoteJournal(), 'pendingInstallLifecycleIntents')]);
  });

  it('accepts an ordered, unique intent list at the cap', (): void => {
    const full: PendingInstallLifecycleIntent[] = Array.from(
      { length: MAX_PENDING_INSTALL_LIFECYCLE_INTENTS },
      (_value: unknown, index: number): PendingInstallLifecycleIntent =>
        intent({
          eventId: `70000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          observedAt: NOW + index,
        }),
    );

    expect(MAX_PENDING_INSTALL_LIFECYCLE_INTENTS).toBe(64);
    expect(
      parseDataClearJournal(remoteJournal({ pendingInstallLifecycleIntents: full })),
    ).not.toBeNull();
    expectRejected([
      remoteJournal({
        pendingInstallLifecycleIntents: [
          ...full,
          intent({ eventId: PROBE_INTENT, observedAt: NOW + full.length }),
        ],
      }),
    ]);
  });

  it.each([
    ['a duplicate event ID', [intent(), intent({ observedAt: NOW + 1 })]],
    [
      'descending observation times',
      [intent({ observedAt: NOW + 1 }), intent({ eventId: INTENT_B })],
    ],
    ['an unordered event ID tie', [intent({ eventId: INTENT_B }), intent({ eventId: INTENT_A })]],
  ])('rejects an intent list with %s', (_label: string, intents: unknown): void => {
    expectRejected([remoteJournal({ pendingInstallLifecycleIntents: intents as never })]);
  });

  it.each([
    ['an extra key', { ...intent(), extra: true }],
    ['a missing key', withoutKey(intent(), 'previousVersion')],
    ['a wrong version', withKey(intent(), 'version', 2)],
    ['a non-uuid event ID', withKey(intent(), 'eventId', 'not-a-uuid')],
    ['an unknown reason', withKey(intent(), 'reason', 'sideload')],
    ['a blank current version', withKey(intent(), 'currentVersion', '  ')],
    ['a blank previous version', withKey(intent(), 'previousVersion', '')],
    ['a fractional observation time', withKey(intent(), 'observedAt', 1.5)],
  ])('rejects an intent with %s', (_label: string, value: unknown): void => {
    expectRejected([remoteJournal({ pendingInstallLifecycleIntents: [value] as never })]);
  });

  it('accepts every Chrome installed reason', (): void => {
    for (const reason of ['install', 'update', 'chrome_update', 'shared_module_update'] as const) {
      expect(
        parseDataClearJournal(
          remoteJournal({ pendingInstallLifecycleIntents: [intent({ reason })] }),
        ),
      ).not.toBeNull();
    }
    expect(
      parseDataClearJournal(
        remoteJournal({
          pendingInstallLifecycleIntents: [intent({ previousVersion: '1.4.1' })],
        }),
      ),
    ).not.toBeNull();
  });

  it('accepts a second keyed target with its own command', (): void => {
    const progress: DataClearResetProgress = resetProgress({
      targets: {
        [FIRST_KEY]: { tabId: 11, documentId: 'document-1', expectedUrl: TARGET_URL },
        [SECOND_KEY]: { tabId: 12, documentId: 'document-2', expectedUrl: SECOND_TARGET_URL },
      },
      commands: {
        [FIRST_KEY]: resetCommand(),
        [SECOND_KEY]: resetCommand({
          tabId: 12,
          documentId: 'document-2',
          expectedUrl: SECOND_TARGET_URL,
        }),
      },
      acknowledgements: {},
    });

    expect(parseDataClearJournal(browserResetJournal({ resetProgress: progress }))).not.toBeNull();
  });

  it.each([
    [
      'a target key that is not its identity',
      resetProgress({
        targets: { wrong: { tabId: 11, documentId: 'document-1', expectedUrl: TARGET_URL } },
      }),
    ],
    ['a command without its target', resetProgress({ targets: {} })],
    ['a target without its command', resetProgress({ commands: {}, acknowledgements: {} })],
    [
      'an acknowledgement without a target',
      resetProgress({
        acknowledgements: {
          [SECOND_KEY]: resetAck({ tabId: 12, documentId: 'document-2', url: SECOND_TARGET_URL }),
        },
      }),
    ],
    [
      'a command for another operation',
      resetProgress({ commands: { [FIRST_KEY]: resetCommand({ operationId: OTHER_OPERATION }) } }),
    ],
    [
      'a command for another epoch',
      resetProgress({
        commands: { [FIRST_KEY]: resetCommand({ enforcementEpoch: OTHER_OPERATION }) },
      }),
    ],
    [
      'a command for another URL',
      resetProgress({
        commands: { [FIRST_KEY]: resetCommand({ expectedUrl: SECOND_TARGET_URL }) },
      }),
    ],
  ])('rejects reset progress with %s', (_label: string, progress: unknown): void => {
    expectRejected([withKey(browserResetJournal(), 'resetProgress', progress)]);
  });

  it.each([
    ['a duplicate inventory key', remoteJournal({ inventory: ['sync:bank', 'sync:bank'] })],
    ['a non-string inventory key', remoteJournal({ inventory: [1] as never })],
    ['inventory left in browser reset', browserResetJournal({ inventory: ['sync:bank'] })],
  ])('rejects %s', (_label: string, value: unknown): void => {
    expectRejected([value]);
  });

  it.each([
    ['a session', resetRuntime({ session: timedFocusSession() })],
    ['a non-zero base revision', resetRuntime({ basePolicyRevision: 1 })],
    ['a non-zero runtime revision', resetRuntime({ runtimeRevision: 1 })],
    ['another enforcement epoch', resetRuntime({ enforcementEpoch: OTHER_OPERATION })],
    ['a reset acknowledgement', resetRuntime({ epochResetAcks: { [FIRST_KEY]: resetAck() } })],
    [
      'a commit checkpoint',
      resetRuntime({ commitCheckpoint: runtimeCommitCheckpoint(resetRuntime()) }),
    ],
    // Spec line 1317: no user history survives the clear.
    ['a blocked-host aggregate', resetRuntime({ todayAgg: dailyAgg() })],
    ['an unlocked host', resetRuntime({ unlocks: [{ host: 'example.com', until: NOW + 60_000 }] })],
    ['a debounced attempt', resetRuntime({ attemptDebounce: { [ATTEMPT_DEBOUNCE_KEY]: NOW } })],
    ['a tab claim', resetRuntime({ tabStates: { 11: runtimeTabState() } })],
    ['an open gate', resetRuntime({ gate: cancelGateState() })],
    ['a handled occurrence', resetRuntime({ handledScheduleOccurrences: [handledOccurrence()] })],
    ['a deferred block claim', resetRuntime({ deferredBlockClaims: deferredBlockClaimMap() })],
    ['a removed tab tombstone', resetRuntime({ removedTabTombstones: { 13: true } })],
    ['accrued focus', resetRuntime({ accruedFocusMs: 45_000 })],
    [
      'a schedule notice token',
      resetRuntime({ scheduleUnavailableNoticeToken: `${ENTRY_ID}@${LOCAL_DATE}` }),
    ],
    ['a prune watermark', resetRuntime({ lastPruneDate: LOCAL_DATE })],
    [
      'a document command',
      resetRuntime({
        documentCommands: clearCommandMap({
          operationId: CLEANUP_OPERATION_ID,
          enforcementEpoch: RESET_EPOCH,
          basePolicyRevision: 0,
          runtimeRevision: 0,
        }),
      }),
    ],
    [
      'a pending transition',
      transitionRuntime(cleanupTransition('start', 'starting-verified', 'start-abandon')),
    ],
    ['a pending closure', cleanupClosureRuntime()],
    ['a published focus checkpoint', publishedFocusRuntime()],
  ])(
    'rejects a browser reset runtime projection with %s',
    (_label: string, runtime: RuntimeStateV2): void => {
      // Every case is a runtime the store itself accepts, so only the journal rule can refuse it.
      expect(parseRuntimeStateV2(runtime)).not.toBeNull();
      expectRejected([withKey(browserResetJournal(), 'runtimeProjection', runtime)]);
    },
  );

  it('accepts exactly the cleared runtime a clean install boots from', (): void => {
    const cleared: RuntimeStateV2 = resetRuntime();

    expect(cleared).toEqual({
      ...emptyStoreRuntimeV2(NOW, RESET_EPOCH),
      date: cleared.date,
    });
    expect(parseDataClearJournal(browserResetJournal())).not.toBeNull();
  });

  it.each([
    ['a legacy projection setup', { ...DEFAULT_SETUP, storageError: 'local-clear-failed' }],
    [
      'a setup still reporting a clear',
      { ...DEFAULT_SETUP, dataClear: { status: 'pending', scope: 'all', phase: 'local' } },
    ],
  ])('rejects a browser reset setup projection with %s', (_label: string, setup: unknown): void => {
    expect(isSetupState(setup)).toBe(true);
    expectRejected([withKey(browserResetJournal(), 'setupProjection', setup)]);
  });

  it.each([
    ['a legacy profile', cleanMarker({ profile: 'legacy' } as never)],
    ['an update reason', cleanMarker({ latestReason: 'update' } as never)],
    ['a blank version', cleanMarker({ extensionVersion: ' ' })],
    ['an extra key', { ...cleanMarker(), extra: true }],
  ])('rejects a clean marker projection with %s', (_label: string, marker: unknown): void => {
    expectRejected([withKey(browserResetJournal(), 'installMarkerProjection', marker)]);
  });

  it('accepts a final marker projection carrying either clean reason', (): void => {
    for (const latestReason of ['install', 'update'] as const) {
      expect(
        parseDataClearJournal(
          browserResetJournal({
            finalInstallMarkerProjection: { ...cleanMarker(), latestReason },
          }),
        ),
      ).not.toBeNull();
    }
    expectRejected([
      withKey(browserResetJournal(), 'finalInstallMarkerProjection', {
        ...cleanMarker(),
        profile: 'legacy',
      }),
    ]);
  });

  it.each([
    ['a fractional attempt start', resetProgress({ attemptStartedAt: 1.5 })],
    ['a resolver pass above the cap', resetProgress({ resolverPassCount: 4 as never })],
    ['a stable pass above two', resetProgress({ stablePasses: 3 as never })],
    ['a negative generation', resetProgress({ targetGeneration: -1 })],
    [
      'a null attempt start with a reserved pass',
      resetProgress({ attemptStartedAt: null, resolverPassCount: 1 }),
    ],
  ])('rejects reset progress with %s', (_label: string, progress: unknown): void => {
    expectRejected([withKey(browserResetJournal(), 'resetProgress', progress)]);
  });

  it('accepts a fresh attempt and the exhausted pass budget', (): void => {
    expect(MAX_DATA_CLEAR_RESOLVER_PASSES).toBe(3);
    expect(DATA_CLEAR_RESET_DEADLINE_MS).toBe(10_000);
    expect(
      parseDataClearJournal(
        browserResetJournal({
          resetProgress: resetProgress({
            attemptStartedAt: null,
            resolverPassCount: 0,
            targetGeneration: null,
            stablePasses: 0,
            acknowledgements: {},
          }),
        }),
      ),
    ).not.toBeNull();
  });

  it('rejects a journal whose retry state the cleanup validator refuses', (): void => {
    expectRejected([
      withKey(remoteJournal(), 'retry', { ...cleanupRetryState(), automaticAttempt: 13 }),
      withKey(remoteJournal(), 'retry', { ...cleanupRetryState(), lastError: '' }),
      withKey(remoteJournal(), 'retry', null),
    ]);
  });

  it('accepts the legacy all-data journal and marks it legacy', (): void => {
    const parsed: DataClearJournal | LegacyAllDataClearJournal | null = parseDataClearJournal(
      legacyJournal(),
    );

    expect(parsed).toEqual(legacyJournal());
    expect(parsed !== null && isLegacyAllDataClearJournal(parsed)).toBe(true);
    expect(isLegacyAllDataClearJournal(remoteJournal())).toBe(false);
  });

  it('deduplicates the legacy inventory in first-occurrence order', (): void => {
    expect(
      parseDataClearJournal({
        scope: 'all',
        phase: 'local',
        inventory: ['sync:settings', 'sync:bank', 'sync:settings'],
      }),
    ).toEqual({ scope: 'all', phase: 'local', inventory: ['sync:settings', 'sync:bank'] });
  });

  it('accepts the synced-policy and local-history journals unchanged', (): void => {
    const synced: SyncedPolicyClearJournal = {
      scope: 'synced-policy',
      phase: 'remote',
      inventory: ['sync:settings'],
    };
    const localHistory: LocalHistoryClearJournal = {
      scope: 'local-history',
      phase: 'runtime',
      inventory: ['events'],
      clearAggregates: true,
      priorStorageError: 'sync-publish-failed',
    };

    expect(parseDataClearJournal(synced)).toEqual(synced);
    expect(parseDataClearJournal(localHistory)).toEqual(localHistory);
    expect(parseDataClearJournal(withoutKey(localHistory, 'priorStorageError'))).toEqual({
      ...localHistory,
      priorStorageError: null,
    });
    expect(isLegacyAllDataClearJournal(synced)).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'journal'],
    ['an unknown scope', { scope: 'everything', phase: 'remote', inventory: [] }],
    ['an unknown phase', remoteJournal({ phase: 'runtime' as never })],
    ['a missing version', withoutKey(remoteJournal(), 'version')],
    ['a wrong version', withKey(remoteJournal(), 'version', 3)],
    ['a non-uuid reset epoch', withKey(remoteJournal(), 'resetEpoch', 'epoch')],
    ['a non-uuid reset operation', withKey(remoteJournal(), 'resetOperationId', 'operation')],
    ['an extra key', { ...remoteJournal(), extra: true }],
  ])('rejects %s', (_label: string, value: unknown): void => {
    expectRejected([value]);
  });

  it('parses a crashed mid-attempt browser reset', (): void => {
    const crashed: AllDataClearJournalV2 = browserResetJournal({
      resetProgress: resetProgress({
        resolverPassCount:
          MAX_DATA_CLEAR_RESOLVER_PASSES as DataClearResetProgress['resolverPassCount'],
        stablePasses: 1,
      }),
    });

    expect(parseDataClearJournal(crashed)).toEqual(crashed);
  });
});

describe('legacy all-data upgrade', (): void => {
  const ids: { resetEpoch: string; resetOperationId: string } = {
    resetEpoch: RESET_EPOCH,
    resetOperationId: RESET_OPERATION,
  };

  it('preserves scope, phase, and first-occurrence inventory', (): void => {
    const upgraded: AllDataClearJournalV2 = upgradeLegacyAllDataClearJournal(
      { scope: 'all', phase: 'local', inventory: ['sync:settings', 'sync:bank', 'sync:settings'] },
      ids,
      NOW,
    );

    expect(upgraded).toEqual({
      version: 2,
      scope: 'all',
      phase: 'local',
      inventory: ['sync:settings', 'sync:bank'],
      resetEpoch: RESET_EPOCH,
      resetOperationId: RESET_OPERATION,
      runtimeProjection: null,
      setupProjection: null,
      installMarkerProjection: null,
      finalInstallMarkerProjection: null,
      pendingInstallLifecycleIntents: [],
      resetProgress: null,
      retry: freshCleanupRetryStateV2(1, NOW),
    });
    expect(parseDataClearJournal(upgraded)).toEqual(upgraded);
  });

  it('returns a structurally equal value for v2 input', (): void => {
    const journal: AllDataClearJournalV2 = browserResetJournal();

    const upgraded: AllDataClearJournalV2 = upgradeLegacyAllDataClearJournal(journal, ids, NOW);

    expect(upgraded).toEqual(journal);
    expect(upgraded).not.toBe(journal);
  });

  it.each([
    ['a synced-policy journal', { scope: 'synced-policy', phase: 'remote', inventory: [] }],
    [
      'a local-history journal',
      { scope: 'local-history', phase: 'local', inventory: [], clearAggregates: false },
    ],
    ['a browser-reset phase', { scope: 'all', phase: 'browser-reset', inventory: [] }],
    ['an extra key', { scope: 'all', phase: 'remote', inventory: [], extra: true }],
    ['null', null],
  ])('refuses to upgrade %s', (_label: string, value: unknown): void => {
    expectInvalidRule(
      (): AllDataClearJournalV2 => upgradeLegacyAllDataClearJournal(value, ids, NOW),
    );
  });

  it('refuses fresh identifiers that are not UUIDs', (): void => {
    expectInvalidRule(
      (): AllDataClearJournalV2 =>
        upgradeLegacyAllDataClearJournal(
          legacyJournal(),
          { resetEpoch: 'epoch', resetOperationId: RESET_OPERATION },
          NOW,
        ),
    );
  });
});

describe('all-data journal creation', (): void => {
  it('starts at remote with an empty inventory and a fresh retry state', (): void => {
    const created: AllDataClearJournalV2 = createAllDataClearJournalV2(
      { resetEpoch: RESET_EPOCH, resetOperationId: RESET_OPERATION },
      NOW,
    );

    expect(created).toEqual({
      version: 2,
      scope: 'all',
      phase: 'remote',
      inventory: [],
      resetEpoch: RESET_EPOCH,
      resetOperationId: RESET_OPERATION,
      runtimeProjection: null,
      setupProjection: null,
      installMarkerProjection: null,
      finalInstallMarkerProjection: null,
      pendingInstallLifecycleIntents: [],
      resetProgress: null,
      retry: freshCleanupRetryStateV2(1, NOW),
    });
    expect(parseDataClearJournal(created)).toEqual(created);
  });

  it('refuses a malformed identity or instant', (): void => {
    expectInvalidRule(
      (): AllDataClearJournalV2 =>
        createAllDataClearJournalV2(
          { resetEpoch: 'epoch', resetOperationId: RESET_OPERATION },
          NOW,
        ),
    );
    expectInvalidRule(
      (): AllDataClearJournalV2 =>
        createAllDataClearJournalV2({ resetEpoch: RESET_EPOCH, resetOperationId: RESET_EPOCH }, -1),
    );
  });
});

describe('install lifecycle intent append', (): void => {
  it('inserts by observation time and then event ID', (): void => {
    const journal: AllDataClearJournalV2 = remoteJournal({
      pendingInstallLifecycleIntents: [
        intent({ eventId: INTENT_B, observedAt: NOW + 10 }),
        intent({ eventId: INTENT_C, observedAt: NOW + 20 }),
      ],
    });

    const appended: { journal: AllDataClearJournalV2; result: string } =
      appendInstallLifecycleIntent(journal, intent({ eventId: INTENT_A, observedAt: NOW + 10 }));

    expect(appended.result).toBe('appended');
    expect(
      appended.journal.pendingInstallLifecycleIntents.map(
        (record: PendingInstallLifecycleIntent): string => record.eventId,
      ),
    ).toEqual([INTENT_A, INTENT_B, INTENT_C]);
    expect(journal.pendingInstallLifecycleIntents).toHaveLength(2);
    expect(parseDataClearJournal(appended.journal)).toEqual(appended.journal);
  });

  it('treats an identical duplicate as a no-op', (): void => {
    const journal: AllDataClearJournalV2 = remoteJournal({
      pendingInstallLifecycleIntents: [intent()],
    });

    const appended: { journal: AllDataClearJournalV2; result: string } =
      appendInstallLifecycleIntent(journal, intent());

    expect(appended.result).toBe('duplicate');
    expect(appended.journal).toEqual(journal);
    expect(appended.journal).not.toBe(journal);
  });

  it('refuses a conflicting duplicate event ID', (): void => {
    const journal: AllDataClearJournalV2 = remoteJournal({
      pendingInstallLifecycleIntents: [intent()],
    });

    expectInvalidRule((): unknown =>
      appendInstallLifecycleIntent(journal, intent({ currentVersion: '9.9.9' })),
    );
  });

  it('reports capacity without evicting a durable intent', (): void => {
    const full: PendingInstallLifecycleIntent[] = Array.from(
      { length: MAX_PENDING_INSTALL_LIFECYCLE_INTENTS },
      (_value: unknown, index: number): PendingInstallLifecycleIntent =>
        intent({
          eventId: `70000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          observedAt: NOW + index,
        }),
    );
    const journal: AllDataClearJournalV2 = remoteJournal({
      pendingInstallLifecycleIntents: full,
    });

    const appended: { journal: AllDataClearJournalV2; result: string } =
      appendInstallLifecycleIntent(
        journal,
        intent({ eventId: PROBE_INTENT, observedAt: NOW + 999 }),
      );

    expect(appended.result).toBe('capacity');
    expect(appended.journal.pendingInstallLifecycleIntents).toEqual(full);
    expect(appended.journal.retry.lastError).toBe('install-lifecycle-intent-capacity');
    expect(journal.retry.lastError).toBeNull();
    expect(parseDataClearJournal(appended.journal)).toEqual(appended.journal);
  });

  it('refuses a malformed intent', (): void => {
    expectInvalidRule((): unknown =>
      appendInstallLifecycleIntent(remoteJournal(), intent({ eventId: 'not-a-uuid' })),
    );
  });
});

describe('all-data public state projection', (): void => {
  it.each<[string, DataClearJournal | null, AllDataClearPublicState]>([
    ['no journal', null, { status: 'idle', scope: null, phase: null }],
    [
      'a fresh remote journal',
      remoteJournal(),
      { status: 'pending', scope: 'all', phase: 'remote' },
    ],
    [
      'a retrying local journal',
      remoteJournal({ phase: 'local', retry: RETRYING_RETRY }),
      { status: 'pending', scope: 'all', phase: 'local' },
    ],
    [
      'an exhausted browser reset',
      browserResetJournal({ retry: EXHAUSTED_RETRY }),
      { status: 'error', scope: 'all', phase: 'browser-reset' },
    ],
    [
      'a synced-policy journal',
      { scope: 'synced-policy', phase: 'remote', inventory: [] },
      { status: 'idle', scope: null, phase: null },
    ],
  ])(
    'projects %s',
    (_label: string, journal: DataClearJournal | null, expected: AllDataClearPublicState): void => {
      expect(projectAllDataClearPublicState(journal)).toEqual(expected);
    },
  );

  it('never projects idle while an all-data journal exists', (): void => {
    for (const phase of ['remote', 'local', 'browser-reset'] as const) {
      const journal: AllDataClearJournalV2 =
        phase === 'browser-reset' ? browserResetJournal() : remoteJournal({ phase });
      expect(projectAllDataClearPublicState(journal).status).not.toBe('idle');
    }
  });
});

describe('clean install marker projection', (): void => {
  it('builds the exact clean marker the browser-reset journal projects', (): void => {
    const marker: CleanInstallMarkerProjection = cleanInstallMarkerProjection(EXTENSION_VERSION);

    expect(marker).toEqual({
      version: 1,
      profile: 'clean',
      latestReason: 'install',
      extensionVersion: EXTENSION_VERSION,
    });
  });

  it('refuses a blank extension version', (): void => {
    expectInvalidRule((): CleanInstallMarkerProjection => cleanInstallMarkerProjection('  '));
  });
});

describe('final marker projection', (): void => {
  it.each([
    ['install', 'install'],
    ['update', 'update'],
    ['chrome_update', 'install'],
    ['shared_module_update', 'install'],
  ] as const)(
    'maps the %s reason to %s',
    (reason: PendingInstallLifecycleIntent['reason'], latestReason: FinalInstallMarkerProjection['latestReason']): void => {
      const record: PendingInstallLifecycleIntent = intent({
        reason,
        currentVersion: '2.0.0',
        previousVersion: '1.9.9',
      });

      const next: FinalInstallMarkerProjection = nextFinalMarkerProjection(
        browserResetJournal({ pendingInstallLifecycleIntents: [record] }),
        record,
      );

      expect(next).toEqual({
        version: 1,
        profile: 'clean',
        latestReason,
        extensionVersion: '2.0.0',
      });
    },
  );

  it('refuses a journal without a final marker projection', (): void => {
    expectInvalidRule(
      (): FinalInstallMarkerProjection =>
        nextFinalMarkerProjection(
          remoteJournal({ pendingInstallLifecycleIntents: [intent()] }),
          intent(),
        ),
    );
  });

  it('refuses an intent without a usable version', (): void => {
    expectInvalidRule(
      (): FinalInstallMarkerProjection =>
        nextFinalMarkerProjection(browserResetJournal(), intent({ currentVersion: ' ' })),
    );
  });

  it('refuses an intent that is not the first pending record', (): void => {
    const first: PendingInstallLifecycleIntent = intent({ eventId: INTENT_A, observedAt: NOW });
    const second: PendingInstallLifecycleIntent = intent({
      eventId: INTENT_B,
      observedAt: NOW + 1,
      reason: 'update',
    });
    const journal: AllDataClearJournalV2 = browserResetJournal({
      pendingInstallLifecycleIntents: [first, second],
    });

    expect(nextFinalMarkerProjection(journal, first).latestReason).toBe('install');
    expectInvalidRule(
      (): FinalInstallMarkerProjection => nextFinalMarkerProjection(journal, second),
    );
  });
});

describe('journal hostile input and detachment', (): void => {
  it('rejects hostile roots and nested values', (): void => {
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
      new Proxy(remoteJournal(), {}),
      cyclicRecord(),
      withKey(remoteJournal(), 'inventory', cyclicRecord()),
      withKey(browserResetJournal(), 'runtimeProjection', new Proxy(resetRuntime(), {})),
      { ...remoteJournal(), [Symbol('extra')]: true },
      withKey(remoteJournal(), 'retry', { ...cleanupRetryState(), [Symbol('extra')]: true }),
      withKey(remoteJournal(), 'inventory', sparseArray('sync:bank')),
      withKey(remoteJournal(), 'pendingInstallLifecycleIntents', sparseArray(intent())),
      withKey(
        browserResetJournal(),
        'resetProgress',
        withKey(resetProgress(), 'exclusions', sparseArray(null)),
      ),
    ]);
  });

  it('rejects an accessor phase without reading it', (): void => {
    let reads: number = 0;
    const accessor: UnknownRecord = { ...remoteJournal() };
    Object.defineProperty(accessor, 'phase', {
      configurable: true,
      enumerable: true,
      get: (): string => {
        reads += 1;
        return 'remote';
      },
    });

    expectRejected([accessor]);
    expect(reads).toBe(0);
  });

  it('does not execute a getter installed by a sibling proxy during inspection', (): void => {
    let getterCalls: number = 0;
    const mutable: UnknownRecord = { ...remoteJournal().retry };
    const trap: unknown = new Proxy(
      { ...intent() },
      {
        getPrototypeOf: (target: object): object | null => {
          Object.defineProperty(mutable, 'batch', {
            configurable: true,
            enumerable: true,
            get: (): number => {
              getterCalls += 1;
              return 0;
            },
          });
          return Reflect.getPrototypeOf(target);
        },
      },
    );

    expectRejected([
      { ...remoteJournal(), retry: mutable, pendingInstallLifecycleIntents: [trap] },
    ]);
    expect(getterCalls).toBe(0);
  });

  it('detaches the parsed journal from the stored value in both directions', (): void => {
    const stored: UnknownRecord = { ...browserResetJournal() };
    const parsed: DataClearJournal | LegacyAllDataClearJournal | null =
      parseDataClearJournal(stored);
    const inventory: string[] = (stored.inventory as string[]) ?? [];

    inventory.push('sync:late');
    if (parsed !== null && 'pendingInstallLifecycleIntents' in parsed) {
      parsed.pendingInstallLifecycleIntents.push(intent());
    }

    expect(parsed).toEqual(browserResetJournal({ pendingInstallLifecycleIntents: [intent()] }));
    expect(stored.inventory).toEqual(['sync:late']);
  });

  it('detaches every journal the helpers return', (): void => {
    const journal: AllDataClearJournalV2 = remoteJournal();
    const created: AllDataClearJournalV2 = createAllDataClearJournalV2(
      { resetEpoch: RESET_EPOCH, resetOperationId: RESET_OPERATION },
      NOW,
    );
    const appended: { journal: AllDataClearJournalV2 } = appendInstallLifecycleIntent(
      journal,
      intent(),
    );

    created.inventory.push('sync:late');
    appended.journal.inventory.push('sync:late');

    expect(journal.inventory).toEqual(['sync:bank', 'sync:settings']);
    expect(
      createAllDataClearJournalV2(
        { resetEpoch: RESET_EPOCH, resetOperationId: RESET_OPERATION },
        NOW,
      ).inventory,
    ).toEqual([]);
  });
});

describe('data clear journal source boundary', (): void => {
  it('imports neither Main, Policy Storage, nor Engine', (): void => {
    const source: string = readFileSync(
      fileURLToPath(new URL('../../../src/background/data-clear-journal.ts', import.meta.url)),
      'utf8',
    );

    expect(source).not.toMatch(/from\s+['"][^'"]*\/?(main|policy-storage|engine)['"]/u);
  });
});

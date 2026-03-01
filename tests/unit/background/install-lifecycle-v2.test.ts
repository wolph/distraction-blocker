import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AllDataClearJournalV2,
  type CleanInstallMarkerProjection,
  emptyDataClearResetProgress,
  type FinalInstallMarkerProjection,
  MAX_PENDING_INSTALL_LIFECYCLE_INTENTS,
  type PendingInstallLifecycleIntent,
} from '../../../src/background/data-clear-journal';
import {
  type AllDataClearLease,
  createAllDataClearLease,
  type DataClearLeaseToken,
} from '../../../src/background/data-clear-lease';
import {
  appendOrApplyInstallLifecycle,
  captureInstallLifecycleIntent,
  type InstallLifecycleSubmissionV2,
  replayLifecycleIntentsV2,
} from '../../../src/background/install-lifecycle-v2';
import { emptyRuntimeV2 } from '../../../src/background/runtime-store-v2';
import { DEFAULT_SETUP } from '../../../src/shared/constants';
import { LOCAL_DATA_CLEAR_JOURNAL } from '../../../src/shared/storage-keys';

const NOW: number = Date.parse('2026-09-04T10:00:00.000Z');
const RESET_EPOCH: string = '30000000-0000-4000-8000-000000000001';
const RESET_OPERATION: string = '30000000-0000-4000-8000-000000000002';
const EXTENSION_VERSION: string = '1.0.0';
const FIRST_EVENT: string = '30000000-0000-4000-8000-00000000000a';
const SECOND_EVENT: string = '30000000-0000-4000-8000-00000000000b';

/** Every event id the journal accepts is a UUID, so the fixtures mint real ones. */
function eventId(index: number): string {
  return `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

interface LifecycleHarness {
  lease: AllDataClearLease;
  storage: Record<string, unknown>;
  markers: FinalInstallMarkerProjection[];
  journalWrites: number;
  journal(): AllDataClearJournalV2;
  run<T>(operation: (token: DataClearLeaseToken) => Promise<T>): Promise<T>;
}

function marker(
  overrides: Partial<FinalInstallMarkerProjection> = {},
): CleanInstallMarkerProjection {
  return {
    version: 1,
    profile: 'clean',
    latestReason: 'install',
    extensionVersion: EXTENSION_VERSION,
    ...overrides,
  } as CleanInstallMarkerProjection;
}

function intent(
  overrides: Partial<PendingInstallLifecycleIntent> = {},
): PendingInstallLifecycleIntent {
  return {
    version: 1,
    eventId: FIRST_EVENT,
    reason: 'install',
    currentVersion: EXTENSION_VERSION,
    previousVersion: null,
    observedAt: NOW,
    ...overrides,
  };
}

/** A clear still deleting storage: no projection exists yet, which is where most events land. */
function journalV2(overrides: Partial<AllDataClearJournalV2> = {}): AllDataClearJournalV2 {
  return {
    version: 2,
    scope: 'all',
    phase: 'local',
    inventory: [],
    resetEpoch: RESET_EPOCH,
    resetOperationId: RESET_OPERATION,
    runtimeProjection: null,
    setupProjection: null,
    installMarkerProjection: null,
    finalInstallMarkerProjection: null,
    pendingInstallLifecycleIntents: [],
    resetProgress: null,
    retry: { batch: 1, automaticAttempt: 0, nextAttemptAt: NOW, lastError: null },
    ...overrides,
  };
}

/** The phase replay runs in, which is the only one carrying a final marker to advance. */
function resetJournal(overrides: Partial<AllDataClearJournalV2> = {}): AllDataClearJournalV2 {
  return {
    ...journalV2(),
    phase: 'browser-reset',
    runtimeProjection: emptyRuntimeV2(NOW, RESET_EPOCH),
    setupProjection: DEFAULT_SETUP,
    installMarkerProjection: marker(),
    finalInstallMarkerProjection: marker(),
    resetProgress: emptyDataClearResetProgress(),
    ...overrides,
  };
}

function harness(stored: unknown = undefined): LifecycleHarness {
  const storage: Record<string, unknown> = {};
  if (stored !== undefined) storage[LOCAL_DATA_CLEAR_JOURNAL] = structuredClone(stored);
  const markers: FinalInstallMarkerProjection[] = [];
  const state: { journalWrites: number } = { journalWrites: 0 };
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(
          async (key: string): Promise<Record<string, unknown>> =>
            Object.hasOwn(storage, key) ? { [key]: structuredClone(storage[key]) } : {},
        ),
        set: vi.fn(async (items: Record<string, unknown>): Promise<void> => {
          if (Object.hasOwn(items, LOCAL_DATA_CLEAR_JOURNAL)) state.journalWrites += 1;
          Object.assign(storage, structuredClone(items));
        }),
        remove: vi.fn(async (key: string): Promise<void> => {
          delete storage[key];
        }),
      },
    },
  });
  const lease: AllDataClearLease = createAllDataClearLease((): boolean => false);
  return {
    lease,
    storage,
    markers,
    get journalWrites(): number {
      return state.journalWrites;
    },
    journal: (): AllDataClearJournalV2 =>
      structuredClone(storage[LOCAL_DATA_CLEAR_JOURNAL]) as AllDataClearJournalV2,
    run: <T>(operation: (token: DataClearLeaseToken) => Promise<T>): Promise<T> =>
      lease.run(operation),
  };
}

/** The replay's materialization seam: it records what it was asked to write. */
function recordMarker(
  harnessed: LifecycleHarness,
): (m: FinalInstallMarkerProjection) => Promise<void> {
  return async (m: FinalInstallMarkerProjection): Promise<void> => {
    harnessed.markers.push(structuredClone(m));
  };
}

describe('install lifecycle capture', () => {
  afterEach((): void => {
    vi.unstubAllGlobals();
  });

  it('reads everything the record needs from the callback', (): void => {
    const captured: PendingInstallLifecycleIntent = captureInstallLifecycleIntent(
      { reason: 'update', previousVersion: '0.9.0' } as chrome.runtime.InstalledDetails,
      NOW,
      'event-7',
      EXTENSION_VERSION,
    );

    expect(captured).toEqual({
      version: 1,
      eventId: 'event-7',
      reason: 'update',
      currentVersion: EXTENSION_VERSION,
      previousVersion: '0.9.0',
      observedAt: NOW,
    });
  });

  it('treats a previous version that is not a string as absent', (): void => {
    const captured: PendingInstallLifecycleIntent = captureInstallLifecycleIntent(
      { reason: 'update', previousVersion: 12 } as unknown as chrome.runtime.InstalledDetails,
      NOW,
      'event-7',
      EXTENSION_VERSION,
    );

    expect(captured.previousVersion).toBeNull();
  });

  it('refuses a reason no version of the API defines, before any write', (): void => {
    const harnessed: LifecycleHarness = harness(journalV2());

    expect(
      (): PendingInstallLifecycleIntent =>
        captureInstallLifecycleIntent(
          { reason: 'sideloaded' } as unknown as chrome.runtime.InstalledDetails,
          NOW,
          'event-7',
          EXTENSION_VERSION,
        ),
    ).toThrow('unknown install lifecycle reason');
    expect(harnessed.journalWrites).toBe(0);
  });
});

describe('install lifecycle submission', () => {
  afterEach((): void => {
    vi.unstubAllGlobals();
  });

  it('applies the event immediately when no clear is running', async (): Promise<void> => {
    const harnessed: LifecycleHarness = harness();
    const applied: string[] = [];

    const submission: InstallLifecycleSubmissionV2 = await appendOrApplyInstallLifecycle(
      harnessed.lease,
      intent(),
      async (): Promise<void> => {
        applied.push('marker');
      },
    );

    expect(submission).toBe('applied');
    expect(applied).toEqual(['marker']);
    expect(harnessed.storage[LOCAL_DATA_CLEAR_JOURNAL]).toBeUndefined();
  });

  it('applies the event immediately when the stored clear belongs to another scope', async (): Promise<void> => {
    const harnessed: LifecycleHarness = harness({
      scope: 'local-history',
      phase: 'local',
      inventory: [],
      clearAggregates: true,
      priorStorageError: null,
    });
    const applied: string[] = [];

    const submission: InstallLifecycleSubmissionV2 = await appendOrApplyInstallLifecycle(
      harnessed.lease,
      intent(),
      async (): Promise<void> => {
        applied.push('marker');
      },
    );

    expect(submission).toBe('applied');
    expect(applied).toEqual(['marker']);
  });

  it('makes the event durable and writes no marker while a clear owns it', async (): Promise<void> => {
    const harnessed: LifecycleHarness = harness(journalV2());
    const applied: string[] = [];

    const submission: InstallLifecycleSubmissionV2 = await appendOrApplyInstallLifecycle(
      harnessed.lease,
      intent({ reason: 'update', previousVersion: '0.9.0' }),
      async (): Promise<void> => {
        applied.push('marker');
      },
    );

    expect(submission).toBe('appended');
    expect(applied).toEqual([]);
    expect(harnessed.journal().pendingInstallLifecycleIntents).toEqual([
      intent({ reason: 'update', previousVersion: '0.9.0' }),
    ]);
  });

  it('upgrades a legacy journal and appends the record in one write', async (): Promise<void> => {
    const harnessed: LifecycleHarness = harness({
      scope: 'all',
      phase: 'local',
      inventory: ['settings'],
    });

    const submission: InstallLifecycleSubmissionV2 = await appendOrApplyInstallLifecycle(
      harnessed.lease,
      intent(),
      async (): Promise<void> => undefined,
    );

    expect(submission).toBe('appended');
    expect(harnessed.journalWrites).toBe(1);
    const written: AllDataClearJournalV2 = harnessed.journal();
    expect(written.version).toBe(2);
    expect(written.phase).toBe('local');
    expect(written.inventory).toEqual(['settings']);
    expect(written.pendingInstallLifecycleIntents).toEqual([intent()]);
  });

  it('keeps one record when the same event is submitted twice', async (): Promise<void> => {
    const harnessed: LifecycleHarness = harness(journalV2());

    await appendOrApplyInstallLifecycle(
      harnessed.lease,
      intent(),
      async (): Promise<void> => undefined,
    );
    const second: InstallLifecycleSubmissionV2 = await appendOrApplyInstallLifecycle(
      harnessed.lease,
      intent(),
      async (): Promise<void> => undefined,
    );

    expect(second).toBe('appended');
    expect(harnessed.journal().pendingInstallLifecycleIntents).toEqual([intent()]);
  });

  it('records the capacity failure and evicts nothing', async (): Promise<void> => {
    const full: PendingInstallLifecycleIntent[] = Array.from(
      { length: MAX_PENDING_INSTALL_LIFECYCLE_INTENTS },
      (_unused: unknown, index: number): PendingInstallLifecycleIntent =>
        intent({ eventId: eventId(index + 1), observedAt: NOW + index }),
    );
    const harnessed: LifecycleHarness = harness(
      journalV2({ pendingInstallLifecycleIntents: full }),
    );

    const submission: InstallLifecycleSubmissionV2 = await appendOrApplyInstallLifecycle(
      harnessed.lease,
      intent({ eventId: eventId(999), observedAt: NOW + 1_000 }),
      async (): Promise<void> => undefined,
    );

    expect(submission).toBe('capacity');
    const written: AllDataClearJournalV2 = harnessed.journal();
    expect(written.pendingInstallLifecycleIntents).toEqual(full);
    expect(written.retry.lastError).toBe('install-lifecycle-intent-capacity');
  });

  it('applies an event that waited for the clear to remove the journal', async (): Promise<void> => {
    const harnessed: LifecycleHarness = harness(journalV2());
    const applied: string[] = [];
    let releaseFinalization: () => void = (): void => undefined;
    const finalizing: Promise<void> = new Promise<void>((resolve: () => void): void => {
      releaseFinalization = resolve;
    });

    // The clear holds the lease and ends by removing the journal, exactly as finalization does.
    const clear: Promise<void> = harnessed.run(async (): Promise<void> => {
      await finalizing;
      delete harnessed.storage[LOCAL_DATA_CLEAR_JOURNAL];
    });
    const submission: Promise<InstallLifecycleSubmissionV2> = appendOrApplyInstallLifecycle(
      harnessed.lease,
      intent(),
      async (): Promise<void> => {
        applied.push('marker');
      },
    );
    releaseFinalization();
    await clear;

    await expect(submission).resolves.toBe('applied');
    expect(applied).toEqual(['marker']);
  });

  it('serializes two events arriving together', async (): Promise<void> => {
    const harnessed: LifecycleHarness = harness(journalV2());

    await Promise.all([
      appendOrApplyInstallLifecycle(
        harnessed.lease,
        intent({ eventId: FIRST_EVENT, observedAt: NOW }),
        async (): Promise<void> => undefined,
      ),
      appendOrApplyInstallLifecycle(
        harnessed.lease,
        intent({ eventId: SECOND_EVENT, observedAt: NOW + 1 }),
        async (): Promise<void> => undefined,
      ),
    ]);

    expect(
      harnessed
        .journal()
        .pendingInstallLifecycleIntents.map(
          (record: PendingInstallLifecycleIntent): string => record.eventId,
        ),
    ).toEqual([FIRST_EVENT, SECOND_EVENT]);
  });
});

describe('install lifecycle replay', () => {
  afterEach((): void => {
    vi.unstubAllGlobals();
  });

  it('replays every record oldest first and leaves the list empty', async (): Promise<void> => {
    const harnessed: LifecycleHarness = harness(
      resetJournal({
        pendingInstallLifecycleIntents: [
          intent({
            eventId: FIRST_EVENT,
            reason: 'install',
            currentVersion: '1.0.5',
            observedAt: NOW,
          }),
          intent({
            eventId: SECOND_EVENT,
            reason: 'update',
            currentVersion: '1.1.0',
            observedAt: NOW + 5,
          }),
        ],
      }),
    );

    const result: 'complete' = await harnessed.run(
      (token: DataClearLeaseToken): Promise<'complete'> =>
        replayLifecycleIntentsV2(harnessed.lease, token, recordMarker(harnessed)),
    );

    expect(result).toBe('complete');
    expect(harnessed.markers).toEqual([
      marker({ latestReason: 'install', extensionVersion: '1.0.5' }),
      marker({ latestReason: 'update', extensionVersion: '1.1.0' }),
    ]);
    const written: AllDataClearJournalV2 = harnessed.journal();
    expect(written.pendingInstallLifecycleIntents).toEqual([]);
    expect(written.finalInstallMarkerProjection).toEqual(
      marker({ latestReason: 'update', extensionVersion: '1.1.0' }),
    );
  });

  it('is a no-op for a journal with nothing to replay', async (): Promise<void> => {
    const harnessed: LifecycleHarness = harness(resetJournal());

    const result: 'complete' = await harnessed.run(
      (token: DataClearLeaseToken): Promise<'complete'> =>
        replayLifecycleIntentsV2(harnessed.lease, token, recordMarker(harnessed)),
    );

    expect(result).toBe('complete');
    expect(harnessed.markers).toEqual([]);
    expect(harnessed.journalWrites).toBe(0);
  });

  it('repeats a record whose marker write was durable before the crash', async (): Promise<void> => {
    // The crash cell between the projection advance and its materialization: the record is still
    // listed, and the projection already says what the marker must become.
    const advanced: FinalInstallMarkerProjection = marker({
      latestReason: 'update',
      extensionVersion: '1.1.0',
    });
    const harnessed: LifecycleHarness = harness(
      resetJournal({
        finalInstallMarkerProjection: advanced,
        pendingInstallLifecycleIntents: [
          intent({ eventId: FIRST_EVENT, reason: 'update', currentVersion: '1.1.0' }),
        ],
      }),
    );

    await harnessed.run(
      (token: DataClearLeaseToken): Promise<'complete'> =>
        replayLifecycleIntentsV2(harnessed.lease, token, recordMarker(harnessed)),
    );

    expect(harnessed.markers).toEqual([advanced]);
    expect(harnessed.journal().finalInstallMarkerProjection).toEqual(advanced);
    expect(harnessed.journal().pendingInstallLifecycleIntents).toEqual([]);
  });

  it('keeps the record when its marker cannot be written', async (): Promise<void> => {
    const harnessed: LifecycleHarness = harness(
      resetJournal({ pendingInstallLifecycleIntents: [intent({ eventId: FIRST_EVENT })] }),
    );

    await expect(
      harnessed.run(
        (token: DataClearLeaseToken): Promise<'complete'> =>
          replayLifecycleIntentsV2(harnessed.lease, token, async (): Promise<void> => {
            throw new Error('marker write refused');
          }),
      ),
    ).rejects.toThrow('marker write refused');

    expect(harnessed.journal().pendingInstallLifecycleIntents).toEqual([
      intent({ eventId: FIRST_EVENT }),
    ]);
  });

  it('refuses to replay a legacy journal, which no owner may leave unupgraded', async (): Promise<void> => {
    const harnessed: LifecycleHarness = harness({
      scope: 'all',
      phase: 'local',
      inventory: [],
    });

    await expect(
      harnessed.run(
        (token: DataClearLeaseToken): Promise<'complete'> =>
          replayLifecycleIntentsV2(harnessed.lease, token, recordMarker(harnessed)),
      ),
    ).rejects.toThrow('a legacy all-data journal upgrades under the lease');
  });

  it('refuses to replay when the journal is gone', async (): Promise<void> => {
    const harnessed: LifecycleHarness = harness();

    await expect(
      harnessed.run(
        (token: DataClearLeaseToken): Promise<'complete'> =>
          replayLifecycleIntentsV2(harnessed.lease, token, recordMarker(harnessed)),
      ),
    ).rejects.toThrow('version 2 all-data journal');
  });
});

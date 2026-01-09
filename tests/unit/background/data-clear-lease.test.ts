import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  type AllDataClearJournalV2,
  appendInstallLifecycleIntent,
  createAllDataClearJournalV2,
  type DataClearJournal,
  isLegacyAllDataClearJournal,
  type LegacyAllDataClearJournal,
  type PendingInstallLifecycleIntent,
  parseDataClearJournal,
  upgradeLegacyAllDataClearJournal,
} from '../../../src/background/data-clear-journal';
import {
  type AllDataClearLease,
  assertNoEngineRuntimeLease,
  createAllDataClearLease,
  type DataClearLeaseToken,
  type JournalTransform,
  transactDataClearJournal,
} from '../../../src/background/data-clear-lease';
import { CoreError } from '../../../src/shared/errors';
import { LOCAL_DATA_CLEAR_JOURNAL } from '../../../src/shared/storage-keys';

type StoredJournal = DataClearJournal | LegacyAllDataClearJournal;
type WriteMode = 'store' | 'corrupt' | 'drop' | 'reject';

const NOW: number = new Date(2026, 8, 3, 10, 0, 0, 0).getTime();
const RESET_EPOCH: string = '60000000-0000-4000-8000-000000000001';
const RESET_OPERATION: string = '60000000-0000-4000-8000-000000000002';
const INTENT_ID: string = '70000000-0000-4000-8000-000000000001';
const EXTENSION_VERSION: string = '1.4.2';
const LEGACY_JOURNAL: LegacyAllDataClearJournal = {
  scope: 'all',
  phase: 'local',
  inventory: ['policy'],
};

interface StorageStub {
  values: Record<string, unknown>;
  /** When set, `get` waits on it, which holds a transaction open past its operation. */
  gate: Promise<void> | null;
  sets: Record<string, unknown>[];
  removes: string[];
  writeMode: WriteMode;
  get: Mock<(key: string) => Promise<Record<string, unknown>>>;
  set: Mock<(items: Record<string, unknown>) => Promise<void>>;
  remove: Mock<(key: string) => Promise<void>>;
}

/**
 * The local area the lease writes through. `writeMode` simulates the failures a journal write must
 * survive: a mangled read-back, a silently dropped write, and a crashed write that rejects.
 */
function stubStorage(initial: Record<string, unknown> = {}): StorageStub {
  const values: Record<string, unknown> = { ...initial };
  const sets: Record<string, unknown>[] = [];
  const removes: string[] = [];
  const stub: StorageStub = {
    values,
    sets,
    removes,
    gate: null,
    writeMode: 'store',
    get: vi.fn(async (key: string): Promise<Record<string, unknown>> => {
      if (stub.gate !== null) await stub.gate;
      return Object.hasOwn(values, key) ? { [key]: values[key] } : {};
    }),
    set: vi.fn(async (items: Record<string, unknown>): Promise<void> => {
      sets.push(items);
      if (stub.writeMode === 'reject') throw new Error('storage set failed');
      if (stub.writeMode === 'drop') return;
      Object.assign(values, stub.writeMode === 'corrupt' ? corruptedWrite(items) : items);
    }),
    remove: vi.fn(async (key: string): Promise<void> => {
      removes.push(key);
      if (stub.writeMode === 'reject') throw new Error('storage remove failed');
      if (stub.writeMode === 'drop') return;
      delete values[key];
    }),
  };
  vi.stubGlobal('chrome', {
    storage: { local: { get: stub.get, set: stub.set, remove: stub.remove } },
  });
  return stub;
}

/** A storage layer that stores a valid but different journal than the one it was handed. */
function corruptedWrite(items: Record<string, unknown>): Record<string, unknown> {
  const journal: AllDataClearJournalV2 = items[LOCAL_DATA_CLEAR_JOURNAL] as AllDataClearJournalV2;
  return {
    [LOCAL_DATA_CLEAR_JOURNAL]: { ...journal, inventory: [...journal.inventory, 'stowaway'] },
  };
}

/** Every lease under test names an engine runtime lease that is not held unless a test says so. */
function newLease(engineLeaseHeld: () => boolean = (): boolean => false): AllDataClearLease {
  return createAllDataClearLease(engineLeaseHeld);
}

interface Gate {
  promise: Promise<void>;
  open(): void;
}

function newGate(): Gate {
  let open: () => void = (): void => undefined;
  const promise: Promise<void> = new Promise<void>((resolve: () => void): void => {
    open = resolve;
  });
  return { promise, open };
}

const MARKER: Record<string, unknown> = {
  version: 1,
  profile: 'clean',
  latestReason: 'install',
  extensionVersion: EXTENSION_VERSION,
};

function seededJournal(): AllDataClearJournalV2 {
  return createAllDataClearJournalV2(
    { resetEpoch: RESET_EPOCH, resetOperationId: RESET_OPERATION },
    NOW,
  );
}

function intentRecord(): PendingInstallLifecycleIntent {
  return {
    version: 1,
    eventId: INTENT_ID,
    reason: 'update',
    currentVersion: EXTENSION_VERSION,
    previousVersion: '1.4.1',
    observedAt: NOW,
  };
}

function allDataJournal(current: StoredJournal | null): AllDataClearJournalV2 {
  if (current === null || current.scope !== 'all' || isLegacyAllDataClearJournal(current)) {
    throw new Error('the transform expected a version 2 all-data journal');
  }
  return current;
}

function storedJournal(storage: StorageStub): AllDataClearJournalV2 {
  return allDataJournal(parseDataClearJournal(storage.values[LOCAL_DATA_CLEAR_JOURNAL]));
}

function setInventory(inventory: string[]): JournalTransform {
  return (current: StoredJournal | null): DataClearJournal => ({
    ...allDataJournal(current),
    inventory,
  });
}

function appendIntent(intent: PendingInstallLifecycleIntent): JournalTransform {
  return (current: StoredJournal | null): DataClearJournal =>
    appendInstallLifecycleIntent(allDataJournal(current), intent).journal;
}

function recording(seen: (StoredJournal | null)[], transform: JournalTransform): JournalTransform {
  return (current: StoredJournal | null): DataClearJournal | null | 'unchanged' => {
    seen.push(current);
    return transform(current);
  };
}

function transact(
  lease: AllDataClearLease,
  transform: JournalTransform,
): Promise<DataClearJournal | null> {
  return lease.run(
    (token: DataClearLeaseToken): Promise<DataClearJournal | null> =>
      transactDataClearJournal(lease, token, transform),
  );
}

function orderedOperation(
  label: string,
  order: string[],
  tokens: DataClearLeaseToken[],
): (token: DataClearLeaseToken) => Promise<string> {
  return async (token: DataClearLeaseToken): Promise<string> => {
    tokens.push(token);
    order.push(`${label}:start`);
    await Promise.resolve();
    await Promise.resolve();
    order.push(`${label}:end`);
    return label;
  };
}

/** Returns the synchronously thrown error, or null when the call returned instead of throwing. */
function captured(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (error: unknown) {
    return error;
  }
}

async function settled(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    (): unknown => null,
    (reason: unknown): unknown => reason,
  );
}

function expectCoreError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(CoreError);
  expect((error as CoreError).code).toBe(code);
}

/** The transaction an operation started and never awaited. */
function startedTransaction(
  outstanding: Promise<DataClearJournal | null>[],
): Promise<DataClearJournal | null> {
  const started: Promise<DataClearJournal | null> | undefined = outstanding[0];
  if (started === undefined) throw new Error('the operation never started a transaction');
  return started;
}

function rejectionReason(outcome: PromiseSettledResult<unknown> | undefined): unknown {
  return outcome !== undefined && outcome.status === 'rejected' ? outcome.reason : null;
}

async function rejectedCoreError(work: Promise<unknown>, code: string): Promise<CoreError> {
  const error: unknown = await settled(work);
  expect(error).toBeInstanceOf(CoreError);
  expect((error as CoreError).code).toBe(code);
  return error as CoreError;
}

/** One inventory write and one intent append under the lease, in the requested order. */
async function interleavedWrites(intentFirst: boolean): Promise<StorageStub> {
  const storage: StorageStub = stubStorage({ [LOCAL_DATA_CLEAR_JOURNAL]: seededJournal() });
  const lease: AllDataClearLease = newLease();
  const seen: (StoredJournal | null)[] = [];
  const inventory: JournalTransform = recording(seen, setInventory(['policy']));
  const intent: JournalTransform = recording(seen, appendIntent(intentRecord()));
  await Promise.all([
    transact(lease, intentFirst ? intent : inventory),
    transact(lease, intentFirst ? inventory : intent),
  ]);
  // The second transform must see the first write, not the value a caller could have captured
  // outside the lease.
  expect(seen[0]).toEqual(seededJournal());
  expect(seen[1]).not.toEqual(seededJournal());
  return storage;
}

afterEach((): void => {
  vi.unstubAllGlobals();
});

describe('exclusive all-data clear lease', (): void => {
  it('serializes concurrent operations in call order and issues distinct tokens', async (): Promise<void> => {
    const lease: AllDataClearLease = newLease();
    const order: string[] = [];
    const tokens: DataClearLeaseToken[] = [];

    const labels: string[] = await Promise.all([
      lease.run(orderedOperation('a', order, tokens)),
      lease.run(orderedOperation('b', order, tokens)),
      lease.run(orderedOperation('c', order, tokens)),
    ]);

    expect(labels).toEqual(['a', 'b', 'c']);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
    expect(new Set(tokens.map((token: DataClearLeaseToken): number => token.id)).size).toBe(3);
  });

  it('refuses a nested acquisition synchronously instead of deadlocking', async (): Promise<void> => {
    const lease: AllDataClearLease = newLease();
    let nested: unknown = null;

    await lease.run(async (): Promise<void> => {
      nested = captured((): unknown => lease.run(async (): Promise<void> => undefined));
    });

    expect(nested).toBeInstanceOf(CoreError);
    expect((nested as CoreError).code).toBe('lease-order');
  });

  it('reports only the running operation token as current', async (): Promise<void> => {
    const lease: AllDataClearLease = newLease();

    const first: DataClearLeaseToken = await lease.run(
      async (token: DataClearLeaseToken): Promise<DataClearLeaseToken> => {
        expect(lease.isCurrent(token)).toBe(true);
        return token;
      },
    );

    expect(lease.isCurrent(first)).toBe(false);
    await lease.run(async (token: DataClearLeaseToken): Promise<void> => {
      expect(lease.isCurrent(token)).toBe(true);
      expect(lease.isCurrent(first)).toBe(false);
      expect(lease.isCurrent({ id: token.id })).toBe(false);
    });
  });

  it('reports the lease held from the acquisition call until the last operation settles', async (): Promise<void> => {
    const lease: AllDataClearLease = newLease();
    expect(lease.held()).toBe(false);

    const first: Promise<boolean> = lease.run(async (): Promise<boolean> => lease.held());
    const second: Promise<boolean> = lease.run(async (): Promise<boolean> => lease.held());
    expect(lease.held()).toBe(true);

    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(lease.held()).toBe(false);
  });

  it('releases the lease when an operation rejects', async (): Promise<void> => {
    const lease: AllDataClearLease = newLease();

    const failure: unknown = await settled(
      lease.run(async (): Promise<void> => {
        throw new Error('operation failed');
      }),
    );

    expect(failure).toBeInstanceOf(Error);
    expect(lease.held()).toBe(false);
    expect(await lease.run(async (): Promise<string> => 'ran')).toBe('ran');
  });

  it('refuses acquisition while an engine runtime lease is held', async (): Promise<void> => {
    let engineHeld: boolean = true;
    const lease: AllDataClearLease = newLease((): boolean => engineHeld);

    const refused: unknown = captured((): unknown =>
      lease.run(async (): Promise<void> => undefined),
    );

    expectCoreError(refused, 'lease-order');
    expect(lease.held()).toBe(false);

    engineHeld = false;
    expect(await lease.run(async (): Promise<string> => 'ran')).toBe('ran');
  });
});

describe('token-checked journal transactions', (): void => {
  it('refuses a second transaction while one is in flight under the same token', async (): Promise<void> => {
    const storage: StorageStub = stubStorage({ [LOCAL_DATA_CLEAR_JOURNAL]: seededJournal() });
    const lease: AllDataClearLease = newLease();

    const outcomes: PromiseSettledResult<DataClearJournal | null>[] = await lease.run(
      (token: DataClearLeaseToken): Promise<PromiseSettledResult<DataClearJournal | null>[]> =>
        Promise.allSettled([
          transactDataClearJournal(lease, token, setInventory(['policy'])),
          transactDataClearJournal(lease, token, appendIntent(intentRecord())),
        ]),
    );

    expect(
      outcomes.map(
        (outcome: PromiseSettledResult<DataClearJournal | null>): string => outcome.status,
      ),
    ).toEqual(['fulfilled', 'rejected']);
    expectCoreError(rejectionReason(outcomes[1]), 'lease-order');
    expect(storage.sets).toHaveLength(1);
    expect(storedJournal(storage).inventory).toEqual(['policy']);
    expect(storedJournal(storage).pendingInstallLifecycleIntents).toEqual([]);
  });

  it('allows sequential transactions under one token with a write between them', async (): Promise<void> => {
    const storage: StorageStub = stubStorage({ [LOCAL_DATA_CLEAR_JOURNAL]: seededJournal() });
    const lease: AllDataClearLease = newLease();
    const seen: (StoredJournal | null)[] = [];

    // The finalization replay shape: advance the journal, materialize the marker, then remove the
    // applied intent, all under one uninterrupted token.
    await lease.run(async (token: DataClearLeaseToken): Promise<void> => {
      await transactDataClearJournal(lease, token, appendIntent(intentRecord()));
      await chrome.storage.local.set({ installMarker: MARKER });
      await transactDataClearJournal(
        lease,
        token,
        recording(
          seen,
          (current: StoredJournal | null): DataClearJournal => ({
            ...allDataJournal(current),
            pendingInstallLifecycleIntents: [],
          }),
        ),
      );
    });

    expect((seen[0] as AllDataClearJournalV2).pendingInstallLifecycleIntents).toEqual([
      intentRecord(),
    ]);
    expect(storedJournal(storage).pendingInstallLifecycleIntents).toEqual([]);
    expect(
      storage.sets.map((items: Record<string, unknown>): string[] => Object.keys(items)),
    ).toEqual([[LOCAL_DATA_CLEAR_JOURNAL], ['installMarker'], [LOCAL_DATA_CLEAR_JOURNAL]]);
  });

  it('lets a new operation transact after an abandoned transaction under the previous token', async (): Promise<void> => {
    const storage: StorageStub = stubStorage({ [LOCAL_DATA_CLEAR_JOURNAL]: seededJournal() });
    const lease: AllDataClearLease = newLease();
    const gate: Gate = newGate();
    const abandoned: Promise<DataClearJournal | null>[] = [];
    storage.gate = gate.promise;

    await lease.run(async (token: DataClearLeaseToken): Promise<void> => {
      abandoned.push(transactDataClearJournal(lease, token, setInventory(['policy'])));
    });
    storage.gate = null;

    const written: DataClearJournal | null = await transact(lease, setInventory(['history']));

    expect(written).toEqual({ ...seededJournal(), inventory: ['history'] });
    expect(storedJournal(storage).inventory).toEqual(['history']);
    gate.open();
    expectCoreError(await settled(startedTransaction(abandoned)), 'lease-order');
  });

  it('refuses a write from a transaction that outlived its operation', async (): Promise<void> => {
    const storage: StorageStub = stubStorage({ [LOCAL_DATA_CLEAR_JOURNAL]: seededJournal() });
    const lease: AllDataClearLease = newLease();
    const gate: Gate = newGate();
    const outstanding: Promise<DataClearJournal | null>[] = [];
    storage.gate = gate.promise;

    await lease.run(async (token: DataClearLeaseToken): Promise<void> => {
      outstanding.push(transactDataClearJournal(lease, token, setInventory(['policy'])));
    });

    expect(lease.held()).toBe(false);
    gate.open();
    expectCoreError(await settled(startedTransaction(outstanding)), 'lease-order');
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.values[LOCAL_DATA_CLEAR_JOURNAL]).toEqual(seededJournal());
  });

  it('refuses a removal from a transaction that outlived its operation', async (): Promise<void> => {
    const storage: StorageStub = stubStorage({ [LOCAL_DATA_CLEAR_JOURNAL]: seededJournal() });
    const lease: AllDataClearLease = newLease();
    const gate: Gate = newGate();
    const outstanding: Promise<DataClearJournal | null>[] = [];
    storage.gate = gate.promise;

    await lease.run(async (token: DataClearLeaseToken): Promise<void> => {
      outstanding.push(transactDataClearJournal(lease, token, (): null => null));
    });

    gate.open();
    expectCoreError(await settled(startedTransaction(outstanding)), 'lease-order');
    expect(storage.remove).not.toHaveBeenCalled();
    expect(storage.values[LOCAL_DATA_CLEAR_JOURNAL]).toEqual(seededJournal());
  });

  it('writes one set and verifies the exact read-back', async (): Promise<void> => {
    const storage: StorageStub = stubStorage({ [LOCAL_DATA_CLEAR_JOURNAL]: seededJournal() });
    const lease: AllDataClearLease = newLease();

    const written: DataClearJournal | null = await transact(lease, setInventory(['policy']));

    expect(written).toEqual({ ...seededJournal(), inventory: ['policy'] });
    expect(storage.sets).toEqual([
      { [LOCAL_DATA_CLEAR_JOURNAL]: { ...seededJournal(), inventory: ['policy'] } },
    ]);
    expect(storage.remove).not.toHaveBeenCalled();
    expect(storedJournal(storage).inventory).toEqual(['policy']);
  });

  it('removes the journal for a null transform and verifies its absence', async (): Promise<void> => {
    const storage: StorageStub = stubStorage({ [LOCAL_DATA_CLEAR_JOURNAL]: seededJournal() });
    const lease: AllDataClearLease = newLease();

    const written: DataClearJournal | null = await transact(lease, (): null => null);

    expect(written).toBeNull();
    expect(storage.removes).toEqual([LOCAL_DATA_CLEAR_JOURNAL]);
    expect(storage.set).not.toHaveBeenCalled();
    expect(Object.hasOwn(storage.values, LOCAL_DATA_CLEAR_JOURNAL)).toBe(false);
  });

  it('writes nothing for an unchanged transform', async (): Promise<void> => {
    const storage: StorageStub = stubStorage({ [LOCAL_DATA_CLEAR_JOURNAL]: seededJournal() });
    const lease: AllDataClearLease = newLease();

    const written: DataClearJournal | null = await transact(lease, (): 'unchanged' => 'unchanged');

    expect(written).toEqual(seededJournal());
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('throws storage when the written journal reads back differently', async (): Promise<void> => {
    const storage: StorageStub = stubStorage({ [LOCAL_DATA_CLEAR_JOURNAL]: seededJournal() });
    const lease: AllDataClearLease = newLease();
    storage.writeMode = 'corrupt';

    await rejectedCoreError(transact(lease, setInventory(['policy'])), 'storage');

    expect(storage.sets).toHaveLength(1);
  });

  it('throws storage when a removed journal reads back present', async (): Promise<void> => {
    const storage: StorageStub = stubStorage({ [LOCAL_DATA_CLEAR_JOURNAL]: seededJournal() });
    const lease: AllDataClearLease = newLease();
    storage.writeMode = 'drop';

    await rejectedCoreError(
      transact(lease, (): null => null),
      'storage',
    );

    expect(storage.removes).toEqual([LOCAL_DATA_CLEAR_JOURNAL]);
  });

  it('throws before any read for a token from a completed operation', async (): Promise<void> => {
    const storage: StorageStub = stubStorage({ [LOCAL_DATA_CLEAR_JOURNAL]: seededJournal() });
    const lease: AllDataClearLease = newLease();
    const stale: DataClearLeaseToken = await lease.run(
      async (token: DataClearLeaseToken): Promise<DataClearLeaseToken> => token,
    );

    await rejectedCoreError(
      transactDataClearJournal(lease, stale, setInventory(['policy'])),
      'lease-order',
    );

    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.set).not.toHaveBeenCalled();
  });

  it('throws before any read for a token the running operation does not hold', async (): Promise<void> => {
    const storage: StorageStub = stubStorage({ [LOCAL_DATA_CLEAR_JOURNAL]: seededJournal() });
    const lease: AllDataClearLease = newLease();
    const other: AllDataClearLease = newLease();

    await lease.run(async (token: DataClearLeaseToken): Promise<void> => {
      await rejectedCoreError(
        transactDataClearJournal(lease, { id: token.id }, setInventory(['policy'])),
        'lease-order',
      );
      await rejectedCoreError(
        transactDataClearJournal(other, token, setInventory(['policy'])),
        'lease-order',
      );
    });

    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.set).not.toHaveBeenCalled();
  });

  it('keeps a remote inventory write and an intent append in either interleaving', async (): Promise<void> => {
    for (const intentFirst of [false, true]) {
      const storage: StorageStub = await interleavedWrites(intentFirst);
      const journal: AllDataClearJournalV2 = storedJournal(storage);

      expect(journal.inventory).toEqual(['policy']);
      expect(journal.pendingInstallLifecycleIntents).toEqual([intentRecord()]);
      vi.unstubAllGlobals();
    }
  });

  it('hands a stored legacy journal to the transform for upgrade', async (): Promise<void> => {
    const storage: StorageStub = stubStorage({ [LOCAL_DATA_CLEAR_JOURNAL]: { ...LEGACY_JOURNAL } });
    const lease: AllDataClearLease = newLease();
    const seen: (StoredJournal | null)[] = [];

    const written: DataClearJournal | null = await transact(
      lease,
      recording(
        seen,
        (current: StoredJournal | null): DataClearJournal =>
          upgradeLegacyAllDataClearJournal(
            current,
            { resetEpoch: RESET_EPOCH, resetOperationId: RESET_OPERATION },
            NOW,
          ),
      ),
    );

    expect(seen).toEqual([LEGACY_JOURNAL]);
    expect(written).toEqual({ ...seededJournal(), phase: 'local', inventory: ['policy'] });
    expect(storedJournal(storage).phase).toBe('local');
  });

  it('throws storage carrying the raw stored value when the journal fails parsing', async (): Promise<void> => {
    const raw: Record<string, unknown> = { scope: 'all', phase: 'nowhere', inventory: [] };
    const storage: StorageStub = stubStorage({ [LOCAL_DATA_CLEAR_JOURNAL]: raw });
    const lease: AllDataClearLease = newLease();
    let reached: boolean = false;

    const error: CoreError = await rejectedCoreError(
      transact(lease, (): 'unchanged' => {
        reached = true;
        return 'unchanged';
      }),
      'storage',
    );

    expect(error.cause).toBe(raw);
    expect(reached).toBe(false);
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('throws before writing when the transform returns an invalid journal', async (): Promise<void> => {
    const storage: StorageStub = stubStorage({ [LOCAL_DATA_CLEAR_JOURNAL]: seededJournal() });
    const lease: AllDataClearLease = newLease();

    await rejectedCoreError(
      transact(
        lease,
        (): DataClearJournal =>
          ({ ...seededJournal(), phase: 'nowhere' }) as unknown as DataClearJournal,
      ),
      'invalid-rule',
    );

    expect(storage.set).not.toHaveBeenCalled();
  });

  it('throws before writing when the transform returns a legacy journal', async (): Promise<void> => {
    const storage: StorageStub = stubStorage({ [LOCAL_DATA_CLEAR_JOURNAL]: seededJournal() });
    const lease: AllDataClearLease = newLease();

    await rejectedCoreError(
      transact(
        lease,
        (): DataClearJournal => ({ ...LEGACY_JOURNAL }) as unknown as DataClearJournal,
      ),
      'invalid-rule',
    );

    expect(storage.set).not.toHaveBeenCalled();
  });

  it('refuses to leave a stored legacy journal unchanged', async (): Promise<void> => {
    const storage: StorageStub = stubStorage({ [LOCAL_DATA_CLEAR_JOURNAL]: { ...LEGACY_JOURNAL } });
    const lease: AllDataClearLease = newLease();

    await rejectedCoreError(
      transact(lease, (): 'unchanged' => 'unchanged'),
      'invalid-rule',
    );

    expect(storage.set).not.toHaveBeenCalled();
  });

  it('leaves the stored journal intact when the write rejects and rereads it on the next run', async (): Promise<void> => {
    const storage: StorageStub = stubStorage({ [LOCAL_DATA_CLEAR_JOURNAL]: seededJournal() });
    const lease: AllDataClearLease = newLease();
    storage.writeMode = 'reject';

    const failure: unknown = await settled(transact(lease, setInventory(['policy'])));

    expect(failure).toBeInstanceOf(Error);
    expect(storage.values[LOCAL_DATA_CLEAR_JOURNAL]).toEqual(seededJournal());

    storage.writeMode = 'store';
    const seen: (StoredJournal | null)[] = [];
    await transact(
      lease,
      recording(seen, (): 'unchanged' => 'unchanged'),
    );

    expect(seen).toEqual([seededJournal()]);
  });
});

describe('deletion lease order', (): void => {
  it('throws lease-order when an engine runtime lease is already held', (): void => {
    const error: unknown = captured((): void => assertNoEngineRuntimeLease((): boolean => true));

    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).code).toBe('lease-order');
  });

  it('reports a throwing engine-lease predicate as a lock-order failure', async (): Promise<void> => {
    const boom: ReferenceError = new ReferenceError('Cannot access engine before initialization');
    const lease: AllDataClearLease = newLease((): boolean => {
      throw boom;
    });

    const refused: unknown = captured((): unknown =>
      lease.run(async (): Promise<void> => undefined),
    );

    expectCoreError(refused, 'lease-order');
    expect((refused as CoreError).cause).toBe(boom);
    expect(lease.held()).toBe(false);
    expect(
      captured((): void =>
        assertNoEngineRuntimeLease((): boolean => {
          throw boom;
        }),
      ),
    ).toBeInstanceOf(CoreError);
  });

  it('returns when no engine runtime lease is held', (): void => {
    expect(captured((): void => assertNoEngineRuntimeLease((): boolean => false))).toBeNull();
  });
});

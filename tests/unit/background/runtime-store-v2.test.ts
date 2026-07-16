import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  classifyStoredRuntime,
  emptyRuntimeV2,
  isRuntimeSchemaMarkerV2,
  loadRuntimeAuthority,
  type RuntimeSchemaMarkerV2,
  readRuntimeSchemaMarker,
  type StoredRuntimeAuthority,
  saveRuntimeV2,
} from '../../../src/background/runtime-store-v2';
import type { RuntimeStateV2 } from '../../../src/background/runtime-v2-types';
import { parseRuntimeStateV2 } from '../../../src/background/runtime-v2-validation';
import {
  emptyRuntime,
  type LegacyRuntimeStateV1,
  loadRuntime,
} from '../../../src/background/stores';
import { CoreError } from '../../../src/shared/errors';
import {
  LOCAL_POLICY_COMMIT,
  LOCAL_POLICY_GENERATION_PREFIX,
  LOCAL_RUNTIME,
  LOCAL_RUNTIME_SCHEMA,
} from '../../../src/shared/storage-keys';
import { localDateStr } from '../../../src/shared/time';
import { commitCheckpointRuntime, EPOCH_ID, publishedFocusRuntime } from './runtime-v2-fixtures';

const NOW: number = new Date(2026, 8, 2, 9, 0, 0, 0).getTime();
const GENERATION_ID: string = 'generation-one';
const GENERATION_REVISION: string = 'revision-one';
const GENERATION_KEY: string = `${LOCAL_POLICY_GENERATION_PREFIX}${GENERATION_ID}`;
const GENERATION_MISSING: string = 'committed runtime generation is missing or invalid';
const MARKER: RuntimeSchemaMarkerV2 = { runtimeSchemaVersion: 2 };
/** The keys a v1 runtime never carries, so their presence rules out an unversioned v1 shape. */
const V2_ONLY_KEYS: readonly string[] = [
  'enforcementEpoch',
  'epochResetAcks',
  'basePolicyRevision',
  'runtimeRevision',
  'documentCommands',
  'enforcementCheckpoint',
  'pendingEnforcementTransition',
  'pendingClosure',
  'handledScheduleOccurrences',
];

interface StorageStub {
  values: Record<string, unknown>;
  localSets: Record<string, unknown>[];
  syncSet: Mock<(items: Record<string, unknown>) => Promise<void>>;
}

function stubStorage(initial: Record<string, unknown> = {}): StorageStub {
  const values: Record<string, unknown> = { ...initial };
  const localSets: Record<string, unknown>[] = [];
  const syncSet: Mock<(items: Record<string, unknown>) => Promise<void>> = vi.fn();
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(
          async (key: string): Promise<Record<string, unknown>> =>
            Object.hasOwn(values, key) ? { [key]: values[key] } : {},
        ),
        set: vi.fn(async (items: Record<string, unknown>): Promise<void> => {
          localSets.push(items);
          Object.assign(values, items);
        }),
      },
      sync: {
        get: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
        set: syncSet,
      },
    },
  });
  return { values, localSets, syncSet };
}

function legacyRuntime(): LegacyRuntimeStateV1 {
  return emptyRuntime(NOW);
}

function accessorRuntime(): unknown {
  const value: Record<string, unknown> = {};
  Object.defineProperty(value, 'runtimeSchemaVersion', {
    get: (): number => 2,
    enumerable: true,
    configurable: true,
  });
  return value;
}

function sparseUnlocksRuntime(): unknown {
  const unlocks: unknown[] = [];
  unlocks[1] = { host: 'example.com', until: NOW };
  return { ...legacyRuntime(), unlocks };
}

function symbolKeyedRuntime(): unknown {
  const value: Record<string | symbol, unknown> = { ...legacyRuntime() };
  value[Symbol('stowaway')] = true;
  return value;
}

function cyclicRuntime(): unknown {
  const value: Record<string, unknown> = { ...legacyRuntime() };
  value.self = value;
  return value;
}

function throwingProxyRuntime(): unknown {
  return new Proxy(
    { runtimeSchemaVersion: 2 },
    {
      get(): never {
        throw new Error('hostile runtime read');
      },
    },
  );
}

afterEach((): void => {
  vi.unstubAllGlobals();
});

describe('empty v2 runtime', (): void => {
  it('builds an idle runtime whose collections are present and empty', (): void => {
    const runtime: RuntimeStateV2 = emptyRuntimeV2(NOW, EPOCH_ID);

    expect(runtime).toEqual({
      runtimeSchemaVersion: 2,
      session: null,
      gate: null,
      unlocks: [],
      tabStates: {},
      accruedFocusMs: 0,
      attemptDebounce: {},
      deferredBlockClaims: {},
      removedTabTombstones: {},
      scheduleUnavailableNoticeToken: null,
      handledScheduleOccurrences: [],
      enforcementEpoch: EPOCH_ID,
      epochResetAcks: {},
      basePolicyRevision: 0,
      runtimeRevision: 0,
      documentCommands: {},
      enforcementCheckpoint: null,
      pendingEnforcementTransition: null,
      pendingClosure: null,
      date: localDateStr(NOW),
      todayAgg: null,
      lastPruneDate: null,
      commitCheckpoint: null,
    });
  });

  it('passes the stored runtime parser unchanged', (): void => {
    const runtime: RuntimeStateV2 = emptyRuntimeV2(NOW, EPOCH_ID);

    expect(parseRuntimeStateV2(runtime)).toEqual(runtime);
  });

  it('detaches each call from the last', (): void => {
    const first: RuntimeStateV2 = emptyRuntimeV2(NOW, EPOCH_ID);
    first.unlocks.push({ host: 'example.com', until: NOW });

    expect(emptyRuntimeV2(NOW, EPOCH_ID).unlocks).toEqual([]);
  });
});

describe('empty v2 runtime arguments', (): void => {
  it('refuses an instant that cannot become a local date', (): void => {
    // `now` reaches storage as the date watermark, so an unsafe instant would only be caught by
    // the parser on the next boot, with nothing left to say which argument was wrong.
    for (const instant of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      expect((): RuntimeStateV2 => emptyRuntimeV2(instant, EPOCH_ID)).toThrow(CoreError);
    }
    expect(emptyRuntimeV2(NOW, EPOCH_ID).date).toBe(localDateStr(NOW));
  });
});

describe('stored runtime classification', (): void => {
  it.each<[string, RuntimeSchemaMarkerV2 | null]>([
    ['without a marker', null],
    ['with a marker', MARKER],
  ])(
    'reports an unwritten runtime as absent %s',
    (_label: string, marker: RuntimeSchemaMarkerV2 | null): void => {
      expect(classifyStoredRuntime(undefined, marker)).toEqual({ kind: 'absent' });
    },
  );

  it.each<[string, RuntimeSchemaMarkerV2 | null]>([
    ['without a marker', null],
    ['with a marker', MARKER],
  ])(
    'accepts a valid stored v2 runtime %s',
    (_label: string, marker: RuntimeSchemaMarkerV2 | null): void => {
      const runtime: RuntimeStateV2 = publishedFocusRuntime();

      expect(classifyStoredRuntime(runtime, marker)).toEqual({ kind: 'v2', runtime });
    },
  );

  it('keeps a stored v2 runtime that still owes its checkpoint replay', (): void => {
    const runtime: RuntimeStateV2 = commitCheckpointRuntime();
    const authority: StoredRuntimeAuthority = classifyStoredRuntime(runtime, MARKER);

    expect(authority).toEqual({ kind: 'v2', runtime });
    expect(authority.kind === 'v2' ? authority.runtime.commitCheckpoint : null).not.toBeNull();
  });

  it('hands an unversioned v1 runtime to migration by reference', (): void => {
    const raw: LegacyRuntimeStateV1 = legacyRuntime();
    const authority: StoredRuntimeAuthority = classifyStoredRuntime(raw, null);

    expect(authority).toEqual({ kind: 'legacy', raw, staleMarker: false });
    expect(authority.kind === 'legacy' ? authority.raw : null).toBe(raw);
  });

  it.each<string>([...V2_ONLY_KEYS])(
    'rejects an unversioned runtime carrying the v2-only key %s',
    (key: string): void => {
      const raw: Record<string, unknown> = { ...legacyRuntime(), [key]: null };

      expect(classifyStoredRuntime(raw, null)).toEqual({
        kind: 'rejected',
        reason: 'invalid-v2',
        raw,
      });
    },
  );

  // A marker over an unversioned v1 value is what a downgrade to a v1 build followed by an upgrade
  // leaves behind. The value is still the person's runtime, so it migrates, and the stale marker
  // is reported alongside so the caller can tell this case from a first migration.
  it('hands an unversioned v1 runtime to migration under a stale schema marker', (): void => {
    const raw: LegacyRuntimeStateV1 = legacyRuntime();
    const authority: StoredRuntimeAuthority = classifyStoredRuntime(raw, MARKER);

    expect(authority).toEqual({ kind: 'legacy', raw, staleMarker: true });
    expect(authority.kind === 'legacy' ? authority.raw : null).toBe(raw);
  });

  it('hands a v1 subset that omits later v1 keys to migration', (): void => {
    // Rick's 7 September profile carried the eleven-key v1 shape, without the tab claim maps the
    // last v1 builds added, and the v1 reader fills those in itself.
    const raw: Record<string, unknown> = {
      session: null,
      gate: null,
      unlocks: [],
      tabStates: {},
      accruedFocusMs: 0,
      attemptDebounce: {},
      scheduleActiveEntryId: null,
      date: '2026-09-09',
      todayAgg: null,
      lastPruneDate: '2026-09-07',
      commitCheckpoint: null,
    };

    expect(classifyStoredRuntime(raw, MARKER)).toEqual({ kind: 'legacy', raw, staleMarker: true });
  });

  it.each<[string, unknown]>([
    ['a record with a key no v1 runtime carried', { session: null, date: '2026-09-09', bogus: 1 }],
    ['a bare string', 'text'],
  ])('rejects %s under the marker as neither v1 nor v2', (_label: string, raw: unknown): void => {
    expect(classifyStoredRuntime(raw, MARKER)).toEqual({
      kind: 'rejected',
      reason: 'marker-without-v2',
      raw,
    });
  });

  it.each<[string, unknown]>([
    ['a record with a key no v1 runtime carried', { session: null, date: '2026-09-09', bogus: 1 }],
    ['a bare string', 'text'],
  ])('rejects %s without a marker as invalid', (_label: string, raw: unknown): void => {
    expect(classifyStoredRuntime(raw, null)).toEqual({
      kind: 'rejected',
      reason: 'invalid-v2',
      raw,
    });
  });

  it.each<[string, RuntimeSchemaMarkerV2 | null]>([
    ['without a marker', null],
    ['with a marker', MARKER],
  ])(
    'rejects a declared v2 runtime the parser refuses %s',
    (_label: string, marker: RuntimeSchemaMarkerV2 | null): void => {
      const raw: RuntimeStateV2 = { ...emptyRuntimeV2(NOW, EPOCH_ID), runtimeRevision: -1 };

      expect(classifyStoredRuntime(raw, marker)).toEqual({
        kind: 'rejected',
        reason: 'invalid-v2',
        raw,
      });
    },
  );

  it.each<[string, unknown]>([
    ['a proxy whose get trap throws', throwingProxyRuntime()],
    ['a runtimeSchemaVersion accessor', accessorRuntime()],
    ['a sparse unlocks array', sparseUnlocksRuntime()],
    ['a symbol-keyed record', symbolKeyedRuntime()],
    ['a cyclic graph', cyclicRuntime()],
  ])('classifies %s without throwing and never as v2', (_label: string, raw: unknown): void => {
    const authority: StoredRuntimeAuthority = classifyStoredRuntime(raw, null);

    // The refused value is carried by identity, not compared field by field: it is exactly the
    // hostile graph the boot reader must be able to report without traversing it.
    expect(authority.kind).toBe('rejected');
    expect(authority.kind === 'rejected' ? authority.reason : null).toBe('invalid-v2');
    expect(authority.kind === 'rejected' ? authority.raw : null).toBe(raw);
  });
});

describe('runtime schema marker', (): void => {
  it('accepts only the exact version 2 marker', (): void => {
    expect(isRuntimeSchemaMarkerV2({ runtimeSchemaVersion: 2 })).toBe(true);
  });

  it.each<[string, unknown]>([
    ['an absent value', undefined],
    ['null', null],
    ['a bare number', 2],
    ['an older version', { runtimeSchemaVersion: 1 }],
    ['a future version', { runtimeSchemaVersion: 3 }],
    ['a marker with an extra key', { runtimeSchemaVersion: 2, migrated: true }],
    ['an accessor marker', accessorRuntime()],
    ['a hostile proxy', throwingProxyRuntime()],
  ])('refuses %s', (_label: string, value: unknown): void => {
    expect(isRuntimeSchemaMarkerV2(value)).toBe(false);
  });

  // Nothing here writes the marker. One local set stores it beside its migration checkpoint, and
  // that combined write belongs to the migration boot reader, not to this store.
  it('reads back a stored marker without writing anything', async (): Promise<void> => {
    const stub: StorageStub = stubStorage({
      [LOCAL_RUNTIME_SCHEMA]: { runtimeSchemaVersion: 2 },
    });

    await expect(readRuntimeSchemaMarker()).resolves.toEqual(MARKER);
    expect(stub.localSets).toEqual([]);
    expect(stub.syncSet).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>]>([
    ['absent', {}],
    ['hostile', { [LOCAL_RUNTIME_SCHEMA]: { runtimeSchemaVersion: [2] } }],
    ['a wrong version', { [LOCAL_RUNTIME_SCHEMA]: { runtimeSchemaVersion: 1 } }],
  ])(
    'reads %s stored marker values as null',
    async (_label: string, stored: Record<string, unknown>): Promise<void> => {
      stubStorage(stored);

      await expect(readRuntimeSchemaMarker()).resolves.toBeNull();
    },
  );
});

describe('runtime authority loading', (): void => {
  it('reads the runtime key when no generation pointer is committed', async (): Promise<void> => {
    const runtime: RuntimeStateV2 = publishedFocusRuntime();
    stubStorage({ [LOCAL_RUNTIME]: runtime });

    await expect(loadRuntimeAuthority()).resolves.toEqual({ kind: 'v2', runtime });
  });

  it('reads the runtime through the committed generation pointer', async (): Promise<void> => {
    const runtime: RuntimeStateV2 = publishedFocusRuntime();
    stubStorage({
      [LOCAL_POLICY_COMMIT]: {
        source: 'generation',
        id: GENERATION_ID,
        revision: GENERATION_REVISION,
      },
      [GENERATION_KEY]: { id: GENERATION_ID, revision: GENERATION_REVISION, runtime },
      [LOCAL_RUNTIME]: legacyRuntime(),
    });

    await expect(loadRuntimeAuthority()).resolves.toEqual({ kind: 'v2', runtime });
  });

  // The generation-resolved value is classified exactly like the direct one, so a v1 shape inside
  // a committed generation migrates under a stale marker rather than being replaced.
  it('hands the generation-resolved v1 value to migration under a stale marker', async (): Promise<void> => {
    stubStorage({
      [LOCAL_POLICY_COMMIT]: {
        source: 'generation',
        id: GENERATION_ID,
        revision: GENERATION_REVISION,
      },
      [GENERATION_KEY]: {
        id: GENERATION_ID,
        revision: GENERATION_REVISION,
        runtime: legacyRuntime(),
      },
      [LOCAL_RUNTIME_SCHEMA]: { runtimeSchemaVersion: 2 },
    });

    await expect(loadRuntimeAuthority()).resolves.toEqual({
      kind: 'legacy',
      raw: legacyRuntime(),
      staleMarker: true,
    });
  });

  it('reports an absent runtime when a partial removal left the marker behind', async (): Promise<void> => {
    stubStorage({ [LOCAL_RUNTIME_SCHEMA]: { runtimeSchemaVersion: 2 } });

    await expect(loadRuntimeAuthority()).resolves.toEqual({ kind: 'absent' });
  });

  it.each<[string, Record<string, unknown>]>([
    ['a missing generation', {}],
    [
      'a mismatched generation',
      { id: GENERATION_ID, revision: 'revision-two', runtime: publishedFocusRuntime() },
    ],
  ])(
    'throws the loadRuntime error text for %s',
    async (_label: string, generation: Record<string, unknown>): Promise<void> => {
      const stored: Record<string, unknown> = {
        [LOCAL_POLICY_COMMIT]: {
          source: 'generation',
          id: GENERATION_ID,
          revision: GENERATION_REVISION,
        },
        ...(Object.keys(generation).length === 0 ? {} : { [GENERATION_KEY]: generation }),
      };
      stubStorage(stored);

      await expect(loadRuntimeAuthority()).rejects.toThrow(GENERATION_MISSING);
      await expect(loadRuntime(NOW)).rejects.toThrow(GENERATION_MISSING);
    },
  );
});

describe('validated v2 runtime save', (): void => {
  it('writes the runtime once through local storage only', async (): Promise<void> => {
    const runtime: RuntimeStateV2 = publishedFocusRuntime();
    const stub: StorageStub = stubStorage();

    await saveRuntimeV2(runtime);

    expect(stub.localSets).toEqual([{ [LOCAL_RUNTIME]: runtime }]);
    expect(stub.syncSet).not.toHaveBeenCalled();
  });

  it('refuses to write a runtime the parser rejects', async (): Promise<void> => {
    const runtime: RuntimeStateV2 = { ...emptyRuntimeV2(NOW, EPOCH_ID), runtimeRevision: -1 };
    const stub: StorageStub = stubStorage();

    await expect(saveRuntimeV2(runtime)).rejects.toThrowError(
      expect.objectContaining({ code: 'invalid-rule' }),
    );
    await expect(saveRuntimeV2(runtime)).rejects.toBeInstanceOf(CoreError);
    expect(stub.localSets).toEqual([]);
    expect(stub.values[LOCAL_RUNTIME]).toBeUndefined();
  });

  it('persists a copy detached from the caller', async (): Promise<void> => {
    const runtime: RuntimeStateV2 = emptyRuntimeV2(NOW, EPOCH_ID);
    const stub: StorageStub = stubStorage();

    await saveRuntimeV2(runtime);
    runtime.runtimeRevision = 99;
    runtime.unlocks.push({ host: 'example.com', until: NOW });

    expect(stub.values[LOCAL_RUNTIME]).toEqual(emptyRuntimeV2(NOW, EPOCH_ID));
  });
});

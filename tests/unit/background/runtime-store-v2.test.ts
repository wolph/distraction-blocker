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
import {
  PREVIOUS_V2_ALLOWED_DOCUMENT_ID,
  PREVIOUS_V2_ALLOWED_TAB_ID,
  PREVIOUS_V2_ALLOWED_URL,
  PREVIOUS_V2_BLOCKED_DOCUMENT_ID,
  PREVIOUS_V2_BLOCKED_TAB_ID,
  PREVIOUS_V2_TAB_COUNT,
  previousActiveRuntimeProfileV2,
  previousIdleRuntimeProfileV2,
  previousV2ClearCommand,
  previousV2DocumentKey,
  previousV2EpochResetAck,
} from '../../fixtures/previous-v2-runtime-profile';
import {
  activeCommand,
  allowedVerdict,
  cleanupClosureRuntime,
  cleanupTransition,
  commitCheckpointRuntime,
  documentKey,
  EPOCH_ID,
  epochResetAck,
  epochResetAckMap,
  OTHER_EPOCH_ID,
  pendingTransition,
  publishedFocusRuntime,
  SECOND_TARGET_URL,
  startingCommand,
  transitionRuntime,
} from './runtime-v2-fixtures';

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
    // The 7 September profile carried the eleven-key v1 shape, without the tab claim maps the
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

  it('hands a v1 record that still carries the retired tab keys to migration', (): void => {
    // The builds before 9053e74 (2026-08-29) stored `stoppedTabIds` and `mutedTabs` at the top
    // level. The v1 reader ignores both, so a runtime last written by one of them migrates rather
    // than being refused for a key the current v1 shape no longer has.
    const raw: Record<string, unknown> = {
      ...legacyRuntime(),
      stoppedTabIds: [11],
      mutedTabs: { 11: true },
    };

    expect(classifyStoredRuntime(raw, null)).toEqual({ kind: 'legacy', raw, staleMarker: false });
    expect(classifyStoredRuntime(raw, MARKER)).toEqual({ kind: 'legacy', raw, staleMarker: true });
  });

  // This guards the inverse of the change: a v1 key list that admitted a foreign key would fail
  // it. It was green before the change too, because the old classifier refused everything under
  // a marker, so it is not evidence that the change happened.
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

/**
 * The shape the build before address-free records stored, modelled on a real profile. Every reader
 * of the runtime is strict, so the storage boundary normalises this one shape on the way in and
 * the boot reader persists the result once. Nothing written is ever in the previous shape again.
 */
describe('stored runtime in the previous v2 shape', (): void => {
  /** A prepared start whose allowed page sits in the view under the old presentation. */
  function preparedWithAllowed(): RuntimeStateV2 {
    const prepared: RuntimeStateV2 = transitionRuntime(pendingTransition('start', 'prepared'));
    const transition = prepared.pendingEnforcementTransition;
    if (transition === null) throw new Error('expected a prepared transition');
    const allowedKey: string = documentKey(12, 'document-2');
    const oldAllowed = startingCommand({
      tabId: 12,
      documentId: 'document-2',
      expectedUrl: SECOND_TARGET_URL,
      operationId: transition.startingOperationId,
      runtimeRevision: transition.startingView.runtimeRevision,
      verdict: allowedVerdict(),
      overlay: null,
    });
    return {
      ...prepared,
      pendingEnforcementTransition: {
        ...transition,
        startingView: {
          ...transition.startingView,
          documents: { ...transition.startingView.documents, [allowedKey]: oldAllowed },
        },
      },
      documentCommands: { ...prepared.documentCommands, [allowedKey]: oldAllowed },
    };
  }

  it('reads an idle profile with no address and no commands', (): void => {
    const raw: unknown = previousIdleRuntimeProfileV2();
    const authority: StoredRuntimeAuthority = classifyStoredRuntime(raw, MARKER);

    expect(authority.kind).toBe('previous-v2');
    if (authority.kind !== 'previous-v2') throw new Error('expected the previous shape');
    const runtime: RuntimeStateV2 = authority.runtime;
    expect(parseRuntimeStateV2(runtime)).toEqual(runtime);
    // Every acknowledgement stays, as the record of the epoch its document holds, and no record
    // carries the address it was earned on.
    expect(Object.keys(runtime.epochResetAcks)).toHaveLength(PREVIOUS_V2_TAB_COUNT);
    for (const [key, record] of Object.entries(runtime.epochResetAcks)) {
      const index: number = Number(key.split(':')[0]) - 100;
      const { url: _url, ...expected } = previousV2EpochResetAck(index);
      expect(record).toEqual(expected);
      expect(record).not.toHaveProperty('url');
    }
    // An idle runtime holds no commands. The batch was the last cleanup's and has done its work.
    expect(runtime.documentCommands).toEqual({});
    expect(runtime.session).toBeNull();
    expect(runtime.todayAgg).toEqual(previousIdleRuntimeProfileV2().todayAgg);
    expect(runtime.runtimeRevision).toBe(previousIdleRuntimeProfileV2().runtimeRevision);
    expect(runtime.basePolicyRevision).toBe(previousIdleRuntimeProfileV2().basePolicyRevision);
    expect(runtime.enforcementEpoch).toBe(previousIdleRuntimeProfileV2().enforcementEpoch);
  });

  it('reads a mid-session profile with its session and its blocked entry alone', (): void => {
    const raw: unknown = previousActiveRuntimeProfileV2();
    const authority: StoredRuntimeAuthority = classifyStoredRuntime(raw, MARKER);

    expect(authority.kind).toBe('previous-v2');
    if (authority.kind !== 'previous-v2') throw new Error('expected the previous shape');
    const runtime: RuntimeStateV2 = authority.runtime;
    expect(parseRuntimeStateV2(runtime)).toEqual(runtime);
    expect(runtime.session).toEqual(previousActiveRuntimeProfileV2().session);
    // The audit's records lose their address the way the acknowledgements do, and nothing else.
    const previousCheckpoint = previousActiveRuntimeProfileV2().enforcementCheckpoint;
    expect(runtime.enforcementCheckpoint).toEqual({
      ...previousCheckpoint,
      documents: previousCheckpoint?.documents.map(({ url: _url, ...record }) => record),
    });
    expect(JSON.stringify(runtime)).not.toContain(PREVIOUS_V2_ALLOWED_URL);
    // The blocked page keeps its command, the allowed page under the old active shape loses it,
    // which is what a session persists now.
    expect(Object.keys(runtime.documentCommands)).toEqual([
      documentKey(PREVIOUS_V2_BLOCKED_TAB_ID, PREVIOUS_V2_BLOCKED_DOCUMENT_ID),
    ]);
    expect(runtime.documentCommands[documentKey(11, PREVIOUS_V2_BLOCKED_DOCUMENT_ID)]).toEqual(
      previousActiveRuntimeProfileV2().documentCommands[documentKey(11, 'document-1')],
    );
    for (const record of Object.values(runtime.epochResetAcks)) {
      expect(record).not.toHaveProperty('url');
    }
    expect(Object.keys(runtime.epochResetAcks).sort()).toEqual([
      documentKey(PREVIOUS_V2_BLOCKED_TAB_ID, PREVIOUS_V2_BLOCKED_DOCUMENT_ID),
      documentKey(PREVIOUS_V2_ALLOWED_TAB_ID, PREVIOUS_V2_ALLOWED_DOCUMENT_ID),
    ]);
  });

  it('leaves a cleanup batch exactly as its journal froze it', (): void => {
    // A cleanup journal owns the map and the parser requires the two to be equal, so only the
    // acknowledgements are normalised under one.
    const closing: RuntimeStateV2 = cleanupClosureRuntime({ epochResetAcks: epochResetAckMap() });
    const raw: unknown = {
      ...closing,
      epochResetAcks: {
        [documentKey(11, 'document-1')]: { ...epochResetAck(), url: 'https://example.com/path' },
      },
    };
    const authority: StoredRuntimeAuthority = classifyStoredRuntime(raw, MARKER);

    expect(authority.kind).toBe('previous-v2');
    if (authority.kind !== 'previous-v2') throw new Error('expected the previous shape');
    expect(authority.runtime.documentCommands).toEqual(closing.documentCommands);
    expect(authority.runtime.pendingClosure).toEqual(closing.pendingClosure);
    expect(authority.runtime.epochResetAcks).toEqual(epochResetAckMap());
  });

  it('reads a transition view with each allowed page as the canonical clear', (): void => {
    // The previous build froze an allowed page under the view's own presentation. The view
    // validator now requires the clear, so the entry is read as the clear the runner would freeze
    // today, in the view and in the map that mirrors it.
    const prepared: RuntimeStateV2 = transitionRuntime(pendingTransition('start', 'prepared'));
    const transition = prepared.pendingEnforcementTransition;
    if (transition === null) throw new Error('expected a prepared transition');
    const allowedKey: string = documentKey(12, 'document-2');
    const oldAllowed = startingCommand({
      tabId: 12,
      documentId: 'document-2',
      expectedUrl: SECOND_TARGET_URL,
      operationId: transition.startingOperationId,
      runtimeRevision: transition.startingView.runtimeRevision,
      verdict: allowedVerdict(),
      overlay: null,
    });
    const raw: unknown = {
      ...prepared,
      pendingEnforcementTransition: {
        ...transition,
        startingView: {
          ...transition.startingView,
          documents: { ...transition.startingView.documents, [allowedKey]: oldAllowed },
        },
      },
      documentCommands: { ...prepared.documentCommands, [allowedKey]: oldAllowed },
    };
    expect(parseRuntimeStateV2(raw)).toBeNull();

    const authority: StoredRuntimeAuthority = classifyStoredRuntime(raw, MARKER);

    expect(authority.kind).toBe('previous-v2');
    if (authority.kind !== 'previous-v2') throw new Error('expected the previous shape');
    const read = authority.runtime.pendingEnforcementTransition?.startingView.documents[allowedKey];
    expect(read?.presentation).toBe('clear');
    expect(read?.verdict).toEqual({
      blocked: false,
      reason: 'no-session',
      categoryId: null,
      matchedPattern: null,
    });
    expect(read?.overlay).toBeNull();
    expect(read?.runtimeRevision).toBe(oldAllowed.runtimeRevision);
    expect(authority.runtime.documentCommands[allowedKey]).toEqual(read);
    expect(authority.runtime.documentCommands[documentKey(11, 'document-1')]).toEqual(
      prepared.documentCommands[documentKey(11, 'document-1')],
    );
  });

  it('reads a cleanup-stage transition view with its allowed page as the canonical clear too', (): void => {
    // The validator checks the starting view at every stage, cleanup included, so a previous-shape
    // runtime stored inside a start-abandon cleanup reads its view rewritten while the batch it
    // owns, and the map that equals it, stay exactly as frozen.
    const cleaning: RuntimeStateV2 = transitionRuntime(
      cleanupTransition('start', 'prepared', 'start-abandon'),
    );
    const transition = cleaning.pendingEnforcementTransition;
    if (transition === null) throw new Error('expected a cleanup transition');
    const allowedKey: string = documentKey(12, 'document-2');
    const oldAllowed = startingCommand({
      tabId: 12,
      documentId: 'document-2',
      expectedUrl: SECOND_TARGET_URL,
      operationId: transition.startingOperationId,
      runtimeRevision: transition.startingView.runtimeRevision,
      verdict: allowedVerdict(),
      overlay: null,
    });
    const raw: unknown = {
      ...cleaning,
      pendingEnforcementTransition: {
        ...transition,
        startingView: {
          ...transition.startingView,
          documents: { ...transition.startingView.documents, [allowedKey]: oldAllowed },
        },
      },
    };
    expect(parseRuntimeStateV2(raw)).toBeNull();

    const authority: StoredRuntimeAuthority = classifyStoredRuntime(raw, MARKER);

    expect(authority.kind).toBe('previous-v2');
    if (authority.kind !== 'previous-v2') throw new Error('expected the previous shape');
    const read = authority.runtime.pendingEnforcementTransition?.startingView.documents[allowedKey];
    expect(read?.presentation).toBe('clear');
    expect(authority.runtime.documentCommands).toEqual(cleaning.documentCommands);
    expect(authority.runtime.pendingEnforcementTransition?.cleanupProgress).toEqual(
      transition.cleanupProgress,
    );
  });

  it('keeps a runtime already in the current shape as plain v2 authority', (): void => {
    const runtime: RuntimeStateV2 = publishedFocusRuntime();

    expect(classifyStoredRuntime(runtime, MARKER)).toEqual({ kind: 'v2', runtime });
  });

  it('still refuses a value the normalised shape cannot make valid', (): void => {
    const broken: unknown = { ...previousIdleRuntimeProfileV2(), session: 'broken' };
    const hostile: unknown = {
      ...previousIdleRuntimeProfileV2(),
      epochResetAcks: { [previousV2DocumentKey(0)]: { ...previousV2EpochResetAck(0), tabId: -1 } },
    };

    expect(classifyStoredRuntime(broken, MARKER).kind).toBe('rejected');
    expect(classifyStoredRuntime(hostile, MARKER).kind).toBe('rejected');
    // The reader drops or rewrites only an entry the strict parser would accept on its own, so a
    // corrupt map cannot be turned into a valid one on the way in. Each of these is refused by the
    // strict parser as stored, and stays refused.
    const idle = previousIdleRuntimeProfileV2({ count: 1 });
    const junkEntries: unknown = {
      ...idle,
      documentCommands: { junk: 1, other: { verdict: 'x' } },
    };
    const otherEpochEntry: unknown = {
      ...idle,
      documentCommands: {
        [previousV2DocumentKey(0)]: {
          ...previousV2ClearCommand(0),
          enforcementEpoch: OTHER_EPOCH_ID,
        },
      },
    };
    const withAllowed: RuntimeStateV2 = preparedWithAllowed();
    const view = withAllowed.pendingEnforcementTransition?.startingView;
    const garbageAllowed: unknown = {
      ...withAllowed,
      pendingEnforcementTransition: {
        ...withAllowed.pendingEnforcementTransition,
        startingView: {
          ...view,
          documents: {
            ...view?.documents,
            [documentKey(12, 'document-2')]: {
              ...view?.documents[documentKey(12, 'document-2')],
              presentation: 'garbage',
              verdict: { blocked: false },
              overlay: { anything: true },
            },
          },
        },
      },
    };
    const numericUrl: unknown = {
      ...idle,
      epochResetAcks: {
        [previousV2DocumentKey(0)]: { ...previousV2EpochResetAck(0), url: 123 },
      },
    };
    for (const value of [junkEntries, otherEpochEntry, garbageAllowed, numericUrl]) {
      expect(parseRuntimeStateV2(value)).toBeNull();
      expect(classifyStoredRuntime(value, MARKER).kind).toBe('rejected');
    }
    // An active command for an allowed page outside any view is dropped, never rewritten, so a
    // session runtime whose only entry is allowed reads as an empty map.
    const allowedOnly: unknown = {
      ...previousActiveRuntimeProfileV2(),
      documentCommands: {
        [documentKey(12, 'document-2')]: activeCommand({
          tabId: 12,
          documentId: 'document-2',
          expectedUrl: SECOND_TARGET_URL,
          verdict: allowedVerdict(),
          overlay: null,
        }),
      },
    };
    const authority: StoredRuntimeAuthority = classifyStoredRuntime(allowedOnly, MARKER);
    expect(authority.kind === 'previous-v2' ? authority.runtime.documentCommands : null).toEqual(
      {},
    );
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

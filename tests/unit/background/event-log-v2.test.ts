import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  appendEventsV2,
  eventIdentityKeyV2,
  mergeEventLogV2,
  parseStoredEventLogV2,
  readEventsV2,
} from '../../../src/background/event-log-v2';
import { EVENT_LOG_CAP } from '../../../src/shared/constants';
import { LOCAL_EVENTS } from '../../../src/shared/storage-keys';
import type {
  LegacyEventRecord,
  SessionEventRecordV2,
  SessionStartedEventV2,
} from '../../../src/shared/types';
import { budgetEarnedEvent, NOW, SESSION_ID, sessionEndedEvent } from './runtime-v2-fixtures';

type StorageGet = (key: string) => Promise<Record<string, unknown>>;
type StorageSet = (items: Record<string, unknown>) => Promise<void>;

interface StorageFake {
  state: Record<string, unknown>;
  get: Mock<StorageGet>;
  set: Mock<StorageSet>;
}

interface StorageFakeOptions {
  /** Clone on read so an in-place mutation of the stored array cannot fake serialized appends. */
  clone: boolean;
  set: StorageSet | null;
}

function stubEventStorage(stored: unknown, options: Partial<StorageFakeOptions> = {}): StorageFake {
  const clone: boolean = options.clone ?? true;
  const state: Record<string, unknown> = { [LOCAL_EVENTS]: stored };
  const get: Mock<StorageGet> = vi.fn(
    async (): Promise<Record<string, unknown>> => (clone ? structuredClone(state) : { ...state }),
  );
  const set: Mock<StorageSet> = vi.fn(
    options.set ??
      (async (items: Record<string, unknown>): Promise<void> => {
        Object.assign(state, items);
      }),
  );
  vi.stubGlobal('chrome', { storage: { local: { get, set } } });
  return { state, get, set };
}

function startedEvent(overrides: Partial<SessionStartedEventV2> = {}): SessionStartedEventV2 {
  return {
    version: 2,
    t: 'sessionStarted',
    eventId: `${SESSION_ID}:start`,
    at: NOW,
    sessionId: SESSION_ID,
    source: 'manual',
    mode: 'blacklist',
    strictness: 'flexible',
    duration: { kind: 'until-stopped' },
    intention: 'Ship the release',
    scheduleOccurrence: null,
    ...overrides,
  };
}

const LEGACY_START: LegacyEventRecord = {
  t: 'sessionStarted',
  at: NOW,
  source: 'manual',
  mode: 'blacklist',
  strictness: 'hard',
  durationMin: 25,
  intention: 'Ship the release',
  sessionId: SESSION_ID,
};
const LEGACY_EARNED: LegacyEventRecord = {
  t: 'budgetEarned',
  at: NOW + 8,
  ms: 5_000,
  sessionId: SESSION_ID,
};

const LEGACY_VARIANTS: readonly LegacyEventRecord[] = [
  LEGACY_START,
  { t: 'sessionCompleted', at: NOW + 1, focusedMs: 1_000, sessionId: SESSION_ID },
  { t: 'sessionCanceled', at: NOW + 2, focusedMs: 2_000, sessionId: SESSION_ID },
  { t: 'sessionIdentityAssigned', at: NOW + 3, startedAt: NOW, sessionId: SESSION_ID },
  { t: 'phase', at: NOW + 4, from: 'focus', to: 'break', sessionId: SESSION_ID },
  {
    t: 'attempt',
    at: NOW + 5,
    url: 'https://example.com/feed',
    host: 'example.com',
    tabId: 7,
    kind: 'navigation',
    sessionId: SESSION_ID,
  },
  { t: 'gateOpened', at: NOW + 6, gate: 'pause', sessionId: SESSION_ID },
  { t: 'gateResisted', at: NOW + 7, gate: 'cancel', sessionId: SESSION_ID },
  LEGACY_EARNED,
  { t: 'pauseTaken', at: NOW + 9, ms: 6_000, sessionId: SESSION_ID },
  { t: 'unlockTaken', at: NOW + 10, host: 'example.com', ms: 7_000, sessionId: SESSION_ID },
];

afterEach((): void => {
  vi.unstubAllGlobals();
});

describe('v2 event identity keys', (): void => {
  it('keys version 2 events by their event ID', (): void => {
    expect(eventIdentityKeyV2(startedEvent())).toBe(`v2:${SESSION_ID}:start`);
    expect(eventIdentityKeyV2(sessionEndedEvent())).toBe(`v2:${SESSION_ID}:end`);
  });

  it('keys legacy events by a key-order independent serialization', (): void => {
    const ordered: LegacyEventRecord = {
      t: 'budgetEarned',
      at: NOW,
      ms: 5_000,
      sessionId: SESSION_ID,
    };
    const shuffled: LegacyEventRecord = {
      sessionId: SESSION_ID,
      ms: 5_000,
      at: NOW,
      t: 'budgetEarned',
    };

    expect(eventIdentityKeyV2(ordered).startsWith('legacy:')).toBe(true);
    expect(eventIdentityKeyV2(shuffled)).toBe(eventIdentityKeyV2(ordered));
    expect(eventIdentityKeyV2({ ...ordered, ms: 6_000 })).not.toBe(eventIdentityKeyV2(ordered));
  });

  it('separates the legacy and version 2 key spaces', (): void => {
    expect(eventIdentityKeyV2(startedEvent())).not.toBe(eventIdentityKeyV2(LEGACY_START));
  });
});

describe('stored v2 event log parsing', (): void => {
  it('accepts every legacy variant beside both version 2 events', (): void => {
    const accepted: SessionEventRecordV2[] = [
      ...LEGACY_VARIANTS,
      startedEvent(),
      sessionEndedEvent(),
    ];

    expect(parseStoredEventLogV2(accepted)).toEqual(accepted);
  });

  it('drops invalid entries and keeps the valid order', (): void => {
    const stored: unknown[] = [
      LEGACY_EARNED,
      null,
      { t: 'budgetEarned', at: Number.NaN, ms: 500 },
      { t: 'unknown', at: NOW },
      { ...startedEvent(), eventId: 'wrong:start' },
      { ...sessionEndedEvent(), reason: 'timer-completed' },
      startedEvent(),
    ];

    expect(parseStoredEventLogV2(stored)).toEqual([LEGACY_EARNED, startedEvent()]);
  });

  it.each([[{ malformed: true }], [null], [undefined], ['[]'], [42]])(
    'returns an empty log for the non-array %#',
    (value: unknown): void => {
      expect(parseStoredEventLogV2(value)).toEqual([]);
    },
  );

  it('drops hostile stored elements without throwing', (): void => {
    const throwing: unknown = new Proxy<Record<string, unknown>>(
      {},
      {
        ownKeys: (): never => {
          throw new Error('ownKeys trap');
        },
      },
    );
    const accessorEventId: Record<string, unknown> = { ...startedEvent() };
    Object.defineProperty(accessorEventId, 'eventId', {
      enumerable: true,
      get: (): string => `${SESSION_ID}:start`,
    });
    const cyclic: Record<string, unknown> = {
      t: 'budgetEarned',
      at: NOW + 8,
      ms: 5_000,
      sessionId: SESSION_ID,
    };
    cyclic.self = cyclic;
    const sparseElement: unknown[] = new Array<unknown>(2);
    sparseElement[1] = budgetEarnedEvent();
    const stored: unknown[] = [
      LEGACY_EARNED,
      throwing,
      accessorEventId,
      cyclic,
      sparseElement,
      sessionEndedEvent(),
    ];

    expect((): SessionEventRecordV2[] => parseStoredEventLogV2(stored)).not.toThrow();
    expect(parseStoredEventLogV2(stored)).toEqual([LEGACY_EARNED, sessionEndedEvent()]);
  });

  it('drops the holes of a sparse stored log', (): void => {
    const sparse: unknown[] = new Array<unknown>(4);
    sparse[1] = budgetEarnedEvent();
    sparse[3] = sessionEndedEvent();

    expect(parseStoredEventLogV2(sparse)).toEqual([budgetEarnedEvent(), sessionEndedEvent()]);
  });

  it('detaches the parsed records from the stored objects', (): void => {
    const stored: Record<string, unknown> = { ...budgetEarnedEvent() };
    const parsed: SessionEventRecordV2[] = parseStoredEventLogV2([stored]);
    stored.ms = 9_999;

    expect(parsed).toEqual([budgetEarnedEvent()]);
  });
});

describe('v2 event log merging', (): void => {
  it('keeps the first occurrence of a version 2 event ID', (): void => {
    const first: SessionEventRecordV2 = sessionEndedEvent({ focusedMs: 30_000 });
    const replayed: SessionEventRecordV2 = sessionEndedEvent({ focusedMs: 45_000 });

    expect(mergeEventLogV2([first], [replayed])).toEqual([first]);
    expect(mergeEventLogV2([], [first, replayed])).toEqual([first]);
  });

  it('keeps structurally identical legacy duplicates out and preserves order', (): void => {
    const earned: SessionEventRecordV2 = budgetEarnedEvent();
    const paused: LegacyEventRecord = {
      t: 'pauseTaken',
      at: NOW + 20,
      ms: 1_000,
      sessionId: SESSION_ID,
    };

    expect(mergeEventLogV2([earned], [{ ...earned }, paused, { ...paused }])).toEqual([
      earned,
      paused,
    ]);
  });

  it('appends a legacy record that differs in one field', (): void => {
    const earned: SessionEventRecordV2 = budgetEarnedEvent();
    const later: SessionEventRecordV2 = budgetEarnedEvent({ ms: 6_000 });

    expect(mergeEventLogV2([earned], [later])).toEqual([earned, later]);
  });

  it('caps the merged log at the event cap by dropping from the front', (): void => {
    const log: SessionEventRecordV2[] = Array.from(
      { length: EVENT_LOG_CAP },
      (_value: unknown, index: number): SessionEventRecordV2 =>
        budgetEarnedEvent({ at: NOW + index }),
    );
    const incoming: SessionEventRecordV2[] = [budgetEarnedEvent({ at: NOW + EVENT_LOG_CAP })];

    const merged: SessionEventRecordV2[] = mergeEventLogV2(log, incoming);

    expect(merged).toHaveLength(EVENT_LOG_CAP);
    expect(merged[0]).toEqual(log[1]);
    expect(merged[merged.length - 1]).toEqual(incoming[0]);
  });

  it('leaves both inputs untouched', (): void => {
    const log: SessionEventRecordV2[] = [budgetEarnedEvent()];
    const incoming: SessionEventRecordV2[] = [sessionEndedEvent()];

    mergeEventLogV2(log, incoming);

    expect(log).toEqual([budgetEarnedEvent()]);
    expect(incoming).toEqual([sessionEndedEvent()]);
  });
});

describe('v2 event log storage', (): void => {
  it('reads the parsed log and drops malformed stored records', async (): Promise<void> => {
    stubEventStorage([budgetEarnedEvent(), { t: 'unknown', at: NOW }, sessionEndedEvent()]);

    await expect(readEventsV2()).resolves.toEqual([budgetEarnedEvent(), sessionEndedEvent()]);
  });

  it('writes the merged log under the events key', async (): Promise<void> => {
    const fake: StorageFake = stubEventStorage([budgetEarnedEvent()]);

    await expect(appendEventsV2([sessionEndedEvent()])).resolves.toBeUndefined();

    expect(fake.set).toHaveBeenCalledWith({
      [LOCAL_EVENTS]: [budgetEarnedEvent(), sessionEndedEvent()],
    });
    expect(fake.state[LOCAL_EVENTS]).toEqual([budgetEarnedEvent(), sessionEndedEvent()]);
  });

  it('repairs a non-array stored log before appending', async (): Promise<void> => {
    const fake: StorageFake = stubEventStorage({ malformed: true });

    await appendEventsV2([sessionEndedEvent()]);

    expect(fake.state[LOCAL_EVENTS]).toEqual([sessionEndedEvent()]);
  });

  it('performs no storage read or write for an empty batch', async (): Promise<void> => {
    const fake: StorageFake = stubEventStorage([budgetEarnedEvent()]);

    await expect(appendEventsV2([])).resolves.toBeUndefined();

    expect(fake.get).not.toHaveBeenCalled();
    expect(fake.set).not.toHaveBeenCalled();
  });

  it('serializes concurrent appends through one queue', async (): Promise<void> => {
    const fake: StorageFake = stubEventStorage([]);
    const first: SessionEventRecordV2 = budgetEarnedEvent({ at: NOW + 1 });
    const second: SessionEventRecordV2 = budgetEarnedEvent({ at: NOW + 2 });

    await Promise.all([appendEventsV2([first]), appendEventsV2([second])]);

    expect(fake.state[LOCAL_EVENTS]).toEqual([first, second]);
    expect(fake.get).toHaveBeenCalledTimes(2);
    expect(fake.set).toHaveBeenCalledTimes(2);
  });

  it('keeps appending after a write rejects', async (): Promise<void> => {
    const state: Record<string, unknown> = { [LOCAL_EVENTS]: [] };
    const set: Mock<StorageSet> = vi
      .fn<StorageSet>()
      .mockRejectedValueOnce(new Error('event storage unavailable'))
      .mockImplementation(async (items: Record<string, unknown>): Promise<void> => {
        Object.assign(state, items);
      });
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (): Promise<Record<string, unknown>> => structuredClone(state)),
          set,
        },
      },
    });
    const first: SessionEventRecordV2 = budgetEarnedEvent({ at: NOW + 1 });
    const second: SessionEventRecordV2 = budgetEarnedEvent({ at: NOW + 2 });

    await expect(appendEventsV2([first])).rejects.toThrow('event storage unavailable');
    await expect(appendEventsV2([second])).resolves.toBeUndefined();

    expect(state[LOCAL_EVENTS]).toEqual([second]);
  });

  it('ignores a replayed end event that disagrees on focused time', async (): Promise<void> => {
    const stored: SessionEventRecordV2 = sessionEndedEvent({ focusedMs: 30_000 });
    const fake: StorageFake = stubEventStorage([stored]);

    await appendEventsV2([sessionEndedEvent({ focusedMs: 45_000 })]);

    expect(fake.state[LOCAL_EVENTS]).toEqual([stored]);
  });

  it('leaves one copy of every event ID when a batch replays across a crash', async (): Promise<void> => {
    const batch: SessionEventRecordV2[] = [startedEvent(), sessionEndedEvent()];
    const state: Record<string, unknown> = { [LOCAL_EVENTS]: [] };
    const set: Mock<StorageSet> = vi
      .fn<StorageSet>()
      .mockRejectedValueOnce(new Error('service worker terminated'))
      .mockImplementation(async (items: Record<string, unknown>): Promise<void> => {
        Object.assign(state, items);
      });
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (): Promise<Record<string, unknown>> => structuredClone(state)),
          set,
        },
      },
    });

    await expect(appendEventsV2(batch)).rejects.toThrow('service worker terminated');
    await appendEventsV2(batch);
    await appendEventsV2(batch);

    expect(state[LOCAL_EVENTS]).toEqual(batch);
  });

  it('never persists an incoming record the parser rejects', async (): Promise<void> => {
    const cyclic: Record<string, unknown> = {
      t: 'budgetEarned',
      at: NOW + 8,
      ms: 5_000,
      sessionId: SESSION_ID,
    };
    cyclic.self = cyclic;
    const fake: StorageFake = stubEventStorage([], { clone: false });

    await appendEventsV2([
      cyclic as unknown as SessionEventRecordV2,
      { t: 'unknown', at: NOW } as unknown as SessionEventRecordV2,
      sessionEndedEvent(),
    ]);

    expect(fake.state[LOCAL_EVENTS]).toEqual([sessionEndedEvent()]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { EnginePorts } from '../../../src/background/engine';
import { Engine } from '../../../src/background/engine';
import { clockRebaseArchiveKey } from '../../../src/background/rollover';
import { emptyRuntime, mergeRuntime, type RuntimeState } from '../../../src/background/stores';
import { SyncWriter } from '../../../src/background/sync-writer';
import { beginPause, endPauseEarly, startSession } from '../../../src/core/session';
import {
  CANCEL_GATE_DELAY_MS,
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  GATE_EXPIRY_MS,
} from '../../../src/shared/constants';
import type { Ack } from '../../../src/shared/messages';
import { SYNC_BANK, SYNC_STREAK } from '../../../src/shared/storage-keys';
import { localDateStr } from '../../../src/shared/time';
import type {
  DailyAgg,
  EventRecord,
  ScheduleEntry,
  SessionConfig,
  SessionSnapshot,
  Settings,
  StreakState,
} from '../../../src/shared/types';

interface Harness {
  engine: Engine;
  ports: {
    [K in keyof EnginePorts]: ReturnType<typeof vi.fn>;
  };
  setNow(ms: number): void;
  loggedEvents(): EventRecord[];
}

const T0: number = new Date(2026, 7, 29, 8, 59).getTime();
const DAY_MS: number = 86_400_000;

function appendUnique(into: EventRecord[], events: EventRecord[]): void {
  const seen: Set<string> = new Set(
    into.map((event: EventRecord): string => JSON.stringify(event)),
  );
  for (const event of events) {
    const key: string = JSON.stringify(event);
    if (seen.has(key)) continue;
    seen.add(key);
    into.push(event);
  }
}

function hasCommitCheckpoint(runtime: RuntimeState): boolean {
  return (runtime as RuntimeState & { commitCheckpoint?: unknown }).commitCheckpoint != null;
}

function makeEngine(opts?: {
  bankMs?: number;
  settings?: Partial<Settings>;
  runtime?: RuntimeState;
  streak?: StreakState | null;
  queueSync?: EnginePorts['queueSync'];
  supersedeSync?: EnginePorts['supersedeSync'];
  persistSyncJournal?: EnginePorts['persistSyncJournal'];
}): Harness {
  let nowMs: number = T0;
  const ports: Harness['ports'] = {
    now: vi.fn((): number => nowMs),
    newId: vi.fn((): string => 'archive-id'),
    saveRuntime: vi.fn().mockResolvedValue(undefined),
    queueSync: opts?.queueSync === undefined ? vi.fn() : vi.fn(opts.queueSync),
    supersedeSync: opts?.supersedeSync === undefined ? vi.fn() : vi.fn(opts.supersedeSync),
    removeSync: vi.fn(),
    persistSyncJournal:
      opts?.persistSyncJournal === undefined
        ? vi.fn().mockResolvedValue(undefined)
        : vi.fn(opts.persistSyncJournal),
    appendEvents: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn(),
    applyBlocking: vi.fn().mockResolvedValue(undefined),
    playSound: vi.fn(),
    notify: vi.fn(),
    updateIcon: vi.fn(),
    scheduleWake: vi.fn(),
    prune: vi.fn().mockResolvedValue(undefined),
    reportError: vi.fn(),
  };
  const settings: Settings = { ...DEFAULT_SETTINGS, ...opts?.settings };
  const engine: Engine = new Engine(
    ports as unknown as EnginePorts,
    settings,
    {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'facebook.com' }],
    },
    { balanceMs: opts?.bankMs ?? 0 },
    opts?.streak ?? null,
    opts?.runtime ?? emptyRuntime(T0),
    'dev-test',
  );
  return {
    engine,
    ports,
    setNow: (ms: number): void => {
      nowMs = ms;
    },
    loggedEvents: (): EventRecord[] =>
      ports.appendEvents.mock.calls.flatMap((c: unknown[]): EventRecord[] => c[0] as EventRecord[]),
  };
}

const manualConfig: SessionConfig = {
  mode: 'blacklist',
  strictness: 'friction',
  durationMin: 25,
  cycling: null,
  intention: 'write the report',
  source: 'manual',
  scheduleEntryId: null,
};

const scheduledEntry: ScheduleEntry = {
  id: 'weekday-focus',
  days: [0, 1, 2, 3, 4, 5, 6],
  start: '09:00',
  end: '10:00',
  mode: 'blacklist',
  strictness: 'hard',
  cycling: null,
  intention: 'scheduled work',
  enabled: true,
};

describe('Engine', () => {
  it('forwards background errors to the configured port', () => {
    const h: Harness = makeEngine();
    const error = new Error('transient tab read failure');

    h.engine.reportError(error);

    expect(h.ports.reportError).toHaveBeenCalledWith(error);
  });

  it('atomically settles mute ownership after a concurrent URL rebind', async () => {
    const h: Harness = makeEngine();
    const engine = h.engine as Engine & {
      settleMuteClaim(tabId: number, finalUrl: string | null): Promise<void>;
    };

    await h.engine.claimMute(7, 'https://blocked.example/source', false);
    await h.engine.markStopped(7, 'https://blocked.example/source', 'replacement-document');
    await h.engine.transferMuteClaim(
      7,
      'https://blocked.example/source',
      'https://blocked.example/intermediate',
    );

    expect(typeof engine.settleMuteClaim).toBe('function');
    await engine.settleMuteClaim(7, 'https://blocked.example/final');
    expect(h.engine.tabFacts(7, 'https://blocked.example/final').wasMutedByUs).toBe(true);
    await engine.settleMuteClaim(7, null);
    expect(h.engine.tabFacts(7, 'https://blocked.example/final').wasMutedByUs).toBe(false);
    expect(
      h.engine.tabFacts(7, 'https://blocked.example/final', 'replacement-document').wasStopped,
    ).toBe(true);
  });

  it('startSession broadcasts, applies blocking, schedules a wake', async () => {
    const h: Harness = makeEngine();
    const ack = await h.engine.startSession(manualConfig);
    expect(ack).toEqual({ ok: true });
    expect(h.ports.applyBlocking).toHaveBeenCalled();
    expect(h.ports.scheduleWake).toHaveBeenCalledWith(T0 + 25 * 60_000);
    const snap = h.engine.snapshot();
    expect(snap.phase).toBe('focus');
    expect(h.ports.broadcast).toHaveBeenCalled();
    expect(h.loggedEvents().some((e: EventRecord): boolean => e.t === 'sessionStarted')).toBe(true);
  });

  it('persists the injected session identity and reuses it after restart', async () => {
    const first: Harness = makeEngine();
    await first.engine.startSession(manualConfig);

    const persisted: RuntimeState = first.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState;
    const started: EventRecord | undefined = first
      .loggedEvents()
      .find((event: EventRecord): boolean => event.t === 'sessionStarted');
    expect(persisted.session?.sessionId).toBe('archive-id');
    expect(started).toMatchObject({ t: 'sessionStarted', sessionId: 'archive-id' });

    const restarted: Harness = makeEngine({ runtime: persisted });
    await restarted.engine.recordAttempt('https://facebook.com/feed', 7, 'navigation');

    expect(restarted.ports.newId).not.toHaveBeenCalled();
    expect(restarted.loggedEvents()).toContainEqual(
      expect.objectContaining({ t: 'attempt', sessionId: 'archive-id' }),
    );
  });

  it('assigns and persists an identity to a legacy active session', async () => {
    const first: Harness = makeEngine();
    await first.engine.startSession(manualConfig);
    const legacy: RuntimeState = structuredClone(
      first.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState,
    );
    if (legacy.session !== null) delete legacy.session.sessionId;

    const migrated: Harness = makeEngine({ runtime: legacy });
    await migrated.engine.snapshotPersisted();

    expect(migrated.ports.saveRuntime.mock.calls.at(-1)?.[0]).toMatchObject({
      session: { sessionId: 'archive-id' },
    });
  });

  it('preserves a migrated session identity during direct tab persistence', async () => {
    const first: Harness = makeEngine();
    await first.engine.startSession(manualConfig);
    const legacy: RuntimeState = structuredClone(
      first.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState,
    );
    if (legacy.session !== null) delete legacy.session.sessionId;
    const migrated: Harness = makeEngine({ runtime: legacy });

    await migrated.engine.markStopped(7, 'https://blocked.example/page', 'document-id');

    expect(migrated.ports.saveRuntime.mock.calls.at(-1)?.[0]).toMatchObject({
      session: { sessionId: 'archive-id' },
    });
  });

  it('does not resolve a mutation response before runtime and event persistence', async () => {
    const h: Harness = makeEngine();
    let releaseEvents: () => void = (): void => {
      throw new Error('event persistence did not start');
    };
    h.ports.appendEvents.mockImplementation(
      (): Promise<void> =>
        new Promise((resolve: () => void): void => {
          releaseEvents = resolve;
        }),
    );

    const starting: Promise<unknown> = h.engine.startSession(manualConfig);
    await vi.waitFor((): void => expect(h.ports.appendEvents).toHaveBeenCalled());
    let resolved = false;
    starting.then((): void => {
      resolved = true;
    });
    await Promise.resolve();

    expect(resolved).toBe(false);
    expect(h.ports.saveRuntime).toHaveBeenCalledTimes(1);
    releaseEvents();
    await starting;
    expect(h.ports.saveRuntime).toHaveBeenCalledTimes(2);
  });

  it('retries runtime persistence after a failed save', async () => {
    const h: Harness = makeEngine();
    h.ports.saveRuntime.mockRejectedValueOnce(new Error('local storage unavailable'));
    const changed: Settings = {
      ...DEFAULT_SETTINGS,
      gate: { ...DEFAULT_SETTINGS.gate, delayMs: 30_000 },
    };

    await expect(h.engine.updateSettings(changed)).rejects.toThrow('local storage unavailable');
    await h.engine.snapshotPersisted();
    expect(h.ports.saveRuntime).toHaveBeenCalledTimes(3);
  });

  it('persists attempts discovered by the blocking sweep without commit deadlock', async () => {
    const h: Harness = makeEngine();
    let attemptWasDurableBeforeSweepContinued = false;
    h.ports.applyBlocking.mockImplementation(async (): Promise<void> => {
      await h.engine.recordAttempt('https://facebook.com/feed', 7, 'existing');
      attemptWasDurableBeforeSweepContinued = h
        .loggedEvents()
        .some((event: EventRecord): boolean => event.t === 'attempt');
    });
    const timeout: Promise<never> = new Promise((_, reject: (reason: Error) => void): void => {
      setTimeout((): void => reject(new Error('commit deadlock')), 100);
    });

    await expect(Promise.race([h.engine.startSession(manualConfig), timeout])).resolves.toEqual({
      ok: true,
    });
    expect(h.loggedEvents().some((event: EventRecord): boolean => event.t === 'attempt')).toBe(
      true,
    );
    expect(attemptWasDurableBeforeSweepContinued).toBe(true);
  });

  it('awaits catch-up persistence before answering an async snapshot request', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession({ ...manualConfig, durationMin: 0.1 });
    h.setNow(T0 + 7_000);
    let releaseEvents: () => void = (): void => {
      throw new Error('event persistence did not start');
    };
    h.ports.appendEvents.mockClear();
    h.ports.appendEvents.mockImplementationOnce(
      (): Promise<void> =>
        new Promise((resolve: () => void): void => {
          releaseEvents = resolve;
        }),
    );

    const reading: Promise<SessionSnapshot> = h.engine.snapshotPersisted();
    await vi.waitFor((): void => expect(h.ports.appendEvents).toHaveBeenCalled());
    let resolved = false;
    void reading.then((): void => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    releaseEvents();
    expect((await reading).phase).toBe('idle');
  });

  it('rejects a second session while one runs', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    const ack = await h.engine.startSession(manualConfig);
    expect(ack.ok).toBe(false);
  });

  it('self-heals into an active scheduled session', () => {
    const h: Harness = makeEngine({ settings: { schedule: [scheduledEntry] } });
    h.setNow(T0 + 16 * 60_000);

    const snapshot: SessionSnapshot = h.engine.snapshot();

    expect(snapshot.config).toMatchObject({
      source: 'schedule',
      scheduleEntryId: scheduledEntry.id,
      strictness: 'hard',
      durationMin: 45,
    });
    expect(h.ports.playSound).toHaveBeenCalledWith('scheduleStart');
    expect(h.ports.notify).toHaveBeenCalledWith('Focus schedule started', 'Locked until 10:00.');
  });

  it('uses the injected identity for a scheduled session and its start event', async () => {
    const h: Harness = makeEngine({ settings: { schedule: [scheduledEntry] } });
    h.setNow(new Date(2026, 7, 29, 9, 1).getTime());

    await h.engine.snapshotPersisted();

    expect(h.ports.saveRuntime.mock.calls.at(-1)?.[0]).toMatchObject({
      session: { sessionId: 'archive-id' },
    });
    expect(h.loggedEvents()).toContainEqual(
      expect.objectContaining({ t: 'sessionStarted', sessionId: 'archive-id' }),
    );
  });

  it('upgrades a running friction session when a hard schedule opens', async () => {
    const h: Harness = makeEngine({ settings: { schedule: [scheduledEntry] } });
    await h.engine.startSession(manualConfig);
    h.setNow(T0 + 16 * 60_000);

    const snapshot: SessionSnapshot = h.engine.snapshot();

    expect(snapshot.config?.strictness).toBe('hard');
    expect(h.ports.playSound).not.toHaveBeenCalledWith('scheduleStart');
  });

  it('rolls the local day and runs retention pruning at most weekly', async () => {
    const h: Harness = makeEngine();
    h.setNow(T0 + DAY_MS);

    await h.engine.tick();

    expect(h.ports.queueSync).toHaveBeenCalledWith(
      `agg:dev-test:${localDateStr(T0)}`,
      expect.objectContaining({ date: localDateStr(T0) }),
    );
    expect(h.ports.prune).toHaveBeenCalledOnce();
    expect(h.ports.prune).toHaveBeenCalledWith(DEFAULT_SETTINGS.retentionDays, T0 + DAY_MS);

    h.setNow(T0 + 2 * DAY_MS);
    await h.engine.tick();

    expect(h.ports.prune).toHaveBeenCalledOnce();
    const savedRuntime: RuntimeState = h.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState;
    expect(savedRuntime.date).toBe(localDateStr(T0 + 2 * DAY_MS));
  });

  it('marks retention pruning only after storage operations succeed', async () => {
    const h: Harness = makeEngine();
    h.ports.prune.mockRejectedValueOnce(new Error('sync remove failed'));

    await h.engine.tick();
    const failedRuntime: RuntimeState = h.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState;
    expect(failedRuntime.lastPruneDate).toBeNull();
    expect(h.ports.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'sync remove failed',
      }),
    );
    h.ports.prune.mockResolvedValueOnce(undefined);
    await h.engine.tick();

    const savedRuntime: RuntimeState = h.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState;
    expect(savedRuntime.lastPruneDate).toBe(localDateStr(T0));
    expect(h.ports.prune).toHaveBeenCalledTimes(2);
  });

  it('accrues pause budget from focus time', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    h.setNow(T0 + 60_000);
    const snap = h.engine.snapshot();
    expect(snap.bankMs).toBeCloseTo(60_000 * DEFAULT_SETTINGS.pause.earnRatio, 3);
  });

  it('does not credit the same in-progress focus interval twice', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    h.setNow(T0 + 60_000);

    const first: SessionSnapshot = h.engine.snapshot();
    const second: SessionSnapshot = h.engine.snapshot();

    expect(second.bankMs).toBe(first.bankMs);
  });

  it('records only the exact newly credited budget without duplicate catch-up', async () => {
    const h: Harness = makeEngine({
      bankMs: 900,
      settings: {
        pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0.5, capMs: 1_000 },
      },
    });
    await h.engine.startSession(manualConfig);
    h.setNow(T0 + 1_000);

    h.engine.snapshot();
    await h.engine.snapshotPersisted();
    await h.engine.snapshotPersisted();

    const earned: EventRecord[] = h
      .loggedEvents()
      .filter((event: EventRecord): boolean => event.t === 'budgetEarned');
    expect(earned).toEqual([
      expect.objectContaining({ t: 'budgetEarned', ms: 100, sessionId: 'archive-id' }),
    ]);
    expect(h.engine.statsOverlay().todayAgg.pauseMsEarned).toBe(100);
  });

  it('recovers one accrual after runtime cleanup persistence fails and the worker restarts', async () => {
    const h: Harness = makeEngine({
      settings: { pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0.5 } },
    });
    await h.engine.startSession(manualConfig);
    let storedRuntime: RuntimeState = structuredClone(
      h.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState,
    );
    let durableBankMs = 0;
    const durableEvents: EventRecord[] = [];
    h.ports.queueSync.mockImplementation((key: string, value: unknown): void => {
      if (key === SYNC_BANK) durableBankMs = (value as { balanceMs: number }).balanceMs;
    });
    h.ports.appendEvents.mockImplementation(async (events: EventRecord[]): Promise<void> => {
      appendUnique(durableEvents, events);
    });
    h.ports.saveRuntime.mockImplementation(async (runtime: RuntimeState): Promise<void> => {
      if (!hasCommitCheckpoint(runtime)) throw new Error('runtime cleanup failed');
      storedRuntime = structuredClone(runtime);
    });
    h.setNow(T0 + 1_000);

    await expect(h.engine.snapshotPersisted()).rejects.toThrow('runtime cleanup failed');

    const restarted: Harness = makeEngine({
      bankMs: durableBankMs,
      runtime: storedRuntime,
      settings: { pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0.5 } },
      queueSync: (key: string, value: unknown): void => {
        if (key === SYNC_BANK) durableBankMs = (value as { balanceMs: number }).balanceMs;
      },
    });
    restarted.ports.appendEvents.mockImplementation(
      async (events: EventRecord[]): Promise<void> => appendUnique(durableEvents, events),
    );
    restarted.setNow(T0 + 1_000);
    await restarted.engine.snapshotPersisted();

    expect(restarted.engine.snapshot().bankMs).toBe(500);
    expect(
      durableEvents.filter((event: EventRecord): boolean => event.t === 'budgetEarned'),
    ).toHaveLength(1);
  });

  it('keeps a second accrual revision while the first event append is blocked', async () => {
    const h: Harness = makeEngine({
      settings: { pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0.5 } },
    });
    await h.engine.startSession(manualConfig);
    h.ports.appendEvents.mockClear();
    h.ports.queueSync.mockClear();
    let releaseFirstAppend: () => void = (): void => {
      throw new Error('first append did not start');
    };
    h.ports.appendEvents.mockImplementationOnce(
      (): Promise<void> =>
        new Promise((resolve: () => void): void => {
          releaseFirstAppend = resolve;
        }),
    );
    h.setNow(T0 + 1_000);
    const first: Promise<SessionSnapshot> = h.engine.snapshotPersisted();
    await vi.waitFor((): void => expect(h.ports.appendEvents).toHaveBeenCalledTimes(1));

    h.setNow(T0 + 2_000);
    const second: Promise<SessionSnapshot> = h.engine.snapshotPersisted();
    releaseFirstAppend();
    await Promise.all([first, second]);

    const bankWrites: Array<{ balanceMs: number }> = h.ports.queueSync.mock.calls
      .filter((call: unknown[]): boolean => call[0] === SYNC_BANK)
      .map((call: unknown[]): { balanceMs: number } => call[1] as { balanceMs: number });
    expect(bankWrites.at(-1)?.balanceMs).toBe(1_000);
    expect(
      h.loggedEvents().filter((event: EventRecord): boolean => event.t === 'budgetEarned'),
    ).toHaveLength(2);

    const storedRuntime: RuntimeState = structuredClone(
      h.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState,
    );
    const restarted: Harness = makeEngine({
      bankMs: bankWrites.at(-1)?.balanceMs ?? 0,
      runtime: storedRuntime,
      settings: { pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0.5 } },
    });
    restarted.setNow(T0 + 2_000);
    await restarted.engine.snapshotPersisted();
    expect(restarted.engine.snapshot().bankMs).toBe(1_000);
  });

  it('keeps a synced bank revision while an accrual event append is blocked', async () => {
    const h: Harness = makeEngine({
      settings: { pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0.5 } },
    });
    await h.engine.startSession(manualConfig);
    h.ports.appendEvents.mockClear();
    h.ports.queueSync.mockClear();
    let releaseFirstAppend: () => void = (): void => {
      throw new Error('first append did not start');
    };
    h.ports.appendEvents.mockImplementationOnce(
      (): Promise<void> =>
        new Promise((resolve: () => void): void => {
          releaseFirstAppend = resolve;
        }),
    );
    h.setNow(T0 + 1_000);
    const accrual: Promise<SessionSnapshot> = h.engine.snapshotPersisted();
    await vi.waitFor((): void => expect(h.ports.appendEvents).toHaveBeenCalledTimes(1));

    const synced: Promise<Ack> = h.engine.applySyncedBank({ balanceMs: 250 });
    releaseFirstAppend();
    await Promise.all([accrual, synced]);

    const bankWrites: Array<{ balanceMs: number }> = h.ports.queueSync.mock.calls
      .filter((call: unknown[]): boolean => call[0] === SYNC_BANK)
      .map((call: unknown[]): { balanceMs: number } => call[1] as { balanceMs: number });
    expect(bankWrites.at(-1)?.balanceMs).toBe(250);
    const storedRuntime: RuntimeState = structuredClone(
      h.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState,
    );
    const restarted: Harness = makeEngine({
      bankMs: bankWrites.at(-1)?.balanceMs ?? 0,
      runtime: storedRuntime,
      settings: { pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0.5 } },
    });
    restarted.setNow(T0 + 1_000);
    expect(restarted.engine.snapshot().bankMs).toBe(250);
  });

  it('keeps cross-queue attempt revisions when the first event append is blocked', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    h.ports.appendEvents.mockClear();
    const durableEvents: EventRecord[] = [];
    let releaseFirstAppend: () => void = (): void => {
      throw new Error('first append did not start');
    };
    let signalSecondAppend: () => void = (): void => {
      throw new Error('second append signal was not initialized');
    };
    const secondAppendStarted: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalSecondAppend = resolve;
    });
    h.ports.appendEvents.mockImplementationOnce(async (events: EventRecord[]): Promise<void> => {
      await new Promise<void>((resolve: () => void): void => {
        releaseFirstAppend = resolve;
      });
      appendUnique(durableEvents, events);
    });
    h.ports.appendEvents.mockImplementation(async (events: EventRecord[]): Promise<void> => {
      signalSecondAppend();
      appendUnique(durableEvents, events);
    });

    Reflect.set(h.engine, 'applyingBlocking', true);
    const first: Promise<void> = h.engine.recordAttempt(
      'https://facebook.com/first',
      7,
      'existing',
    );
    await vi.waitFor((): void => expect(h.ports.appendEvents).toHaveBeenCalledTimes(1));

    Reflect.set(h.engine, 'applyingBlocking', false);
    const second: Promise<void> = h.engine.recordAttempt(
      'https://facebook.com/second',
      8,
      'navigation',
    );
    await Promise.race([
      secondAppendStarted,
      new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, 20);
      }),
    ]);
    releaseFirstAppend();
    await Promise.all([first, second]);

    expect(
      durableEvents.filter((event: EventRecord): boolean => event.t === 'attempt'),
    ).toHaveLength(2);
    const storedRuntime: RuntimeState = structuredClone(
      h.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState,
    );
    const restarted: Harness = makeEngine({ runtime: storedRuntime });
    expect(restarted.engine.snapshot().attemptsToday).toBe(2);
  });

  it('does not overwrite a durable tab mutation when checkpoint cleanup finishes', async () => {
    const h: Harness = makeEngine();
    let releaseEvents: () => void = (): void => {
      throw new Error('event persistence did not start');
    };
    h.ports.appendEvents.mockImplementationOnce(
      (): Promise<void> =>
        new Promise((resolve: () => void): void => {
          releaseEvents = resolve;
        }),
    );

    const starting: Promise<Ack> = h.engine.startSession(manualConfig);
    await vi.waitFor((): void => expect(h.ports.appendEvents).toHaveBeenCalledTimes(1));
    await h.engine.markStopped(7, 'https://facebook.com/feed', 'durable-document');
    releaseEvents();
    await starting;

    const storedRuntime: RuntimeState = structuredClone(
      h.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState,
    );
    const restarted: Harness = makeEngine({ runtime: mergeRuntime(storedRuntime, T0) });
    expect(
      restarted.engine.tabFacts(7, 'https://facebook.com/feed', 'durable-document').wasStopped,
    ).toBe(true);
    await restarted.engine.snapshotPersisted();
    expect(restarted.ports.saveRuntime.mock.calls.at(-1)?.[0]).toMatchObject({
      tabStates: { 7: { stoppedDocumentId: 'durable-document' } },
      commitCheckpoint: null,
    });
  });

  it('does not persist an unowned accrual through a concurrent tab mutation', async () => {
    const h: Harness = makeEngine({
      settings: { pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0.5 } },
    });
    await h.engine.startSession(manualConfig);
    h.ports.appendEvents.mockClear();
    let releaseEvents: () => void = (): void => {
      throw new Error('event persistence did not start');
    };
    h.ports.appendEvents.mockImplementationOnce(
      (): Promise<void> =>
        new Promise((resolve: () => void): void => {
          releaseEvents = resolve;
        }),
    );

    h.setNow(T0 + 1_000);
    const first: Promise<SessionSnapshot> = h.engine.snapshotPersisted();
    await vi.waitFor((): void => expect(h.ports.appendEvents).toHaveBeenCalledTimes(1));
    h.setNow(T0 + 2_000);
    const second: Promise<SessionSnapshot> = h.engine.snapshotPersisted();
    await h.engine.markStopped(7, 'https://facebook.com/feed', 'durable-document');

    const crashRuntime: RuntimeState = structuredClone(
      h.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState,
    );
    const restarted: Harness = makeEngine({
      runtime: mergeRuntime(crashRuntime, T0 + 2_000),
      settings: { pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0.5 } },
    });
    restarted.setNow(T0 + 2_000);
    expect((await restarted.engine.snapshotPersisted()).bankMs).toBe(1_000);
    expect(
      restarted.engine.tabFacts(7, 'https://facebook.com/feed', 'durable-document').wasStopped,
    ).toBe(true);

    releaseEvents();
    await Promise.all([first, second]);
  });

  it('does not restore bank data from a checkpoint that does not own a bank write', async () => {
    const runtime: RuntimeState = emptyRuntime(T0);
    runtime.commitCheckpoint = {
      bank: { balanceMs: 100 },
      events: [],
      syncBank: false,
    };

    const h: Harness = makeEngine({ bankMs: 900, runtime });
    expect(h.engine.snapshot().bankMs).toBe(900);
    await h.engine.snapshotPersisted();
    expect(h.engine.snapshot().bankMs).toBe(900);
  });

  it('restores and advances a resumed phase whose original boundary has passed', async () => {
    const config: SessionConfig = {
      ...manualConfig,
      cycling: { focusMin: 5, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 },
    };
    const started = startSession(config, T0, 'resumed-session');
    const paused = beginPause(started, T0 + 4 * 60_000, 5 * 60_000);
    const resumed = endPauseEarly(paused, T0 + 6 * 60_000);
    expect(resumed.phaseStartedAt).toBeGreaterThan(resumed.phaseEndsAt);
    const runtime: RuntimeState = mergeRuntime(
      {
        ...emptyRuntime(T0 + 6 * 60_000),
        session: resumed,
        accruedFocusMs: resumed.focusedMs,
      },
      T0 + 6 * 60_000,
    );

    const h: Harness = makeEngine({ runtime });
    h.setNow(T0 + 6 * 60_000);
    expect((await h.engine.snapshotPersisted()).phase).toBe('break');
  });

  it('credits only focus time across a cycling phase boundary', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession({
      ...manualConfig,
      durationMin: 20,
      cycling: { focusMin: 5, shortBreakMin: 5, longBreakMin: 5, longEvery: 4 },
    });

    h.setNow(T0 + 4 * 60_000);
    expect(h.engine.snapshot().bankMs).toBeCloseTo(
      4 * 60_000 * DEFAULT_SETTINGS.pause.earnRatio,
      3,
    );
    h.setNow(T0 + 6 * 60_000);
    expect(h.engine.snapshot().bankMs).toBeCloseTo(
      5 * 60_000 * DEFAULT_SETTINGS.pause.earnRatio,
      3,
    );
    h.setNow(T0 + 11 * 60_000);
    expect(h.engine.snapshot().bankMs).toBeCloseTo(
      6 * 60_000 * DEFAULT_SETTINGS.pause.earnRatio,
      3,
    );
  });

  it('records in-progress focus when a friction session is canceled', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    await h.engine.openGate('cancel', null);
    h.setNow(T0 + CANCEL_GATE_DELAY_MS);

    const ack = await h.engine.confirmGate('I choose distraction over: write the report');

    expect(ack).toEqual({ ok: true });
    const canceled: EventRecord | undefined = h
      .loggedEvents()
      .find((event: EventRecord): boolean => event.t === 'sessionCanceled');
    expect(canceled).toMatchObject({ t: 'sessionCanceled', focusedMs: CANCEL_GATE_DELAY_MS });
  });

  it('splits focus and closes every missed day after a multi-day wake', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession({ ...manualConfig, durationMin: 3 * 24 * 60 });
    const firstMidnight: number = new Date(2026, 7, 30, 0, 0).getTime();
    h.setNow(new Date(2026, 7, 31, 1, 0).getTime());

    await h.engine.tick();

    expect(h.ports.queueSync).toHaveBeenCalledWith(
      `agg:dev-test:${localDateStr(T0)}`,
      expect.objectContaining({ focusMs: firstMidnight - T0 }),
    );
    expect(h.ports.queueSync).toHaveBeenCalledWith(
      `agg:dev-test:${localDateStr(firstMidnight)}`,
      expect.objectContaining({ focusMs: DAY_MS }),
    );
    expect(h.engine.getStreak()).toMatchObject({ current: 2 });
  });

  it('quarantines a future local aggregate and removes its daily key', async () => {
    const runtime: RuntimeState = emptyRuntime(T0);
    const futureDate: string = localDateStr(T0 + 3 * DAY_MS);
    const futureAgg: DailyAgg = {
      date: futureDate,
      focusMs: 60_000,
      sessionsStarted: 1,
      sessionsCompleted: 0,
      attempts: { 'x.com': 2 },
      attemptsOther: 0,
      pausesTaken: 0,
      pauseMsSpent: 0,
      pauseMsEarned: 0,
      unlocksTaken: 0,
      unlockMsSpent: 0,
      resisted: 0,
    };
    runtime.date = futureDate;
    runtime.todayAgg = futureAgg;
    const futureStreak: StreakState = {
      current: 2,
      freezeTokens: 1,
      lastCountedDate: futureDate,
      lastFreezeGrantDate: null,
      activeDays: [1, 2],
      activeMonth: futureDate.slice(0, 7),
    };
    const h: Harness = makeEngine({ runtime, streak: futureStreak });

    await h.engine.tick();
    const overlay = h.engine.statsOverlay();

    expect(overlay.todayAgg.date).toBe(localDateStr(T0));
    expect(overlay.todayAgg.focusMs).toBe(0);
    expect(h.ports.removeSync).toHaveBeenCalledWith(`agg:dev-test:${futureDate}`);
    expect(h.ports.queueSync).not.toHaveBeenCalledWith(
      `agg:dev-test:${futureDate}`,
      expect.anything(),
    );
    expect(h.ports.queueSync).toHaveBeenCalledWith(
      clockRebaseArchiveKey('dev-test', futureDate, T0, 'archive-id'),
      futureAgg,
    );
    expect(h.ports.queueSync).not.toHaveBeenCalledWith(
      `agg:dev-test:${localDateStr(T0)}`,
      expect.anything(),
    );
    expect(h.ports.queueSync).toHaveBeenCalledWith('streak', {
      ...futureStreak,
      current: 0,
      lastCountedDate: null,
      activeDays: [],
      activeMonth: localDateStr(T0).slice(0, 7),
    });
  });

  it('clears future streak markers during a same-month clock rebase', async () => {
    const runtime: RuntimeState = emptyRuntime(T0);
    const futureDate: string = localDateStr(T0 + DAY_MS);
    runtime.date = futureDate;
    const futureStreak: StreakState = {
      current: 3,
      freezeTokens: 1,
      lastCountedDate: futureDate,
      lastFreezeGrantDate: futureDate,
      activeDays: [28, 30],
      activeMonth: futureDate.slice(0, 7),
    };
    const h: Harness = makeEngine({ runtime, streak: futureStreak });

    await h.engine.tick();

    expect(h.engine.getStreak()).toEqual({
      ...futureStreak,
      current: 0,
      lastCountedDate: null,
      lastFreezeGrantDate: null,
      activeDays: [28],
    });
    expect(h.ports.queueSync).toHaveBeenCalledWith(SYNC_STREAK, h.engine.getStreak());
  });

  it('clears a pending gate when a session completes before a new session starts', async () => {
    const h: Harness = makeEngine({ bankMs: 300_000 });
    await h.engine.startSession({ ...manualConfig, durationMin: 0.1 });
    await h.engine.openGate('pause', null);
    h.setNow(T0 + 7_000);
    await h.engine.tick();

    await h.engine.startSession(manualConfig);

    expect(h.engine.snapshot().gate).toBeNull();
  });

  it('verdictFor blocks during focus, returns no-session when idle', async () => {
    const h: Harness = makeEngine();
    expect(h.engine.verdictFor('https://facebook.com/feed').reason).toBe('no-session');
    await h.engine.startSession(manualConfig);
    expect(h.engine.verdictFor('https://facebook.com/feed').blocked).toBe(true);
    expect(h.engine.verdictFor('https://example.com/').blocked).toBe(false);
  });

  it('opens a pause gate with readyAt = now + delayMs', async () => {
    const h: Harness = makeEngine({ bankMs: 300_000 });
    await h.engine.startSession(manualConfig);
    const ack = await h.engine.openGate('pause', null);
    expect(ack).toEqual({ ok: true });
    const gate = h.engine.snapshot().gate;
    expect(gate?.readyAt).toBe(T0 + DEFAULT_SETTINGS.gate.delayMs);
    expect(gate?.requiredPhrase).toBeNull();
    expect(h.loggedEvents().some((e: EventRecord): boolean => e.t === 'gateOpened')).toBe(true);
  });

  it('rejects a pause gate the budget cannot afford', async () => {
    const h: Harness = makeEngine({
      bankMs: 0,
      settings: { pause: { ...DEFAULT_SETTINGS.pause } },
    });
    await h.engine.startSession(manualConfig);
    const ack = await h.engine.openGate('pause', null);
    expect(ack.ok).toBe(false);
  });

  it('rejects confirmGate before readyAt, accepts after, spends and pauses', async () => {
    const h: Harness = makeEngine({
      bankMs: 300_000,
      settings: { pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0 } },
    });
    await h.engine.startSession(manualConfig);
    await h.engine.openGate('pause', null);
    const early = await h.engine.confirmGate(null);
    expect(early.ok).toBe(false);
    h.setNow(T0 + DEFAULT_SETTINGS.gate.delayMs);
    const ack = await h.engine.confirmGate(null);
    expect(ack).toEqual({ ok: true });
    const snap = h.engine.snapshot();
    expect(snap.phase).toBe('paused');
    expect(snap.bankMs).toBe(300_000 - DEFAULT_SETTINGS.pause.pauseMs);
    expect(h.loggedEvents().some((e: EventRecord): boolean => e.t === 'pauseTaken')).toBe(true);
  });

  it('records exact pause and unlock spending against the active session', async () => {
    const h: Harness = makeEngine({
      bankMs: 600_000,
      settings: { pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0 } },
    });
    await h.engine.startSession(manualConfig);
    await h.engine.openGate('pause', null);
    h.setNow(T0 + DEFAULT_SETTINGS.gate.delayMs);
    await h.engine.confirmGate(null);
    await h.engine.resumeFromPause();
    await h.engine.openGate('unlockSite', 'facebook.com');
    h.setNow(T0 + 2 * DEFAULT_SETTINGS.gate.delayMs);
    await h.engine.confirmGate(null);

    expect(h.loggedEvents()).toContainEqual(
      expect.objectContaining({
        t: 'pauseTaken',
        ms: DEFAULT_SETTINGS.pause.pauseMs,
        sessionId: 'archive-id',
      }),
    );
    expect(h.loggedEvents()).toContainEqual(
      expect.objectContaining({
        t: 'unlockTaken',
        ms: DEFAULT_SETTINGS.pause.unlockMs,
        sessionId: 'archive-id',
      }),
    );
    expect(h.engine.statsOverlay().todayAgg).toMatchObject({
      pauseMsSpent: DEFAULT_SETTINGS.pause.pauseMs,
      unlockMsSpent: DEFAULT_SETTINGS.pause.unlockMs,
    });
  });

  it.each([
    ['pause', 'pauseTaken'],
    ['unlockSite', 'unlockTaken'],
  ] as const)(
    'recovers one %s spend after runtime cleanup persistence fails and the worker restarts',
    async (gate: 'pause' | 'unlockSite', eventType: 'pauseTaken' | 'unlockTaken') => {
      const initialBankMs: number = 600_000;
      const h: Harness = makeEngine({
        bankMs: initialBankMs,
        settings: { pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0 } },
      });
      await h.engine.startSession(manualConfig);
      await h.engine.openGate(gate, gate === 'unlockSite' ? 'facebook.com' : null);
      let storedRuntime: RuntimeState = structuredClone(
        h.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState,
      );
      let durableBankMs: number = initialBankMs;
      const durableEvents: EventRecord[] = [];
      h.ports.queueSync.mockImplementation((key: string, value: unknown): void => {
        if (key === SYNC_BANK) durableBankMs = (value as { balanceMs: number }).balanceMs;
      });
      h.ports.appendEvents.mockImplementation(async (events: EventRecord[]): Promise<void> => {
        appendUnique(durableEvents, events);
      });
      h.ports.saveRuntime.mockImplementation(async (runtime: RuntimeState): Promise<void> => {
        if (!hasCommitCheckpoint(runtime)) throw new Error('runtime cleanup failed');
        storedRuntime = structuredClone(runtime);
      });
      h.setNow(T0 + DEFAULT_SETTINGS.gate.delayMs);

      await expect(h.engine.confirmGate(null)).rejects.toThrow('runtime cleanup failed');

      const restarted: Harness = makeEngine({
        bankMs: durableBankMs,
        runtime: storedRuntime,
        settings: { pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0 } },
        queueSync: (key: string, value: unknown): void => {
          if (key === SYNC_BANK) durableBankMs = (value as { balanceMs: number }).balanceMs;
        },
      });
      restarted.ports.appendEvents.mockImplementation(
        async (events: EventRecord[]): Promise<void> => appendUnique(durableEvents, events),
      );
      restarted.setNow(T0 + DEFAULT_SETTINGS.gate.delayMs);
      if (storedRuntime.gate === null) await restarted.engine.snapshotPersisted();
      else await restarted.engine.confirmGate(null);

      expect(restarted.engine.snapshot().bankMs).toBe(
        initialBankMs - DEFAULT_SETTINGS.pause.pauseMs,
      );
      expect(
        durableEvents.filter((event: EventRecord): boolean => event.t === eventType),
      ).toHaveLength(1);
    },
  );

  it('abandonGate clears the gate and logs resisted', async () => {
    const h: Harness = makeEngine({ bankMs: 300_000 });
    await h.engine.startSession(manualConfig);
    await h.engine.openGate('pause', null);
    const ack = await h.engine.abandonGate();
    expect(ack).toEqual({ ok: true });
    expect(h.engine.snapshot().gate).toBeNull();
    expect(h.loggedEvents().some((e: EventRecord): boolean => e.t === 'gateResisted')).toBe(true);
    expect(h.engine.statsOverlay().todayAgg.resisted).toBe(1);
  });

  it('tick closes an expired gate as resisted', async () => {
    const h: Harness = makeEngine({ bankMs: 300_000 });
    await h.engine.startSession(manualConfig);
    await h.engine.openGate('pause', null);
    h.setNow(T0 + DEFAULT_SETTINGS.gate.delayMs + GATE_EXPIRY_MS + 1);
    await h.engine.tick();
    expect(h.engine.snapshot().gate).toBeNull();
    expect(h.loggedEvents().some((e: EventRecord): boolean => e.t === 'gateResisted')).toBe(true);
  });

  it('cancel gate demands the exact phrase and ends the session', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    const opened = await h.engine.openGate('cancel', null);
    expect(opened).toEqual({ ok: true });
    h.setNow(T0 + CANCEL_GATE_DELAY_MS);
    const wrong = await h.engine.confirmGate('let me out');
    expect(wrong.ok).toBe(false);
    const right = await h.engine.confirmGate('I choose distraction over: write the report');
    expect(right).toEqual({ ok: true });
    expect(h.engine.snapshot().phase).toBe('idle');
    expect(h.loggedEvents().some((e: EventRecord): boolean => e.t === 'sessionCanceled')).toBe(
      true,
    );
  });

  it('rejects the cancel gate during a hard session', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession({ ...manualConfig, strictness: 'hard' });
    const ack = await h.engine.openGate('cancel', null);
    expect(ack.ok).toBe(false);
  });

  it('unlockSite adds a SiteUnlock that verdictFor honors until expiry', async () => {
    const h: Harness = makeEngine({
      bankMs: 300_000,
      settings: { pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0 } },
    });
    await h.engine.startSession(manualConfig);
    expect(h.engine.verdictFor('https://facebook.com/feed').blocked).toBe(true);
    await h.engine.openGate('unlockSite', 'facebook.com');
    h.setNow(T0 + DEFAULT_SETTINGS.gate.delayMs);
    const ack = await h.engine.confirmGate(null);
    expect(ack).toEqual({ ok: true });
    expect(h.engine.verdictFor('https://facebook.com/feed').blocked).toBe(false);
    expect(h.engine.snapshot().activeUnlocks).toEqual([
      {
        host: 'facebook.com',
        until: T0 + DEFAULT_SETTINGS.gate.delayMs + DEFAULT_SETTINGS.pause.unlockMs,
      },
    ]);
    h.setNow(T0 + DEFAULT_SETTINGS.gate.delayMs + DEFAULT_SETTINGS.pause.unlockMs + 1);
    expect(h.engine.verdictFor('https://facebook.com/feed').blocked).toBe(true);
  });

  it('normalizes a site unlock to its registrable host', async () => {
    const h: Harness = makeEngine({
      bankMs: 300_000,
      settings: {
        pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0 },
      },
    });
    await h.engine.startSession(manualConfig);
    await h.engine.openGate('unlockSite', 'm.facebook.com');
    h.setNow(T0 + DEFAULT_SETTINGS.gate.delayMs);
    await h.engine.confirmGate(null);

    expect(h.engine.snapshot().activeUnlocks[0]?.host).toBe('facebook.com');
    expect(h.engine.verdictFor('https://www.facebook.com/feed').blocked).toBe(false);
  });

  it('completes the session on tick past sessionEndsAt with sound and notification', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    h.setNow(T0 + 25 * 60_000 + 1);
    await h.engine.tick();
    expect(h.engine.snapshot().phase).toBe('idle');
    expect(h.ports.playSound).toHaveBeenCalledWith('sessionComplete');
    expect(h.ports.notify).toHaveBeenCalled();
    expect(h.loggedEvents().some((e: EventRecord): boolean => e.t === 'sessionCompleted')).toBe(
      true,
    );
  });

  it('resumeFromPause restores focus', async () => {
    const h: Harness = makeEngine({
      bankMs: 300_000,
      settings: { pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0 } },
    });
    await h.engine.startSession(manualConfig);
    await h.engine.openGate('pause', null);
    h.setNow(T0 + DEFAULT_SETTINGS.gate.delayMs);
    await h.engine.confirmGate(null);
    h.setNow(T0 + DEFAULT_SETTINGS.gate.delayMs + 60_000);
    const ack = await h.engine.resumeFromPause();
    expect(ack).toEqual({ ok: true });
    expect(h.engine.snapshot().phase).toBe('focus');
  });

  it('recordAttempt debounces the same tab and url within 30 s', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    await h.engine.recordAttempt('https://facebook.com/feed', 7, 'navigation');
    await h.engine.recordAttempt('https://facebook.com/feed', 7, 'navigation');
    const attempts: EventRecord[] = h
      .loggedEvents()
      .filter((e: EventRecord): boolean => e.t === 'attempt');
    expect(attempts).toHaveLength(1);
    expect(h.engine.snapshot().attemptsToday).toBe(1);
  });

  it('keeps a debounced caller behind the matching in-flight attempt persistence', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    let releasePersistence: () => void = (): void => {
      throw new Error('attempt persistence did not start');
    };
    let signalPersistence: () => void = (): void => {
      throw new Error('attempt persistence signal was not initialized');
    };
    const persistenceStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalPersistence = resolve;
    });
    h.ports.appendEvents.mockImplementationOnce(
      (): Promise<void> =>
        new Promise((resolve: () => void): void => {
          releasePersistence = resolve;
          signalPersistence();
        }),
    );

    const first: Promise<void> = h.engine.recordAttempt(
      'https://facebook.com/feed',
      7,
      'navigation',
    );
    await persistenceStarted;
    let secondResolved = false;
    const second: Promise<void> = h.engine
      .recordAttempt('https://facebook.com/feed', 7, 'existing')
      .then((): void => {
        secondResolved = true;
      });
    await Promise.resolve();

    expect(secondResolved).toBe(false);
    releasePersistence();
    await Promise.all([first, second]);
  });

  it('does not strand overlapping same-key persistence after the debounce window', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    let releasePersistence: () => void = (): void => {
      throw new Error('attempt persistence did not start');
    };
    let signalPersistence: () => void = (): void => {
      throw new Error('attempt persistence signal was not initialized');
    };
    const persistenceStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalPersistence = resolve;
    });
    h.ports.appendEvents.mockImplementationOnce(
      (): Promise<void> =>
        new Promise((resolve: () => void): void => {
          releasePersistence = resolve;
          signalPersistence();
        }),
    );

    const first: Promise<void> = h.engine.recordAttempt(
      'https://facebook.com/feed',
      7,
      'navigation',
    );
    await persistenceStarted;
    h.setNow(T0 + 31_000);
    const second: Promise<void> = h.engine.recordAttempt(
      'https://facebook.com/feed',
      7,
      'existing',
    );
    releasePersistence();
    const outcome: 'completed' | 'stranded' = await Promise.race([
      Promise.all([first, second]).then((): 'completed' => 'completed'),
      new Promise((resolve: (value: 'stranded') => void): void => {
        setTimeout((): void => resolve('stranded'), 50);
      }),
    ]);

    expect(outcome).toBe('completed');
  });

  it('reports a commit rejection once after attempt persistence becomes durable', async () => {
    const h: Harness = makeEngine();
    const applyError = new Error('blocking sweep failed after persistence');
    let rejectApply: (error: unknown) => void = (): void => {
      throw new Error('apply rejection was not initialized');
    };
    let signalApplyStarted: () => void = (): void => {
      throw new Error('apply start signal was not initialized');
    };
    const applyStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalApplyStarted = resolve;
    });
    h.ports.applyBlocking.mockImplementationOnce(
      (): Promise<void> =>
        new Promise((_resolve: () => void, reject: (error: unknown) => void): void => {
          rejectApply = reject;
          signalApplyStarted();
        }),
    );
    Reflect.set(h.engine, 'needsBlocking', true);

    const attempt: Promise<void> = h.engine.recordAttempt(
      'https://facebook.com/feed',
      7,
      'navigation',
    );
    await applyStarted;
    await expect(attempt).resolves.toBeUndefined();

    rejectApply(applyError);
    await vi.waitFor((): void => {
      expect(h.ports.reportError).toHaveBeenCalledWith(applyError);
    });
    expect(h.ports.reportError).toHaveBeenCalledTimes(1);
  });

  it('retries failed same-key attempt persistence inside the debounce window', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    h.ports.appendEvents.mockClear();
    h.ports.appendEvents.mockRejectedValueOnce(new Error('event storage unavailable'));

    await expect(
      h.engine.recordAttempt('https://facebook.com/feed', 7, 'navigation'),
    ).rejects.toThrow('event storage unavailable');
    await expect(
      h.engine.recordAttempt('https://facebook.com/feed', 7, 'existing'),
    ).resolves.toBeUndefined();

    expect(h.ports.appendEvents).toHaveBeenCalledTimes(2);
    const retriedEvents: EventRecord[] = h.ports.appendEvents.mock.calls[1]?.[0] ?? [];
    expect(
      retriedEvents.filter((event: EventRecord): boolean => event.t === 'attempt'),
    ).toHaveLength(1);
    expect(h.engine.snapshot().attemptsToday).toBe(1);
  });

  it('counts a new same-key attempt after failed persistence debounce expires', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    h.ports.appendEvents.mockClear();
    h.ports.appendEvents.mockRejectedValueOnce(new Error('event storage unavailable'));

    await expect(
      h.engine.recordAttempt('https://facebook.com/feed', 7, 'navigation'),
    ).rejects.toThrow('event storage unavailable');
    h.setNow(T0 + 31_000);
    await h.engine.recordAttempt('https://facebook.com/feed', 7, 'existing');

    expect(h.ports.appendEvents).toHaveBeenCalledTimes(2);
    const retriedEvents: EventRecord[] = h.ports.appendEvents.mock.calls[1]?.[0] ?? [];
    expect(
      retriedEvents.filter((event: EventRecord): boolean => event.t === 'attempt'),
    ).toHaveLength(2);
    expect(h.engine.snapshot().attemptsToday).toBe(2);
  });

  it('prunes absent tab records while preserving live restore state', async () => {
    const h: Harness = makeEngine();
    await h.engine.claimMute(7, 'https://kept.example', true);
    await h.engine.claimMute(8, 'https://missing.example', false);
    await h.engine.markStopped(7, 'https://kept.example', 'kept-document');
    await h.engine.markStopped(9, 'https://missing.example', 'missing-document');

    h.engine.reconcileTabs(
      new Map([
        [
          7,
          {
            url: 'https://kept.example',
            mutedByExtension: true,
            documentId: 'kept-document',
          },
        ],
      ]),
    );

    expect(h.engine.tabFacts(7, 'https://kept.example', 'kept-document')).toEqual({
      wasMutedByUs: true,
      priorMuted: true,
      wasStopped: true,
    });
    expect(h.engine.tabFacts(8, 'https://missing.example')).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: false,
    });
    expect(h.engine.tabFacts(9, 'https://missing.example')).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: false,
    });
  });

  it('persists mute ownership before resolving the claim and persists release', async () => {
    const h: Harness = makeEngine();
    let releaseSave: () => void = (): void => {};
    let signalSave: () => void = (): void => {};
    const saveBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseSave = resolve;
    });
    const saveStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalSave = resolve;
    });
    h.ports.saveRuntime.mockImplementationOnce((runtime: RuntimeState): Promise<void> => {
      expect(runtime.tabStates[7]).toEqual({
        muteUrl: 'https://blocked.example/page',
        priorMuted: false,
        stoppedDocumentId: null,
      });
      signalSave();
      return saveBlocked;
    });
    let claimed: boolean = false;

    const pendingClaim: Promise<void> = h.engine
      .claimMute(7, 'https://blocked.example/page', false)
      .then((result: boolean): void => {
        claimed = result;
      });
    const firstCompletion: 'save' | 'claim' = await Promise.race([
      saveStarted.then((): 'save' => 'save'),
      pendingClaim.then((): 'claim' => 'claim'),
    ]);

    expect(firstCompletion).toBe('save');
    expect(claimed).toBe(false);
    releaseSave();
    await pendingClaim;
    expect(claimed).toBe(true);

    h.ports.saveRuntime.mockClear();
    await h.engine.releaseMuteClaim(7, 'https://blocked.example/page');
    expect(h.ports.saveRuntime).toHaveBeenCalledWith(expect.objectContaining({ tabStates: {} }));
  });

  it('drops persisted tab state when a reused id has a different URL', async () => {
    const h: Harness = makeEngine();
    await h.engine.markStopped(7, 'https://blocked.example/old');
    await h.engine.claimMute(7, 'https://blocked.example/old', false);

    h.engine.reconcileTabs(
      new Map([[7, { url: 'https://allowed.example/new', mutedByExtension: false }]]),
    );

    expect(h.engine.tabFacts(7, 'https://allowed.example/new')).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: false,
    });
  });

  it('drops same-url tab effects when the live mute is not extension-owned', async () => {
    const h: Harness = makeEngine();
    const url = 'https://blocked.example/page';
    await h.engine.markStopped(7, url);
    await h.engine.claimMute(7, url, false);

    h.engine.reconcileTabs(new Map([[7, { url, mutedByExtension: false }]]));

    expect(h.engine.tabFacts(7, url)).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: false,
    });
  });

  it('drops same-url stopped ownership when no extension mute confirms the tab', async () => {
    const h: Harness = makeEngine();
    const url = 'https://blocked.example/page';
    await h.engine.markStopped(7, url);

    h.engine.reconcileTabs(new Map([[7, { url, mutedByExtension: false }]]));

    expect(h.engine.tabFacts(7, url)).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: false,
    });
  });

  it('rebinds an extension-owned mute after navigation interrupts the mute update', async () => {
    const h: Harness = makeEngine();
    await h.engine.claimMute(7, 'https://blocked.example/old', false);

    h.engine.reconcileTabs(
      new Map([
        [
          7,
          {
            url: 'https://allowed.example/new',
            mutedByExtension: true,
          },
        ],
      ]),
    );

    expect(h.engine.tabFacts(7, 'https://allowed.example/new')).toEqual({
      wasMutedByUs: true,
      priorMuted: false,
      wasStopped: false,
    });
  });

  it('does not relabel persisted state through a direct URL mismatch', async () => {
    const h: Harness = makeEngine();
    await h.engine.markStopped(7, 'https://blocked.example/old');
    await h.engine.claimMute(7, 'https://blocked.example/old', false);

    expect(h.engine.tabFacts(7, 'https://allowed.example/new')).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: false,
    });
  });

  it('rebinds a confirmed navigation while preserving its tab state', async () => {
    const h: Harness = makeEngine();
    await h.engine.markStopped(7, 'https://blocked.example/old', 'document-one');
    await h.engine.claimMute(7, 'https://blocked.example/old', false);

    h.engine.rebindTab(7, 'https://blocked.example/new');

    expect(h.engine.tabFacts(7, 'https://blocked.example/new', 'document-one')).toEqual({
      wasMutedByUs: true,
      priorMuted: false,
      wasStopped: true,
    });
  });

  it('ignores stale restore and reload completions for another URL', async () => {
    const h: Harness = makeEngine();
    await h.engine.markStopped(7, 'https://blocked.example/new', 'document-current');
    await h.engine.claimMute(7, 'https://blocked.example/new', false);

    h.engine.noteMuteRestored(7, 'https://blocked.example/old');
    h.engine.noteReloaded(7, 'document-stale');

    expect(h.engine.tabFacts(7, 'https://blocked.example/new', 'document-current')).toEqual({
      wasMutedByUs: true,
      priorMuted: false,
      wasStopped: true,
    });
  });

  it('preserves stopped-document ownership before mute ownership exists', async () => {
    const h: Harness = makeEngine();
    const url = 'https://blocked.example/page';

    await h.engine.markStopped(7, url, 'document-one');
    h.engine.reconcileTabs(
      new Map([
        [
          7,
          {
            url,
            mutedByExtension: false,
            documentId: 'document-one',
          },
        ],
      ]),
    );

    expect(h.engine.tabFacts(7, url, 'document-one')).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: true,
    });
  });

  it('does not give a reused same-URL tab stopped-document ownership', async () => {
    const h: Harness = makeEngine();
    const url = 'https://blocked.example/page';

    await h.engine.markStopped(7, url, 'document-one');

    expect(h.engine.tabFacts(7, url, 'document-two')).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: false,
    });
  });

  it('caps the active daily attempt map before queueing sync data', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    for (let index: number = 0; index < 25; index++) {
      await h.engine.recordAttempt(`https://site-${index}.com/feed`, index, 'existing');
    }

    const dailyWrites: unknown[][] = h.ports.queueSync.mock.calls.filter(
      (call: unknown[]): boolean => call[0] === `agg:dev-test:${localDateStr(T0)}`,
    );
    const latest = dailyWrites.at(-1)?.[1] as {
      attempts: Record<string, number>;
      attemptsOther: number;
    };
    expect(Object.keys(latest.attempts)).toHaveLength(20);
    expect(latest.attemptsOther).toBe(5);
    expect(Object.keys(h.engine.statsOverlay().todayAgg.attempts)).toHaveLength(20);
  });

  it('updateSettings rejects weakening during hard, applies otherwise', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession({ ...manualConfig, strictness: 'hard' });
    const weaker: Settings = {
      ...DEFAULT_SETTINGS,
      gate: { ...DEFAULT_SETTINGS.gate, delayMs: 1_000 },
    };
    const rejected = await h.engine.updateSettings(weaker);
    expect(rejected.ok).toBe(false);
    const stronger: Settings = {
      ...DEFAULT_SETTINGS,
      gate: { ...DEFAULT_SETTINGS.gate, delayMs: 30_000 },
    };
    const ack = await h.engine.updateSettings(stronger);
    expect(ack).toEqual({ ok: true });
    expect(h.engine.getSettings().gate.delayMs).toBe(30_000);
    expect(h.ports.queueSync).toHaveBeenCalledWith('settings', stronger);
  });

  it('does not acknowledge accepted lists before the sync journal is durable', async () => {
    let releaseJournal: () => void = (): void => {};
    let signalJournalStarted: () => void = (): void => {};
    const journalBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseJournal = resolve;
    });
    const journalStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalJournalStarted = resolve;
    });
    const h: Harness = makeEngine({
      persistSyncJournal: (): Promise<void> => {
        signalJournalStarted();
        return journalBlocked;
      },
    });
    const updatedLists = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host' as const, pattern: 'blocked.example' }],
    };
    let acknowledged: boolean = false;

    const pendingAck: Promise<void> = h.engine.updateLists(updatedLists).then((): void => {
      acknowledged = true;
    });
    const firstCompletion: 'journal' | 'ack' = await Promise.race([
      journalStarted.then((): 'journal' => 'journal'),
      pendingAck.then((): 'ack' => 'ack'),
    ]);

    expect(firstCompletion).toBe('journal');
    expect(acknowledged).toBe(false);
    releaseJournal();
    await pendingAck;
    expect(acknowledged).toBe(true);
  });

  it('journals aggregate writes discovered during the blocking sweep before acknowledgement', async () => {
    let persistCalls: number = 0;
    let releaseSecondJournal: () => void = (): void => {};
    let signalSecondJournal: () => void = (): void => {};
    const secondJournalBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseSecondJournal = resolve;
    });
    const secondJournalStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalSecondJournal = resolve;
    });
    const h: Harness = makeEngine({
      persistSyncJournal: (): Promise<void> => {
        persistCalls += 1;
        if (persistCalls !== 2) return Promise.resolve();
        signalSecondJournal();
        return secondJournalBlocked;
      },
    });
    h.ports.applyBlocking.mockImplementation(
      (): Promise<void> => h.engine.recordAttempt('https://facebook.com/feed', 7, 'existing'),
    );

    const pendingAck: Promise<unknown> = h.engine.startSession(manualConfig);
    const firstCompletion: 'journal' | 'ack' = await Promise.race([
      secondJournalStarted.then((): 'journal' => 'journal'),
      pendingAck.then((): 'ack' => 'ack'),
    ]);

    expect(firstCompletion).toBe('journal');
    releaseSecondJournal();
    await pendingAck;
  });

  it('applies live sync changes without echoing and rejects hard-session weakening', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession({ ...manualConfig, strictness: 'hard' });
    h.ports.queueSync.mockClear();
    const weaker: Settings = {
      ...DEFAULT_SETTINGS,
      gate: { ...DEFAULT_SETTINGS.gate, delayMs: 1_000 },
    };

    const rejected = await h.engine.applySyncedSettings(weaker);
    const accepted = await h.engine.applySyncedBank({ balanceMs: 42_000 });

    expect(rejected.ok).toBe(false);
    expect(accepted).toEqual({ ok: true });
    expect(h.engine.getSettings().gate.delayMs).toBe(DEFAULT_SETTINGS.gate.delayMs);
    expect(h.engine.snapshot().bankMs).toBe(42_000);
    expect(h.ports.queueSync).not.toHaveBeenCalledWith('settings', expect.anything());
    expect(h.ports.queueSync).not.toHaveBeenCalledWith('bank', expect.anything());
  });

  it('applies newer synced streak progress and supersedes pending state', async () => {
    const local: StreakState = {
      current: 2,
      freezeTokens: 0,
      lastCountedDate: '2026-08-26',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [25, 26],
      activeMonth: '2026-08',
    };
    const remote: StreakState = {
      ...local,
      current: 3,
      lastCountedDate: '2026-08-27',
      activeDays: [25, 26, 27],
    };
    const h: Harness = makeEngine({ streak: local });

    await h.engine.applySyncedStreak(remote);

    expect(h.engine.getStreak()).toEqual(remote);
    expect(h.ports.supersedeSync).toHaveBeenCalledWith(SYNC_STREAK, remote);
  });

  it('does not replace newer local streak progress with stale sync data', async () => {
    const remote: StreakState = {
      current: 2,
      freezeTokens: 0,
      lastCountedDate: '2026-08-26',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [25, 26],
      activeMonth: '2026-08',
    };
    const local: StreakState = {
      ...remote,
      current: 3,
      lastCountedDate: '2026-08-27',
      activeDays: [25, 26, 27],
    };
    const h: Harness = makeEngine({ streak: local });

    await h.engine.applySyncedStreak(remote);

    expect(h.engine.getStreak()).toEqual(local);
    expect(h.ports.queueSync).toHaveBeenCalledWith(SYNC_STREAK, local);
  });

  it('merges equal-marker streak counters and active days without regression', async () => {
    const remote: StreakState = {
      current: 3,
      freezeTokens: 2,
      lastCountedDate: '2026-08-28',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [25, 28],
      activeMonth: '2026-08',
    };
    const local: StreakState = {
      ...remote,
      current: 5,
      freezeTokens: 1,
      activeDays: [24, 25, 26, 27],
    };
    const h: Harness = makeEngine({ streak: local });

    await h.engine.applySyncedStreak(remote);

    const merged: StreakState = {
      ...remote,
      current: 5,
      freezeTokens: 2,
      activeDays: [24, 25, 26, 27, 28],
    };
    expect(h.engine.getStreak()).toEqual(merged);
    expect(h.ports.queueSync).toHaveBeenCalledWith(SYNC_STREAK, merged);
  });

  it('sanitizes future remote streak markers before arbitration', async () => {
    const local: StreakState = {
      current: 0,
      freezeTokens: 1,
      lastCountedDate: null,
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [28],
      activeMonth: '2026-08',
    };
    const remote: StreakState = {
      current: 5,
      freezeTokens: 2,
      lastCountedDate: '2026-09-01',
      lastFreezeGrantDate: '2026-09-01',
      activeDays: [1],
      activeMonth: '2026-09',
    };
    const h: Harness = makeEngine({ streak: local });

    await h.engine.applySyncedStreak(remote);

    const corrected: StreakState = {
      current: 0,
      freezeTokens: 1,
      lastCountedDate: null,
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [28],
      activeMonth: '2026-08',
    };
    expect(h.engine.getStreak()).toEqual(corrected);
    expect(h.ports.queueSync).toHaveBeenCalledWith(SYNC_STREAK, corrected);
  });

  it('supersedes an older pending streak write with newer remote progress', async () => {
    const older: StreakState = {
      current: 2,
      freezeTokens: 0,
      lastCountedDate: '2026-08-26',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [25, 26],
      activeMonth: '2026-08',
    };
    const newer: StreakState = {
      ...older,
      current: 3,
      lastCountedDate: '2026-08-27',
      activeDays: [25, 26, 27],
    };
    const write = vi.fn().mockResolvedValue(undefined);
    const writer: SyncWriter = new SyncWriter(10_000, write);
    writer.queue(SYNC_STREAK, older);
    const h: Harness = makeEngine({
      streak: older,
      supersedeSync: (key: string, value: unknown): void => writer.supersede(key, value),
    });

    await h.engine.applySyncedStreak(newer);
    await writer.flushNow();

    expect(write).toHaveBeenCalledWith({ [SYNC_STREAK]: newer });
  });

  it('does not create a sync write when no local streak is pending', async () => {
    const remote: StreakState = {
      current: 3,
      freezeTokens: 0,
      lastCountedDate: '2026-08-27',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [25, 26, 27],
      activeMonth: '2026-08',
    };
    const write = vi.fn().mockResolvedValue(undefined);
    const writer: SyncWriter = new SyncWriter(10_000, write);
    const h: Harness = makeEngine({
      supersedeSync: (key: string, value: unknown): void => writer.supersede(key, value),
    });

    await h.engine.applySyncedStreak(remote);
    await writer.flushNow();

    expect(write).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { EnginePorts } from '../../../src/background/engine';
import { Engine } from '../../../src/background/engine';
import { clockRebaseArchiveKey } from '../../../src/background/rollover';
import { emptyRuntime, type RuntimeState } from '../../../src/background/stores';
import { SyncWriter } from '../../../src/background/sync-writer';
import {
  CANCEL_GATE_DELAY_MS,
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  GATE_EXPIRY_MS,
} from '../../../src/shared/constants';
import { SYNC_STREAK } from '../../../src/shared/storage-keys';
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

function makeEngine(opts?: {
  bankMs?: number;
  settings?: Partial<Settings>;
  runtime?: RuntimeState;
  streak?: StreakState | null;
  queueSync?: EnginePorts['queueSync'];
  supersedeSync?: EnginePorts['supersedeSync'];
}): Harness {
  let nowMs: number = T0;
  const ports: Harness['ports'] = {
    now: vi.fn((): number => nowMs),
    saveRuntime: vi.fn().mockResolvedValue(undefined),
    queueSync: opts?.queueSync === undefined ? vi.fn() : vi.fn(opts.queueSync),
    supersedeSync: opts?.supersedeSync === undefined ? vi.fn() : vi.fn(opts.supersedeSync),
    removeSync: vi.fn(),
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
    await Promise.resolve();

    expect(h.ports.saveRuntime).not.toHaveBeenCalled();
    releaseEvents();
    await starting;
    expect(h.ports.saveRuntime).toHaveBeenCalled();
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
    expect(h.ports.saveRuntime).toHaveBeenCalledTimes(2);
  });

  it('persists attempts discovered by the blocking sweep without commit deadlock', async () => {
    const h: Harness = makeEngine();
    h.ports.applyBlocking.mockImplementation(
      (): Promise<void> => h.engine.recordAttempt('https://facebook.com/feed', 7, 'existing'),
    );
    const timeout: Promise<never> = new Promise((_, reject: (reason: Error) => void): void => {
      setTimeout((): void => reject(new Error('commit deadlock')), 100);
    });

    await expect(Promise.race([h.engine.startSession(manualConfig), timeout])).resolves.toEqual({
      ok: true,
    });
    expect(h.loggedEvents().some((event: EventRecord): boolean => event.t === 'attempt')).toBe(
      true,
    );
  });

  it('awaits catch-up persistence before answering an async snapshot request', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession({ ...manualConfig, durationMin: 0.1 });
    h.setNow(T0 + 7_000);
    let releaseEvents: () => void = (): void => {
      throw new Error('event persistence did not start');
    };
    h.ports.appendEvents.mockImplementationOnce(
      (): Promise<void> =>
        new Promise((resolve: () => void): void => {
          releaseEvents = resolve;
        }),
    );

    const reading: Promise<SessionSnapshot> = h.engine.snapshotPersisted();
    await Promise.resolve();
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
      unlocksTaken: 0,
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
      clockRebaseArchiveKey('dev-test', futureDate, T0),
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

  it('prunes absent tab records while preserving live restore state', async () => {
    const h: Harness = makeEngine();
    h.engine.noteMuted(7, 'https://kept.example', true);
    h.engine.noteMuted(8, 'https://missing.example', false);
    await h.engine.markStopped(7, 'https://kept.example');
    await h.engine.markStopped(9, 'https://missing.example');

    h.engine.reconcileTabs(new Map([[7, 'https://kept.example']]));

    expect(h.engine.tabFacts(7, 'https://kept.example')).toEqual({
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

  it('drops persisted tab state when a reused id has a different URL', async () => {
    const h: Harness = makeEngine();
    await h.engine.markStopped(7, 'https://blocked.example/old');
    h.engine.noteMuted(7, 'https://blocked.example/old', false);

    h.engine.reconcileTabs(new Map([[7, 'https://allowed.example/new']]));

    expect(h.engine.tabFacts(7, 'https://allowed.example/new')).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: false,
    });
  });

  it('does not relabel persisted state through a direct URL mismatch', async () => {
    const h: Harness = makeEngine();
    await h.engine.markStopped(7, 'https://blocked.example/old');
    h.engine.noteMuted(7, 'https://blocked.example/old', false);

    expect(h.engine.tabFacts(7, 'https://allowed.example/new')).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: false,
    });
  });

  it('rebinds a confirmed navigation while preserving its tab state', async () => {
    const h: Harness = makeEngine();
    await h.engine.markStopped(7, 'https://blocked.example/old');
    h.engine.noteMuted(7, 'https://blocked.example/old', false);

    h.engine.rebindTab(7, 'https://blocked.example/new');

    expect(h.engine.tabFacts(7, 'https://blocked.example/new')).toEqual({
      wasMutedByUs: true,
      priorMuted: false,
      wasStopped: true,
    });
  });

  it('ignores stale restore and reload completions for another URL', async () => {
    const h: Harness = makeEngine();
    await h.engine.markStopped(7, 'https://blocked.example/new');
    h.engine.noteMuted(7, 'https://blocked.example/new', false);

    h.engine.noteMuteRestored(7, 'https://blocked.example/old');
    h.engine.noteReloaded(7, 'https://blocked.example/old');

    expect(h.engine.tabFacts(7, 'https://blocked.example/new')).toEqual({
      wasMutedByUs: true,
      priorMuted: false,
      wasStopped: true,
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

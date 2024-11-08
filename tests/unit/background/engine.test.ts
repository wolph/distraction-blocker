import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnginePorts } from '../../../src/background/engine';
import { Engine } from '../../../src/background/engine';
import { emptyRuntime, type RuntimeState } from '../../../src/background/stores';
import { activeEntry, windowEnd } from '../../../src/core/schedule';
import {
  CANCEL_GATE_DELAY_MS,
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  GATE_EXPIRY_MS,
} from '../../../src/shared/constants';
import { localDateStr } from '../../../src/shared/time';
import type {
  BankState,
  EventRecord,
  ScheduleEntry,
  SessionConfig,
  SessionSnapshot,
  SessionState,
  Settings,
} from '../../../src/shared/types';

// The real src/core modules still throw "not implemented" on this branch
// (checked before writing these mocks). Once ws/core merges, delete the
// mocks and let the real modules referee.
vi.mock('../../../src/core/session', () => ({
  startSession: (config: SessionConfig, now: number): SessionState => {
    const endsAt: number = now + config.durationMin * 60_000;
    return {
      config,
      startedAt: now,
      sessionEndsAt: endsAt,
      phase: 'focus',
      phaseStartedAt: now,
      phaseEndsAt: endsAt,
      cycleIndex: 0,
      pausedFrom: null,
      focusedMs: 0,
    };
  },
  advance: (state: SessionState, now: number): { next: SessionState | null; events: unknown[] } => {
    if (state.phase === 'focus') {
      const upTo: number = Math.min(now, state.phaseEndsAt);
      const focusedMs: number = Math.max(state.focusedMs, upTo - state.phaseStartedAt);
      if (now >= state.sessionEndsAt) {
        return { next: null, events: [{ type: 'completed', at: state.sessionEndsAt, focusedMs }] };
      }
      return { next: { ...state, focusedMs }, events: [] };
    }
    return { next: state, events: [] };
  },
  beginPause: (state: SessionState, now: number, pauseMs: number): SessionState => ({
    ...state,
    phase: 'paused',
    pausedFrom: { phase: state.phase as 'focus' | 'break', phaseEndsAt: state.phaseEndsAt },
    phaseStartedAt: now,
    phaseEndsAt: now + pauseMs,
  }),
  endPauseEarly: (state: SessionState, now: number): SessionState => ({
    ...state,
    phase: state.pausedFrom?.phase ?? 'focus',
    phaseStartedAt: now,
    phaseEndsAt: state.pausedFrom?.phaseEndsAt ?? state.sessionEndsAt,
    pausedFrom: null,
  }),
  startNextFocusEarly: (state: SessionState): SessionState => state,
}));

vi.mock('../../../src/core/budget', async () => {
  const { CoreError } = await import('../../../src/shared/errors');
  return {
    accrue: (
      bank: BankState,
      delta: number,
      eco: { earnRatio: number; capMs: number },
    ): BankState => ({
      balanceMs: Math.min(eco.capMs, bank.balanceMs + delta * eco.earnRatio),
    }),
    spend: (bank: BankState, ms: number): BankState => {
      if (bank.balanceMs < ms) throw new CoreError('insufficient-budget', 'not enough budget');
      return { balanceMs: bank.balanceMs - ms };
    },
    msUntilAffordable: (): number => 0,
  };
});

vi.mock('../../../src/core/matcher', () => ({
  compileMatcher: (lists: unknown, _cats: unknown, mode: string): unknown => ({
    mode,
    lists,
    hosts: new Map(),
    regexes: [],
    excluded: new Set(),
  }),
  evaluateUrl: (
    _m: unknown,
    url: string,
    unlocks: Array<{ host: string; until: number }>,
    now: number,
  ): { blocked: boolean; reason: string; matchedPattern: string | null } => {
    const host: string = new URL(url).hostname;
    const domain: string = host.endsWith('facebook.com') ? 'facebook.com' : host;
    if (unlocks.some((u): boolean => (u.host === domain || u.host === host) && u.until > now)) {
      return { blocked: false, reason: 'unlock', matchedPattern: host };
    }
    if (host.endsWith('facebook.com')) {
      return { blocked: true, reason: 'custom', matchedPattern: 'facebook.com' };
    }
    return { blocked: false, reason: 'default', matchedPattern: null };
  },
  registrableHost: (url: string): string | null => {
    const host: string = url.includes('://') ? new URL(url).hostname : url;
    return host.endsWith('facebook.com') ? 'facebook.com' : host;
  },
  validateRule: (): null => null,
}));

vi.mock('../../../src/core/schedule', () => ({
  activeEntry: vi.fn((): null => null),
  nextStart: (): null => null,
  windowEnd: vi.fn((): Date => new Date(0)),
  validateEntry: (): null => null,
}));

vi.mock('../../../src/core/stats', () => ({
  emptyDaily: (date: string): unknown => ({
    date,
    focusMs: 0,
    sessionsStarted: 0,
    sessionsCompleted: 0,
    attempts: {},
    attemptsOther: 0,
    pausesTaken: 0,
    pauseMsSpent: 0,
    unlocksTaken: 0,
    resisted: 0,
  }),
  addEvent: (agg: Record<string, unknown>, ev: EventRecord): unknown => {
    const next: Record<string, unknown> = structuredClone(agg);
    if (ev.t === 'attempt') {
      const attempts: Record<string, number> = next.attempts as Record<string, number>;
      attempts[ev.host] = (attempts[ev.host] ?? 0) + 1;
    }
    if (ev.t === 'gateResisted') next.resisted = (next.resisted as number) + 1;
    if (ev.t === 'sessionStarted') next.sessionsStarted = (next.sessionsStarted as number) + 1;
    if (ev.t === 'sessionCompleted') {
      next.sessionsCompleted = (next.sessionsCompleted as number) + 1;
      next.focusMs = (next.focusMs as number) + ev.focusedMs;
    }
    if (ev.t === 'pauseTaken') {
      next.pausesTaken = (next.pausesTaken as number) + 1;
      next.pauseMsSpent = (next.pauseMsSpent as number) + ev.ms;
    }
    if (ev.t === 'unlockTaken') next.unlocksTaken = (next.unlocksTaken as number) + 1;
    return next;
  },
  mergeDaily: (aggs: unknown[]): unknown => aggs[0],
  mergeMonthly: (aggs: unknown[]): unknown => aggs[0],
  capAttempts: (agg: unknown): unknown => agg,
  rollupMonth: (): unknown => ({}),
}));

vi.mock('../../../src/core/streak', () => ({
  emptyStreak: (month: string): unknown => ({
    current: 0,
    freezeTokens: 0,
    lastCountedDate: null,
    lastFreezeGrantDate: null,
    activeDays: [],
    activeMonth: month,
  }),
  closeDay: (streak: unknown): unknown => streak,
}));

interface Harness {
  engine: Engine;
  ports: {
    [K in keyof EnginePorts]: ReturnType<typeof vi.fn>;
  };
  setNow(ms: number): void;
  loggedEvents(): EventRecord[];
}

const T0: number = 1_000_000_000;
const DAY_MS: number = 86_400_000;

function makeEngine(opts?: { bankMs?: number; settings?: Partial<Settings> }): Harness {
  let nowMs: number = T0;
  const ports: Harness['ports'] = {
    now: vi.fn((): number => nowMs),
    saveRuntime: vi.fn().mockResolvedValue(undefined),
    queueSync: vi.fn(),
    appendEvents: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn(),
    applyBlocking: vi.fn().mockResolvedValue(undefined),
    playSound: vi.fn(),
    notify: vi.fn(),
    updateIcon: vi.fn(),
    scheduleWake: vi.fn(),
    prune: vi.fn(),
  };
  const settings: Settings = { ...DEFAULT_SETTINGS, ...opts?.settings };
  const engine: Engine = new Engine(
    ports as unknown as EnginePorts,
    settings,
    DEFAULT_LISTS,
    { balanceMs: opts?.bankMs ?? 0 },
    null,
    emptyRuntime(T0),
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
  beforeEach((): void => {
    vi.mocked(activeEntry).mockReset().mockReturnValue(null);
    vi.mocked(windowEnd).mockReset().mockReturnValue(new Date(0));
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

  it('rejects a second session while one runs', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    const ack = await h.engine.startSession(manualConfig);
    expect(ack.ok).toBe(false);
  });

  it('self-heals into an active scheduled session', () => {
    const h: Harness = makeEngine({ settings: { schedule: [scheduledEntry] } });
    vi.mocked(activeEntry).mockReturnValue(scheduledEntry);
    vi.mocked(windowEnd).mockReturnValue(new Date(T0 + 45 * 60_000));

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
    vi.mocked(activeEntry).mockReturnValue(scheduledEntry);

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

  it('accrues pause budget from focus time', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    h.setNow(T0 + 60_000);
    const snap = h.engine.snapshot();
    expect(snap.bankMs).toBeCloseTo(60_000 * DEFAULT_SETTINGS.pause.earnRatio, 3);
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
});

import { describe, expect, it } from 'vitest';
import type { AlarmNameV2, AlarmPortsV2 } from '../../../src/background/alarms-v2';
import {
  CLOSURE_CLEANUP_ALARM,
  clearAlarmWithReadBackV2,
  createAlarmWithReadBackV2,
  DATA_CLEAR_RETRY_ALARM,
  ensurePhaseAlarmV2,
  ensureTickAlarmV2,
  PHASE_ALARM,
  parseAlarmNameV2,
  planPhaseAlarmV2,
  TICK_ALARM,
  TRANSITION_CLEANUP_ALARM,
} from '../../../src/background/alarms-v2';
import { CoreError } from '../../../src/shared/errors';
import type { SessionStateV2 } from '../../../src/shared/types';
import {
  breakSession,
  pausedSession,
  sessionConfigV2,
  timedFocusSession,
  untilStoppedFocusSession,
} from './runtime-v2-fixtures';

interface AlarmCallV2 {
  op: 'create' | 'createPeriodic' | 'get' | 'clear';
  name: AlarmNameV2;
  when: number | null;
  periodInMinutes: number | null;
}

interface TrackedAlarmPortsV2 extends AlarmPortsV2 {
  calls: AlarmCallV2[];
  scheduled: Map<AlarmNameV2, number>;
}

interface PortOverridesV2 {
  create?: (name: AlarmNameV2, when: number) => Promise<void>;
  get?: (name: AlarmNameV2) => Promise<{ scheduledTime: number } | null>;
  clear?: (name: AlarmNameV2) => Promise<void>;
}

const PERIODIC_SCHEDULED_TIME: number = 1_750_000_060_000;
const WHEN: number = 1_750_000_000_000;

/** An in-memory alarms port that records every call, with per-test failure injection. */
function trackedPorts(overrides: PortOverridesV2 = {}): TrackedAlarmPortsV2 {
  const calls: AlarmCallV2[] = [];
  const scheduled: Map<AlarmNameV2, number> = new Map<AlarmNameV2, number>();
  return {
    calls,
    scheduled,
    create(name: AlarmNameV2, when: number): Promise<void> {
      calls.push({ op: 'create', name, when, periodInMinutes: null });
      if (overrides.create !== undefined) return overrides.create(name, when);
      scheduled.set(name, when);
      return Promise.resolve();
    },
    createPeriodic(name: AlarmNameV2, periodInMinutes: number): Promise<void> {
      calls.push({ op: 'createPeriodic', name, when: null, periodInMinutes });
      scheduled.set(name, PERIODIC_SCHEDULED_TIME);
      return Promise.resolve();
    },
    get(name: AlarmNameV2): Promise<{ scheduledTime: number } | null> {
      calls.push({ op: 'get', name, when: null, periodInMinutes: null });
      if (overrides.get !== undefined) return overrides.get(name);
      const scheduledTime: number | undefined = scheduled.get(name);
      return Promise.resolve(scheduledTime === undefined ? null : { scheduledTime });
    },
    clear(name: AlarmNameV2): Promise<void> {
      calls.push({ op: 'clear', name, when: null, periodInMinutes: null });
      if (overrides.clear !== undefined) return overrides.clear(name);
      scheduled.delete(name);
      return Promise.resolve();
    },
  };
}

function ops(ports: TrackedAlarmPortsV2): string[] {
  return ports.calls.map((call: AlarmCallV2): string => call.op);
}

function indefinitePauseSession(phaseEndsAt: number): SessionStateV2 {
  return untilStoppedFocusSession({
    phase: 'paused',
    phaseEndsAt,
    pausedFrom: { phase: 'focus', phaseEndsAt: null },
  });
}

describe('alarm names', () => {
  it('are the five static singletons of the inventory table', () => {
    expect(TICK_ALARM).toBe('tick');
    expect(PHASE_ALARM).toBe('phase');
    expect(TRANSITION_CLEANUP_ALARM).toBe('transition-cleanup');
    expect(CLOSURE_CLEANUP_ALARM).toBe('closure-cleanup');
    expect(DATA_CLEAR_RETRY_ALARM).toBe('data-clear-retry');
  });

  it('parse back to themselves', () => {
    const names: readonly AlarmNameV2[] = [
      TICK_ALARM,
      PHASE_ALARM,
      TRANSITION_CLEANUP_ALARM,
      CLOSURE_CLEANUP_ALARM,
      DATA_CLEAR_RETRY_ALARM,
    ];

    for (const name of names) {
      expect(parseAlarmNameV2(name)).toBe(name);
    }
  });

  it('rejects every other name', () => {
    const rejected: readonly string[] = [
      '',
      ' ',
      'Tick',
      'phase ',
      'session-end',
      'transition_cleanup',
      'data-clear',
      'toString',
      'constructor',
    ];

    for (const name of rejected) {
      expect(parseAlarmNameV2(name)).toBeNull();
    }
  });
});

describe('planPhaseAlarmV2', () => {
  it('plans the earlier of the phase end and the session end for timed focus', () => {
    const session: SessionStateV2 = timedFocusSession({
      phaseEndsAt: WHEN + 60_000,
      sessionEndsAt: WHEN + 120_000,
    });

    expect(planPhaseAlarmV2(session)).toBe(WHEN + 60_000);
  });

  it('plans the earlier of the break end and the session end for a timed break', () => {
    const session: SessionStateV2 = breakSession({
      phaseEndsAt: WHEN + 30_000,
      sessionEndsAt: WHEN + 120_000,
    });

    expect(planPhaseAlarmV2(session)).toBe(WHEN + 30_000);
  });

  it('plans the earlier of the pause expiry and the session end for a timed pause', () => {
    const session: SessionStateV2 = pausedSession({
      phaseEndsAt: WHEN + 90_000,
      sessionEndsAt: WHEN + 120_000,
    });

    expect(planPhaseAlarmV2(session)).toBe(WHEN + 90_000);
  });

  it('plans no alarm for indefinite focus', () => {
    expect(planPhaseAlarmV2(untilStoppedFocusSession())).toBeNull();
  });

  it('plans the finite pause expiry for an indefinite pause', () => {
    expect(planPhaseAlarmV2(indefinitePauseSession(WHEN + 45_000))).toBe(WHEN + 45_000);
  });

  it('takes the session end when the phase end runs past it', () => {
    const session: SessionStateV2 = timedFocusSession({
      phaseEndsAt: WHEN + 600_000,
      sessionEndsAt: WHEN + 120_000,
    });

    expect(planPhaseAlarmV2(session)).toBe(WHEN + 120_000);
  });

  it('throws an invalid-rule CoreError for a non-finite end', () => {
    const hostile: readonly SessionStateV2[] = [
      timedFocusSession({ phaseEndsAt: null }),
      timedFocusSession({ sessionEndsAt: null }),
      timedFocusSession({ phaseEndsAt: Number.POSITIVE_INFINITY }),
      timedFocusSession({ sessionEndsAt: Number.NaN }),
      indefinitePauseSession(Number.POSITIVE_INFINITY),
      untilStoppedFocusSession({
        phase: 'paused',
        phaseEndsAt: null,
        pausedFrom: { phase: 'focus', phaseEndsAt: null },
      }),
    ];

    for (const session of hostile) {
      expect((): number | null => planPhaseAlarmV2(session)).toThrow(CoreError);
    }
    try {
      planPhaseAlarmV2(timedFocusSession({ phaseEndsAt: null }));
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(CoreError);
      expect((error as CoreError).code).toBe('invalid-rule');
    }
  });
});

describe('createAlarmWithReadBackV2', () => {
  it('creates, reads back, and accepts only the exact scheduled time', async () => {
    const ports: TrackedAlarmPortsV2 = trackedPorts();

    const created: boolean = await createAlarmWithReadBackV2(ports, PHASE_ALARM, WHEN);

    expect(created).toBe(true);
    expect(ops(ports)).toEqual(['create', 'get']);
    expect(ports.calls[0]).toEqual({
      op: 'create',
      name: PHASE_ALARM,
      when: WHEN,
      periodInMinutes: null,
    });
  });

  it('rejects a read-back the browser rounded to the next minute', async () => {
    const ports: TrackedAlarmPortsV2 = trackedPorts({
      get: (): Promise<{ scheduledTime: number } | null> =>
        Promise.resolve({ scheduledTime: WHEN + 1 }),
    });

    expect(await createAlarmWithReadBackV2(ports, PHASE_ALARM, WHEN)).toBe(false);
  });

  it('rejects a missing read-back', async () => {
    const ports: TrackedAlarmPortsV2 = trackedPorts({
      get: (): Promise<{ scheduledTime: number } | null> => Promise.resolve(null),
    });

    expect(await createAlarmWithReadBackV2(ports, PHASE_ALARM, WHEN)).toBe(false);
  });

  it('reports a throwing create without reading back', async () => {
    const ports: TrackedAlarmPortsV2 = trackedPorts({
      create: (): Promise<void> => Promise.reject(new Error('alarms unavailable')),
    });

    expect(await createAlarmWithReadBackV2(ports, PHASE_ALARM, WHEN)).toBe(false);
    expect(ops(ports)).toEqual(['create']);
  });

  it('reports a throwing read-back', async () => {
    const ports: TrackedAlarmPortsV2 = trackedPorts({
      get: (): Promise<{ scheduledTime: number } | null> =>
        Promise.reject(new Error('alarms unavailable')),
    });

    expect(await createAlarmWithReadBackV2(ports, PHASE_ALARM, WHEN)).toBe(false);
  });
});

describe('clearAlarmWithReadBackV2', () => {
  it('clears and confirms absence', async () => {
    const ports: TrackedAlarmPortsV2 = trackedPorts();
    await createAlarmWithReadBackV2(ports, PHASE_ALARM, WHEN);
    ports.calls.length = 0;

    const cleared: boolean = await clearAlarmWithReadBackV2(ports, PHASE_ALARM);

    expect(cleared).toBe(true);
    expect(ops(ports)).toEqual(['clear', 'get']);
    expect(ports.scheduled.has(PHASE_ALARM)).toBe(false);
  });

  it('reports an alarm that survived the clear', async () => {
    const ports: TrackedAlarmPortsV2 = trackedPorts({
      clear: (): Promise<void> => Promise.resolve(),
      get: (): Promise<{ scheduledTime: number } | null> =>
        Promise.resolve({ scheduledTime: WHEN }),
    });

    expect(await clearAlarmWithReadBackV2(ports, PHASE_ALARM)).toBe(false);
  });

  it('reports a throwing clear without reading back', async () => {
    const ports: TrackedAlarmPortsV2 = trackedPorts({
      clear: (): Promise<void> => Promise.reject(new Error('alarms unavailable')),
    });

    expect(await clearAlarmWithReadBackV2(ports, PHASE_ALARM)).toBe(false);
    expect(ops(ports)).toEqual(['clear']);
  });
});

describe('ensurePhaseAlarmV2', () => {
  it('clears and reads back when no session owns the alarm', async () => {
    const ports: TrackedAlarmPortsV2 = trackedPorts();
    await createAlarmWithReadBackV2(ports, PHASE_ALARM, WHEN);
    ports.calls.length = 0;

    const outcome: 'ready' | 'alarm-failed' = await ensurePhaseAlarmV2(ports, null);

    expect(outcome).toBe('ready');
    expect(ops(ports)).toEqual(['clear', 'get']);
    expect(ports.scheduled.has(PHASE_ALARM)).toBe(false);
  });

  it('clears for an indefinite focus session, which owns no phase alarm', async () => {
    const ports: TrackedAlarmPortsV2 = trackedPorts();

    const outcome: 'ready' | 'alarm-failed' = await ensurePhaseAlarmV2(
      ports,
      untilStoppedFocusSession(),
    );

    expect(outcome).toBe('ready');
    expect(ops(ports)).toEqual(['clear', 'get']);
    expect(ports.calls[0]?.name).toBe(PHASE_ALARM);
  });

  it('creates the planned boundary and reads it back for a timed session', async () => {
    const ports: TrackedAlarmPortsV2 = trackedPorts();
    const session: SessionStateV2 = timedFocusSession({
      phaseEndsAt: WHEN + 60_000,
      sessionEndsAt: WHEN + 120_000,
    });

    const outcome: 'ready' | 'alarm-failed' = await ensurePhaseAlarmV2(ports, session);

    expect(outcome).toBe('ready');
    expect(ops(ports)).toEqual(['create', 'get']);
    expect(ports.calls[0]?.when).toBe(planPhaseAlarmV2(session));
    expect(ports.scheduled.get(PHASE_ALARM)).toBe(WHEN + 60_000);
  });

  it('reports alarm-failed when the created alarm reads back at another time', async () => {
    const ports: TrackedAlarmPortsV2 = trackedPorts({
      get: (): Promise<{ scheduledTime: number } | null> =>
        Promise.resolve({ scheduledTime: WHEN }),
    });

    const outcome: 'ready' | 'alarm-failed' = await ensurePhaseAlarmV2(
      ports,
      timedFocusSession({ phaseEndsAt: WHEN + 60_000, sessionEndsAt: WHEN + 120_000 }),
    );

    expect(outcome).toBe('alarm-failed');
  });

  it('reports alarm-failed when a clear cannot be confirmed', async () => {
    const ports: TrackedAlarmPortsV2 = trackedPorts({
      clear: (): Promise<void> => Promise.resolve(),
      get: (): Promise<{ scheduledTime: number } | null> =>
        Promise.resolve({ scheduledTime: WHEN }),
    });

    expect(await ensurePhaseAlarmV2(ports, null)).toBe('alarm-failed');
  });

  it('is idempotent across a restart: the same session plans and reads back the same time twice', async () => {
    const ports: TrackedAlarmPortsV2 = trackedPorts();
    const session: SessionStateV2 = timedFocusSession({
      phaseEndsAt: WHEN + 60_000,
      sessionEndsAt: WHEN + 120_000,
    });

    const first: 'ready' | 'alarm-failed' = await ensurePhaseAlarmV2(ports, session);
    const second: 'ready' | 'alarm-failed' = await ensurePhaseAlarmV2(ports, session);

    expect([first, second]).toEqual(['ready', 'ready']);
    expect(ops(ports)).toEqual(['create', 'get', 'create', 'get']);
    expect(ports.calls[0]?.when).toBe(ports.calls[2]?.when);
    expect(ports.scheduled.size).toBe(1);
  });

  it('propagates the plan failure for a session with a non-finite end', async () => {
    const ports: TrackedAlarmPortsV2 = trackedPorts();

    await expect(
      ensurePhaseAlarmV2(ports, timedFocusSession({ phaseEndsAt: null })),
    ).rejects.toBeInstanceOf(CoreError);
    expect(ops(ports)).toEqual([]);
  });
});

describe('ensureTickAlarmV2', () => {
  it('creates the one-minute periodic tick', async () => {
    const ports: TrackedAlarmPortsV2 = trackedPorts();

    await ensureTickAlarmV2(ports);

    expect(ports.calls).toEqual([
      { op: 'createPeriodic', name: TICK_ALARM, when: null, periodInMinutes: 1 },
    ]);
  });

  it('replaces the tick by name on every boot', async () => {
    const ports: TrackedAlarmPortsV2 = trackedPorts();

    await ensureTickAlarmV2(ports);
    await ensureTickAlarmV2(ports);

    expect(ops(ports)).toEqual(['createPeriodic', 'createPeriodic']);
    expect(ports.scheduled.size).toBe(1);
  });
});

describe('session fixture sanity', () => {
  it('keeps the timed configuration the plan branches on', () => {
    expect(sessionConfigV2().duration).toEqual({ kind: 'timed', minutes: 25 });
    expect(untilStoppedFocusSession().config.duration).toEqual({ kind: 'until-stopped' });
  });
});

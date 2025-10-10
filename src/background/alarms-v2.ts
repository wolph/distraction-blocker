/**
 * The five static alarm singletons, the exact `phase` alarm plan, and the read-back every owned
 * alarm write must pass. Pure functions over an injected port: nothing here touches a chrome API,
 * a clock, or storage, so the worker owns both the port and what an `alarm-failed` outcome means.
 */

import { CoreError } from '../shared/errors';
import type { SessionStateV2 } from '../shared/types';

/** One-minute periodic maintenance and schedule checks. Owned by the global worker. */
export const TICK_ALARM: 'tick' = 'tick';
/** The single next session boundary. Owned by a durable session, including a pending commit. */
export const PHASE_ALARM: 'phase' = 'phase';
/** The next bounded transition cleanup retry. Owned by a pending transition in cleanup. */
export const TRANSITION_CLEANUP_ALARM: 'transition-cleanup' = 'transition-cleanup';
/** The next bounded closure cleanup retry. Owned by a pending closure in cleanup. */
export const CLOSURE_CLEANUP_ALARM: 'closure-cleanup' = 'closure-cleanup';
/** The next bounded all-data retry. Owned by the main all-data phase dispatcher. */
export const DATA_CLEAR_RETRY_ALARM: 'data-clear-retry' = 'data-clear-retry';

export type AlarmNameV2 =
  | typeof TICK_ALARM
  | typeof PHASE_ALARM
  | typeof TRANSITION_CLEANUP_ALARM
  | typeof CLOSURE_CLEANUP_ALARM
  | typeof DATA_CLEAR_RETRY_ALARM;

export interface AlarmPortsV2 {
  create(name: AlarmNameV2, when: number): Promise<void>;
  createPeriodic(name: AlarmNameV2, periodInMinutes: number): Promise<void>;
  get(name: AlarmNameV2): Promise<{ scheduledTime: number } | null>;
  clear(name: AlarmNameV2): Promise<void>;
}

/** The tick period the spec fixes for install and every boot. */
const TICK_PERIOD_MINUTES: number = 1;
const ALARM_NAMES: ReadonlySet<string> = new Set<string>([
  TICK_ALARM,
  PHASE_ALARM,
  TRANSITION_CLEANUP_ALARM,
  CLOSURE_CLEANUP_ALARM,
  DATA_CLEAR_RETRY_ALARM,
]);

/** The listener dispatches by name, so an unknown wake resolves to null instead of a guess. */
export function parseAlarmNameV2(name: string): AlarmNameV2 | null {
  return ALARM_NAMES.has(name) ? (name as AlarmNameV2) : null;
}

/**
 * Returns the exact `phase` boundary for a session, or null when it owns no alarm. A timed session
 * takes the earlier of its phase end and its session end, whichever phase it is in, because the one
 * singleton also owns the fixed session end. Indefinite focus owns no boundary at all, and an
 * indefinite non-focus phase owns its own finite expiry. A missing or non-finite end is a broken
 * durable session rather than a plan, so it raises instead of scheduling an arbitrary time.
 */
export function planPhaseAlarmV2(session: SessionStateV2): number | null {
  if (session.config.duration.kind === 'until-stopped') {
    if (session.phase === 'focus') return null;
    return finiteBoundary(session.phaseEndsAt, 'phaseEndsAt');
  }
  return Math.min(
    finiteBoundary(session.phaseEndsAt, 'phaseEndsAt'),
    finiteBoundary(session.sessionEndsAt, 'sessionEndsAt'),
  );
}

/**
 * Creates one owned alarm and confirms it by reading it back at exactly the requested time. A
 * browser that rounded, dropped, or refused the write reports false, and the caller enters its
 * cleanup path rather than trusting an alarm it never verified.
 */
export async function createAlarmWithReadBackV2(
  ports: AlarmPortsV2,
  name: AlarmNameV2,
  when: number,
): Promise<boolean> {
  try {
    await ports.create(name, when);
    const alarm: { scheduledTime: number } | null = await ports.get(name);
    return alarm !== null && alarm.scheduledTime === when;
  } catch {
    return false;
  }
}

/** Clears one owned alarm and confirms its absence. A surviving alarm reports false. */
export async function clearAlarmWithReadBackV2(
  ports: AlarmPortsV2,
  name: AlarmNameV2,
): Promise<boolean> {
  try {
    await ports.clear(name);
    return (await ports.get(name)) === null;
  } catch {
    return false;
  }
}

/**
 * Brings the single `phase` alarm in line with the session that owns it. No session and indefinite
 * focus both clear it, every other session creates its planned boundary, and each answer is read
 * back before this reports `ready`. Creation replaces by name, so repeating the same session is
 * idempotent. A session whose ends are not finite raises `CoreError` instead of reporting failure:
 * that is broken durable state, not an alarm the browser refused.
 */
export async function ensurePhaseAlarmV2(
  ports: AlarmPortsV2,
  session: SessionStateV2 | null,
): Promise<'ready' | 'alarm-failed'> {
  const when: number | null = session === null ? null : planPhaseAlarmV2(session);
  const settled: boolean =
    when === null
      ? await clearAlarmWithReadBackV2(ports, PHASE_ALARM)
      : await createAlarmWithReadBackV2(ports, PHASE_ALARM, when);
  return settled ? 'ready' : 'alarm-failed';
}

/**
 * Creates the periodic tick at install and every boot. Creation replaces by name, so calling it on
 * a worker that already has one is a no-op with the same period.
 */
export async function ensureTickAlarmV2(ports: AlarmPortsV2): Promise<void> {
  await ports.createPeriodic(TICK_ALARM, TICK_PERIOD_MINUTES);
}

function finiteBoundary(value: number | null, field: string): number {
  if (value === null || !Number.isFinite(value)) {
    throw new CoreError('invalid-rule', `session ${field} is not a finite alarm boundary`);
  }
  return value;
}

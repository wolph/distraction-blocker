/**
 * The five static alarm singletons, the exact `phase` alarm plan, and the read-back every owned
 * alarm write must pass. Pure functions over an injected `AlarmPortsV2`: nothing here touches a
 * chrome API, a clock, or storage, so the worker owns both the port and what an `alarm-failed`
 * outcome means.
 *
 * Every creation here is followed by a `get` that validates the exact intended role and time, as
 * the spec requires of all alarm creation. A one-shot alarm must read back at exactly its requested
 * time and with no period. The periodic tick has no caller-chosen time, so its verifiable half is
 * existence plus its exact period. `ensureTickAlarmV2` therefore answers `'ready' | 'alarm-failed'`
 * like `ensurePhaseAlarmV2`, not `void`: a consumer that ignores the answer keeps a worker whose
 * periodic maintenance may never have been registered.
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

/** One read-back row. `periodInMinutes` is null for a one-shot alarm. */
export interface ScheduledAlarmV2 {
  scheduledTime: number;
  periodInMinutes: number | null;
}

/**
 * The alarm surface this module drives. The adapter that wraps `chrome.alarms` owns two mappings:
 * a missing alarm, which the Chrome API resolves as `undefined`, must become `null`, and an absent
 * `periodInMinutes` on a one-shot alarm must become `null`. Reporting `undefined` for either would
 * fail every read-back here and route the worker into cleanup forever.
 */
export interface AlarmPortsV2 {
  create(name: AlarmNameV2, when: number): Promise<void>;
  createPeriodic(name: AlarmNameV2, periodInMinutes: number): Promise<void>;
  get(name: AlarmNameV2): Promise<ScheduledAlarmV2 | null>;
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
 * Creates one owned one-shot alarm and confirms it by reading it back at exactly the requested time
 * and in its one-shot role. A browser that rounded, dropped, refused, or made it periodic reports
 * false, and the caller enters its cleanup path rather than trusting an alarm it never verified.
 */
export function createAlarmWithReadBackV2(
  ports: AlarmPortsV2,
  name: AlarmNameV2,
  when: number,
): Promise<boolean> {
  return createWithReadBack(
    ports,
    name,
    (): Promise<void> => ports.create(name, when),
    (alarm: ScheduledAlarmV2): boolean =>
      alarm.scheduledTime === when && alarm.periodInMinutes === null,
  );
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
 * Creates the periodic tick at install and every boot, then reads it back. Creation replaces by
 * name, so calling it on a worker that already has one is idempotent. A periodic alarm has no
 * caller-chosen time, so the read-back validates the half that is verifiable: the alarm exists and
 * carries exactly the one-minute period. Anything else answers `alarm-failed`, so a silent no-op
 * cannot leave the worker without periodic maintenance and schedule checks.
 */
export async function ensureTickAlarmV2(ports: AlarmPortsV2): Promise<'ready' | 'alarm-failed'> {
  const created: boolean = await createWithReadBack(
    ports,
    TICK_ALARM,
    (): Promise<void> => ports.createPeriodic(TICK_ALARM, TICK_PERIOD_MINUTES),
    (alarm: ScheduledAlarmV2): boolean => alarm.periodInMinutes === TICK_PERIOD_MINUTES,
  );
  return created ? 'ready' : 'alarm-failed';
}

/** Creates through the caller's port call, then reports whether the read-back proves the intent. */
async function createWithReadBack(
  ports: AlarmPortsV2,
  name: AlarmNameV2,
  create: () => Promise<void>,
  matches: (alarm: ScheduledAlarmV2) => boolean,
): Promise<boolean> {
  try {
    await create();
    const alarm: ScheduledAlarmV2 | null = await ports.get(name);
    return alarm !== null && matches(alarm);
  } catch {
    return false;
  }
}

function finiteBoundary(value: number | null, field: string): number {
  if (value === null || !Number.isFinite(value)) {
    throw new CoreError('invalid-rule', `session ${field} is not a finite alarm boundary`);
  }
  return value;
}

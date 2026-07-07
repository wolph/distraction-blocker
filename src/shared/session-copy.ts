import { formatMinutes } from './format';
import type {
  CycleConfig,
  GateSettings,
  SessionDuration,
  SessionEndReasonV2,
  Strictness,
} from './types';

/** Duration control, the start button, and the forced cycle disclosure. */
export const UNTIL_STOPPED_LABEL: string = 'Until stopped';
/** The Until stopped chip shows this glyph and carries UNTIL_STOPPED_LABEL as its name. */
export const INFINITY_GLYPH: string = '∞';
/** Positional labels for the three timed presets, read after the minutes: "50 deep work". */
export const PRESET_LABELS: readonly [string, string, string] = ['short', 'focus', 'deep work'];
/** The hover explanation of the deep work chip. The label itself stays short. */
export const DEEP_WORK_NOTE: string =
  'A preference, not science: one long uninterrupted block, with no automatic breaks.';

/**
 * The hint under the presets for a timed draft. Cycles only interrupt a session longer than one
 * focus block, so a 25 minute session under 25 minute blocks reads as uninterrupted.
 */
export function timedDurationHint(minutes: number, cycling: CycleConfig | null): string {
  if (cycling !== null && cycling.focusMin < minutes) {
    return `${minutes} min total, with ${cycling.focusMin} min focus blocks`;
  }
  return `${minutes} min uninterrupted focus`;
}
/** The start button of a Flexible until-stopped draft. */
export const START_UNTIL_STOPPED_LABEL: string = 'Start until stopped';
/** The start button of a Friction until-stopped draft, which ends through its gate. */
export const LOCK_UNTIL_MANUAL_UNLOCK_LABEL: string = 'Lock until manual unlock';
export const UNTIL_STOPPED_DISCLOSURE: string =
  'Until stopped sessions keep Flexible or Friction and cannot use focus and break cycles.';
/**
 * Why Hard lock is disabled while Until stopped is selected. One sentence, rendered on the
 * choice itself in the popup and next to the schedule editor's radio.
 */
export const HARD_UNAVAILABLE_REASON: string =
  'Hard lock is not available for Until stopped: with no timer and no manual end, the session could never end.';
export const END_SESSION_LABEL: string = 'End session';
/** The End control and the gate confirm of a Friction until-stopped session. */
export const UNLOCK_LABEL: string = 'Unlock';

function formatDelaySeconds(delayMs: number): string {
  const seconds: number = delayMs / 1_000;
  return Number.isInteger(seconds) ? String(seconds) : String(Number(seconds.toFixed(3)));
}

/** The deliberation wait as a phrase: "no wait" or "a 10-second wait". */
export function formatGateWait(delayMs: number): string {
  return delayMs === 0 ? 'no wait' : `a ${formatDelaySeconds(delayMs)}-second wait`;
}

/**
 * The hint under the duration control while Until stopped is selected. It says how the session
 * will end before it starts, with the configured wait and phrase for Friction, and that cycles are
 * off. Hard never reaches this hint, because the draft clamps it away from Until stopped.
 */
export function untilStoppedHint(
  strictness: Exclude<Strictness, 'hard'>,
  gate: Pick<GateSettings, 'delayMs' | 'requireTypedPhrase'>,
): string {
  if (strictness === 'flexible') {
    return `Runs until you end it with ${END_SESSION_LABEL}. Cycles off.`;
  }
  const wait: string = formatGateWait(gate.delayMs);
  const requirement: string = gate.requireTypedPhrase ? `${wait} and a typed sentence` : wait;
  return `Runs until you unlock it: ${requirement}, then ${UNLOCK_LABEL}. Cycles off.`;
}

/**
 * The accessible name of the forced cycles group. Both the popup start form and the schedule
 * editor render it, and a screen reader is the only place it is heard, so a copy that drifted
 * in one file would be invisible to sighted review.
 */
export const FORCED_CYCLES_LABEL: string = 'Cycles forced by Until stopped';

/**
 * The two blocking modes, named once. The start button reads the same pair the mode radios
 * render, so renaming one used to leave the button and the radio disagreeing.
 */
export const MODE_LABELS: { blacklist: string; whitelist: string } = {
  blacklist: 'Block selected sites',
  whitelist: 'Allow selected sites only',
};

/** Clock labels. Focus time is wall-clock time in the focus phase. */
export const FOCUS_TIME_LABEL: string = 'Focus time';
export const FOCUS_PHASE_CLOCK_LABEL: string = 'focus phase';
export const TOTAL_SESSION_CLOCK_LABEL: string = 'total session';
export const PAUSE_CLOCK_LABEL: string = 'pause';
export const BREAK_CLOCK_LABEL: string = 'break';

/** Shown on the toolbar badge while a session runs with no finite end. */
export const INDEFINITE_BADGE_TEXT: string = 'ON';

/** Popup lifecycle and command errors. */
export const POPUP_STARTING_COPY: string = 'Focus Lock is starting. Applying your selected rules.';
export const POPUP_CLOSURE_CLEANUP_COPY: string = 'Session ended. Finishing browser cleanup.';
export const POPUP_TRANSITION_CLEANUP_COPY: string =
  'Focus Lock could not start. Finishing browser cleanup.';
export const POPUP_TRANSITION_ERROR_COPY: string =
  'Focus Lock could not clean up an incomplete start.';
export const POPUP_CLOSURE_ERROR_COPY: string = 'Focus Lock could not finish browser cleanup.';
export const RETRY_CLEANUP_LABEL: string = 'Retry cleanup';
export const END_FAILED_COPY: string = 'Could not end session. Try again.';
export const RETRY_FAILED_COPY: string = 'Could not retry cleanup. Try again.';
export const ACTION_FAILED_COPY: string = 'Could not request that action. Try again.';
export const DATA_CLEAR_PENDING_COPY: string = 'Deleting Focus Lock data. Finishing cleanup.';
export const DATA_CLEAR_ERROR_COPY: string = 'Could not delete data. Try again.';

/** Schedule editor and the scheduled start notification. */
export const SCHEDULE_WINDOW_LABEL: string = 'Until window ends';
export const SCHEDULE_UNTIL_STOPPED_COPY: string =
  'Starts on schedule and runs until you stop it: End session for Flexible, Unlock through the deliberation gate for Friction. Cycles off.';
export const SCHEDULE_STARTED_TITLE: string = 'Focus schedule started';
export const SCHEDULE_UNTIL_STOPPED_BODY: string = 'Active until you stop it.';

/** Settings, which is read-only for active session control. */
export const SETTINGS_INDEFINITE_COPY: string =
  'Until stopped session active. Use the toolbar popup to view or end it.';
export const SETTINGS_STARTING_COPY: string =
  'Focus Lock is starting. Checking website access and applying your rules.';
/**
 * The specification lists this line in two sections, so two names are right. Two independent
 * literals were not: editing the popup line left Settings on the old wording, and the copy test
 * would have passed because it spelled the string twice as well.
 */
export const SETTINGS_CLEANUP_COPY: string = POPUP_CLOSURE_CLEANUP_COPY;
export const SETTINGS_ERROR_COPY: string =
  'Focus Lock could not finish browser cleanup. Open the popup and retry.';
export const SETTINGS_SESSION_DISCLOSURE: string =
  'The toolbar popup owns session controls. The active session keeps the rules captured when it started.';

/** Settings copy for an active timed session, ending at a local "HH:MM" wall clock. */
export function settingsTimedCopy(endsAtHhMm: string): string {
  return `Timed session active until ${endsAtHhMm}. It ends automatically. Use the toolbar popup for live status.`;
}

const STATS_OUTCOME_LABELS: Record<SessionEndReasonV2, string> = {
  'timer-completed': 'Completed',
  'manual-completed': 'Completed manually',
  'manual-canceled': 'Ended early',
  'website-access-lost': 'Ended: website access lost',
  'content-registration-failed': 'Ended: blocking setup failed',
  'alarm-failed': 'Ended: timer setup failed',
  'tab-enforcement-failed': 'Ended: page enforcement failed',
  'invalid-active-state': 'Ended: recovery failed',
};

/** Stats outcome wording for one ended session. */
export function statsOutcomeLabelV2(reason: SessionEndReasonV2): string {
  return STATS_OUTCOME_LABELS[reason];
}

/** Stats plan wording for one session, "Until stopped" or the planned length. */
export function statsPlanLabelV2(duration: SessionDuration): string {
  return duration.kind === 'until-stopped' ? UNTIL_STOPPED_LABEL : formatMinutes(duration.minutes);
}

import { formatMinutes } from './format';
import type { SessionDuration, SessionEndReasonV2 } from './types';

/** Duration control and the forced session type and cycle disclosure. */
export const UNTIL_STOPPED_LABEL: string = 'Until stopped';
export const START_UNTIL_STOPPED_LABEL: string = 'Start until stopped';
export const UNTIL_STOPPED_FORCED_HINT: string =
  'Flexible session. Cycles off. End it manually from the popup.';
export const UNTIL_STOPPED_DISCLOSURE: string =
  'Until stopped sessions use Flexible blocking and cannot use focus and break cycles.';
export const END_SESSION_LABEL: string = 'End session';

/** Clock labels. Focus time is wall-clock time in the focus phase. */
export const FOCUS_TIME_LABEL: string = 'Focus time';
export const FOCUS_PHASE_CLOCK_LABEL: string = 'focus phase';
export const TOTAL_SESSION_CLOCK_LABEL: string = 'total session';

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
export const DATA_CLEAR_PENDING_COPY: string = 'Deleting Focus Lock data. Finishing cleanup.';
export const DATA_CLEAR_ERROR_COPY: string = 'Could not delete data. Try again.';

/** Schedule editor and the scheduled start notification. */
export const SCHEDULE_WINDOW_LABEL: string = 'Until window ends';
export const SCHEDULE_UNTIL_STOPPED_COPY: string =
  'Starts on schedule and continues until you end it manually.';
export const SCHEDULE_STARTED_TITLE: string = 'Focus schedule started';
export const SCHEDULE_UNTIL_STOPPED_BODY: string = 'Active until you end it manually.';

/** Settings, which is read-only for active session control. */
export const SETTINGS_INDEFINITE_COPY: string =
  'Until stopped session active. Use the toolbar popup to view or end it.';
export const SETTINGS_STARTING_COPY: string =
  'Focus Lock is starting. Checking website access and applying your rules.';
export const SETTINGS_CLEANUP_COPY: string = 'Session ended. Finishing browser cleanup.';
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

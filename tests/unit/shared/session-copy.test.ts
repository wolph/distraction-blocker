import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTION_FAILED_COPY,
  BREAK_CLOCK_LABEL,
  DATA_CLEAR_ERROR_COPY,
  DATA_CLEAR_PENDING_COPY,
  END_FAILED_COPY,
  END_SESSION_LABEL,
  FOCUS_PHASE_CLOCK_LABEL,
  FOCUS_TIME_LABEL,
  INDEFINITE_BADGE_TEXT,
  PAUSE_CLOCK_LABEL,
  POPUP_CLOSURE_CLEANUP_COPY,
  POPUP_CLOSURE_ERROR_COPY,
  POPUP_STARTING_COPY,
  POPUP_TRANSITION_CLEANUP_COPY,
  POPUP_TRANSITION_ERROR_COPY,
  RETRY_CLEANUP_LABEL,
  RETRY_FAILED_COPY,
  SCHEDULE_STARTED_TITLE,
  SCHEDULE_UNTIL_STOPPED_BODY,
  SCHEDULE_UNTIL_STOPPED_COPY,
  SCHEDULE_WINDOW_LABEL,
  SETTINGS_CLEANUP_COPY,
  SETTINGS_ERROR_COPY,
  SETTINGS_INDEFINITE_COPY,
  SETTINGS_SESSION_DISCLOSURE,
  SETTINGS_STARTING_COPY,
  START_UNTIL_STOPPED_LABEL,
  settingsTimedCopy,
  statsOutcomeLabelV2,
  statsPlanLabelV2,
  TOTAL_SESSION_CLOCK_LABEL,
  UNTIL_STOPPED_DISCLOSURE,
  UNTIL_STOPPED_FORCED_HINT,
  UNTIL_STOPPED_LABEL,
} from '../../../src/shared/session-copy';
import type { SessionDuration, SessionEndReasonV2 } from '../../../src/shared/types';

const OUTCOME_LABELS: ReadonlyArray<readonly [SessionEndReasonV2, string]> = [
  ['timer-completed', 'Completed'],
  ['manual-completed', 'Completed manually'],
  ['manual-canceled', 'Ended early'],
  ['website-access-lost', 'Ended: website access lost'],
  ['content-registration-failed', 'Ended: blocking setup failed'],
  ['alarm-failed', 'Ended: timer setup failed'],
  ['tab-enforcement-failed', 'Ended: page enforcement failed'],
  ['invalid-active-state', 'Ended: recovery failed'],
];

describe('session copy', (): void => {
  it('publishes the exact duration and forced-control copy', (): void => {
    expect(UNTIL_STOPPED_LABEL).toBe('Until stopped');
    expect(START_UNTIL_STOPPED_LABEL).toBe('Start until stopped');
    expect(UNTIL_STOPPED_FORCED_HINT).toBe(
      'Flexible session. Cycles off. End it manually from the popup.',
    );
    expect(UNTIL_STOPPED_DISCLOSURE).toBe(
      'Until stopped sessions use Flexible blocking and cannot use focus and break cycles.',
    );
    expect(END_SESSION_LABEL).toBe('End session');
  });

  it('publishes the exact clock labels', (): void => {
    expect(FOCUS_TIME_LABEL).toBe('Focus time');
    expect(FOCUS_PHASE_CLOCK_LABEL).toBe('focus phase');
    expect(TOTAL_SESSION_CLOCK_LABEL).toBe('total session');
    expect(PAUSE_CLOCK_LABEL).toBe('pause');
    expect(BREAK_CLOCK_LABEL).toBe('break');
  });

  it('publishes the exact badge text', (): void => {
    expect(INDEFINITE_BADGE_TEXT).toBe('ON');
  });

  it('publishes the exact popup lifecycle and command error copy', (): void => {
    expect(POPUP_STARTING_COPY).toBe('Focus Lock is starting. Applying your selected rules.');
    expect(POPUP_CLOSURE_CLEANUP_COPY).toBe('Session ended. Finishing browser cleanup.');
    expect(POPUP_TRANSITION_CLEANUP_COPY).toBe(
      'Focus Lock could not start. Finishing browser cleanup.',
    );
    expect(POPUP_TRANSITION_ERROR_COPY).toBe('Focus Lock could not clean up an incomplete start.');
    expect(POPUP_CLOSURE_ERROR_COPY).toBe('Focus Lock could not finish browser cleanup.');
    expect(RETRY_CLEANUP_LABEL).toBe('Retry cleanup');
    expect(END_FAILED_COPY).toBe('Could not end session. Try again.');
    expect(RETRY_FAILED_COPY).toBe('Could not retry cleanup. Try again.');
    expect(ACTION_FAILED_COPY).toBe('Could not request that action. Try again.');
    expect(DATA_CLEAR_PENDING_COPY).toBe('Deleting Focus Lock data. Finishing cleanup.');
    expect(DATA_CLEAR_ERROR_COPY).toBe('Could not delete data. Try again.');
  });

  it('publishes the exact schedule copy', (): void => {
    expect(SCHEDULE_WINDOW_LABEL).toBe('Until window ends');
    expect(SCHEDULE_UNTIL_STOPPED_COPY).toBe(
      'Starts on schedule and continues until you end it manually.',
    );
    expect(SCHEDULE_STARTED_TITLE).toBe('Focus schedule started');
    expect(SCHEDULE_UNTIL_STOPPED_BODY).toBe('Active until you end it manually.');
  });

  it('publishes the exact Settings session copy', (): void => {
    expect(SETTINGS_INDEFINITE_COPY).toBe(
      'Until stopped session active. Use the toolbar popup to view or end it.',
    );
    expect(settingsTimedCopy('14:30')).toBe(
      'Timed session active until 14:30. It ends automatically. Use the toolbar popup for live status.',
    );
    expect(settingsTimedCopy('09:05')).toBe(
      'Timed session active until 09:05. It ends automatically. Use the toolbar popup for live status.',
    );
    expect(SETTINGS_STARTING_COPY).toBe(
      'Focus Lock is starting. Checking website access and applying your rules.',
    );
    expect(SETTINGS_CLEANUP_COPY).toBe('Session ended. Finishing browser cleanup.');
    expect(SETTINGS_ERROR_COPY).toBe(
      'Focus Lock could not finish browser cleanup. Open the popup and retry.',
    );
    expect(SETTINGS_SESSION_DISCLOSURE).toBe(
      'The toolbar popup owns session controls. The active session keeps the rules captured when it started.',
    );
  });

  it('maps every v2 end reason to its Stats wording', (): void => {
    for (const [reason, label] of OUTCOME_LABELS) {
      expect(statsOutcomeLabelV2(reason)).toBe(label);
    }
  });

  it('labels the Stats plan column for both durations', (): void => {
    const indefinite: SessionDuration = { kind: 'until-stopped' };
    const timed: SessionDuration = { kind: 'timed', minutes: 25 };
    const long: SessionDuration = { kind: 'timed', minutes: 90 };

    expect(statsPlanLabelV2(indefinite)).toBe('Until stopped');
    expect(statsPlanLabelV2(timed)).toBe('25 m');
    expect(statsPlanLabelV2(long)).toBe('1 h 30 m');
  });

  it('never describes focus time as active computer use', (): void => {
    const source: string = readFileSync(resolve('src/shared/session-copy.ts'), 'utf8');
    const lowered: string = source.toLowerCase();

    for (const term of ['active computer use', 'keyboard', 'mouse']) {
      expect(lowered).not.toContain(term);
    }
    expect(source).toContain("'Focus time'");
  });
});

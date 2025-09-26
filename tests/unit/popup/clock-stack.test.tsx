/** @vitest-environment jsdom */
import './chrome-fake';

import { cleanup, render } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { BREAK_CLOCK_LABEL, ClockStack, PAUSE_CLOCK_LABEL } from '../../../src/popup/ClockStack';
import {
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  emptySnapshotV2,
  rulesFromLists,
} from '../../../src/shared/constants';
import {
  FOCUS_PHASE_CLOCK_LABEL,
  FOCUS_TIME_LABEL,
  TOTAL_SESSION_CLOCK_LABEL,
  UNTIL_STOPPED_LABEL,
} from '../../../src/shared/session-copy';
import type { SessionConfigV2, SessionSnapshotV2 } from '../../../src/shared/types';

const NOW: number = 1_700_000_000_000;
const MIN: number = 60_000;

const TIMED_CYCLING_CONFIG: SessionConfigV2 = {
  mode: 'blacklist',
  strictness: 'friction',
  duration: { kind: 'timed', minutes: 50 },
  cycling: DEFAULT_SETTINGS.defaultCycling,
  intention: 'write the report',
  source: 'manual',
  scheduleOccurrence: null,
  rules: rulesFromLists(DEFAULT_LISTS),
};

const INDEFINITE_CONFIG: SessionConfigV2 = {
  ...TIMED_CYCLING_CONFIG,
  strictness: 'flexible',
  duration: { kind: 'until-stopped' },
  cycling: null,
};

/** A 50 minute session whose first 25 minute focus phase just started. */
function timedCyclingFocus(): SessionSnapshotV2 {
  return {
    ...emptySnapshotV2(NOW),
    lifecycle: { kind: 'active', endAuthority: { kind: 'immediate', actionLabel: 'End session' } },
    phase: 'focus',
    config: TIMED_CYCLING_CONFIG,
    startedAt: NOW,
    phaseStartedAt: NOW,
    phaseEndsAt: NOW + 25 * MIN,
    sessionEndsAt: NOW + 50 * MIN,
  };
}

/** The same 50 minute session with cycles off, so one phase spans the session. */
function timedSingleFocus(): SessionSnapshotV2 {
  return {
    ...timedCyclingFocus(),
    config: { ...TIMED_CYCLING_CONFIG, cycling: null },
    phaseEndsAt: NOW + 50 * MIN,
  };
}

function timedPause(): SessionSnapshotV2 {
  return {
    ...timedCyclingFocus(),
    phase: 'paused',
    phaseStartedAt: NOW,
    phaseEndsAt: NOW + 5 * MIN,
  };
}

function indefiniteFocus(focusedMs: number): SessionSnapshotV2 {
  return {
    ...emptySnapshotV2(NOW),
    lifecycle: { kind: 'active', endAuthority: { kind: 'immediate', actionLabel: 'End session' } },
    phase: 'focus',
    config: INDEFINITE_CONFIG,
    startedAt: NOW - focusedMs,
    phaseStartedAt: NOW - focusedMs,
    phaseEndsAt: null,
    sessionEndsAt: null,
    sessionFocusedMs: focusedMs,
  };
}

function indefinitePause(focusedMs: number): SessionSnapshotV2 {
  return {
    ...indefiniteFocus(focusedMs),
    phase: 'paused',
    phaseStartedAt: NOW,
    phaseEndsAt: NOW + 5 * MIN,
  };
}

interface ClockRow {
  value: string;
  label: string;
}

function rows(container: Element): ClockRow[] {
  return Array.from(container.querySelectorAll('.clock-stack__row')).map(
    (row: Element): ClockRow => ({
      value: (row.querySelector('.clock-stack__value')?.textContent ?? '').trim(),
      label: (row.querySelector('.clock-stack__label')?.textContent ?? '').trim(),
    }),
  );
}

afterEach((): void => {
  cleanup();
});

describe('ClockStack', (): void => {
  it('shows the focus phase first and the total session second while timed cycling', (): void => {
    const { container } = render(h(ClockStack, { snapshot: timedCyclingFocus(), now: NOW }));

    expect(rows(container)).toEqual([
      { value: '25:00', label: FOCUS_PHASE_CLOCK_LABEL },
      { value: '50:00', label: TOTAL_SESSION_CLOCK_LABEL },
    ]);
  });

  it('keeps the total session honest after a phase transition', (): void => {
    const secondPhase: SessionSnapshotV2 = {
      ...timedCyclingFocus(),
      config: { ...TIMED_CYCLING_CONFIG, duration: { kind: 'timed', minutes: 90 } },
      phaseStartedAt: NOW + 30 * MIN,
      phaseEndsAt: NOW + 55 * MIN,
      sessionEndsAt: NOW + 90 * MIN,
    };
    const { container } = render(h(ClockStack, { snapshot: secondPhase, now: NOW + 30 * MIN }));

    expect(rows(container)).toEqual([
      { value: '25:00', label: FOCUS_PHASE_CLOCK_LABEL },
      { value: '1:00:00', label: TOTAL_SESSION_CLOCK_LABEL },
    ]);
  });

  it('shows the break countdown first and the total session second', (): void => {
    const onBreak: SessionSnapshotV2 = {
      ...timedCyclingFocus(),
      phase: 'break',
      phaseStartedAt: NOW,
      phaseEndsAt: NOW + 5 * MIN,
    };
    const { container } = render(h(ClockStack, { snapshot: onBreak, now: NOW }));

    expect(rows(container)).toEqual([
      { value: '5:00', label: BREAK_CLOCK_LABEL },
      { value: '50:00', label: TOTAL_SESSION_CLOCK_LABEL },
    ]);
  });

  it('renders one clock when the phase and the session end together', (): void => {
    const { container, queryByText } = render(
      h(ClockStack, { snapshot: timedSingleFocus(), now: NOW }),
    );

    expect(rows(container)).toEqual([{ value: '50:00', label: TOTAL_SESSION_CLOCK_LABEL }]);
    expect(queryByText(FOCUS_PHASE_CLOCK_LABEL)).toBeNull();
  });

  it('shows the pause countdown first and the total session second while timed', (): void => {
    const { container } = render(h(ClockStack, { snapshot: timedPause(), now: NOW }));

    expect(rows(container)).toEqual([
      { value: '5:00', label: PAUSE_CLOCK_LABEL },
      { value: '50:00', label: TOTAL_SESSION_CLOCK_LABEL },
    ]);
  });

  it('shows ticking focus time and until stopped with no countdown while indefinite', (): void => {
    const view = render(h(ClockStack, { snapshot: indefiniteFocus(10 * MIN), now: NOW }));

    expect(rows(view.container)).toEqual([{ value: '10:00', label: FOCUS_TIME_LABEL }]);
    expect(view.getByText(UNTIL_STOPPED_LABEL)).toBeTruthy();
    expect(view.queryByText(FOCUS_PHASE_CLOCK_LABEL)).toBeNull();
    expect(view.queryByText(TOTAL_SESSION_CLOCK_LABEL)).toBeNull();

    view.rerender(h(ClockStack, { snapshot: indefiniteFocus(10 * MIN), now: NOW + 90_000 }));
    expect(rows(view.container)).toEqual([{ value: '11:30', label: FOCUS_TIME_LABEL }]);
  });

  it('freezes focus time behind the pause countdown while indefinite', (): void => {
    const view = render(h(ClockStack, { snapshot: indefinitePause(10 * MIN), now: NOW }));

    expect(rows(view.container)).toEqual([
      { value: '5:00', label: PAUSE_CLOCK_LABEL },
      { value: '10:00', label: FOCUS_TIME_LABEL },
    ]);
    expect(view.getByText(UNTIL_STOPPED_LABEL)).toBeTruthy();

    view.rerender(h(ClockStack, { snapshot: indefinitePause(10 * MIN), now: NOW + 3 * MIN }));
    expect(rows(view.container)).toEqual([
      { value: '2:00', label: PAUSE_CLOCK_LABEL },
      { value: '10:00', label: FOCUS_TIME_LABEL },
    ]);
  });

  it('never ticks focus time past a finite phase end', (): void => {
    const capped: SessionSnapshotV2 = {
      ...indefiniteFocus(0),
      phaseStartedAt: NOW,
      phaseEndsAt: NOW + 60_000,
    };
    const view = render(h(ClockStack, { snapshot: capped, now: NOW + 30_000 }));
    expect(rows(view.container)).toEqual([{ value: '0:30', label: FOCUS_TIME_LABEL }]);

    view.rerender(h(ClockStack, { snapshot: capped, now: NOW + 5 * MIN }));
    expect(rows(view.container)).toEqual([{ value: '1:00', label: FOCUS_TIME_LABEL }]);
  });

  it('renders no clocks for a non-active lifecycle', (): void => {
    const starting: SessionSnapshotV2 = {
      ...emptySnapshotV2(NOW),
      lifecycle: {
        kind: 'starting',
        operationId: 'op-1',
        transition: 'start',
        endAuthority: { kind: 'hidden' },
      },
    };
    const { container, queryByText } = render(h(ClockStack, { snapshot: starting, now: NOW }));

    expect(rows(container)).toEqual([]);
    expect(queryByText(UNTIL_STOPPED_LABEL)).toBeNull();
  });
});

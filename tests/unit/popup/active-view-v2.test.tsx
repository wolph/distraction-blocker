/** @vitest-environment jsdom */
import './chrome-fake';

import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActiveViewV2 } from '../../../src/popup/ActiveViewV2';
import {
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  emptySnapshotV2,
  MIN_BREAK_BEFORE_EARLY_MS,
  rulesFromLists,
} from '../../../src/shared/constants';
import type { Request, SessionRequestV2, StatsBundle } from '../../../src/shared/messages';
import {
  END_FAILED_COPY,
  END_SESSION_LABEL,
  FOCUS_PHASE_CLOCK_LABEL,
  FOCUS_TIME_LABEL,
  TOTAL_SESSION_CLOCK_LABEL,
  UNTIL_STOPPED_LABEL,
} from '../../../src/shared/session-copy';
import type {
  EndAuthorityV2,
  GateState,
  SessionConfigV2,
  SessionSnapshotV2,
} from '../../../src/shared/types';
import { resetChromeFake, sendMessageMock, tabsQueryMock } from './chrome-fake';

const NOW: number = 1_700_000_000_000;
const MIN: number = 60_000;

const IMMEDIATE: EndAuthorityV2 = { kind: 'immediate', actionLabel: 'End session' };
const HIDDEN: EndAuthorityV2 = { kind: 'hidden' };
const CLOSED_FRICTION: EndAuthorityV2 = {
  kind: 'friction-gate',
  gate: null,
  copy: { actionLabel: 'End session' },
  actions: { open: 'open-end-gate' },
};

function openFriction(gate: Partial<GateState & { kind: 'cancel' }> = {}): EndAuthorityV2 {
  return {
    kind: 'friction-gate',
    gate: {
      kind: 'cancel',
      host: null,
      openedAt: NOW - 2_000,
      readyAt: NOW + 8_000,
      requiredPhrase: null,
      ...gate,
    },
    copy: {
      title: 'End this session',
      back: 'Never mind, back to work',
      phraseLabel: 'Type this to confirm:',
      confirm: 'End the session',
      intentionReminder: 'write the report',
    },
    actions: { abandon: 'abandon-gate', confirm: 'confirm-gate' },
  };
}

const TIMED_CONFIG: SessionConfigV2 = {
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
  ...TIMED_CONFIG,
  strictness: 'flexible',
  duration: { kind: 'until-stopped' },
  cycling: null,
};

function focusSnap(endAuthority: EndAuthorityV2 = CLOSED_FRICTION): SessionSnapshotV2 {
  return {
    ...emptySnapshotV2(NOW),
    lifecycle: { kind: 'active', endAuthority },
    phase: 'focus',
    config: TIMED_CONFIG,
    startedAt: NOW - 5 * MIN,
    phaseStartedAt: NOW - 5 * MIN,
    phaseEndsAt: NOW + 20 * MIN,
    sessionEndsAt: NOW + 45 * MIN,
    bankMs: 10 * MIN,
    bankAccrualPerMs: 5 / 30,
  };
}

function indefinitePauseSnap(): SessionSnapshotV2 {
  return {
    ...focusSnap(IMMEDIATE),
    config: INDEFINITE_CONFIG,
    phase: 'paused',
    phaseStartedAt: NOW,
    phaseEndsAt: NOW + 5 * MIN,
    sessionEndsAt: null,
    sessionFocusedMs: 12 * MIN,
  };
}

function breakSnap(elapsedMs: number): SessionSnapshotV2 {
  return {
    ...focusSnap(IMMEDIATE),
    phase: 'break',
    phaseStartedAt: NOW - elapsedMs,
    phaseEndsAt: NOW + 3 * MIN,
    bankAccrualPerMs: 0,
  };
}

const statsBundle: StatsBundle = {
  days: [],
  months: [],
  streak: {
    current: 0,
    freezeTokens: 0,
    lastCountedDate: null,
    lastFreezeGrantDate: null,
    activeDays: [],
    activeMonth: '2026-09',
  },
  recentSessions: [],
  totals: {
    focusMsToday: 52 * MIN,
    focusMsLast7Days: 0,
    attemptsToday: 0,
    resistedToday: 0,
  },
};

type AnyRequest = Request | SessionRequestV2;

function sessionRequests(): AnyRequest[] {
  return sendMessageMock.mock.calls
    .map(([request]: unknown[]): AnyRequest => request as AnyRequest)
    .filter((request: AnyRequest): boolean => request.type !== 'getStats');
}

/**
 * Resolves once the clicked control is enabled again, which happens in the same commit
 * as any error state. Asserting no alert before that would pass on a pending command.
 */
async function settled(button: HTMLButtonElement): Promise<void> {
  await waitFor((): void => expect(button.disabled).toBe(false));
}

beforeEach((): void => {
  resetChromeFake();
  sendMessageMock.mockImplementation(async (request: AnyRequest): Promise<unknown> => {
    if (request.type === 'getStats') return statsBundle;
    return { ok: true, code: 'ok' };
  });
  tabsQueryMock.mockResolvedValue([{ url: 'https://www.youtube.com/watch?v=1' }]);
});

afterEach((): void => {
  cleanup();
});

describe('ActiveViewV2', (): void => {
  it('renders the labelled clocks, intention, bank meter, and spend buttons in focus', async (): Promise<void> => {
    const { container, getByText, getByRole } = render(
      h(ActiveViewV2, { snapshot: focusSnap(), now: NOW }),
    );

    expect(getByText('20:00')).toBeTruthy();
    expect(getByText(FOCUS_PHASE_CLOCK_LABEL)).toBeTruthy();
    expect(getByText('45:00')).toBeTruthy();
    expect(getByText(TOTAL_SESSION_CLOCK_LABEL)).toBeTruthy();
    expect(getByText('write the report')).toBeTruthy();
    expect(container.querySelector('.meter-fill')).toBeTruthy();
    expect(getByText('10:00 pause banked')).toBeTruthy();
    expect(getByRole('button', { name: /Unlock this site for 5 min/ })).toBeTruthy();
    expect(getByRole('button', { name: /Pause blocking for 5 min/ })).toBeTruthy();
    await waitFor((): void => {
      expect(getByText('52 min focused today')).toBeTruthy();
    });
  });

  it('spends pause and unlock through the v2 channel', async (): Promise<void> => {
    const pauseView = render(h(ActiveViewV2, { snapshot: focusSnap(), now: NOW }));
    const pause: HTMLButtonElement = pauseView.getByRole('button', {
      name: /Pause blocking for 5 min/,
    }) as HTMLButtonElement;
    fireEvent.click(pause);
    await waitFor((): void => {
      expect(sessionRequests()).toEqual([{ type: 'openGate', gate: 'pause', host: null }]);
    });
    await settled(pause);
    expect(pauseView.queryByRole('alert')).toBeNull();
    pauseView.unmount();
    sendMessageMock.mockClear();

    const unlockView = render(h(ActiveViewV2, { snapshot: focusSnap(), now: NOW }));
    const unlock: HTMLButtonElement = unlockView.getByRole('button', {
      name: /Unlock this site for 5 min/,
    }) as HTMLButtonElement;
    await waitFor((): void => expect(unlock.disabled).toBe(false));
    fireEvent.click(unlock);
    await waitFor((): void => {
      expect(sessionRequests()).toEqual([
        { type: 'openGate', gate: 'unlockSite', host: 'youtube.com' },
      ]);
    });
    await settled(unlock);
    expect(unlockView.queryByRole('alert')).toBeNull();
  });

  it('ends immediately from focus through requestSessionEnd', async (): Promise<void> => {
    const { getByRole, queryByRole } = render(
      h(ActiveViewV2, { snapshot: focusSnap(IMMEDIATE), now: NOW }),
    );
    const end: HTMLButtonElement = getByRole('button', {
      name: END_SESSION_LABEL,
    }) as HTMLButtonElement;

    fireEvent.click(end);

    await waitFor((): void => {
      expect(sessionRequests()).toEqual([{ type: 'requestSessionEnd' }]);
    });
    await settled(end);
    expect(queryByRole('alert')).toBeNull();
  });

  it('shows End alongside Resume now during an indefinite pause', async (): Promise<void> => {
    const { getByRole, getByText, queryByRole } = render(
      h(ActiveViewV2, { snapshot: indefinitePauseSnap(), now: NOW }),
    );

    expect(getByText(UNTIL_STOPPED_LABEL)).toBeTruthy();
    expect(getByText(FOCUS_TIME_LABEL)).toBeTruthy();
    expect(getByRole('button', { name: 'Resume now' })).toBeTruthy();

    const end: HTMLButtonElement = getByRole('button', {
      name: END_SESSION_LABEL,
    }) as HTMLButtonElement;
    fireEvent.click(end);
    await waitFor((): void => {
      expect(sessionRequests()).toEqual([{ type: 'requestSessionEnd' }]);
    });
    await settled(end);
    expect(queryByRole('alert')).toBeNull();
  });

  it('resumes from an indefinite pause through resumeFromPause', async (): Promise<void> => {
    const { getByRole, queryByRole } = render(
      h(ActiveViewV2, { snapshot: indefinitePauseSnap(), now: NOW }),
    );
    const resume: HTMLButtonElement = getByRole('button', {
      name: 'Resume now',
    }) as HTMLButtonElement;

    fireEvent.click(resume);

    await waitFor((): void => {
      expect(sessionRequests()).toEqual([{ type: 'resumeFromPause' }]);
    });
    await settled(resume);
    expect(queryByRole('alert')).toBeNull();
  });

  it('opens the End gate instead of ending for a closed friction authority', async (): Promise<void> => {
    const { getByRole, queryByRole } = render(
      h(ActiveViewV2, { snapshot: focusSnap(CLOSED_FRICTION), now: NOW }),
    );
    const end: HTMLButtonElement = getByRole('button', {
      name: END_SESSION_LABEL,
    }) as HTMLButtonElement;

    fireEvent.click(end);

    await waitFor((): void => {
      expect(sessionRequests()).toEqual([{ type: 'openEndGate' }]);
    });
    await settled(end);
    expect(queryByRole('alert')).toBeNull();
  });

  it('renders the persisted cancel gate and sends its commands through the v2 channel', async (): Promise<void> => {
    const authority: EndAuthorityV2 = openFriction({ requiredPhrase: 'let me stop' });
    const view = render(h(ActiveViewV2, { snapshot: focusSnap(authority), now: NOW + 9_000 }));

    expect(view.queryByRole('button', { name: END_SESSION_LABEL })).toBeNull();
    expect(view.getByText('Type this to confirm: let me stop')).toBeTruthy();

    fireEvent.input(view.getByRole('textbox'), { target: { value: 'let me stop' } });
    const confirm: HTMLButtonElement = view.getByRole('button', {
      name: 'End the session',
    }) as HTMLButtonElement;
    fireEvent.click(confirm);
    await waitFor((): void => {
      expect(sessionRequests()).toEqual([{ type: 'confirmGate', typedPhrase: 'let me stop' }]);
    });
    await settled(confirm);
    expect(view.queryByRole('alert')).toBeNull();

    const abandon: HTMLButtonElement = view.getByRole('button', {
      name: 'Never mind, back to work',
    }) as HTMLButtonElement;
    fireEvent.click(abandon);
    await waitFor((): void => {
      expect(sessionRequests()).toEqual([
        { type: 'confirmGate', typedPhrase: 'let me stop' },
        { type: 'abandonGate' },
      ]);
    });
    await settled(abandon);
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('shows the worker text for a rejected gate command', async (): Promise<void> => {
    sendMessageMock.mockImplementation(async (request: AnyRequest): Promise<unknown> => {
      if (request.type === 'getStats') return statsBundle;
      return {
        ok: false,
        code: 'gate-not-ready',
        error: 'Wait for the delay to finish.',
      };
    });
    const view = render(h(ActiveViewV2, { snapshot: focusSnap(openFriction()), now: NOW + 9_000 }));

    fireEvent.click(view.getByRole('button', { name: 'End the session' }));

    expect(await view.findByText('Wait for the delay to finish.')).toBeTruthy();
  });

  it('hides every End control for a hidden authority', (): void => {
    const { queryByRole } = render(h(ActiveViewV2, { snapshot: focusSnap(HIDDEN), now: NOW }));

    expect(queryByRole('button', { name: END_SESSION_LABEL })).toBeNull();
    expect(queryByRole('button', { name: 'End the session' })).toBeNull();
  });

  it('shows the worker text for a rejected end command', async (): Promise<void> => {
    sendMessageMock.mockImplementation(async (request: AnyRequest): Promise<unknown> => {
      if (request.type === 'getStats') return statsBundle;
      return {
        ok: false,
        code: 'end-not-allowed',
        error: 'This session cannot be ended yet.',
      };
    });
    const { getByRole, findByText } = render(
      h(ActiveViewV2, { snapshot: focusSnap(IMMEDIATE), now: NOW }),
    );

    fireEvent.click(getByRole('button', { name: END_SESSION_LABEL }));

    expect(await findByText('This session cannot be ended yet.')).toBeTruthy();
  });

  it('falls back to the end failure copy when the transport rejects', async (): Promise<void> => {
    sendMessageMock.mockImplementation(async (request: AnyRequest): Promise<unknown> => {
      if (request.type === 'getStats') return statsBundle;
      throw new Error('Receiving end does not exist.');
    });
    const { getByRole, findByText } = render(
      h(ActiveViewV2, { snapshot: focusSnap(IMMEDIATE), now: NOW }),
    );

    fireEvent.click(getByRole('button', { name: END_SESSION_LABEL }));

    expect(await findByText(END_FAILED_COPY)).toBeTruthy();
  });

  it('falls back to the end failure copy for an unknown result code', async (): Promise<void> => {
    sendMessageMock.mockImplementation(async (request: AnyRequest): Promise<unknown> => {
      if (request.type === 'getStats') return statsBundle;
      return { ok: false, code: 'not-a-real-code', error: 'trust me' };
    });
    const { getByRole, findByText, queryByText } = render(
      h(ActiveViewV2, { snapshot: focusSnap(IMMEDIATE), now: NOW }),
    );

    fireEvent.click(getByRole('button', { name: END_SESSION_LABEL }));

    expect(await findByText(END_FAILED_COPY)).toBeTruthy();
    expect(queryByText('trust me')).toBeNull();
  });

  it('keeps the break early start behavior', async (): Promise<void> => {
    const early = render(
      h(ActiveViewV2, { snapshot: breakSnap(MIN_BREAK_BEFORE_EARLY_MS - 1_000), now: NOW }),
    );
    expect(early.queryByRole('button', { name: 'Start next focus early' })).toBeNull();
    early.unmount();

    const ready = render(
      h(ActiveViewV2, { snapshot: breakSnap(MIN_BREAK_BEFORE_EARLY_MS), now: NOW }),
    );
    const startEarly: HTMLButtonElement = ready.getByRole('button', {
      name: 'Start next focus early',
    }) as HTMLButtonElement;
    fireEvent.click(startEarly);

    await waitFor((): void => {
      expect(sessionRequests()).toEqual([{ type: 'startNextFocusEarly' }]);
    });
    await settled(startEarly);
    expect(ready.queryByRole('alert')).toBeNull();
  });

  it('renders a gate whose readyAt precedes openedAt with confirm still disabled', (): void => {
    const hostile: EndAuthorityV2 = openFriction({ openedAt: NOW, readyAt: NOW - 60_000 });
    const { getByRole } = render(h(ActiveViewV2, { snapshot: focusSnap(hostile), now: NOW }));

    const confirm: HTMLButtonElement = getByRole('button', {
      name: 'End the session',
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(
      (getByRole('button', { name: 'Never mind, back to work' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

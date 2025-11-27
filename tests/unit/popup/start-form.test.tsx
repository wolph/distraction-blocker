/** @vitest-environment jsdom */
import './chrome-fake';

import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSessionStartRequestV2 } from '../../../src/background/request-validation';
import { DEFAULT_LISTS, DEFAULT_SETTINGS, rulesFromLists } from '../../../src/shared/constants';
import {
  type SessionRequestV2,
  STALE_SESSION_RULES_ERROR,
  type StartSessionResponseV2,
} from '../../../src/shared/messages';
import {
  START_UNTIL_STOPPED_LABEL,
  UNTIL_STOPPED_FORCED_HINT,
  UNTIL_STOPPED_LABEL,
} from '../../../src/shared/session-copy';
import type { ListsConfig, SettingsV2 } from '../../../src/shared/types';
import { resetChromeFake, sendMessageMock } from './chrome-fake';

vi.mock('../../../src/core/categories', () => ({
  ALL_CATEGORIES: [
    { id: 'social', title: 'Social', hosts: ['facebook.com'] },
    { id: 'video', title: 'Video and streaming', hosts: ['youtube.com'] },
  ],
}));

import { StartForm } from '../../../src/popup/StartForm';

const SETTINGS: SettingsV2 = { ...DEFAULT_SETTINGS, schedule: [] };
const TIMED_START_LABEL: string = 'Start 25 min - Block selected sites';
const FORCED_TYPE_LABEL: string = 'Session type forced by Until stopped';
const FORCED_CYCLES_LABEL: string = 'Cycles forced by Until stopped';

type StartRequest = Extract<SessionRequestV2, { type: 'startSession' }>;

function requests(): SessionRequestV2[] {
  return sendMessageMock.mock.calls.map(
    ([request]: unknown[]): SessionRequestV2 => request as SessionRequestV2,
  );
}

function startRequests(): StartRequest[] {
  return requests().filter(
    (request: SessionRequestV2): request is StartRequest => request.type === 'startSession',
  );
}

function answerStartWith(response: StartSessionResponseV2): void {
  sendMessageMock.mockImplementation(async (request: SessionRequestV2): Promise<unknown> => {
    if (request.type === 'startSession') return response;
    return undefined;
  });
}

beforeEach((): void => {
  resetChromeFake();
  answerStartWith({ ok: true, code: 'ok' });
});

afterEach((): void => {
  cleanup();
});

describe('StartForm duration and forced controls', (): void => {
  it('forces Flexible and no cycles while Until stopped is selected', (): void => {
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.click(view.getByRole('button', { name: UNTIL_STOPPED_LABEL }));

    const forcedType: HTMLElement = view.getByRole('group', { name: FORCED_TYPE_LABEL });
    const flexible: HTMLElement = view.getByRole('button', { name: 'Flexible' });
    expect(forcedType.getAttribute('aria-disabled')).toBe('true');
    expect(forcedType.contains(flexible)).toBe(true);
    expect(flexible.getAttribute('aria-pressed')).toBe('true');

    const forcedCycles: HTMLElement = view.getByRole('group', { name: FORCED_CYCLES_LABEL });
    const cycles: HTMLInputElement = view.getByRole('checkbox') as HTMLInputElement;
    expect(forcedCycles.getAttribute('aria-disabled')).toBe('true');
    expect(forcedCycles.contains(cycles)).toBe(true);
    expect(cycles.checked).toBe(false);

    expect(view.getByText(UNTIL_STOPPED_FORCED_HINT)).toBeTruthy();
    expect(view.getByRole('button', { name: START_UNTIL_STOPPED_LABEL })).toBeTruthy();
  });

  it('refuses a session type change while the control is forced', (): void => {
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.click(view.getByRole('button', { name: UNTIL_STOPPED_LABEL }));
    fireEvent.click(view.getByRole('button', { name: 'Hard lock' }));

    expect(view.getByRole('button', { name: 'Flexible' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(view.getByRole('button', { name: 'Hard lock' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(view.getByRole('button', { name: START_UNTIL_STOPPED_LABEL })).toBeTruthy();

    fireEvent.click(view.getByRole('button', { name: '25 focus' }));

    expect(view.getByRole('button', { name: 'Friction' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(view.getByRole('button', { name: 'Hard lock' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('restores the timed session type, cycles, and start label when a preset returns', (): void => {
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.click(view.getByRole('button', { name: UNTIL_STOPPED_LABEL }));
    fireEvent.click(view.getByRole('button', { name: '25 focus' }));

    expect(view.queryByRole('group', { name: FORCED_TYPE_LABEL })).toBeNull();
    expect(view.queryByRole('group', { name: FORCED_CYCLES_LABEL })).toBeNull();
    expect(view.getByRole('button', { name: 'Friction' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect((view.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    expect(view.queryByText(UNTIL_STOPPED_FORCED_HINT)).toBeNull();
    expect(view.getByRole('button', { name: TIMED_START_LABEL })).toBeTruthy();
  });

  it('restores typed custom minutes through the pressed Until stopped chip', (): void => {
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.input(view.getByLabelText('Custom minutes'), { target: { value: '45' } });
    fireEvent.click(view.getByRole('button', { name: UNTIL_STOPPED_LABEL }));

    expect(view.getByRole('button', { name: START_UNTIL_STOPPED_LABEL })).toBeTruthy();
    expect((view.getByLabelText('Custom minutes') as HTMLInputElement).value).toBe('45');

    fireEvent.click(view.getByRole('button', { name: UNTIL_STOPPED_LABEL }));

    expect((view.getByLabelText('Custom minutes') as HTMLInputElement).value).toBe('45');
    expect(view.getByRole('button', { name: 'Start 45 min - Block selected sites' })).toBeTruthy();
  });

  it('restores a non-default session type and cycle choice after the detour', (): void => {
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.click(view.getByRole('button', { name: 'Hard lock' }));
    fireEvent.click(view.getByRole('checkbox'));
    fireEvent.click(view.getByRole('button', { name: UNTIL_STOPPED_LABEL }));
    fireEvent.click(view.getByRole('button', { name: '25 focus' }));

    expect(view.getByRole('button', { name: 'Hard lock' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect((view.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect(view.getByRole('button', { name: TIMED_START_LABEL })).toBeTruthy();
  });

  it('keeps the stored preset when custom minutes are typed during the detour', (): void => {
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.click(view.getByRole('button', { name: '50 deep work (preference, not science)' }));
    fireEvent.click(view.getByRole('button', { name: UNTIL_STOPPED_LABEL }));
    fireEvent.input(view.getByLabelText('Custom minutes'), { target: { value: '7' } });

    expect(view.getByRole('button', { name: 'Start 7 min - Block selected sites' })).toBeTruthy();

    fireEvent.input(view.getByLabelText('Custom minutes'), { target: { value: '' } });

    expect(view.getByRole('button', { name: 'Start 50 min - Block selected sites' })).toBeTruthy();
  });
});

describe('StartForm start command', (): void => {
  it('sends the exact until-stopped start request the worker accepts', async (): Promise<void> => {
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.click(view.getByRole('button', { name: UNTIL_STOPPED_LABEL }));
    fireEvent.input(view.getByLabelText('Intention'), { target: { value: 'ship the release' } });
    fireEvent.click(view.getByRole('button', { name: START_UNTIL_STOPPED_LABEL }));

    await waitFor((): void => expect(startRequests()).toHaveLength(1));
    const request: StartRequest | undefined = startRequests()[0];
    expect(request).toEqual({
      type: 'startSession',
      config: {
        mode: 'blacklist',
        strictness: 'flexible',
        duration: { kind: 'until-stopped' },
        cycling: null,
        intention: 'ship the release',
        source: 'manual',
        scheduleOccurrence: null,
        rules: rulesFromLists(DEFAULT_LISTS),
      },
    });
    expect(parseSessionStartRequestV2(request)).toEqual(request);
  });

  it('sends the timed request when a preset is selected', async (): Promise<void> => {
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.click(view.getByRole('button', { name: TIMED_START_LABEL }));

    await waitFor((): void => expect(startRequests()).toHaveLength(1));
    expect(startRequests()[0]?.config.duration).toEqual({ kind: 'timed', minutes: 25 });
    expect(startRequests()[0]?.config.strictness).toBe('friction');
  });

  it('refuses to send a start without a usable session length', (): void => {
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.input(view.getByLabelText('Custom minutes'), { target: { value: '0' } });
    fireEvent.click(
      view.getByRole('button', { name: 'Start invalid time - Block selected sites' }),
    );

    expect(view.getByRole('alert').textContent).toContain('session length');
    expect(startRequests()).toHaveLength(0);
  });

  it('shows the worker error text for every rejected start code', async (): Promise<void> => {
    const codes: readonly StartSessionResponseV2['code'][] = [
      'invalid-request',
      'transition-cleanup-pending',
      'closure-cleanup-pending',
      'data-clear-pending',
    ];

    for (const code of codes) {
      resetChromeFake();
      answerStartWith({ ok: false, code, error: `worker said ${code}` } as StartSessionResponseV2);
      const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

      fireEvent.click(view.getByRole('button', { name: TIMED_START_LABEL }));

      await waitFor((): void => {
        expect(view.getByRole('alert').textContent).toBe(`worker said ${code}`);
      });
      cleanup();
    }
  });

  it('keeps the draft after a transition failure that still needs cleanup', async (): Promise<void> => {
    answerStartWith({
      ok: false,
      code: 'tab-enforcement-failed',
      error: 'Blocking could not start on an open tab.',
      cleanupPending: true,
    });
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.input(view.getByLabelText('Intention'), { target: { value: 'write the report' } });
    fireEvent.click(view.getByRole('button', { name: UNTIL_STOPPED_LABEL }));
    fireEvent.click(view.getByRole('button', { name: START_UNTIL_STOPPED_LABEL }));

    await waitFor((): void => {
      expect(view.getByRole('alert').textContent).toBe('Blocking could not start on an open tab.');
    });
    expect((view.getByLabelText('Intention') as HTMLInputElement).value).toBe('write the report');
    expect(view.getByRole('button', { name: START_UNTIL_STOPPED_LABEL })).toBeTruthy();
  });

  it('shows the fallback when the worker answers with a malformed response', async (): Promise<void> => {
    sendMessageMock.mockResolvedValue({ ok: false, code: 'nope', error: 'unknown' });
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.click(view.getByRole('button', { name: TIMED_START_LABEL }));

    await waitFor((): void => {
      expect(view.getByRole('alert').textContent).toBe('Could not start session. Try again.');
    });
  });

  it('fetches and rebases current lists after a stale response before a new explicit start', async (): Promise<void> => {
    const refreshed: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, video: true },
      custom: [{ kind: 'host', pattern: 'fresh.example' }],
    };
    let startCount: number = 0;
    sendMessageMock.mockImplementation(async (request: SessionRequestV2): Promise<unknown> => {
      if (request.type !== 'startSession') return refreshed;
      startCount += 1;
      return startCount === 1
        ? { ok: false, code: 'invalid-request', error: STALE_SESSION_RULES_ERROR }
        : { ok: true, code: 'ok' };
    });
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.click(view.getByRole('button', { name: 'Social' }));
    fireEvent.click(view.getByRole('button', { name: TIMED_START_LABEL }));
    await view.findByText('fresh.example');

    expect(requests().map((request: SessionRequestV2): string => request.type)).toEqual([
      'startSession',
      'getLists',
    ]);
    expect(view.getByRole('alert').textContent).toBe(STALE_SESSION_RULES_ERROR);

    fireEvent.click(view.getByRole('button', { name: TIMED_START_LABEL }));

    await waitFor((): void => {
      expect(startRequests()).toHaveLength(2);
      expect(startRequests()[1]?.config.rules).toEqual(
        expect.objectContaining({
          baselineRevision: rulesFromLists(refreshed).baselineRevision,
          permanentBlacklist: refreshed.custom,
          categories: expect.objectContaining({ social: true, video: true }),
        }),
      );
    });
    // The reset after the accepted start uses the refreshed lists, not the stale prop.
    expect(view.getByText('fresh.example')).toBeTruthy();
  });

  it('resets the form to Settings defaults after a successful start', async (): Promise<void> => {
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.input(view.getByLabelText('Intention'), { target: { value: 'ship the release' } });
    fireEvent.click(view.getByRole('button', { name: 'Hard lock' }));
    fireEvent.click(view.getByRole('button', { name: UNTIL_STOPPED_LABEL }));
    fireEvent.click(view.getByRole('button', { name: START_UNTIL_STOPPED_LABEL }));

    await waitFor((): void => {
      expect(view.getByRole('button', { name: TIMED_START_LABEL })).toBeTruthy();
    });
    expect((view.getByLabelText('Intention') as HTMLInputElement).value).toBe('');
    expect(view.getByRole('button', { name: 'Friction' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect((view.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('disables the start action through the startsDisabled prop', (): void => {
    const view = render(
      <StartForm settings={SETTINGS} lists={DEFAULT_LISTS} startsDisabled={true} />,
    );
    const start: HTMLButtonElement = view.getByRole('button', {
      name: TIMED_START_LABEL,
    }) as HTMLButtonElement;

    expect(start.disabled).toBe(true);
    fireEvent.click(start);

    expect(startRequests()).toHaveLength(0);
  });

  it('keeps fallback category controls out of the draft', (): void => {
    const view = render(
      <StartForm settings={SETTINGS} lists={DEFAULT_LISTS} categoriesEditable={false} />,
    );
    const social: HTMLButtonElement = view.getByRole('button', {
      name: 'Social',
    }) as HTMLButtonElement;

    expect(social.disabled).toBe(true);
    fireEvent.click(social);

    expect(social.getAttribute('aria-pressed')).toBe('false');
    expect(requests()).toHaveLength(0);
  });
});

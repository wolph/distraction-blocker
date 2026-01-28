/** @vitest-environment jsdom */
import './chrome-fake';

import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { h, type VNode } from 'preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  endCommandOf,
  endControl,
  gateIdentity,
  gateIntention,
  mapGateError,
  sendGateCommand,
  useV2Command,
  type V2Command,
  type V2EndCommand,
} from '../../../src/popup/v2-command';
import { DEFAULT_LISTS, rulesFromLists } from '../../../src/shared/constants';
import type { SessionRequestV2 } from '../../../src/shared/messages';
import { END_SESSION_LABEL } from '../../../src/shared/session-copy';
import type {
  EndAuthorityV2,
  GateState,
  SessionConfigV2,
  SessionRuleSnapshot,
} from '../../../src/shared/types';
import { resetChromeFake, sendMessageMock } from './chrome-fake';

const NOW: number = 1_700_000_000_000;
const FALLBACK: string = 'Could not do that. Try again.';

const HIDDEN: EndAuthorityV2 = { kind: 'hidden' };
const IMMEDIATE: EndAuthorityV2 = { kind: 'immediate', actionLabel: 'End session' };
const CLOSED_FRICTION: EndAuthorityV2 = {
  kind: 'friction-gate',
  gate: null,
  copy: { actionLabel: 'End session' },
  actions: { open: 'open-end-gate' },
};
const CANCEL_GATE: GateState & { kind: 'cancel' } = {
  kind: 'cancel',
  host: null,
  openedAt: NOW - 2_000,
  readyAt: NOW + 8_000,
  requiredPhrase: null,
};
const OPEN_FRICTION: EndAuthorityV2 = {
  kind: 'friction-gate',
  gate: CANCEL_GATE,
  copy: {
    title: 'End this session',
    back: 'Never mind, back to work',
    phraseLabel: 'Type this to confirm:',
    confirm: 'End the session',
    intentionReminder: null,
  },
  actions: { abandon: 'abandon-gate', confirm: 'confirm-gate' },
};

const PAUSE_GATE: GateState = {
  kind: 'pause',
  host: null,
  openedAt: NOW - 2_000,
  readyAt: NOW + 8_000,
  requiredPhrase: null,
};

const RULES: SessionRuleSnapshot = rulesFromLists(DEFAULT_LISTS);
const CONFIG: SessionConfigV2 = {
  mode: 'blacklist',
  strictness: 'friction',
  duration: { kind: 'until-stopped' },
  cycling: null,
  intention: 'ship the release',
  source: 'manual',
  scheduleOccurrence: null,
  rules: RULES,
};

interface HarnessProps {
  authority: EndAuthorityV2;
  onBegin?: () => void;
}

/** Renders the shared End control over the shared command hook, as both v2 views do. */
function Harness({ authority, onBegin }: HarnessProps): VNode {
  const command: V2Command = useV2Command({ onBegin });
  return h(
    'div',
    null,
    endControl(authority, command),
    command.error === null ? null : h('p', { role: 'alert' }, command.error),
  );
}

function requests(): SessionRequestV2[] {
  return sendMessageMock.mock.calls.map(
    ([request]: unknown[]): SessionRequestV2 => request as SessionRequestV2,
  );
}

beforeEach((): void => {
  resetChromeFake();
  sendMessageMock.mockImplementation(async (): Promise<unknown> => ({ ok: true, code: 'ok' }));
});

afterEach((): void => {
  cleanup();
});

describe('gateIdentity', (): void => {
  it('changes when any persisted gate field changes', (): void => {
    expect(gateIdentity(CANCEL_GATE)).toBe(gateIdentity({ ...CANCEL_GATE }));
    expect(gateIdentity(CANCEL_GATE)).not.toBe(
      gateIdentity({ ...CANCEL_GATE, openedAt: NOW - 1_000 }),
    );
    expect(gateIdentity(CANCEL_GATE)).not.toBe(
      gateIdentity({ ...CANCEL_GATE, requiredPhrase: 'let me stop' }),
    );
  });
});

describe('gateIntention', (): void => {
  it('reads the persisted reminder for a cancel gate and the config for the others', (): void => {
    const withReminder: EndAuthorityV2 = {
      ...OPEN_FRICTION,
      copy: { ...OPEN_FRICTION.copy, intentionReminder: 'write the report' },
    } as EndAuthorityV2;

    // The persisted reminder wins for the cancel gate, so a worker that suppressed it with
    // null shows nothing even while the config still carries an intention.
    expect(gateIntention(withReminder, CANCEL_GATE, CONFIG)).toBe('write the report');
    expect(gateIntention(OPEN_FRICTION, CANCEL_GATE, CONFIG)).toBe('');

    // A pause or unlock gate carries no persisted copy, so it falls back to the session's own.
    expect(gateIntention(withReminder, PAUSE_GATE, CONFIG)).toBe('ship the release');
    expect(gateIntention(IMMEDIATE, CANCEL_GATE, CONFIG)).toBe('ship the release');
    expect(gateIntention(IMMEDIATE, CANCEL_GATE, null)).toBe('');
  });
});

describe('endCommandOf', (): void => {
  it('maps every End authority to its command', (): void => {
    expect(endCommandOf(HIDDEN)).toBeNull();
    expect(endCommandOf(IMMEDIATE)).toEqual({ type: 'requestSessionEnd' });
    expect(endCommandOf(CLOSED_FRICTION)).toEqual({ type: 'openEndGate' });
    expect(endCommandOf(OPEN_FRICTION)).toBeNull();
  });
});

describe('endControl', (): void => {
  it('renders nothing for an authority that hides End', (): void => {
    const { container } = render(h(Harness, { authority: HIDDEN }));

    expect(container.querySelector('button')).toBeNull();
  });

  it('sends the authority command and stays silent on an accepted answer', async (): Promise<void> => {
    const { getByRole, queryByRole } = render(h(Harness, { authority: IMMEDIATE }));
    const end: HTMLButtonElement = getByRole('button', {
      name: END_SESSION_LABEL,
    }) as HTMLButtonElement;

    fireEvent.click(end);

    await waitFor((): void => expect(requests()).toEqual([{ type: 'requestSessionEnd' }]));
    await waitFor((): void => expect(end.disabled).toBe(false));
    expect(queryByRole('alert')).toBeNull();
  });

  it('opens the cancel gate for a closed friction authority', async (): Promise<void> => {
    const { getByRole } = render(h(Harness, { authority: CLOSED_FRICTION }));

    fireEvent.click(getByRole('button', { name: END_SESSION_LABEL }));

    await waitFor((): void => expect(requests()).toEqual([{ type: 'openEndGate' }]));
  });
});

describe('useV2Command', (): void => {
  it('shows the worker text for a coded rejection', async (): Promise<void> => {
    sendMessageMock.mockImplementation(
      async (): Promise<unknown> => ({
        ok: false,
        code: 'end-not-allowed',
        error: 'This session cannot be ended.',
      }),
    );
    const { findByText, getByRole } = render(h(Harness, { authority: IMMEDIATE }));

    fireEvent.click(getByRole('button', { name: END_SESSION_LABEL }));

    expect(await findByText('This session cannot be ended.')).toBeTruthy();
  });

  it('falls back when the answer is not an exact coded result', async (): Promise<void> => {
    sendMessageMock.mockImplementation(async (): Promise<unknown> => ({ ok: 'yes' }));
    const { findByRole, getByRole } = render(h(Harness, { authority: IMMEDIATE }));

    fireEvent.click(getByRole('button', { name: END_SESSION_LABEL }));

    expect((await findByRole('alert')).textContent).toBe('Could not end session. Try again.');
  });

  it('falls back when the transport throws', async (): Promise<void> => {
    sendMessageMock.mockImplementation(async (): Promise<unknown> => {
      throw new Error('port closed');
    });
    const { findByRole, getByRole } = render(h(Harness, { authority: IMMEDIATE }));

    fireEvent.click(getByRole('button', { name: END_SESSION_LABEL }));

    expect((await findByRole('alert')).textContent).toBe('Could not end session. Try again.');
  });

  it('holds one command in flight and reports each begin once', async (): Promise<void> => {
    const deferred: { release: ((value: unknown) => void) | null } = { release: null };
    let begins: number = 0;
    sendMessageMock.mockImplementation(
      (): Promise<unknown> =>
        new Promise((resolve: (value: unknown) => void): void => {
          deferred.release = resolve;
        }),
    );
    const { getByRole } = render(
      h(Harness, {
        authority: IMMEDIATE,
        onBegin: (): void => {
          begins += 1;
        },
      }),
    );
    const end: HTMLButtonElement = getByRole('button', {
      name: END_SESSION_LABEL,
    }) as HTMLButtonElement;

    fireEvent.click(end);
    fireEvent.click(end);

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(begins).toBe(1);
    await waitFor((): void => expect(end.disabled).toBe(true));

    deferred.release?.({ ok: true, code: 'ok' });
    await waitFor((): void => expect(end.disabled).toBe(false));

    fireEvent.click(end);
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(begins).toBe(2);
  });
});

describe('gate transport', (): void => {
  it('sends gate commands through the v2 channel', async (): Promise<void> => {
    const abandon: unknown = await sendGateCommand({ type: 'abandonGate' });
    const confirm: unknown = await sendGateCommand({
      type: 'confirmGate',
      typedPhrase: 'let me stop',
    });

    expect(abandon).toEqual({ ok: true, code: 'ok' });
    expect(confirm).toEqual({ ok: true, code: 'ok' });
    expect(requests()).toEqual([
      { type: 'abandonGate' },
      { type: 'confirmGate', typedPhrase: 'let me stop' },
    ]);
  });

  it('maps gate answers with the v2 validator, never the v1 Ack rule', (): void => {
    expect(mapGateError({ ok: true, code: 'ok' }, FALLBACK)).toBeNull();
    expect(mapGateError({ ok: false, code: 'gate-not-ready', error: 'Wait.' }, FALLBACK)).toBe(
      'Wait.',
    );
    expect(mapGateError({ ok: false, code: 'nonsense', error: 'Wait.' }, FALLBACK)).toBe(FALLBACK);
    expect(mapGateError(undefined, FALLBACK)).toBe(FALLBACK);
  });
});

describe('command types', (): void => {
  it('narrows the End command union to the two authority commands', (): void => {
    const end: V2EndCommand = { type: 'requestSessionEnd' };
    const open: V2EndCommand = { type: 'openEndGate' };

    expect([end, open]).toEqual([{ type: 'requestSessionEnd' }, { type: 'openEndGate' }]);
  });
});

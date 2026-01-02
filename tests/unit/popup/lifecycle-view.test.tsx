/** @vitest-environment jsdom */
import './chrome-fake';

import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LifecycleView,
  type LifecycleViewProps,
  RETRY_FAILED_COPY,
} from '../../../src/popup/LifecycleView';
import { DEFAULT_LISTS, emptySnapshotV2, rulesFromLists } from '../../../src/shared/constants';
import type { SessionRequestV2 } from '../../../src/shared/messages';
import {
  DATA_CLEAR_ERROR_COPY,
  DATA_CLEAR_PENDING_COPY,
  END_SESSION_LABEL,
  POPUP_CLOSURE_CLEANUP_COPY,
  POPUP_CLOSURE_ERROR_COPY,
  POPUP_STARTING_COPY,
  POPUP_TRANSITION_CLEANUP_COPY,
  POPUP_TRANSITION_ERROR_COPY,
  RETRY_CLEANUP_LABEL,
} from '../../../src/shared/session-copy';
import type {
  EndAuthorityV2,
  GateState,
  SessionConfigV2,
  SessionSnapshotV2,
  SetupState,
} from '../../../src/shared/types';
import { resetChromeFake, sendMessageMock } from './chrome-fake';

const NOW: number = 1_700_000_000_000;
const READY: number = NOW + 9_000;

const HIDDEN: EndAuthorityV2 = { kind: 'hidden' };
const IMMEDIATE: EndAuthorityV2 = { kind: 'immediate', actionLabel: 'End session' };
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

const IDLE_CLEAR: SetupState['dataClear'] = { status: 'idle', scope: null, phase: null };

function startingSnap(endAuthority: EndAuthorityV2): SessionSnapshotV2 {
  return {
    ...emptySnapshotV2(NOW),
    lifecycle: { kind: 'starting', operationId: 'op-1', transition: 'start', endAuthority },
  };
}

function cleanupSnap(journal: 'transition' | 'closure'): SessionSnapshotV2 {
  return {
    ...emptySnapshotV2(NOW),
    lifecycle: { kind: 'cleanup', journal, id: 'journal-1', endAuthority: { kind: 'hidden' } },
  };
}

function errorSnap(
  code: 'transition-cleanup-failed' | 'closure-cleanup-failed',
): SessionSnapshotV2 {
  return {
    ...emptySnapshotV2(NOW),
    lifecycle: { kind: 'error', code, retryAvailable: true, endAuthority: { kind: 'hidden' } },
  };
}

function view(
  snapshot: SessionSnapshotV2,
  dataClear: LifecycleViewProps['dataClear'] = IDLE_CLEAR,
  now: number = NOW,
): ReturnType<typeof render> {
  return render(h(LifecycleView, { snapshot, now, dataClear }));
}

function sessionRequests(): SessionRequestV2[] {
  return sendMessageMock.mock.calls.map(
    ([request]: unknown[]): SessionRequestV2 => request as SessionRequestV2,
  );
}

/** Resolves once the clicked control is enabled again, in the same commit as any error. */
async function settled(button: HTMLButtonElement): Promise<void> {
  await waitFor((): void => expect(button.disabled).toBe(false));
}

beforeEach((): void => {
  resetChromeFake();
  sendMessageMock.mockImplementation(async (): Promise<unknown> => ({ ok: true, code: 'ok' }));
});

afterEach((): void => {
  cleanup();
});

describe('LifecycleView starting', (): void => {
  it('shows the pre-commit starting copy with no clock, no End, and no start', (): void => {
    const { container, getByText, queryAllByRole } = view(startingSnap(HIDDEN));

    expect(getByText(POPUP_STARTING_COPY)).toBeTruthy();
    expect(container.querySelector('.clock-stack')).toBeNull();
    expect(queryAllByRole('button')).toEqual([]);
  });

  it('ends a committed Flexible start through requestSessionEnd', async (): Promise<void> => {
    const { getByRole, getByText, queryByRole } = view(startingSnap(IMMEDIATE));
    const end: HTMLButtonElement = getByRole('button', {
      name: END_SESSION_LABEL,
    }) as HTMLButtonElement;

    expect(getByText(POPUP_STARTING_COPY)).toBeTruthy();
    fireEvent.click(end);

    await waitFor((): void => {
      expect(sessionRequests()).toEqual([{ type: 'requestSessionEnd' }]);
    });
    await settled(end);
    expect(queryByRole('alert')).toBeNull();
  });

  it('opens the cancel gate of a committed Friction start', async (): Promise<void> => {
    const { getByRole, getByText, queryByRole } = view(startingSnap(CLOSED_FRICTION));
    const end: HTMLButtonElement = getByRole('button', {
      name: END_SESSION_LABEL,
    }) as HTMLButtonElement;

    expect(getByText(POPUP_STARTING_COPY)).toBeTruthy();
    fireEvent.click(end);

    await waitFor((): void => {
      expect(sessionRequests()).toEqual([{ type: 'openEndGate' }]);
    });
    await settled(end);
    expect(queryByRole('alert')).toBeNull();
  });

  it('renders the persisted cancel gate with its exact copy', async (): Promise<void> => {
    const authority: EndAuthorityV2 = openFriction({ requiredPhrase: 'let me stop' });
    const rendered = view(startingSnap(authority), IDLE_CLEAR, READY);

    expect(rendered.getByText('End this session')).toBeTruthy();
    expect(rendered.getByText('You said: write the report')).toBeTruthy();
    expect(rendered.getByText('Type this to confirm: let me stop')).toBeTruthy();
    expect(rendered.queryByRole('button', { name: END_SESSION_LABEL })).toBeNull();
    expect(rendered.getByRole('button', { name: 'Never mind, back to work' })).toBeTruthy();

    fireEvent.input(rendered.getByRole('textbox'), { target: { value: 'let me stop' } });
    const confirm: HTMLButtonElement = rendered.getByRole('button', {
      name: 'End the session',
    }) as HTMLButtonElement;
    fireEvent.click(confirm);

    await waitFor((): void => {
      expect(sessionRequests()).toEqual([{ type: 'confirmGate', typedPhrase: 'let me stop' }]);
    });
    await settled(confirm);
    expect(rendered.queryByRole('alert')).toBeNull();
  });

  it('shows the persisted delay before the gate is ready', (): void => {
    const rendered = view(startingSnap(openFriction()), IDLE_CLEAR, NOW);

    expect(rendered.container.querySelector('.gate-wait')?.textContent).toBe(
      'A moment to decide: 2 of 10 s',
    );
    expect(
      (rendered.getByRole('button', { name: 'End the session' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('clears the typed phrase when a different cancel gate opens', (): void => {
    const first: EndAuthorityV2 = openFriction({ requiredPhrase: 'let me stop' });
    const second: EndAuthorityV2 = openFriction({
      requiredPhrase: 'let me stop',
      openedAt: NOW - 1_000,
    });
    const { getByRole, rerender } = render(
      h(LifecycleView, { snapshot: startingSnap(first), now: READY, dataClear: IDLE_CLEAR }),
    );

    fireEvent.input(getByRole('textbox'), { target: { value: 'let me stop' } });
    expect((getByRole('textbox') as HTMLInputElement).value).toBe('let me stop');

    rerender(
      h(LifecycleView, { snapshot: startingSnap(second), now: READY, dataClear: IDLE_CLEAR }),
    );

    expect((getByRole('textbox') as HTMLInputElement).value).toBe('');
  });

  it('maps a rejected v2 gate command to the worker text', async (): Promise<void> => {
    sendMessageMock.mockImplementation(
      async (): Promise<unknown> => ({
        ok: false,
        code: 'gate-not-ready',
        error: 'Wait for the delay to finish.',
      }),
    );
    const rendered = view(startingSnap(openFriction()), IDLE_CLEAR, READY);

    fireEvent.click(rendered.getByRole('button', { name: 'End the session' }));

    expect(await rendered.findByText('Wait for the delay to finish.')).toBeTruthy();
  });

  it('ignores a config that a starting snapshot must not carry', (): void => {
    const config: SessionConfigV2 = {
      mode: 'blacklist',
      strictness: 'friction',
      duration: { kind: 'timed', minutes: 50 },
      cycling: null,
      intention: 'write the report',
      source: 'manual',
      scheduleOccurrence: null,
      rules: rulesFromLists(DEFAULT_LISTS),
    };
    const snapshot: SessionSnapshotV2 = {
      ...startingSnap(HIDDEN),
      config,
      phase: 'focus',
      startedAt: NOW - 60_000,
      phaseStartedAt: NOW - 60_000,
      phaseEndsAt: NOW + 60_000,
      sessionEndsAt: NOW + 60_000,
    };
    const { container, getByText, queryByText } = view(snapshot);

    expect(getByText(POPUP_STARTING_COPY)).toBeTruthy();
    expect(queryByText('write the report')).toBeNull();
    expect(container.querySelector('.clock-stack')).toBeNull();
  });
});

describe('LifecycleView cleanup', (): void => {
  it('names closure cleanup', (): void => {
    const { getByText, queryAllByRole } = view(cleanupSnap('closure'));

    expect(getByText(POPUP_CLOSURE_CLEANUP_COPY)).toBeTruthy();
    expect(queryAllByRole('button')).toEqual([]);
  });

  it('names transition cleanup', (): void => {
    const { getByText, queryAllByRole } = view(cleanupSnap('transition'));

    expect(getByText(POPUP_TRANSITION_CLEANUP_COPY)).toBeTruthy();
    expect(queryAllByRole('button')).toEqual([]);
  });
});

describe('LifecycleView cleanup errors', (): void => {
  it('retries an exhausted transition cleanup', async (): Promise<void> => {
    const { getByRole, getByText, queryByRole } = view(errorSnap('transition-cleanup-failed'));
    const retry: HTMLButtonElement = getByRole('button', {
      name: RETRY_CLEANUP_LABEL,
    }) as HTMLButtonElement;

    expect(getByText(POPUP_TRANSITION_ERROR_COPY)).toBeTruthy();
    fireEvent.click(retry);

    await waitFor((): void => {
      expect(sessionRequests()).toEqual([{ type: 'retryTransitionCleanup' }]);
    });
    await settled(retry);
    expect(queryByRole('alert')).toBeNull();
  });

  it('retries an exhausted closure cleanup', async (): Promise<void> => {
    const { getByRole, getByText, queryByRole } = view(errorSnap('closure-cleanup-failed'));
    const retry: HTMLButtonElement = getByRole('button', {
      name: RETRY_CLEANUP_LABEL,
    }) as HTMLButtonElement;

    expect(getByText(POPUP_CLOSURE_ERROR_COPY)).toBeTruthy();
    fireEvent.click(retry);

    await waitFor((): void => {
      expect(sessionRequests()).toEqual([{ type: 'retryClosureCleanup' }]);
    });
    await settled(retry);
    expect(queryByRole('alert')).toBeNull();
  });

  it('falls back to its own copy when the retry transport fails', async (): Promise<void> => {
    sendMessageMock.mockImplementation(async (): Promise<unknown> => {
      throw new Error('port closed');
    });
    const { findByRole, getByRole } = view(errorSnap('transition-cleanup-failed'));

    fireEvent.click(getByRole('button', { name: RETRY_CLEANUP_LABEL }));

    expect((await findByRole('alert')).textContent).toBe(RETRY_FAILED_COPY);
  });

  it('shows the worker text when a retry is not available', async (): Promise<void> => {
    sendMessageMock.mockImplementation(
      async (): Promise<unknown> => ({
        ok: false,
        code: 'retry-not-available',
        error: 'Cleanup is still retrying on its own.',
      }),
    );
    const { getByRole, findByText } = view(errorSnap('closure-cleanup-failed'));

    fireEvent.click(getByRole('button', { name: RETRY_CLEANUP_LABEL }));

    expect(await findByText('Cleanup is still retrying on its own.')).toBeTruthy();
  });
});

describe('LifecycleView all-data clear', (): void => {
  /** Every all-data phase SetupState carries, browser-reset included. */
  const PENDING_PHASES: ReadonlyArray<LifecycleViewProps['dataClear']> = [
    { status: 'pending', scope: 'all', phase: 'remote' },
    { status: 'pending', scope: 'all', phase: 'local' },
    { status: 'pending', scope: 'all', phase: 'browser-reset' },
  ];

  it('overrides every lifecycle and control while a clear is pending', (): void => {
    for (const dataClear of PENDING_PHASES) {
      const { getByText, queryAllByRole, queryByText, unmount } = view(
        startingSnap(IMMEDIATE),
        dataClear,
      );

      expect(getByText(DATA_CLEAR_PENDING_COPY)).toBeTruthy();
      expect(queryByText(POPUP_STARTING_COPY)).toBeNull();
      expect(queryAllByRole('button')).toEqual([]);
      unmount();
    }
  });

  it('overrides idle with the pending copy', (): void => {
    const { getByText, queryAllByRole } = view(emptySnapshotV2(NOW), {
      status: 'pending',
      scope: 'all',
      phase: 'local',
    });

    expect(getByText(DATA_CLEAR_PENDING_COPY)).toBeTruthy();
    expect(queryAllByRole('button')).toEqual([]);
  });

  it('retries an exhausted clear through retryDataClear', async (): Promise<void> => {
    const { getByRole, getByText, queryByRole } = view(emptySnapshotV2(NOW), {
      status: 'error',
      scope: 'all',
      phase: 'browser-reset',
    });
    const retry: HTMLButtonElement = getByRole('button', {
      name: RETRY_CLEANUP_LABEL,
    }) as HTMLButtonElement;

    expect(getByText(DATA_CLEAR_ERROR_COPY)).toBeTruthy();
    fireEvent.click(retry);

    await waitFor((): void => {
      expect(sessionRequests()).toEqual([{ type: 'retryDataClear' }]);
    });
    await settled(retry);
    expect(queryByRole('alert')).toBeNull();
  });

  it('shows the stub retry-not-available text for a data clear retry', async (): Promise<void> => {
    sendMessageMock.mockImplementation(
      async (): Promise<unknown> => ({
        ok: false,
        code: 'retry-not-available',
        error: 'Data clear retry is not available yet.',
      }),
    );
    const { findByText, getByRole } = view(emptySnapshotV2(NOW), {
      status: 'error',
      scope: 'all',
      phase: 'remote',
    });

    fireEvent.click(getByRole('button', { name: RETRY_CLEANUP_LABEL }));

    expect(await findByText('Data clear retry is not available yet.')).toBeTruthy();
  });

  it('leaves other clear scopes to their own surfaces', (): void => {
    const { getByText, queryByText } = view(cleanupSnap('closure'), {
      status: 'pending',
      scope: 'local-history',
      phase: 'runtime',
    });

    expect(getByText(POPUP_CLOSURE_CLEANUP_COPY)).toBeTruthy();
    expect(queryByText(DATA_CLEAR_PENDING_COPY)).toBeNull();
  });
});

describe('LifecycleView idle and active', (): void => {
  it('renders nothing when another view owns the state', (): void => {
    const idle = view(emptySnapshotV2(NOW));
    expect(idle.container.textContent).toBe('');
    idle.unmount();

    const active = view({
      ...emptySnapshotV2(NOW),
      lifecycle: { kind: 'active', endAuthority: IMMEDIATE },
      phase: 'focus',
    });
    expect(active.container.textContent).toBe('');
  });
});

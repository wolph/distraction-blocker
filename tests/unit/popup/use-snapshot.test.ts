/** @vitest-environment jsdom */
import './chrome-fake';

import { cleanup, render, waitFor } from '@testing-library/preact';
import { h, type VNode } from 'preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSnapshot } from '../../../src/popup/use-snapshot';
import { emptySnapshot } from '../../../src/shared/constants';
import type { SessionSnapshot } from '../../../src/shared/types';
import { emitMessage, resetChromeFake, sendMessageMock } from './chrome-fake';

function Probe(): VNode {
  const { snapshot } = useSnapshot();
  return h('output', null, snapshot === null ? 'loading' : snapshot.phase);
}

function focusSnapshot(at: number): SessionSnapshot {
  return {
    ...emptySnapshot(at),
    phase: 'focus',
    startedAt: at,
    phaseStartedAt: at,
    phaseEndsAt: at + 25 * 60_000,
    sessionEndsAt: at + 25 * 60_000,
  };
}

describe('useSnapshot', () => {
  beforeEach((): void => {
    resetChromeFake();
  });

  afterEach((): void => {
    cleanup();
  });

  it('loads the initial snapshot via getSnapshot', async (): Promise<void> => {
    sendMessageMock.mockResolvedValue(emptySnapshot(Date.now()));
    const { getByRole } = render(h(Probe, null));

    expect(getByRole('status').textContent).toBe('loading');
    await waitFor((): void => {
      expect(getByRole('status').textContent).toBe('idle');
    });
    expect(sendMessageMock).toHaveBeenCalledWith({ type: 'getSnapshot' });
  });

  it('re-renders when a stateChanged broadcast arrives', async (): Promise<void> => {
    sendMessageMock.mockResolvedValue(emptySnapshot(Date.now()));
    const { getByRole } = render(h(Probe, null));
    await waitFor((): void => {
      expect(getByRole('status').textContent).toBe('idle');
    });

    emitMessage({ type: 'stateChanged', snapshot: focusSnapshot(Date.now()) });
    await waitFor((): void => {
      expect(getByRole('status').textContent).toBe('focus');
    });
  });

  it('unsubscribes the broadcast listener on unmount', async (): Promise<void> => {
    sendMessageMock.mockResolvedValue(emptySnapshot(Date.now()));
    const { unmount } = render(h(Probe, null));
    const { messageListeners } = await import('./chrome-fake');
    await waitFor((): void => {
      expect(messageListeners.length).toBe(1);
    });
    unmount();
    expect(messageListeners.length).toBe(0);
  });
});

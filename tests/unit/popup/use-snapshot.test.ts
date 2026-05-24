/** @vitest-environment jsdom */
import './chrome-fake';

import { act, cleanup, render, waitFor } from '@testing-library/preact';
import { h, type VNode } from 'preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../../src/popup/App';
import { useSnapshot } from '../../../src/popup/use-snapshot';
import { DEFAULT_SETTINGS, emptySnapshot } from '../../../src/shared/constants';
import type { SessionSnapshot } from '../../../src/shared/types';
import { emitMessage, resetChromeFake, sendMessageMock } from './chrome-fake';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = (): void => {};
  const promise: Promise<T> = new Promise<T>((done: (value: T) => void): void => {
    resolve = done;
  });
  return { promise, resolve };
}

function Probe(): VNode {
  const { error, snapshot } = useSnapshot();
  return h('output', null, error ? 'unavailable' : snapshot === null ? 'loading' : snapshot.phase);
}

function SnapshotProbe(): VNode {
  const { snapshot } = useSnapshot();
  return h('output', null, snapshot === null ? 'loading' : `${snapshot.phase}:${snapshot.theme}`);
}

function focusSnapshot(at: number): SessionSnapshot {
  return {
    ...emptySnapshot(at),
    phase: 'focus',
    config: {
      mode: 'blacklist',
      strictness: 'friction',
      durationMin: 25,
      cycling: DEFAULT_SETTINGS.defaultCycling,
      intention: '',
      source: 'manual',
      scheduleEntryId: null,
    },
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

  it('does not let a stale initial response overwrite a newer broadcast', async (): Promise<void> => {
    const initial: Deferred<SessionSnapshot> = deferred<SessionSnapshot>();
    sendMessageMock.mockReturnValue(initial.promise);
    const { getByRole } = render(h(SnapshotProbe, null));
    await waitFor((): void =>
      expect(sendMessageMock).toHaveBeenCalledWith({ type: 'getSnapshot' }),
    );
    emitMessage({
      type: 'stateChanged',
      snapshot: { ...focusSnapshot(Date.now()), theme: 'dark' },
    });
    await waitFor((): void => expect(getByRole('status').textContent).toBe('focus:dark'));
    await act(async (): Promise<void> => {
      initial.resolve(emptySnapshot(Date.now()));
      await initial.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getByRole('status').textContent).toBe('focus:dark');
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

  it('fails closed when getSnapshot rejects', async (): Promise<void> => {
    sendMessageMock.mockRejectedValue(new Error('worker unavailable'));
    const { getByRole } = render(h(Probe, null));

    await waitFor((): void => {
      expect(getByRole('status').textContent).toBe('unavailable');
    });
  });

  it('shows no session controls when the initial snapshot is unavailable', async (): Promise<void> => {
    sendMessageMock.mockRejectedValue(new Error('worker unavailable'));
    const { getByRole, queryByRole } = render(h(App, null));

    await waitFor((): void => {
      expect(getByRole('status').textContent?.trim()).toBe('Focus status unavailable');
    });
    expect(queryByRole('button', { name: 'Start focusing' })).toBeNull();
    expect(queryByRole('button', { name: /Unlock all sites/ })).toBeNull();
    expect(queryByRole('button', { name: 'End session' })).toBeNull();
  });

  it('fails closed when getSnapshot returns a malformed active object', async (): Promise<void> => {
    sendMessageMock.mockResolvedValue({
      phase: 'focus',
      config: { strictness: 'friction' },
    });
    const { getByRole } = render(h(Probe, null));

    await waitFor((): void => {
      expect(getByRole('status').textContent).toBe('unavailable');
    });
  });

  it('fails closed when a stateChanged broadcast is malformed', async (): Promise<void> => {
    sendMessageMock.mockResolvedValue(emptySnapshot(Date.now()));
    const { getByRole } = render(h(Probe, null));
    await waitFor((): void => {
      expect(getByRole('status').textContent).toBe('idle');
    });

    emitMessage({ type: 'stateChanged', snapshot: { phase: 'focus' } });

    await waitFor((): void => {
      expect(getByRole('status').textContent).toBe('unavailable');
    });
  });
});

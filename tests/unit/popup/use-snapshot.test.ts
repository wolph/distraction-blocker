/** @vitest-environment jsdom */
import './chrome-fake';

import { act, cleanup, render, waitFor } from '@testing-library/preact';
import { h, type VNode } from 'preact';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { App } from '../../../src/popup/App';
import { useSnapshot } from '../../../src/popup/use-snapshot';
import {
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  DEFAULT_SETUP,
  emptySnapshot,
  rulesFromLists,
} from '../../../src/shared/constants';
import type { SessionSnapshot } from '../../../src/shared/types';
import { emitMessage, resetChromeFake, sendMessageMock } from './chrome-fake';

/** The one-shot guard `use-snapshot.ts` writes before it reloads. */
const RELOAD_FLAG: string = 'focusLockSnapshotReload';

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
    lifecycle: {
      kind: 'active',
      // Friction reaches its End through the cancel gate, so no gate is open yet.
      endAuthority: {
        kind: 'friction-gate',
        gate: null,
        copy: { actionLabel: 'End session' },
        actions: { open: 'open-end-gate' },
      },
    },
    phase: 'focus',
    config: {
      mode: 'blacklist',
      strictness: 'friction',
      duration: { kind: 'timed', minutes: 25 },
      cycling: DEFAULT_SETTINGS.defaultCycling,
      intention: '',
      source: 'manual',
      scheduleOccurrence: null,
      rules: rulesFromLists(DEFAULT_LISTS),
    },
    startedAt: at,
    phaseStartedAt: at,
    phaseEndsAt: at + 25 * 60_000,
    sessionEndsAt: at + 25 * 60_000,
  };
}

/**
 * jsdom refuses to redefine location's own properties, so the whole global is stubbed. The spread
 * carries the URL: jsdom gives Location its attributes as own enumerable members, not as
 * prototype accessors, so href and the rest survive it. That is what the assertion pins, because
 * a jsdom that moved them onto the prototype would leave anything reading the URL under this
 * stub with undefined, and the failure would surface far from here.
 */
function stubReload(): Mock<() => void> {
  const reload: Mock<() => void> = vi.fn<() => void>();
  const href: string = window.location.href;
  vi.stubGlobal('location', { ...window.location, reload });
  expect(location.href).toBe(href);
  return reload;
}

describe('useSnapshot', () => {
  beforeEach((): void => {
    resetChromeFake();
    sessionStorage.clear();
  });

  afterEach((): void => {
    cleanup();
    vi.unstubAllGlobals();
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
    sendMessageMock.mockImplementation(async (request: { type: string }): Promise<unknown> => {
      if (request.type === 'getSetupState') {
        return {
          ...DEFAULT_SETUP,
          completed: true,
          storageMode: 'local',
          websiteAccess: 'granted',
          blockingRegistration: 'ready',
        };
      }
      throw new Error('worker unavailable');
    });
    const { getByRole, queryByRole } = render(h(App, null));

    await waitFor((): void => {
      expect(getByRole('status').textContent?.trim()).toBe('Focus status unavailable');
    });
    expect(queryByRole('button', { name: /^Start / })).toBeNull();
    expect(queryByRole('button', { name: /Unlock all sites/ })).toBeNull();
    expect(queryByRole('button', { name: 'End session' })).toBeNull();
  });

  it('reloads once for a snapshot it cannot validate', async (): Promise<void> => {
    const reload: Mock<() => void> = stubReload();
    sendMessageMock.mockResolvedValue({
      phase: 'focus',
      config: { strictness: 'friction' },
    });
    const { getByRole } = render(h(Probe, null));

    // jsdom cannot navigate, so the guard flag and the reload call are what the page leaves behind.
    await waitFor((): void => {
      expect(sessionStorage.getItem(RELOAD_FLAG)).toBe('1');
    });
    expect(reload).toHaveBeenCalledOnce();
    expect(getByRole('status').textContent).toBe('loading');
  });

  it('never reloads a page whose session storage refuses to remember the attempt', async (): Promise<void> => {
    const reload: Mock<() => void> = stubReload();
    vi.stubGlobal('sessionStorage', {
      getItem: (): string | null => {
        throw new Error('storage is blocked');
      },
      setItem: (): void => {
        throw new Error('storage is blocked');
      },
    });
    sendMessageMock.mockResolvedValue({
      phase: 'focus',
      config: { strictness: 'friction' },
    });
    const { getByRole } = render(h(Probe, null));

    await waitFor((): void => {
      expect(getByRole('status').textContent).toBe('unavailable');
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it('fails closed when the reloaded page still cannot validate the snapshot', async (): Promise<void> => {
    const reload: Mock<() => void> = stubReload();
    sessionStorage.setItem(RELOAD_FLAG, '1');
    sendMessageMock.mockResolvedValue({
      phase: 'focus',
      config: { strictness: 'friction' },
    });
    const { getByRole } = render(h(Probe, null));

    await waitFor((): void => {
      expect(getByRole('status').textContent).toBe('unavailable');
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it('fails closed when a stateChanged broadcast is malformed after the reload', async (): Promise<void> => {
    sessionStorage.setItem(RELOAD_FLAG, '1');
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

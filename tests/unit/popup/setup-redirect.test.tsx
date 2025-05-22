/** @vitest-environment jsdom */
import './chrome-fake';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../../src/popup/App';
import {
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  DEFAULT_SETUP,
  emptySnapshot,
} from '../../../src/shared/constants';
import type { Request } from '../../../src/shared/messages';
import type { SetupState } from '../../../src/shared/types';
import { resetChromeFake, sendMessageMock, tabsCreateMock } from './chrome-fake';

let setup: SetupState;

beforeEach((): void => {
  resetChromeFake();
  setup = structuredClone(DEFAULT_SETUP);
  sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
    if (request.type === 'getSetupState') return structuredClone(setup);
    if (request.type === 'getSnapshot') return emptySnapshot(Date.now());
    if (request.type === 'getSettings') return DEFAULT_SETTINGS;
    if (request.type === 'getLists') return DEFAULT_LISTS;
    return { ok: true };
  });
});

afterEach((): void => cleanup());

describe('popup setup routing', (): void => {
  it('replaces session controls for incomplete setup and opens onboarding', async (): Promise<void> => {
    const view = render(<App />);

    expect(await view.findByRole('heading', { name: 'Finish setting up Focus Lock' })).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Start focusing' })).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Open setup' }));
    await waitFor((): void => {
      expect(sendMessageMock).toHaveBeenCalledWith({ type: 'openOnboarding' });
    });
    expect(tabsCreateMock).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { error: 'missing ok' },
    { ok: true, extra: true },
    { ok: false },
    { ok: false, error: '' },
    { ok: false, error: 'worker failed', extra: true },
  ])(
    'shows a retryable setup error for malformed open response %#',
    async (response: unknown): Promise<void> => {
      const normalImplementation: ((request: Request) => Promise<unknown>) | undefined =
        sendMessageMock.getMockImplementation();
      if (normalImplementation === undefined) throw new Error('missing normal worker fake');
      sendMessageMock.mockImplementation(
        async (request: Request): Promise<unknown> =>
          request.type === 'openOnboarding' ? response : normalImplementation(request),
      );
      const view = render(<App />);

      fireEvent.click(await view.findByRole('button', { name: 'Open setup' }));

      expect((await view.findByRole('alert')).textContent).toBe('Could not open setup. Try again.');
      expect(view.getByRole('button', { name: 'Open setup' })).toBeTruthy();
    },
  );

  it('shows completed setup session controls without a setup redirect', async (): Promise<void> => {
    setup = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };

    const view = render(<App />);

    expect(await view.findByRole('button', { name: 'Start focusing' })).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Open setup' })).toBeNull();
  });

  it('shows and dismisses the truthful registration-loss notice', async (): Promise<void> => {
    setup = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'local',
      websiteAccess: 'denied',
      blockingRegistration: 'unavailable',
      websiteAccessNotice: 'revoked-during-session',
    };

    const view = render(<App />);

    expect(
      await view.findByText('Your session ended because website access was removed.'),
    ).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Dismiss website access notice' }));
    await waitFor((): void => {
      expect(sendMessageMock).toHaveBeenCalledWith({ type: 'dismissWebsiteAccessNotice' });
    });
    await waitFor((): void => {
      expect(view.queryByText('Your session ended because website access was removed.')).toBeNull();
    });
  });

  it.each([
    {},
    { error: 'missing ok' },
    { ok: true, extra: true },
    { ok: false },
    { ok: false, error: '' },
    { ok: false, error: 'worker failed', extra: true },
  ])(
    'keeps the truthful notice visible for malformed dismissal response %#',
    async (response: unknown): Promise<void> => {
      setup = {
        ...DEFAULT_SETUP,
        completed: true,
        storageMode: 'local',
        websiteAccess: 'denied',
        blockingRegistration: 'unavailable',
        websiteAccessNotice: 'revoked-during-session',
      };
      const normalImplementation: ((request: Request) => Promise<unknown>) | undefined =
        sendMessageMock.getMockImplementation();
      if (normalImplementation === undefined) throw new Error('missing normal worker fake');
      sendMessageMock.mockImplementation(
        async (request: Request): Promise<unknown> =>
          request.type === 'dismissWebsiteAccessNotice' ? response : normalImplementation(request),
      );
      const view = render(<App />);
      const notice: string = 'Your session ended because website access was removed.';

      fireEvent.click(await view.findByRole('button', { name: 'Dismiss website access notice' }));

      expect((await view.findByRole('alert')).textContent).toBe(
        'Could not dismiss this notice. Try again.',
      );
      expect(view.getByText(notice)).toBeTruthy();
      expect(view.getByRole('button', { name: 'Dismiss website access notice' })).toBeTruthy();
    },
  );

  it('does not show a stale notice after blocking registration is ready', async (): Promise<void> => {
    setup = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'local',
      websiteAccess: 'granted',
      blockingRegistration: 'ready',
      websiteAccessNotice: 'registration-failed-during-session',
    };

    const view = render(<App />);

    expect(await view.findByRole('button', { name: 'Start focusing' })).toBeTruthy();
    expect(view.queryByText(/session ended/i)).toBeNull();
  });
});

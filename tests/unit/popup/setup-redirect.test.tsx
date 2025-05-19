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
      expect(tabsCreateMock).toHaveBeenCalledWith({
        url: 'chrome-extension://fake-id/src/onboarding/onboarding.html',
      });
    });
  });

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

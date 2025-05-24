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
import {
  permissionsRequestMock,
  resetChromeFake,
  sendMessageMock,
  tabsCreateMock,
} from './chrome-fake';

let setup: SetupState;

beforeEach((): void => {
  resetChromeFake();
  setup = structuredClone(DEFAULT_SETUP);
  sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
    if (request.type === 'getSetupState') return structuredClone(setup);
    if (request.type === 'getSnapshot') return emptySnapshot(Date.now());
    if (request.type === 'getSettings') return DEFAULT_SETTINGS;
    if (request.type === 'getLists') return DEFAULT_LISTS;
    if (request.type === 'reconcileWebsiteAccess') {
      return { ok: true, granted: false, registration: 'unavailable' };
    }
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

  it('keeps session start unavailable when completed setup has no website blocking', async (): Promise<void> => {
    setup = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'local',
      websiteAccess: 'denied',
      blockingRegistration: 'unavailable',
    };

    const view = render(<App />);

    expect(await view.findByText('Website blocking is off')).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Start focusing' })).toBeNull();
    expect(view.getByRole('button', { name: 'Enable website blocking' })).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Open setup' })).toBeNull();
    expect(permissionsRequestMock).not.toHaveBeenCalled();
  });

  it('requests website access directly and reconciles it before enabling session start', async (): Promise<void> => {
    setup = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'local',
      websiteAccess: 'denied',
      blockingRegistration: 'unavailable',
    };
    permissionsRequestMock.mockResolvedValue(true);
    const normalImplementation: ((request: Request) => Promise<unknown>) | undefined =
      sendMessageMock.getMockImplementation();
    if (normalImplementation === undefined) throw new Error('missing normal worker fake');
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type === 'reconcileWebsiteAccess') {
        setup = {
          ...setup,
          websiteAccess: 'granted',
          blockingRegistration: 'ready',
        };
        return { ok: true, granted: true, registration: 'ready' };
      }
      return normalImplementation(request);
    });
    const view = render(<App />);

    fireEvent.click(await view.findByRole('button', { name: 'Enable website blocking' }));

    await waitFor((): void => expect(permissionsRequestMock).toHaveBeenCalledOnce());
    expect(sendMessageMock).toHaveBeenCalledWith({ type: 'reconcileWebsiteAccess' });
    expect(await view.findByRole('button', { name: 'Start focusing' })).toBeTruthy();
  });

  it('keeps blocking off after denial and offers Retry', async (): Promise<void> => {
    setup = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'local',
      websiteAccess: 'denied',
      blockingRegistration: 'unavailable',
    };
    const view = render(<App />);

    fireEvent.click(await view.findByRole('button', { name: 'Enable website blocking' }));

    expect((await view.findByRole('status')).textContent).toBe(
      'Chrome did not grant website access. Website blocking is still off.',
    );
    expect(sendMessageMock).toHaveBeenCalledWith({ type: 'reconcileWebsiteAccess' });
    expect(view.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Start focusing' })).toBeNull();
  });

  it('shows session controls after completed setup only when registration is ready', async (): Promise<void> => {
    setup = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'local',
      websiteAccess: 'granted',
      blockingRegistration: 'ready',
    };

    const view = render(<App />);

    expect(await view.findByRole('button', { name: 'Start focusing' })).toBeTruthy();
    expect(view.queryByText('Website blocking is off')).toBeNull();
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

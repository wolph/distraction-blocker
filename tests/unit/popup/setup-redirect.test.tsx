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

function moveFocusToDocumentBody(): void {
  const focusSink: HTMLButtonElement = document.createElement('button');
  document.body.append(focusSink);
  focusSink.focus();
  focusSink.remove();
  expect(document.activeElement).toBe(document.body);
}

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
    expect(view.queryByRole('button', { name: /^Start / })).toBeNull();
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
    expect(view.queryByRole('button', { name: /^Start / })).toBeNull();
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
    expect(await view.findByRole('button', { name: /^Start 25 min/ })).toBeTruthy();
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
    expect(view.queryByRole('button', { name: /^Start / })).toBeNull();
  });

  it('focuses Retry after a denied popup permission action settles', async (): Promise<void> => {
    setup = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'local',
      websiteAccess: 'denied',
      blockingRegistration: 'unavailable',
    };
    const normalImplementation: ((request: Request) => Promise<unknown>) | undefined =
      sendMessageMock.getMockImplementation();
    if (normalImplementation === undefined) throw new Error('missing normal worker fake');
    const reconciliationGate: { resolve: (() => void) | null } = { resolve: null };
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type !== 'reconcileWebsiteAccess') return normalImplementation(request);
      await new Promise<void>((resolve: () => void): void => {
        reconciliationGate.resolve = resolve;
      });
      return { ok: true, granted: false, registration: 'unavailable' };
    });
    const view = render(<App />);
    const enable: HTMLButtonElement = (await view.findByRole('button', {
      name: 'Enable website blocking',
    })) as HTMLButtonElement;
    enable.focus();
    fireEvent.click(enable);
    await waitFor((): void => expect(enable.disabled).toBe(true));
    moveFocusToDocumentBody();

    const resolveReconciliation: (() => void) | null = reconciliationGate.resolve;
    if (resolveReconciliation === null) throw new Error('reconciliation request did not start');
    resolveReconciliation();
    const retry: HTMLButtonElement = (await view.findByRole('button', {
      name: 'Retry',
    })) as HTMLButtonElement;
    await waitFor((): void => expect(document.activeElement).toBe(retry));
  });

  it('keeps user-moved focus when popup permission reconciliation settles', async (): Promise<void> => {
    setup = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'local',
      websiteAccess: 'denied',
      blockingRegistration: 'unavailable',
    };
    const normalImplementation: ((request: Request) => Promise<unknown>) | undefined =
      sendMessageMock.getMockImplementation();
    if (normalImplementation === undefined) throw new Error('missing normal worker fake');
    const reconciliationGate: { resolve: (() => void) | null } = { resolve: null };
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type !== 'reconcileWebsiteAccess') return normalImplementation(request);
      await new Promise<void>((resolve: () => void): void => {
        reconciliationGate.resolve = resolve;
      });
      return { ok: true, granted: false, registration: 'unavailable' };
    });
    const view = render(<App />);
    const enable: HTMLButtonElement = (await view.findByRole('button', {
      name: 'Enable website blocking',
    })) as HTMLButtonElement;
    enable.focus();
    fireEvent.click(enable);
    await waitFor((): void => expect(enable.disabled).toBe(true));
    const statistics: HTMLButtonElement = view.getByRole('button', {
      name: 'Settings',
    }) as HTMLButtonElement;
    statistics.focus();
    expect(document.activeElement).toBe(statistics);

    const resolveReconciliation: (() => void) | null = reconciliationGate.resolve;
    if (resolveReconciliation === null) throw new Error('reconciliation request did not start');
    resolveReconciliation();
    expect(await view.findByRole('button', { name: 'Retry' })).toBeTruthy();
    await waitFor((): void => expect(document.activeElement).toBe(statistics));
  });

  it.each([
    {
      promptGranted: true,
      response: {
        ok: false,
        error: 'Registration failed after permission changed.',
        granted: false,
        registration: 'error',
      },
      websiteAccess: 'denied' as const,
      blockingRegistration: 'unavailable' as const,
      expectedCopy: 'Chrome did not grant website access. Website blocking is still off.',
      absentCopy:
        'Website access is granted, but Focus Lock could not enable blocking. Retry setup or reload the extension.',
    },
    {
      promptGranted: false,
      response: {
        ok: false,
        error: 'Registration failed after permission changed.',
        granted: true,
        registration: 'error',
      },
      websiteAccess: 'granted' as const,
      blockingRegistration: 'error' as const,
      expectedCopy:
        'Website access is granted, but Focus Lock could not enable blocking. Retry setup or reload the extension.',
      absentCopy: 'Chrome did not grant website access. Website blocking is still off.',
    },
  ])(
    'renders and reloads authoritative reconciliation mismatch %#',
    async ({
      promptGranted,
      response,
      websiteAccess,
      blockingRegistration,
      expectedCopy,
      absentCopy,
    }): Promise<void> => {
      setup = {
        ...DEFAULT_SETUP,
        completed: true,
        storageMode: 'local',
        websiteAccess: 'pending',
        blockingRegistration: 'unavailable',
      };
      permissionsRequestMock.mockResolvedValue(promptGranted);
      const normalImplementation: ((request: Request) => Promise<unknown>) | undefined =
        sendMessageMock.getMockImplementation();
      if (normalImplementation === undefined) throw new Error('missing normal worker fake');
      sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
        if (request.type !== 'reconcileWebsiteAccess') return normalImplementation(request);
        setup = { ...setup, websiteAccess, blockingRegistration };
        return response;
      });
      const first = render(<App />);

      fireEvent.click(await first.findByRole('button', { name: 'Enable website blocking' }));

      expect((await first.findByRole('status')).textContent).toBe(expectedCopy);
      expect(first.queryByText(absentCopy)).toBeNull();
      expect(first.queryByRole('button', { name: /^Start / })).toBeNull();

      first.unmount();
      const reloaded = render(<App />);
      expect((await reloaded.findByRole('status')).textContent).toBe(expectedCopy);
      expect(reloaded.queryByText(absentCopy)).toBeNull();
      expect(reloaded.queryByRole('button', { name: /^Start / })).toBeNull();
    },
  );

  it('shows session controls after completed setup only when registration is ready', async (): Promise<void> => {
    setup = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'local',
      websiteAccess: 'granted',
      blockingRegistration: 'ready',
    };

    const view = render(<App />);

    expect(await view.findByRole('button', { name: /^Start 25 min/ })).toBeTruthy();
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

    expect(await view.findByRole('button', { name: /^Start 25 min/ })).toBeTruthy();
    expect(view.queryByText(/session ended/i)).toBeNull();
  });
});

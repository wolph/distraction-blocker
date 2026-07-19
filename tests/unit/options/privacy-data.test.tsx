/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../../src/options/App';
import {
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  DEFAULT_SETUP,
  emptySnapshot,
} from '../../../src/shared/constants';
import type { Request } from '../../../src/shared/messages';
import { WEBSITE_ORIGINS } from '../../../src/shared/permissions';
import {
  LEGACY_REMOTE_POLICY_DROPPED_COPY,
  LOCAL_ONLY_DATA_ITEMS,
  SYNCED_DATA_ITEMS,
} from '../../../src/shared/privacy-copy';
import type { SetupState } from '../../../src/shared/types';
import type { ChromeFake } from './chrome-fake';
import { installChromeFake } from './chrome-fake';

interface ChromeActions {
  permissionRequest: ReturnType<typeof vi.fn>;
  tabCreate: ReturnType<typeof vi.fn>;
}

let fake: ChromeFake;
let setup: SetupState;
let actions: ChromeActions;

function setupState(update: Partial<SetupState> = {}): SetupState {
  return {
    ...DEFAULT_SETUP,
    completed: true,
    websiteAccess: 'denied',
    blockingRegistration: 'unavailable',
    storageMode: 'sync',
    ...update,
  };
}

function installActions(): ChromeActions {
  const permissionRequest: ReturnType<typeof vi.fn> = vi.fn(async (): Promise<boolean> => true);
  const tabCreate: ReturnType<typeof vi.fn> = vi.fn(async (): Promise<void> => {});
  const chromeObject: {
    runtime: { id?: string };
    permissions?: { request: typeof permissionRequest };
    tabs?: { create: typeof tabCreate };
  } = globalThis.chrome as unknown as {
    runtime: { id?: string };
    permissions?: { request: typeof permissionRequest };
    tabs?: { create: typeof tabCreate };
  };
  chromeObject.runtime.id = 'focus-lock-test';
  chromeObject.permissions = { request: permissionRequest };
  chromeObject.tabs = { create: tabCreate };
  return { permissionRequest, tabCreate };
}

function renderPrivacy(): ReturnType<typeof render> {
  return render(<App />);
}

beforeEach((): void => {
  window.history.replaceState(null, '', '/#privacy');
  setup = setupState();
  fake = installChromeFake();
  actions = installActions();
  fake.respond('getSettings', DEFAULT_SETTINGS);
  fake.respond('getLists', DEFAULT_LISTS);
  fake.respond('getSnapshot', emptySnapshot(0));
  fake.respond('getSetupState', (): SetupState => structuredClone(setup));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:focus-lock-export');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((): void => {});
});

afterEach((): void => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('Privacy and data', (): void => {
  it('distinguishes missing access from registration failure', async (): Promise<void> => {
    const missing = renderPrivacy();
    await waitFor((): void => expect(missing.getByText('Website access is off')).toBeTruthy());
    expect(missing.getByRole('button', { name: 'Enable website blocking' })).toBeTruthy();
    cleanup();

    setup = setupState({ websiteAccess: 'granted', blockingRegistration: 'error' });
    const failed = renderPrivacy();
    await waitFor((): void =>
      expect(
        failed.getByText('Website access is granted, but blocking is not active'),
      ).toBeTruthy(),
    );
    expect(failed.getByRole('button', { name: 'Retry website blocking' })).toBeTruthy();
  });

  it('rereads the setup record when the worker writes it while the page is open', async (): Promise<void> => {
    // Every state below is written by the worker without this page asking, so a page that read
    // the record once keeps reporting the old one. Website access is the one that matters most:
    // Settings would say blocking is enabled while enforcement is off.
    setup = setupState({ websiteAccess: 'granted', blockingRegistration: 'ready' });
    const view = renderPrivacy();
    await waitFor((): void => expect(view.getByText('Website blocking is enabled')).toBeTruthy());

    setup = setupState({ websiteAccess: 'denied', blockingRegistration: 'unavailable' });
    act((): void => {
      fake.emitStorageChange({ setup: { newValue: structuredClone(setup) } });
    });

    await waitFor((): void => expect(view.getByText('Website access is off')).toBeTruthy());
    expect(view.queryByText('Website blocking is enabled')).toBeNull();
  });

  it('surfaces a data-clear failure that the worker records while the page is open', async (): Promise<void> => {
    const view = renderPrivacy();
    await waitFor((): void => expect(view.getByText('Website access is off')).toBeTruthy());
    expect(view.queryByRole('button', { name: 'Retry all data deletion' })).toBeNull();

    setup = setupState({ dataClear: { status: 'error', scope: 'all', phase: 'browser-reset' } });
    act((): void => {
      fake.emitStorageChange({ setup: { newValue: structuredClone(setup) } });
    });

    await waitFor((): void =>
      expect(view.getByRole('button', { name: 'Retry all data deletion' })).toBeTruthy(),
    );
  });

  it('ignores storage changes that are not the setup record', async (): Promise<void> => {
    setup = setupState({ websiteAccess: 'granted', blockingRegistration: 'ready' });
    const view = renderPrivacy();
    await waitFor((): void => expect(view.getByText('Website blocking is enabled')).toBeTruthy());
    const before: number = fake.sent.filter(
      (request: Request): boolean => request.type === 'getSetupState',
    ).length;

    act((): void => {
      fake.emitStorageChange({ runtime: { newValue: {} } });
      fake.emitStorageChange({ setup: { newValue: {} } }, 'sync');
    });

    expect(
      fake.sent.filter((request: Request): boolean => request.type === 'getSetupState').length,
    ).toBe(before);
  });

  it('does not imply immediate privacy actions need the settings save bar', async (): Promise<void> => {
    const view = renderPrivacy();
    await waitFor((): void => expect(view.getByText('Website access is off')).toBeTruthy());

    expect(view.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Discard changes' })).toBeNull();
  });

  it('requests permission directly, reconciles registration, and exposes Chrome settings', async (): Promise<void> => {
    const callOrder: string[] = [];
    actions.permissionRequest.mockImplementation(async (): Promise<boolean> => {
      callOrder.push('permission');
      return true;
    });
    fake.respond('reconcileWebsiteAccess', (): object => {
      callOrder.push('reconcile');
      setup = setupState({ websiteAccess: 'granted', blockingRegistration: 'ready' });
      return { ok: true, granted: true, registration: 'ready' };
    });
    const view = renderPrivacy();
    await waitFor((): void =>
      expect(view.getByRole('button', { name: 'Enable website blocking' })).toBeTruthy(),
    );

    fireEvent.click(view.getByRole('button', { name: 'Enable website blocking' }));
    await waitFor((): void => expect(view.getByText('Website blocking is enabled')).toBeTruthy());
    expect(callOrder).toEqual(['permission', 'reconcile']);
    expect(actions.permissionRequest).toHaveBeenCalledWith({ origins: [...WEBSITE_ORIGINS] });

    const openSettings: HTMLButtonElement = view.getByRole('button', {
      name: 'Open Chrome permission settings',
    }) as HTMLButtonElement;
    await waitFor((): void => expect(openSettings.disabled).toBe(false));
    fireEvent.click(openSettings);
    await waitFor((): void =>
      expect(actions.tabCreate).toHaveBeenCalledWith({
        url: 'chrome://extensions/?id=focus-lock-test',
      }),
    );
  });

  it('retries registration without requesting permission again', async (): Promise<void> => {
    setup = setupState({ websiteAccess: 'granted', blockingRegistration: 'error' });
    fake.respond('reconcileWebsiteAccess', (): object => {
      setup = setupState({ websiteAccess: 'granted', blockingRegistration: 'ready' });
      return { ok: true, granted: true, registration: 'ready' };
    });
    const view = renderPrivacy();
    await waitFor((): void =>
      expect(view.getByRole('button', { name: 'Retry website blocking' })).toBeTruthy(),
    );

    fireEvent.click(view.getByRole('button', { name: 'Retry website blocking' }));
    await waitFor((): void => expect(view.getByText('Website blocking is enabled')).toBeTruthy());
    expect(actions.permissionRequest).not.toHaveBeenCalled();
  });

  it('keeps website access off when the Chrome permission prompt is denied', async (): Promise<void> => {
    actions.permissionRequest.mockResolvedValue(false);
    fake.respond('reconcileWebsiteAccess', {
      ok: true,
      granted: false,
      registration: 'unavailable',
    });
    const view = renderPrivacy();
    await waitFor((): void =>
      expect(view.getByRole('button', { name: 'Enable website blocking' })).toBeTruthy(),
    );

    fireEvent.click(view.getByRole('button', { name: 'Enable website blocking' }));
    await waitFor((): void =>
      expect(view.getByRole('status').textContent).toBe('Website access was not granted.'),
    );
    expect(view.getByText('Website access is off')).toBeTruthy();
  });

  it('shows one Sync switch, durable pending and error states, and shared data copy', async (): Promise<void> => {
    setup = setupState({ syncWriteStatus: 'pending' });
    const pending = renderPrivacy();
    await waitFor((): void =>
      expect(pending.getByText('Chrome Sync is still saving your latest changes.')).toBeTruthy(),
    );
    expect(pending.getAllByRole('switch')).toHaveLength(1);
    const syncCard: HTMLElement = document.querySelector(
      'section[aria-labelledby="chrome-sync-heading"]',
    ) as HTMLElement;
    for (const item of [...SYNCED_DATA_ITEMS, ...LOCAL_ONLY_DATA_ITEMS]) {
      expect(within(syncCard).getByText(item)).toBeTruthy();
    }
    cleanup();

    setup = setupState({ syncWriteStatus: 'error', storageError: 'sync-publish-failed' });
    const failed = renderPrivacy();
    await waitFor((): void =>
      expect(
        failed.getByText(
          'Chrome Sync could not save your latest changes. Your local save is safe.',
        ),
      ).toBeTruthy(),
    );
    expect(failed.getByRole('button', { name: 'Retry Chrome Sync' })).toBeTruthy();
  });

  it('reports synced data from an older version that the import reset', async (): Promise<void> => {
    setup = setupState({ storageMode: null, storageError: 'legacy-remote-policy-dropped' });
    const view = renderPrivacy();

    await waitFor((): void =>
      expect(view.getByText(LEGACY_REMOTE_POLICY_DROPPED_COPY)).toBeTruthy(),
    );
    expect(view.getByRole('alert').textContent).toBe(LEGACY_REMOTE_POLICY_DROPPED_COPY);
    expect(view.queryByRole('button', { name: 'Retry Chrome Sync' })).toBeNull();
  });

  it('retries Sync without deleting the accepted local save', async (): Promise<void> => {
    setup = setupState({ syncWriteStatus: 'error', storageError: 'sync-publish-failed' });
    fake.respond('retrySync' as Request['type'], (request: Request): object => {
      expect(request).toEqual({ type: 'retrySync' });
      setup = setupState({ storageMode: 'sync', syncWriteStatus: 'idle', storageError: null });
      return { ok: true, syncWriteStatus: 'idle' };
    });
    const view = renderPrivacy();
    await waitFor((): void =>
      expect(view.getByRole('button', { name: 'Retry Chrome Sync' })).toBeTruthy(),
    );

    fireEvent.click(view.getByRole('button', { name: 'Retry Chrome Sync' }));
    await waitFor((): void => expect(view.getByText('Chrome Sync is on.')).toBeTruthy());
    expect(fake.sent).not.toContainEqual({
      type: 'clearFocusLockData',
      scope: 'synced-policy',
    });
    expect(fake.sent).not.toContainEqual({
      type: 'setStorageMode',
      storageMode: 'sync',
      deleteRemote: false,
    });
  });

  it('retries a failed first Sync publication through the enable path after reload', async (): Promise<void> => {
    setup = setupState({
      storageMode: 'local',
      syncWriteStatus: 'error',
      storageError: 'sync-publish-failed',
    });
    fake.respond('setStorageMode', (request: Request): object => {
      expect(request).toEqual({ type: 'setStorageMode', storageMode: 'sync', deleteRemote: false });
      setup = setupState({ storageMode: 'sync', syncWriteStatus: 'idle', storageError: null });
      return { ok: true };
    });
    const view = renderPrivacy();
    const retry: HTMLButtonElement = await waitFor(
      (): HTMLButtonElement =>
        view.getByRole('button', { name: 'Retry enabling Chrome Sync' }) as HTMLButtonElement,
    );

    fireEvent.click(retry);

    await waitFor((): void => expect(view.getByText('Chrome Sync is on.')).toBeTruthy());
    expect(fake.sent).toContainEqual({
      type: 'setStorageMode',
      storageMode: 'sync',
      deleteRemote: false,
    });
    expect(fake.sent).not.toContainEqual({ type: 'retrySync' });
  });

  it.each([
    {
      scope: 'local-history' as const,
      label: 'Retry local history deletion',
      copy: 'Local history could not be deleted. Try again.',
    },
    {
      scope: 'synced-policy' as const,
      label: 'Retry remote Sync deletion',
      copy: 'Remote Chrome Sync data could not be deleted. Try again.',
    },
  ])(
    'prioritizes and retries the durable $scope deletion failure after reload',
    async ({ scope, label, copy }): Promise<void> => {
      const dataClear: SetupState['dataClear'] =
        scope === 'local-history'
          ? { status: 'error', scope, phase: 'local' }
          : { status: 'error', scope, phase: 'remote' };
      setup = setupState({
        syncWriteStatus: 'error',
        storageError: scope === 'local-history' ? 'local-clear-failed' : 'remote-deletion-failed',
        dataClear,
      });
      fake.respond('clearFocusLockData', (request: Request): object => {
        expect(request).toEqual({ type: 'clearFocusLockData', scope });
        setup = setupState();
        return { ok: true, scope, status: 'cleared' };
      });
      const view = renderPrivacy();

      await waitFor((): void => expect(view.getByText(copy)).toBeTruthy());
      expect(
        view.queryByText(
          'Chrome Sync could not save your latest changes. Your local save is safe.',
        ),
      ).toBeNull();
      expect(view.queryByRole('button', { name: 'Retry Chrome Sync' })).toBeNull();

      fireEvent.click(view.getByRole('button', { name: label }));
      await waitFor((): void =>
        expect(fake.sent).toContainEqual({ type: 'clearFocusLockData', scope }),
      );
    },
  );

  it('retries a stuck all-data deletion rather than asking for a new one', async (): Promise<void> => {
    setup = setupState({
      dataClear: { status: 'error', scope: 'all', phase: 'browser-reset' },
    });
    fake.respond('retryDataClear', (request: Request): object => {
      expect(request).toEqual({ type: 'retryDataClear' });
      setup = setupState({
        dataClear: { status: 'pending', scope: 'all', phase: 'browser-reset' },
      });
      return { ok: true, code: 'ok' };
    });
    const view = renderPrivacy();

    await waitFor((): void =>
      expect(view.getByText('All Focus Lock data could not be deleted. Try again.')).toBeTruthy(),
    );

    fireEvent.click(view.getByRole('button', { name: 'Retry all data deletion' }));

    // Asking for a new deletion is what ran no phase of the one already in progress and answered
    // success for it, so the button resumes the clear the journal is holding instead.
    await waitFor((): void => expect(fake.sent).toContainEqual({ type: 'retryDataClear' }));
    expect(fake.sent).not.toContainEqual({ type: 'clearFocusLockData', scope: 'all' });
    await waitFor((): void =>
      expect(view.getByText('Resuming deletion of all Focus Lock data.')).toBeTruthy(),
    );
  });

  it('reports an all-data retry the worker refused', async (): Promise<void> => {
    setup = setupState({
      dataClear: { status: 'error', scope: 'all', phase: 'browser-reset' },
    });
    fake.respond('retryDataClear', (): object => ({
      ok: false,
      code: 'retry-not-available',
      error: 'Data clear retry is not available.',
    }));
    const view = renderPrivacy();

    await waitFor((): void =>
      expect(view.getByText('All Focus Lock data could not be deleted. Try again.')).toBeTruthy(),
    );

    fireEvent.click(view.getByRole('button', { name: 'Retry all data deletion' }));

    // The refusal is the answer the user gets. Reporting the resumption the worker declined would
    // leave them waiting on a deletion that never restarted.
    await waitFor((): void =>
      expect(view.getByRole('alert').textContent).toBe('Could not delete data. Try again.'),
    );
    expect(view.queryByText('Resuming deletion of all Focus Lock data.')).toBeNull();
  });

  it('disables Sync without combining remote deletion', async (): Promise<void> => {
    fake.respond('setStorageMode', (request: Request): object => {
      expect(request).toEqual({
        type: 'setStorageMode',
        storageMode: 'local',
        deleteRemote: false,
      });
      setup = setupState({ storageMode: 'local' });
      return { ok: true };
    });
    const view = renderPrivacy();
    const sync: HTMLInputElement = await waitFor(
      (): HTMLInputElement =>
        view.getByRole('switch', {
          name: 'Sync Focus Lock data across Chrome devices',
        }) as HTMLInputElement,
    );

    fireEvent.click(sync);
    await waitFor((): void => expect(sync.checked).toBe(false));
    expect(fake.sent).not.toContainEqual({
      type: 'clearFocusLockData',
      scope: 'synced-policy',
    });
    expect(view.getByRole('button', { name: 'Delete remote Sync data' })).toBeTruthy();
  });

  it('cancels and confirms local-history deletion with complete scope copy', async (): Promise<void> => {
    setup = setupState({ storageMode: 'local' });
    fake.respond('clearFocusLockData', {
      ok: true,
      scope: 'local-history',
      status: 'cleared',
    });
    const view = renderPrivacy();
    await waitFor((): void =>
      expect(view.getByRole('button', { name: 'Delete local history' })).toBeTruthy(),
    );

    fireEvent.click(view.getByRole('button', { name: 'Delete local history' }));
    const dialog: HTMLElement = view.getByRole('dialog', { name: 'Delete local history?' });
    expect(dialog.textContent).toContain('full URLs');
    expect(dialog.textContent).toContain('focus intentions');
    expect(dialog.textContent).toContain('detailed session events');
    expect(dialog.textContent).toContain('local-only aggregate statistics');
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
    expect(
      fake.sent.some((request: Request): boolean => request.type === 'clearFocusLockData'),
    ).toBe(false);

    fireEvent.click(view.getByRole('button', { name: 'Delete local history' }));
    fireEvent.click(view.getByRole('button', { name: 'Confirm delete local history' }));
    await waitFor((): void =>
      expect(view.getByRole('status').textContent).toBe('Local history deleted.'),
    );
    expect(fake.sent).toContainEqual({ type: 'clearFocusLockData', scope: 'local-history' });
    expect(view.getAllByRole('status')).toHaveLength(1);
  });

  it('focuses the safe confirmation action and restores focus after Escape', async (): Promise<void> => {
    const view = renderPrivacy();
    const open: HTMLButtonElement = await waitFor(
      (): HTMLButtonElement =>
        view.getByRole('button', { name: 'Delete local history' }) as HTMLButtonElement,
    );

    fireEvent.click(open);
    await waitFor((): void => expect(document.activeElement?.textContent).toBe('Cancel'));
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor((): void => {
      expect(view.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(open);
    });
  });

  it('traps Tab in the modal and makes the background inert until cancellation', async (): Promise<void> => {
    const view = renderPrivacy();
    const open: HTMLButtonElement = await waitFor(
      (): HTMLButtonElement =>
        view.getByRole('button', { name: 'Delete local history' }) as HTMLButtonElement,
    );
    const exportButton: HTMLButtonElement = view.getByRole('button', {
      name: 'Export local event log',
    }) as HTMLButtonElement;

    fireEvent.click(open);
    const dialog: HTMLElement = view.getByRole('dialog', { name: 'Delete local history?' });
    const cancel: HTMLButtonElement = view.getByRole('button', {
      name: 'Cancel',
    }) as HTMLButtonElement;
    const confirm: HTMLButtonElement = view.getByRole('button', {
      name: 'Confirm delete local history',
    }) as HTMLButtonElement;
    await waitFor((): void => expect(document.activeElement).toBe(cancel));
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog.hasAttribute('open')).toBe(true);

    confirm.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);

    fireEvent.click(exportButton);
    expect(fake.sent).not.toContainEqual({ type: 'exportEvents' });
    expect(view.getByRole('dialog')).toBe(dialog);

    fireEvent.click(cancel);
    await waitFor((): void => expect(view.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(open);
  });

  it('keeps remote deletion separate, off-only, and preserves local data in its copy', async (): Promise<void> => {
    setup = setupState({ storageMode: 'local' });
    fake.respond('clearFocusLockData', {
      ok: true,
      scope: 'synced-policy',
      status: 'cleared',
    });
    const view = renderPrivacy();
    await waitFor((): void =>
      expect(view.getByRole('button', { name: 'Delete remote Sync data' })).toBeTruthy(),
    );

    fireEvent.click(view.getByRole('button', { name: 'Delete remote Sync data' }));
    const dialog: HTMLElement = view.getByRole('dialog', { name: 'Delete remote Sync data?' });
    for (const text of [
      'settings',
      'block and allow lists',
      'site access credit',
      'streaks',
      'domain-level blocked-attempt aggregates',
      'Local settings and statistics stay on this device.',
    ]) {
      expect(dialog.textContent).toContain(text);
    }
    fireEvent.click(view.getByRole('button', { name: 'Confirm delete remote Sync data' }));
    await waitFor((): void =>
      expect(view.getByRole('status').textContent).toBe('Remote Chrome Sync data deleted.'),
    );
    expect(fake.sent).toContainEqual({ type: 'clearFocusLockData', scope: 'synced-policy' });

    cleanup();
    setup = setupState({ storageMode: 'sync' });
    const syncing = renderPrivacy();
    await waitFor((): void => expect(syncing.getByText('Chrome Sync is on.')).toBeTruthy());
    expect(syncing.queryByRole('button', { name: 'Delete remote Sync data' })).toBeNull();
  });

  it('hides remote deletion until local-only storage is authoritative', async (): Promise<void> => {
    setup = setupState({ storageMode: null });
    const view = renderPrivacy();
    await waitFor((): void =>
      expect(
        view.getByRole('switch', { name: 'Sync Focus Lock data across Chrome devices' }),
      ).toBeTruthy(),
    );

    expect(view.queryByRole('button', { name: 'Delete remote Sync data' })).toBeNull();
  });

  it('exports the local event log and reports worker failures in one alert', async (): Promise<void> => {
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation((): void => {});
    fake.respond('exportEvents', { json: '[]' });
    fake.respond('clearFocusLockData', {
      ok: false,
      error: 'local clear failed',
      scope: 'local-history',
      status: 'pending',
    });
    const view = renderPrivacy();
    await waitFor((): void =>
      expect(view.getByRole('button', { name: 'Export local event log' })).toBeTruthy(),
    );

    fireEvent.click(view.getByRole('button', { name: 'Export local event log' }));
    await waitFor((): void => expect(anchorClick).toHaveBeenCalledOnce());
    expect(fake.sent).toContainEqual({ type: 'exportEvents' });

    fireEvent.click(view.getByRole('button', { name: 'Delete local history' }));
    await act(async (): Promise<void> => {
      fireEvent.click(view.getByRole('button', { name: 'Confirm delete local history' }));
    });
    await waitFor((): void =>
      expect(view.getByRole('alert').textContent).toContain('local clear failed'),
    );
  });
});

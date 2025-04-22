import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getContentRegistrationStatus,
  reconcileContentRegistration,
} from '../../../src/background/content-registration';
import { CONTENT_SCRIPT_ID, WEBSITE_ORIGINS } from '../../../src/shared/permissions';

const CONTENT_FILE: string = 'assets/index.iife-abc123.js';

vi.mock('../../../src/content/index.iife.ts?script&iife', () => ({
  default: 'assets/index.iife-abc123.js',
}));

interface RegistrationChrome {
  permissionGranted: boolean;
  registrations: chrome.scripting.RegisteredContentScript[];
  permissionError: Error | null;
  registrationReadError: Error | null;
  registrationWriteError: Error | null;
}

const state: RegistrationChrome = {
  permissionGranted: false,
  registrations: [],
  permissionError: null,
  registrationReadError: null,
  registrationWriteError: null,
};

function expectedRegistration(): chrome.scripting.RegisteredContentScript {
  return {
    id: CONTENT_SCRIPT_ID,
    js: [CONTENT_FILE],
    matches: [...WEBSITE_ORIGINS],
    runAt: 'document_start',
    allFrames: false,
    persistAcrossSessions: true,
    world: 'ISOLATED',
  };
}

function stubChrome(): void {
  vi.stubGlobal('chrome', {
    permissions: {
      contains: vi.fn(async (): Promise<boolean> => {
        if (state.permissionError !== null) throw state.permissionError;
        return state.permissionGranted;
      }),
    },
    scripting: {
      getRegisteredContentScripts: vi.fn(
        async (): Promise<chrome.scripting.RegisteredContentScript[]> => {
          if (state.registrationReadError !== null) throw state.registrationReadError;
          return structuredClone(state.registrations);
        },
      ),
      registerContentScripts: vi.fn(
        async (registrations: chrome.scripting.RegisteredContentScript[]): Promise<void> => {
          if (state.registrationWriteError !== null) throw state.registrationWriteError;
          state.registrations = structuredClone(registrations);
        },
      ),
      unregisterContentScripts: vi.fn(async (): Promise<void> => {
        state.registrations = [];
      }),
    },
  });
}

beforeEach((): void => {
  state.permissionGranted = false;
  state.registrations = [];
  state.permissionError = null;
  state.registrationReadError = null;
  state.registrationWriteError = null;
  stubChrome();
});

describe('runtime content registration', () => {
  it('keeps registration unavailable when website access is absent', async (): Promise<void> => {
    await expect(reconcileContentRegistration(vi.fn())).resolves.toBe('unavailable');

    expect(chrome.permissions.contains).toHaveBeenCalledWith({ origins: [...WEBSITE_ORIGINS] });
    expect(chrome.scripting.registerContentScripts).not.toHaveBeenCalled();
  });

  it('registers the emitted isolated document-start script after access is granted', async (): Promise<void> => {
    state.permissionGranted = true;

    await expect(reconcileContentRegistration(vi.fn())).resolves.toBe('ready');

    expect(chrome.scripting.registerContentScripts).toHaveBeenCalledWith([expectedRegistration()]);
  });

  it('leaves an exact registration untouched across worker restarts', async (): Promise<void> => {
    state.permissionGranted = true;
    state.registrations = [expectedRegistration()];

    await expect(reconcileContentRegistration(vi.fn())).resolves.toBe('ready');
    await expect(reconcileContentRegistration(vi.fn())).resolves.toBe('ready');

    expect(chrome.scripting.unregisterContentScripts).not.toHaveBeenCalled();
    expect(chrome.scripting.registerContentScripts).not.toHaveBeenCalled();
  });

  it('accepts Chrome-omitted registration defaults', async (): Promise<void> => {
    state.permissionGranted = true;
    const registration: chrome.scripting.RegisteredContentScript = expectedRegistration();
    delete registration.allFrames;
    delete registration.persistAcrossSessions;
    delete registration.world;
    state.registrations = [registration];

    await expect(reconcileContentRegistration(vi.fn())).resolves.toBe('ready');

    expect(chrome.scripting.unregisterContentScripts).not.toHaveBeenCalled();
    expect(chrome.scripting.registerContentScripts).not.toHaveBeenCalled();
  });

  it('replaces a registration with restrictive extras', async (): Promise<void> => {
    state.permissionGranted = true;
    state.registrations = [
      {
        ...expectedRegistration(),
        excludeMatches: ['https://example.com/*'],
      },
    ];

    await expect(reconcileContentRegistration(vi.fn())).resolves.toBe('ready');

    expect(chrome.scripting.unregisterContentScripts).toHaveBeenCalledOnce();
    expect(chrome.scripting.registerContentScripts).toHaveBeenCalledOnce();
  });

  it('serializes concurrent reconciliation so duplicate registration stays idempotent', async (): Promise<void> => {
    state.permissionGranted = true;

    await Promise.all([
      reconcileContentRegistration(vi.fn()),
      reconcileContentRegistration(vi.fn()),
    ]);

    expect(chrome.scripting.registerContentScripts).toHaveBeenCalledOnce();
  });

  it('replaces a stale registration before reporting readiness', async (): Promise<void> => {
    state.permissionGranted = true;
    state.registrations = [{ ...expectedRegistration(), runAt: 'document_idle' }];

    await expect(reconcileContentRegistration(vi.fn())).resolves.toBe('ready');

    expect(chrome.scripting.unregisterContentScripts).toHaveBeenCalledWith({
      ids: [CONTENT_SCRIPT_ID],
    });
    expect(chrome.scripting.registerContentScripts).toHaveBeenCalledWith([expectedRegistration()]);
  });

  it('removes a retained registration when access is removed', async (): Promise<void> => {
    state.registrations = [expectedRegistration()];

    await expect(reconcileContentRegistration(vi.fn())).resolves.toBe('unavailable');

    expect(chrome.scripting.unregisterContentScripts).toHaveBeenCalledWith({
      ids: [CONTENT_SCRIPT_ID],
    });
  });

  it('reports the original API failure and returns a truthful error status', async (): Promise<void> => {
    const failure: Error = new Error('registration rejected');
    const reportError = vi.fn();
    state.permissionGranted = true;
    state.registrationWriteError = failure;

    await expect(reconcileContentRegistration(reportError)).resolves.toBe('error');

    expect(reportError).toHaveBeenCalledWith(failure);
    expect(await getContentRegistrationStatus(reportError)).toBe('error');
  });

  it('classifies missing access, exact registration, and stale registration', async (): Promise<void> => {
    await expect(getContentRegistrationStatus(vi.fn())).resolves.toBe('unavailable');

    state.permissionGranted = true;
    state.registrations = [expectedRegistration()];
    await expect(getContentRegistrationStatus(vi.fn())).resolves.toBe('ready');

    state.registrations = [{ ...expectedRegistration(), world: 'MAIN' }];
    await expect(getContentRegistrationStatus(vi.fn())).resolves.toBe('error');
    expect(chrome.scripting.registerContentScripts).not.toHaveBeenCalled();
  });
});

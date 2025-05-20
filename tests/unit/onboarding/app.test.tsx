/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../../src/onboarding/App';
import type { OnboardingDraft } from '../../../src/onboarding/draft-storage';
import { DEFAULT_LISTS, DEFAULT_SETTINGS, DEFAULT_SETUP } from '../../../src/shared/constants';
import type { Request } from '../../../src/shared/messages';
import { isOnboardingDraft } from '../../../src/shared/runtime-validation';
import { LOCAL_ONBOARDING_DRAFT } from '../../../src/shared/storage-keys';
import type { SetupState, StorageMode } from '../../../src/shared/types';

const sendMessageMock = vi.fn<(request: Request) => Promise<unknown>>();
const permissionRequestMock = vi.fn<() => Promise<boolean>>();
let localState: Record<string, unknown> = {};
let setupState: SetupState = DEFAULT_SETUP;

function installChromeFake(): void {
  vi.stubGlobal('chrome', {
    permissions: {
      request: permissionRequestMock,
    },
    runtime: {
      getURL: (path: string): string => `chrome-extension://fake-id/${path}`,
      sendMessage: sendMessageMock,
    },
  });
}

function loadStoredDraft(): OnboardingDraft | null {
  const stored: unknown = localState[LOCAL_ONBOARDING_DRAFT];
  return isOnboardingDraft(stored) ? structuredClone(stored) : null;
}

function saveDraftResponse(draft: OnboardingDraft): unknown {
  const current: OnboardingDraft | null = loadStoredDraft();
  if (setupState.completed) {
    return {
      ok: false,
      error: 'Setup was completed in another tab.',
      conflict: true,
      completed: true,
      draft: current,
    };
  }
  const expectedRevision: number = current?.revision ?? 0;
  const canSave: boolean =
    (current === null && draft.revision === 0) ||
    (current !== null && draft.revision === current.revision);
  if (!canSave) {
    return {
      ok: false,
      error: 'Setup changed in another tab. The latest choices were reloaded.',
      conflict: true,
      completed: false,
      draft: current,
    };
  }
  const saved: OnboardingDraft = { ...structuredClone(draft), revision: expectedRevision + 1 };
  localState[LOCAL_ONBOARDING_DRAFT] = saved;
  return { ok: true, draft: structuredClone(saved) };
}

function completeOnboardingResponse(revision: number, storageMode: StorageMode): unknown {
  const current: OnboardingDraft | null = loadStoredDraft();
  if (
    setupState.completed ||
    current === null ||
    current.revision !== revision ||
    current.step !== 3 ||
    storageMode !== (current.syncEnabled ? 'sync' : 'local')
  ) {
    return { ok: false, error: 'Setup changed in another tab. Reload the latest choices.' };
  }
  setupState = { ...setupState, completed: true, storageMode };
  delete localState[LOCAL_ONBOARDING_DRAFT];
  return { ok: true };
}

async function persistedDraft(): Promise<OnboardingDraft> {
  await waitFor((): void => {
    expect(localState[LOCAL_ONBOARDING_DRAFT]).toBeDefined();
  });
  return structuredClone(localState[LOCAL_ONBOARDING_DRAFT]) as OnboardingDraft;
}

beforeEach((): void => {
  localState = {};
  setupState = structuredClone(DEFAULT_SETUP);
  sendMessageMock.mockReset();
  permissionRequestMock.mockReset();
  permissionRequestMock.mockResolvedValue(false);
  sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
    if (request.type === 'getSetupState') return structuredClone(setupState);
    if (request.type === 'getSettings') return structuredClone(DEFAULT_SETTINGS);
    if (request.type === 'getLists') return structuredClone(DEFAULT_LISTS);
    if (request.type === 'getOnboardingDraft') {
      const draft: OnboardingDraft | null = loadStoredDraft();
      return {
        draft,
        invalid: Object.hasOwn(localState, LOCAL_ONBOARDING_DRAFT) && draft === null,
      };
    }
    if (request.type === 'saveOnboardingDraft') return saveDraftResponse(request.draft);
    if (request.type === 'cleanupOnboardingDraft') {
      if (!setupState.completed) return { ok: false, error: 'Setup is not complete.' };
      delete localState[LOCAL_ONBOARDING_DRAFT];
      return { ok: true };
    }
    if (request.type === 'completeOnboarding') {
      return completeOnboardingResponse(request.revision, request.storageMode);
    }
    if (request.type === 'reconcileWebsiteAccess') {
      return { ok: true, granted: false, registration: 'unavailable' };
    }
    return { ok: true };
  });
  installChromeFake();
});

afterEach((): void => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('onboarding page state', (): void => {
  it('persists Step 1 choices before navigating and restores Step 2 on reload', async (): Promise<void> => {
    const first = render(<App />);
    expect(await first.findByText('Step 1 of 3')).toBeTruthy();
    expect(first.getByRole('heading', { name: 'Choose your starting block list' })).toBeTruthy();

    fireEvent.click(first.getByRole('checkbox', { name: 'Social' }));
    await waitFor((): void => {
      expect((localState[LOCAL_ONBOARDING_DRAFT] as OnboardingDraft).lists.categories.social).toBe(
        true,
      );
    });
    fireEvent.click(first.getByRole('button', { name: 'Continue' }));
    expect(await first.findByText('Step 2 of 3')).toBeTruthy();
    const draft: OnboardingDraft = await persistedDraft();
    expect(draft.step).toBe(2);
    expect(draft.lists.categories.social).toBe(true);
    expect(
      sendMessageMock.mock.calls.map(([request]: [Request]): Request['type'] => request.type),
    ).not.toContain('completeSetup');

    first.unmount();
    const reloaded = render(<App />);
    expect(await reloaded.findByRole('heading', { name: 'Enable website blocking' })).toBeTruthy();
    expect(reloaded.getByText('Step 2 of 3')).toBeTruthy();
    expect(permissionRequestMock).not.toHaveBeenCalled();
  });

  it('persists a denied permission attempt without advancing', async (): Promise<void> => {
    localState[LOCAL_ONBOARDING_DRAFT] = {
      version: 1,
      revision: 1,
      step: 2,
      settings: DEFAULT_SETTINGS,
      lists: DEFAULT_LISTS,
      websiteAccessChoice: 'pending',
      syncEnabled: true,
    } satisfies OnboardingDraft;

    const view = render(<App />);
    const enable: HTMLElement = await view.findByRole('button', {
      name: 'Enable website blocking',
    });
    fireEvent.click(enable);

    await waitFor((): void => {
      const draft: OnboardingDraft = localState[LOCAL_ONBOARDING_DRAFT] as OnboardingDraft;
      expect(draft.step).toBe(2);
      expect(draft.websiteAccessChoice).toBe('denied');
    });
    expect(permissionRequestMock).toHaveBeenCalledOnce();
    expect(view.getByText('Step 2 of 3')).toBeTruthy();
  });

  it('persists Not now before advancing to Step 3', async (): Promise<void> => {
    localState[LOCAL_ONBOARDING_DRAFT] = {
      version: 1,
      revision: 1,
      step: 2,
      settings: DEFAULT_SETTINGS,
      lists: DEFAULT_LISTS,
      websiteAccessChoice: 'pending',
      syncEnabled: true,
    } satisfies OnboardingDraft;

    const view = render(<App />);
    fireEvent.click(await view.findByRole('button', { name: 'Not now' }));

    expect(await view.findByText('Step 3 of 3')).toBeTruthy();
    const draft: OnboardingDraft = await persistedDraft();
    expect(draft.step).toBe(3);
    expect(draft.websiteAccessChoice).toBe('deferred');
    expect(permissionRequestMock).not.toHaveBeenCalled();
  });

  it('commits settings and lists only through the final setup action', async (): Promise<void> => {
    localState[LOCAL_ONBOARDING_DRAFT] = {
      version: 1,
      revision: 4,
      step: 3,
      settings: DEFAULT_SETTINGS,
      lists: DEFAULT_LISTS,
      websiteAccessChoice: 'deferred',
      syncEnabled: false,
    } satisfies OnboardingDraft;

    const view = render(<App />);
    fireEvent.click(await view.findByRole('button', { name: 'Finish setup without sync' }));

    expect(await view.findByRole('heading', { name: 'Setup complete' })).toBeTruthy();
    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'completeOnboarding',
      revision: 4,
      storageMode: 'local',
    });
    expect(localState[LOCAL_ONBOARDING_DRAFT]).toBeUndefined();
  });

  it('ignores and removes a stale draft when setup is complete', async (): Promise<void> => {
    setupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    localState[LOCAL_ONBOARDING_DRAFT] = {
      version: 1,
      revision: 1,
      step: 2,
      settings: DEFAULT_SETTINGS,
      lists: DEFAULT_LISTS,
      websiteAccessChoice: 'denied',
      syncEnabled: true,
    } satisfies OnboardingDraft;

    const view = render(<App />);

    expect(await view.findByRole('heading', { name: 'Setup complete' })).toBeTruthy();
    await waitFor((): void => expect(localState[LOCAL_ONBOARDING_DRAFT]).toBeUndefined());
  });

  it('shows completed setup and removes its draft without loading editable policy', async (): Promise<void> => {
    setupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    localState[LOCAL_ONBOARDING_DRAFT] = { invalid: true };
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type === 'getSetupState') return structuredClone(setupState);
      if (request.type === 'cleanupOnboardingDraft') {
        delete localState[LOCAL_ONBOARDING_DRAFT];
        return { ok: true };
      }
      throw new Error('editable policy unavailable');
    });

    const view = render(<App />);

    expect(await view.findByRole('heading', { name: 'Setup complete' })).toBeTruthy();
    await waitFor((): void => expect(localState[LOCAL_ONBOARDING_DRAFT]).toBeUndefined());
  });

  it('recovers an invalid draft from loaded defaults with a visible notice', async (): Promise<void> => {
    localState[LOCAL_ONBOARDING_DRAFT] = { version: 1, step: 8, syncEnabled: 'yes' };

    const view = render(<App />);

    expect((await view.findByRole('status')).textContent).toBe(
      'Your saved setup progress could not be restored. Starting again with your current defaults.',
    );
    expect(view.getByText('Step 1 of 3')).toBeTruthy();
    const draft: OnboardingDraft = await persistedDraft();
    expect(draft.step).toBe(1);
    expect(draft.settings).toEqual(DEFAULT_SETTINGS);
    expect(draft.lists).toEqual(DEFAULT_LISTS);
  });

  it('renders a retryable load error as the only page state', async (): Promise<void> => {
    sendMessageMock.mockRejectedValue(new Error('worker unavailable'));

    const view = render(<App />);

    expect((await view.findByRole('alert')).textContent).toBe('Could not load setup. Try again.');
    expect(view.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(view.queryByText(/Step \d of 3/)).toBeNull();
  });
});

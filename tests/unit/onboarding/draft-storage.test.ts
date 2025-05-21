import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  completeOnboardingDraft,
  loadOnboardingDraft,
  OnboardingDraftConflictError,
  OnboardingDraftOperationalError,
  removeOnboardingDraft,
  saveOnboardingDraft,
} from '../../../src/onboarding/draft-storage';
import { DEFAULT_LISTS, DEFAULT_SETTINGS } from '../../../src/shared/constants';
import type { Request } from '../../../src/shared/messages';
import type { OnboardingDraft } from '../../../src/shared/types';

const sendMessageMock = vi.fn<(request: Request) => Promise<unknown>>();
const DRAFT: OnboardingDraft = {
  version: 1,
  revision: 2,
  step: 1,
  settings: DEFAULT_SETTINGS,
  lists: DEFAULT_LISTS,
  websiteAccessChoice: 'pending',
  syncEnabled: true,
};

beforeEach((): void => {
  sendMessageMock.mockReset();
  vi.stubGlobal('chrome', { runtime: { sendMessage: sendMessageMock } });
});

describe('onboarding draft response boundary', (): void => {
  it.each([
    { ok: false, error: 'storage unavailable', draft: null },
    { ok: true, invalid: false },
    { draft: DRAFT, invalid: false },
    { ok: true, draft: DRAFT, invalid: true },
  ])('rejects malformed load response %#', async (response: unknown): Promise<void> => {
    sendMessageMock.mockResolvedValue(response);

    await expect(loadOnboardingDraft()).rejects.toBeInstanceOf(OnboardingDraftOperationalError);
  });

  it('distinguishes an operational save failure from a revision conflict', async (): Promise<void> => {
    sendMessageMock.mockResolvedValue({ ok: false, error: 'storage set failed' });

    await expect(saveOnboardingDraft(DRAFT)).rejects.toBeInstanceOf(
      OnboardingDraftOperationalError,
    );
    await expect(saveOnboardingDraft(DRAFT)).rejects.not.toBeInstanceOf(
      OnboardingDraftConflictError,
    );
  });

  it.each([
    { ok: true },
    { ok: true, draft: { ...DRAFT, revision: -1 } },
    { ok: false, error: 'conflict', conflict: true, completed: false },
    {
      ok: false,
      error: 'conflict',
      conflict: true,
      completed: false,
      draft: DRAFT,
      extra: true,
    },
  ])('rejects malformed save response %#', async (response: unknown): Promise<void> => {
    sendMessageMock.mockResolvedValue(response);

    await expect(saveOnboardingDraft(DRAFT)).rejects.toBeInstanceOf(
      OnboardingDraftOperationalError,
    );
  });

  it('preserves the exact conflict variant', async (): Promise<void> => {
    sendMessageMock.mockResolvedValue({
      ok: false,
      error: 'Setup changed in another tab.',
      conflict: true,
      completed: false,
      draft: DRAFT,
    });

    await expect(saveOnboardingDraft(DRAFT)).rejects.toMatchObject({
      name: 'OnboardingDraftConflictError',
      completed: false,
      draft: DRAFT,
    });
  });

  it('rejects malformed cleanup responses', async (): Promise<void> => {
    sendMessageMock.mockResolvedValue({ ok: true, extra: true });

    await expect(removeOnboardingDraft()).rejects.toBeInstanceOf(OnboardingDraftOperationalError);
  });

  it('distinguishes completion conflicts from operational failures', async (): Promise<void> => {
    sendMessageMock.mockResolvedValueOnce({ ok: false, error: 'policy storage failed' });
    sendMessageMock.mockResolvedValueOnce({
      ok: false,
      error: 'Setup changed in another tab.',
      conflict: true,
      completed: false,
      draft: DRAFT,
    });

    await expect(completeOnboardingDraft(2, 'sync')).rejects.toBeInstanceOf(
      OnboardingDraftOperationalError,
    );
    await expect(completeOnboardingDraft(2, 'sync')).rejects.toBeInstanceOf(
      OnboardingDraftConflictError,
    );
  });

  it.each([
    { ok: true, draft: DRAFT },
    { ok: false, error: 'conflict', conflict: false, completed: false, draft: DRAFT },
    { ok: false, error: 'conflict', conflict: true, completed: false },
  ])('rejects malformed completion response %#', async (response: unknown): Promise<void> => {
    sendMessageMock.mockResolvedValue(response);

    await expect(completeOnboardingDraft(2, 'sync')).rejects.toBeInstanceOf(
      OnboardingDraftOperationalError,
    );
  });
});

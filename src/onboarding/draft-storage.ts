import {
  type OnboardingDraftConflict,
  type OnboardingDraftLoadResponse,
  sendRequest,
} from '../shared/messages';
import {
  isOnboardingCleanupResponse,
  isOnboardingCompletionResponse,
  isOnboardingDraftLoadResponse,
  isOnboardingDraftWriteResponse,
} from '../shared/runtime-validation';
import type { ListsConfig, OnboardingDraft, Settings, StorageMode } from '../shared/types';

export type { OnboardingDraft, OnboardingStep, WebsiteAccessChoice } from '../shared/types';
export type DraftLoadResult = Extract<OnboardingDraftLoadResponse, { ok: true }>;

export class OnboardingDraftOperationalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnboardingDraftOperationalError';
  }
}

export class OnboardingDraftConflictError extends Error {
  readonly completed: boolean;
  readonly draft: OnboardingDraft | null;

  constructor(response: OnboardingDraftConflict) {
    super(response.error);
    this.name = 'OnboardingDraftConflictError';
    this.completed = response.completed;
    this.draft = response.draft;
  }
}

export function createOnboardingDraft(settings: Settings, lists: ListsConfig): OnboardingDraft {
  return {
    version: 1,
    revision: 0,
    step: 1,
    settings: structuredClone(settings),
    lists: structuredClone(lists),
    websiteAccessChoice: 'pending',
    syncEnabled: true,
  };
}

export async function loadOnboardingDraft(): Promise<DraftLoadResult> {
  const response: unknown = await sendRequest({ type: 'getOnboardingDraft' });
  if (!isOnboardingDraftLoadResponse(response)) {
    throw new OnboardingDraftOperationalError('Invalid onboarding draft load response.');
  }
  if (!response.ok) throw new OnboardingDraftOperationalError(response.error);
  return response;
}

export async function saveOnboardingDraft(draft: OnboardingDraft): Promise<OnboardingDraft> {
  const response: unknown = await sendRequest({
    type: 'saveOnboardingDraft',
    draft,
  });
  if (!isOnboardingDraftWriteResponse(response)) {
    throw new OnboardingDraftOperationalError('Invalid onboarding draft save response.');
  }
  if (!response.ok && response.conflict === true) {
    throw new OnboardingDraftConflictError(response);
  }
  if (!response.ok) throw new OnboardingDraftOperationalError(response.error);
  return response.draft;
}

export async function removeOnboardingDraft(): Promise<void> {
  const response: unknown = await sendRequest({ type: 'cleanupOnboardingDraft' });
  if (!isOnboardingCleanupResponse(response)) {
    throw new OnboardingDraftOperationalError('Invalid onboarding draft cleanup response.');
  }
  if (!response.ok) throw new OnboardingDraftOperationalError(response.error);
}

export async function completeOnboardingDraft(
  revision: number,
  storageMode: StorageMode,
): Promise<void> {
  const response: unknown = await sendRequest({
    type: 'completeOnboarding',
    revision,
    storageMode,
  });
  if (!isOnboardingCompletionResponse(response)) {
    throw new OnboardingDraftOperationalError('Invalid onboarding completion response.');
  }
  if (!response.ok && response.conflict === true) {
    throw new OnboardingDraftConflictError(response);
  }
  if (!response.ok) throw new OnboardingDraftOperationalError(response.error);
}

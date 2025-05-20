import {
  type Ack,
  type OnboardingDraftLoadResponse,
  type OnboardingDraftWriteResponse,
  sendRequest,
} from '../shared/messages';
import type { ListsConfig, OnboardingDraft, Settings } from '../shared/types';

export type { OnboardingDraft, OnboardingStep, WebsiteAccessChoice } from '../shared/types';
export type DraftLoadResult = OnboardingDraftLoadResponse;

export class OnboardingDraftConflictError extends Error {
  readonly completed: boolean;
  readonly draft: OnboardingDraft | null;

  constructor(response: Extract<OnboardingDraftWriteResponse, { ok: false }>) {
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
  return sendRequest({ type: 'getOnboardingDraft' });
}

export async function saveOnboardingDraft(draft: OnboardingDraft): Promise<OnboardingDraft> {
  const response: OnboardingDraftWriteResponse = await sendRequest({
    type: 'saveOnboardingDraft',
    draft,
  });
  if (!response.ok) throw new OnboardingDraftConflictError(response);
  return response.draft;
}

export async function removeOnboardingDraft(): Promise<void> {
  const response: Ack = await sendRequest({ type: 'cleanupOnboardingDraft' });
  if (!response.ok) throw new Error(response.error);
}

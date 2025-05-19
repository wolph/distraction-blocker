import { isListsConfig, isSettings } from '../shared/runtime-validation';
import { LOCAL_ONBOARDING_DRAFT } from '../shared/storage-keys';
import type { ListsConfig, Settings } from '../shared/types';

export type OnboardingStep = 1 | 2 | 3;
export type WebsiteAccessChoice =
  | 'pending'
  | 'granted'
  | 'denied'
  | 'deferred'
  | 'registration-error';

export interface OnboardingDraft {
  version: 1;
  step: OnboardingStep;
  settings: Settings;
  lists: ListsConfig;
  websiteAccessChoice: WebsiteAccessChoice;
  syncEnabled: boolean;
}

export interface DraftLoadResult {
  draft: OnboardingDraft | null;
  invalid: boolean;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  try {
    const actual: PropertyKey[] = Reflect.ownKeys(value);
    return (
      actual.length === keys.length &&
      actual.every((key: PropertyKey): boolean => typeof key === 'string' && keys.includes(key))
    );
  } catch {
    return false;
  }
}

export function isOnboardingDraft(value: unknown): value is OnboardingDraft {
  try {
    return (
      isRecord(value) &&
      hasExactKeys(value, [
        'version',
        'step',
        'settings',
        'lists',
        'websiteAccessChoice',
        'syncEnabled',
      ]) &&
      value.version === 1 &&
      (value.step === 1 || value.step === 2 || value.step === 3) &&
      isSettings(value.settings) &&
      isListsConfig(value.lists) &&
      (value.websiteAccessChoice === 'pending' ||
        value.websiteAccessChoice === 'granted' ||
        value.websiteAccessChoice === 'denied' ||
        value.websiteAccessChoice === 'deferred' ||
        value.websiteAccessChoice === 'registration-error') &&
      typeof value.syncEnabled === 'boolean'
    );
  } catch {
    return false;
  }
}

export function createOnboardingDraft(settings: Settings, lists: ListsConfig): OnboardingDraft {
  return {
    version: 1,
    step: 1,
    settings: structuredClone(settings),
    lists: structuredClone(lists),
    websiteAccessChoice: 'pending',
    syncEnabled: true,
  };
}

export async function loadOnboardingDraft(): Promise<DraftLoadResult> {
  const stored: Record<string, unknown> = await chrome.storage.local.get(LOCAL_ONBOARDING_DRAFT);
  if (!Object.hasOwn(stored, LOCAL_ONBOARDING_DRAFT)) return { draft: null, invalid: false };
  const value: unknown = stored[LOCAL_ONBOARDING_DRAFT];
  if (!isOnboardingDraft(value)) return { draft: null, invalid: true };
  return { draft: structuredClone(value), invalid: false };
}

export async function saveOnboardingDraft(draft: OnboardingDraft): Promise<void> {
  if (!isOnboardingDraft(draft)) throw new Error('invalid onboarding draft');
  await chrome.storage.local.set({ [LOCAL_ONBOARDING_DRAFT]: structuredClone(draft) });
}

export async function removeOnboardingDraft(): Promise<void> {
  await chrome.storage.local.remove(LOCAL_ONBOARDING_DRAFT);
}

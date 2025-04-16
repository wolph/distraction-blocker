export const SYNC_SETTINGS: string = 'settings';
export const SYNC_LISTS: string = 'lists';
export const SYNC_LIST_CATEGORY_PREFIX: string = 'lists:category:';
export const SYNC_BANK: string = 'bank';
export const SYNC_STREAK: string = 'streak';

export function syncAggKey(deviceId: string, date: string): string {
  return `agg:${deviceId}:${date}`;
}
export function syncMonthKey(deviceId: string, month: string): string {
  return `aggm:${deviceId}:${month}`;
}

export const LOCAL_RUNTIME: string = 'runtime';
export const LOCAL_EVENTS: string = 'events';
export const LOCAL_DEVICE_ID: string = 'deviceId';
export const LOCAL_SYNC_JOURNAL: string = 'syncJournal';
export const LOCAL_SYNC_QUOTA_EVICTION: string = 'syncQuotaEviction';
export const LOCAL_CACHES: string = 'caches';
export const LOCAL_LISTS_SNAPSHOT: string = 'listsSnapshot';
export const LOCAL_SETUP: string = 'setup';
export const LOCAL_INSTALL_MARKER: string = 'installMarker';
export const LOCAL_ONBOARDING_DRAFT: string = 'onboardingDraft';
export const LOCAL_POLICY_GENERATION_PREFIX: string = 'policyGeneration:';
export const LOCAL_POLICY_COMMIT: string = 'policyCommit';
export const LOCAL_DATA_CLEAR_JOURNAL: string = 'dataClearJournal';
export const LOCAL_AGGREGATE_TOMBSTONES: string = 'aggregateTombstones';
export const LOCAL_AGGREGATE_PRUNE: string = 'aggregatePrune';
export const LOCAL_SETTINGS: string = 'settings';
export const LOCAL_LISTS: string = 'lists';
export const LOCAL_BANK: string = 'bank';
export const LOCAL_STREAK: string = 'streak';

export function syncListCategoryKey(categoryId: string): string {
  return `${SYNC_LIST_CATEGORY_PREFIX}${categoryId}`;
}

export const SYNC_SETTINGS: string = 'settings';
export const SYNC_LISTS: string = 'lists';
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
export const LOCAL_CACHES: string = 'caches';

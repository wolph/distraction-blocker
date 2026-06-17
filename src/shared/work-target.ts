import type { Rejection, StartSessionResult } from './messages';

export interface WorkTab {
  tabId: number;
  title: string;
  hostname?: string;
}

export interface StoredWorkTarget {
  sessionId: string;
  tabId: number;
  incognito: boolean;
}

export type WorkTabsResult = { ok: true; tabs: WorkTab[] } | Rejection;
export type WorkTargetResult =
  | {
      ok: true;
      sessionId: string | null;
      state: 'ready' | 'missing' | 'unavailable';
      title: string | null;
    }
  | Rejection;

export function isBrowserTabId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function parseStoredWorkTarget(value: unknown): StoredWorkTarget | null {
  const record: Record<string, unknown> | null = dataRecord(value);
  if (record === null) return null;
  if (
    Object.keys(record).length !== 3 ||
    typeof record.sessionId !== 'string' ||
    record.sessionId.trim().length === 0 ||
    !isBrowserTabId(record.tabId) ||
    typeof record.incognito !== 'boolean'
  )
    return null;
  return { sessionId: record.sessionId, tabId: record.tabId, incognito: record.incognito };
}

function dataRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return null;
      const descriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(
        value,
        key,
      );
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function exact(record: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(record).length === keys.length &&
    keys.every((key: string): boolean => Object.hasOwn(record, key))
  );
}

function rejection(record: Record<string, unknown>): Rejection | null {
  return record.ok === false &&
    typeof record.error === 'string' &&
    record.error.trim().length > 0 &&
    exact(record, ['ok', 'error'])
    ? { ok: false, error: record.error }
    : null;
}

export function parseStartSessionResult(value: unknown): StartSessionResult | null {
  const record: Record<string, unknown> | null = dataRecord(value);
  if (record === null) return null;
  if (record.ok === true && exact(record, ['ok'])) return { ok: true };
  if (
    record.ok === false &&
    typeof record.error === 'string' &&
    record.error.trim().length > 0 &&
    record.sessionStarted === true &&
    exact(record, ['ok', 'error', 'sessionStarted'])
  ) {
    return { ok: false, error: record.error, sessionStarted: true };
  }
  return rejection(record);
}

export function parseWorkTargetResult(value: unknown): WorkTargetResult | null {
  const record: Record<string, unknown> | null = dataRecord(value);
  if (record === null) return null;
  if (record.ok === false) return rejection(record);
  if (record.ok !== true || !exact(record, ['ok', 'sessionId', 'state', 'title'])) return null;
  const { sessionId, state, title }: Record<string, unknown> = record;
  if (sessionId !== null && (typeof sessionId !== 'string' || sessionId.trim().length === 0))
    return null;
  if (state === 'ready' && typeof sessionId === 'string' && typeof title === 'string')
    return { ok: true, sessionId, state, title };
  if ((state === 'missing' || state === 'unavailable') && title === null)
    return { ok: true, sessionId, state, title };
  return null;
}

export function parseWorkTabsResult(value: unknown): WorkTabsResult | null {
  const record: Record<string, unknown> | null = dataRecord(value);
  if (record === null) return null;
  if (record.ok === false) return rejection(record);
  if (record.ok !== true || !exact(record, ['ok', 'tabs']) || !Array.isArray(record.tabs))
    return null;
  const tabs: WorkTab[] = [];
  try {
    for (const value of record.tabs as unknown[]) {
      const tab: Record<string, unknown> | null = dataRecord(value);
      if (
        tab === null ||
        !(
          exact(tab, ['tabId', 'title']) ||
          (exact(tab, ['tabId', 'title', 'hostname']) && isWorkHostname(tab.hostname))
        ) ||
        !isBrowserTabId(tab.tabId) ||
        typeof tab.title !== 'string'
      )
        return null;
      tabs.push({
        tabId: tab.tabId,
        title: tab.title,
        ...(Object.hasOwn(tab, 'hostname') ? { hostname: tab.hostname as string } : {}),
      });
    }
  } catch {
    return null;
  }
  return { ok: true, tabs };
}

function isWorkHostname(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) return false;
  try {
    return new URL(`http://${value}/`).hostname === value;
  } catch {
    return false;
  }
}

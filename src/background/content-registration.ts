import contentScriptFile from '../content/index.iife.ts?script&iife';
import { CONTENT_SCRIPT_ID, WEBSITE_ORIGINS } from '../shared/permissions';
import type { BlockingRegistrationStatus } from '../shared/types';

export type RegistrationErrorReporter = (error: unknown) => void;
export type WebsitePermissionStatus = 'granted' | 'denied' | 'unknown';

export interface ContentRegistrationState {
  permission: WebsitePermissionStatus;
  status: BlockingRegistrationStatus;
}

function sorted(values: readonly string[] | undefined): string[] {
  return [...(values ?? [])].sort();
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value: string, index: number): boolean => value === right[index])
  );
}

function hasValues(values: readonly string[] | undefined): boolean {
  return (values?.length ?? 0) > 0;
}

function registrationMatches(registration: chrome.scripting.RegisteredContentScript): boolean {
  return (
    registration.id === CONTENT_SCRIPT_ID &&
    arraysEqual(sorted(registration.js), [contentScriptFile]) &&
    arraysEqual(sorted(registration.matches), sorted(WEBSITE_ORIGINS)) &&
    registration.runAt === 'document_start' &&
    (registration.allFrames ?? false) === false &&
    (registration.persistAcrossSessions ?? true) === true &&
    (registration.world ?? 'ISOLATED') === 'ISOLATED' &&
    (registration.matchOriginAsFallback ?? false) === false &&
    !hasValues(registration.css) &&
    !hasValues(registration.excludeMatches)
  );
}

async function permissionGranted(): Promise<boolean> {
  return chrome.permissions.contains({ origins: [...WEBSITE_ORIGINS] });
}

async function currentRegistrations(): Promise<chrome.scripting.RegisteredContentScript[]> {
  return chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
}

export async function getContentRegistrationStatus(
  reportError: RegistrationErrorReporter,
): Promise<BlockingRegistrationStatus> {
  try {
    if (!(await permissionGranted())) return 'unavailable';
    const registrations: chrome.scripting.RegisteredContentScript[] = await currentRegistrations();
    const registration: chrome.scripting.RegisteredContentScript | undefined = registrations[0];
    return registrations.length === 1 &&
      registration !== undefined &&
      registrationMatches(registration)
      ? 'ready'
      : 'error';
  } catch (error: unknown) {
    reportError(error);
    return 'error';
  }
}

export async function reconcileContentRegistration(
  reportError: RegistrationErrorReporter,
): Promise<BlockingRegistrationStatus> {
  return (await reconcileContentRegistrationState(reportError)).status;
}

export async function reconcileContentRegistrationState(
  reportError: RegistrationErrorReporter,
): Promise<ContentRegistrationState> {
  const requested: Promise<ContentRegistrationState> = reconciliationTail.then(
    (): Promise<ContentRegistrationState> => reconcileContentRegistrationNow(reportError),
    (): Promise<ContentRegistrationState> => reconcileContentRegistrationNow(reportError),
  );
  reconciliationTail = requested.then(
    (): void => undefined,
    (): void => undefined,
  );
  return requested;
}

let reconciliationTail: Promise<void> = Promise.resolve();

async function reconcileContentRegistrationNow(
  reportError: RegistrationErrorReporter,
): Promise<ContentRegistrationState> {
  let permission: Exclude<WebsitePermissionStatus, 'unknown'>;
  try {
    const granted: boolean = await permissionGranted();
    permission = granted ? 'granted' : 'denied';
  } catch (error: unknown) {
    reportError(error);
    return { permission: 'unknown', status: 'error' };
  }
  try {
    const registrations: chrome.scripting.RegisteredContentScript[] = await currentRegistrations();
    if (permission === 'denied') {
      if (registrations.length > 0) {
        await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
      }
      return { permission, status: 'unavailable' };
    }
    const registration: chrome.scripting.RegisteredContentScript | undefined = registrations[0];
    if (
      registrations.length === 1 &&
      registration !== undefined &&
      registrationMatches(registration)
    ) {
      return { permission, status: 'ready' };
    }
    if (registrations.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    }
    await chrome.scripting.registerContentScripts([
      {
        id: CONTENT_SCRIPT_ID,
        js: [contentScriptFile],
        matches: [...WEBSITE_ORIGINS],
        runAt: 'document_start',
        allFrames: false,
        persistAcrossSessions: true,
        world: 'ISOLATED',
      },
    ]);
    return { permission, status: 'ready' };
  } catch (error: unknown) {
    reportError(error);
    return { permission, status: 'error' };
  }
}

export { contentScriptFile };

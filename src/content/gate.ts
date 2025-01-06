/** Pure decision helpers for the document_start gate. Kept out of
 * index.ts so tests never execute the entry's top-level evaluate(). */

const CONTENT_LIFECYCLE_KEY: string = '__focusLockContentLifecycle';

export function claimContentLifecycle(scope: Record<string, unknown>): boolean {
  if (scope[CONTENT_LIFECYCLE_KEY] === true) return false;
  scope[CONTENT_LIFECYCLE_KEY] = true;
  return true;
}

export function docStateFor(readyState: DocumentReadyState): 'fresh' | 'loaded' {
  return readyState === 'loading' ? 'fresh' : 'loaded';
}

export function shouldStop(blocked: boolean, docState: 'fresh' | 'loaded'): boolean {
  return blocked && docState === 'fresh';
}

export function installPersistedPageShow(target: Window, reevaluate: () => void): () => void {
  const onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) reevaluate();
  };
  target.addEventListener('pageshow', onPageShow);
  return (): void => target.removeEventListener('pageshow', onPageShow);
}

export function recoverRestoredOverlay(document: Document): boolean {
  const staleHosts: Element[] = Array.from(document.querySelectorAll('focus-lock-overlay'));
  const wasStopped: boolean = staleHosts.length > 0 && document.title === 'Locked - Focus Lock';
  for (const host of staleHosts) host.remove();
  return wasStopped;
}

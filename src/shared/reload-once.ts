/** Set once per page, so a page that reloads into the same failure shows the error instead. */
const RELOAD_FLAG: string = 'focusLockSnapshotReload';

/**
 * An extension page older than the worker cannot validate a v2 snapshot, and the spec answers that
 * with one reload: the reloaded page is the current one. A page that fails again after reloading
 * falls through to whatever the caller already shows rather than looping.
 *
 * Answers true when the reload was started, so the caller returns without touching its own state.
 */
export function reloadOnceForInvalidSnapshot(): boolean {
  try {
    if (sessionStorage.getItem(RELOAD_FLAG) !== null) return false;
    sessionStorage.setItem(RELOAD_FLAG, '1');
  } catch {
    // A page without session storage cannot remember the attempt, so it never reloads.
    return false;
  }
  location.reload();
  return true;
}

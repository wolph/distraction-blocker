/** Pure decision helpers for the document_start gate. Kept out of
 * index.ts so tests never execute the entry's top-level evaluate(). */

export function docStateFor(readyState: DocumentReadyState): 'fresh' | 'loaded' {
  return readyState === 'loading' ? 'fresh' : 'loaded';
}

export function shouldStop(blocked: boolean, docState: 'fresh' | 'loaded'): boolean {
  return blocked && docState === 'fresh';
}

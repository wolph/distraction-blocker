import type { WebsiteAccessReconciliation } from './messages';

export type WebsiteAccessOutcome =
  | { kind: 'ready' }
  | { kind: 'denied'; error: string | null }
  | { kind: 'registration-error'; error: string }
  | { kind: 'error'; error: string };

export function websiteAccessOutcome(response: WebsiteAccessReconciliation): WebsiteAccessOutcome {
  if (response.ok) return response.granted ? { kind: 'ready' } : { kind: 'denied', error: null };
  if (response.granted === false) return { kind: 'denied', error: response.error };
  if (response.granted === true) return { kind: 'registration-error', error: response.error };
  return { kind: 'error', error: response.error };
}

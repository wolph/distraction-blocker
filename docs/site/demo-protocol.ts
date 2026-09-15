import type { Broadcast, Request } from '../../src/shared/messages';

/** What a tab iframe may ask of the page that owns it. Same origin, so a direct object works. */
export interface DemoBridge {
  handle(request: Request): Promise<unknown>;
  subscribe(tabId: number, listener: (message: Broadcast) => void): () => void;
  clockSpeed: number;
}

export const DEMO_BRIDGE_KEY: '__focusLockDemo' = '__focusLockDemo';
export const TAB_ID_PARAM: 'tab' = 'tab';
export const DEMO_CLOCK_SPEED: number = 60;

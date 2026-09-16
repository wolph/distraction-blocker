/**
 * The session the demo boots with. A visitor lands on a blocked Headlines tab with a focus session
 * already running, so the lockscreen is the first thing on screen and the story starts from there.
 */

import type { ListsConfig, SessionConfigV2 } from '../../src/shared/types';
import type { DemoEngine } from './engine';

export const DEMO_INTENTION: string = 'Finish the proposal';
export const DEMO_SESSION_MINUTES: number = 25;

/** A timed Friction session under the saved lists, the same rules the popup would capture. */
export function demoSessionConfig(lists: ListsConfig): SessionConfigV2 {
  return {
    mode: 'blacklist',
    strictness: 'friction',
    duration: { kind: 'timed', minutes: DEMO_SESSION_MINUTES },
    cycling: null,
    intention: DEMO_INTENTION,
    source: 'manual',
    scheduleOccurrence: null,
    rules: {
      baselineRevision: 'demo',
      baselineCategories: lists.categories,
      categories: lists.categories,
      exclusions: {},
      permanentBlacklist: lists.custom,
      permanentAllowlist: lists.whitelist,
      sessionBlacklist: [],
      sessionAllowlist: [],
    },
  };
}

/** Starts the seeded session with the draft as the work tab, then lands on Headlines. */
export async function seedDemoSession(
  engine: DemoEngine,
  workTabId: number,
  landingTabId: number,
): Promise<void> {
  const lists: ListsConfig = await engine.handle({ type: 'getLists' });
  const started = await engine.handle({
    type: 'startSession',
    config: demoSessionConfig(lists),
    workTabId,
    windowId: 1,
  });
  if (!started.ok) throw new Error(`the demo session did not start: ${started.error}`);
  engine.activate(landingTabId);
}

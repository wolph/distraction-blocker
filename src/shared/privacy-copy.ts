export const SYNCED_DATA_ITEMS: readonly string[] = [
  'Settings',
  'Block and allow lists',
  'Site access credit',
  'Streaks',
  'Domain-level blocked-attempt aggregates',
];

/** Shown while the setup record carries `legacy-remote-policy-dropped`. */
export const LEGACY_REMOTE_POLICY_DROPPED_COPY: string =
  'Some synced data from an older version could not be read and was reset.';

/**
 * Shown beside the disabled all-data control while the snapshot holds a session, a gate, or an
 * unlock, and in place of the worker's refusal when a lagging snapshot let the request through.
 * The worker refuses that clear on purpose: a Hard session must not be escapable through a delete
 * button.
 */
export const ALL_DATA_CLEAR_RUNNING_SESSION_COPY: string =
  'End the running session before deleting all data.';

/** The worker's own refusal string for an all-data clear over a runtime that is not stopped. */
export const WORKER_ALL_DATA_CLEAR_RUNNING_REFUSAL: string =
  'stop the active session and blocking state before deleting all data';

export const LOCAL_ONLY_DATA_ITEMS: readonly string[] = [
  'Full URLs',
  'Focus intentions',
  'Detailed session events',
  'Active runtime session',
];

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

export const LOCAL_ONLY_DATA_ITEMS: readonly string[] = [
  'Full URLs',
  'Focus intentions',
  'Detailed session events',
  'Active runtime session',
];

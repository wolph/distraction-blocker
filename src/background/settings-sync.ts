import type { ScheduleEntryV2, Settings } from '../shared/types';

/** Keep the existing Sync schema readable by older versions without publishing intention text. */
export function settingsForSync(settings: Settings): Settings {
  return {
    ...settings,
    schedule: settings.schedule.map(
      (entry: ScheduleEntryV2): ScheduleEntryV2 => ({
        ...entry,
        intention: '',
      }),
    ),
  };
}

/** Schedule IDs survive timing edits and reordering. New remote entries have no local intention. */
export function settingsWithLocalIntentions(incoming: Settings, local: Settings): Settings {
  const intentions: Map<string, string> = new Map(
    local.schedule.map((entry: ScheduleEntryV2): [string, string] => [entry.id, entry.intention]),
  );
  return {
    ...incoming,
    schedule: incoming.schedule.map(
      (entry: ScheduleEntryV2): ScheduleEntryV2 => ({
        ...entry,
        intention: intentions.get(entry.id) ?? '',
      }),
    ),
  };
}

/** Detect leaked fields even in a malformed remote record that cannot be accepted as settings. */
export function hasScheduleIntentions(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('schedule' in value)) return false;
  if (!Array.isArray(value.schedule)) return false;
  return value.schedule.some(
    (entry: unknown): boolean =>
      typeof entry === 'object' && entry !== null && 'intention' in entry && entry.intention !== '',
  );
}

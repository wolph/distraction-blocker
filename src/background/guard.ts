import type {
  ListsConfig,
  Rule,
  ScheduleEntry,
  SessionMode,
  SessionState,
  Settings,
  Strictness,
} from '../shared/types';

/**
 * Weakening guard for hard sessions. Additive edits always pass, edits
 * that would unlock something mid-session are rejected with a
 * user-facing reason. Friction sessions and idle allow everything.
 * Null means allowed, a string is the rejection reason.
 */

function ruleIds(rules: Rule[]): Set<string> {
  return new Set(rules.map((r: Rule): string => `${r.kind}:${r.pattern}`));
}

function removedAny(current: Rule[], incoming: Rule[]): boolean {
  const next: Set<string> = ruleIds(incoming);
  return [...ruleIds(current)].some((id: string): boolean => !next.has(id));
}

function addedAny(current: Rule[], incoming: Rule[]): boolean {
  return removedAny(incoming, current);
}

function isHard(session: SessionState | null): boolean {
  return session !== null && session.config.strictness === 'hard';
}

const STRICTNESS_STRENGTH: Record<Strictness, number> = {
  flexible: 0,
  friction: 1,
  hard: 2,
};

function strictnessWeakened(current: Strictness, incoming: Strictness): boolean {
  return STRICTNESS_STRENGTH[incoming] < STRICTNESS_STRENGTH[current];
}

export function listsChangeAllowed(
  session: SessionState | null,
  mode: SessionMode | null,
  current: ListsConfig,
  incoming: ListsConfig,
): string | null {
  if (!isHard(session)) return null;
  if (mode === 'blacklist' && removedAny(current.custom, incoming.custom)) {
    return 'a hard session is running: removing blocked sites unlocks when it ends';
  }
  if (mode === 'whitelist' && addedAny(current.whitelist, incoming.whitelist)) {
    return 'a hard session is running: new whitelist entries unlock when it ends';
  }
  for (const [id, enabled] of Object.entries(current.categories)) {
    if (
      mode === 'blacklist' &&
      enabled &&
      incoming.categories[id as keyof ListsConfig['categories']] === false
    ) {
      return 'a hard session is running: disabling categories unlocks when it ends';
    }
  }
  for (const [id, hosts] of Object.entries(incoming.exclusions)) {
    const before: Set<string> = new Set(
      current.exclusions[id as keyof ListsConfig['categories']] ?? [],
    );
    if (mode === 'blacklist' && (hosts ?? []).some((h: string): boolean => !before.has(h))) {
      return 'a hard session is running: new exclusions unlock when it ends';
    }
  }
  return null;
}

function scheduleWeakened(
  sourceEntryId: string | null,
  current: ScheduleEntry[],
  incoming: ScheduleEntry[],
): boolean {
  if (sourceEntryId === null) return false;
  const before: ScheduleEntry | undefined = current.find(
    (e: ScheduleEntry): boolean => e.id === sourceEntryId,
  );
  if (before === undefined) return false;
  const after: ScheduleEntry | undefined = incoming.find(
    (e: ScheduleEntry): boolean => e.id === sourceEntryId,
  );
  if (after === undefined) return true;
  if (before.enabled && !after.enabled) return true;
  if (before.days.some((day: number): boolean => !after.days.includes(day))) return true;
  if (after.start > before.start || after.end < before.end) return true;
  return strictnessWeakened(before.strictness, after.strictness);
}

export function settingsChangeAllowed(
  session: SessionState | null,
  current: Settings,
  incoming: Settings,
): string | null {
  if (!isHard(session)) return null;
  if (strictnessWeakened(current.defaultStrictness, incoming.defaultStrictness)) {
    return 'a hard session is running: weakening the default strictness waits until it ends';
  }
  if (incoming.gate.delayMs < current.gate.delayMs) {
    return 'a hard session is running: shortening the deliberation delay weakens the gate';
  }
  if (current.gate.requireTypedPhrase && !incoming.gate.requireTypedPhrase) {
    return 'a hard session is running: dropping the typed phrase weakens the gate';
  }
  if (incoming.pause.earnRatio > current.pause.earnRatio) {
    return 'a hard session is running: raising the pause earn rate funds more escapes';
  }
  if (incoming.pause.capMs > current.pause.capMs) {
    return 'a hard session is running: raising the pause cap funds more escapes';
  }
  if (incoming.pause.pauseMs < current.pause.pauseMs) {
    return 'a hard session is running: shortening pauses lowers their cost';
  }
  if (incoming.pause.unlockMs < current.pause.unlockMs) {
    return 'a hard session is running: shortening unlocks lowers their cost';
  }
  if (
    scheduleWeakened(
      session?.config.scheduleOccurrence?.entryId ?? null,
      current.schedule,
      incoming.schedule,
    )
  ) {
    return 'a hard session is running: its schedule entry cannot be weakened until it ends';
  }
  return null;
}

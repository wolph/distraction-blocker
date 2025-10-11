import { formatBadge } from '../shared/time';
import type { Phase, SessionSnapshotV2 } from '../shared/types';
import type { IconSpec } from './icon';

/**
 * The same palette as `icon.ts`, which cannot be shared because its record is private
 * there. The cutover slice collapses the two files and this copy goes with it.
 */
const STATE_COLORS: Record<Phase, string> = {
  idle: '#9ca3af',
  focus: '#22c55e',
  break: '#14b8a6',
  paused: '#f59e0b',
};

/** Shown while a session runs with no finite end. */
export const INDEFINITE_BADGE_TEXT: string = 'ON';

/**
 * Only an active session has clocks to report. Starting, cleanup, and error hide a
 * durable session behind a journal, so nothing about it may reach the toolbar.
 */
function projectsActiveClocks(snapshot: SessionSnapshotV2): boolean {
  return snapshot.lifecycle.kind === 'active' && snapshot.phase !== 'idle';
}

/**
 * Badge text and color for one v2 snapshot. A timed session counts the whole session
 * down, never the phase, so a phase transition cannot make the badge jump upward.
 */
export function badgeForV2(
  snapshot: SessionSnapshotV2,
  countdown: boolean,
): { text: string; color: string } {
  const color: string = STATE_COLORS[snapshot.phase];
  if (!countdown || !projectsActiveClocks(snapshot)) return { text: '', color };
  if (snapshot.sessionEndsAt === null) return { text: INDEFINITE_BADGE_TEXT, color };
  return { text: formatBadge(snapshot.sessionEndsAt - snapshot.at), color };
}

/**
 * Pure description of the icon for a v2 snapshot: phase color, shackle position, and
 * phase progress. Indefinite focus has no phase end, so it draws no ring. An indefinite
 * pause does have one, so its pause ring still fills toward the pause end.
 */
export function iconSpecV2(snapshot: SessionSnapshotV2): IconSpec {
  const color: string = STATE_COLORS[snapshot.phase];
  if (
    !projectsActiveClocks(snapshot) ||
    snapshot.phaseStartedAt === null ||
    snapshot.phaseEndsAt === null
  ) {
    return { color, open: snapshot.phase === 'idle', progress: 0, glyph: 'lock', ring: false };
  }
  const span: number = snapshot.phaseEndsAt - snapshot.phaseStartedAt;
  const progress: number =
    span <= 0 ? 0 : Math.min(1, Math.max(0, (snapshot.at - snapshot.phaseStartedAt) / span));
  return {
    color,
    open: false,
    progress,
    glyph: snapshot.phase === 'break' ? 'cup' : 'lock',
    ring: true,
  };
}

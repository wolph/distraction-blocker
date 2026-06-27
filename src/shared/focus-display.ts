import { minToMs } from './time';
import type { CycleConfig, SessionSnapshot } from './types';

export interface FocusDisplay {
  text: string;
  endsAt: number | null;
  progress: number;
}

function hasUpcomingBreak(
  snapshot: SessionSnapshot,
  phaseEnd: number,
  sessionEnd: number,
): boolean {
  const cycling: CycleConfig | null = snapshot.config?.cycling ?? null;
  if (cycling === null || phaseEnd >= sessionEnd) return false;
  const isLong: boolean = (snapshot.cycleIndex + 1) % cycling.longEvery === 0;
  const breakMs: number = minToMs(isLong ? cycling.longBreakMin : cycling.shortBreakMin);
  // The session machine completes early when its final break leaves no focus time.
  return breakMs > 0 && phaseEnd + breakMs < sessionEnd - 1;
}

/** Present the next focus boundary without a constantly changing seconds display. */
export function focusDisplay(snapshot: SessionSnapshot, now: number): FocusDisplay {
  const phaseEnd: number | null = snapshot.phaseEndsAt;
  const sessionEnd: number | null = snapshot.sessionEndsAt;
  if (
    snapshot.phase === 'focus' &&
    snapshot.config?.durationMin === null &&
    phaseEnd === null &&
    sessionEnd === null
  ) {
    return { text: 'Until manual unlock', endsAt: null, progress: 0 };
  }
  if (phaseEnd === null || sessionEnd === null || snapshot.phaseStartedAt === null) {
    return { text: 'Updating session', endsAt: null, progress: 0 };
  }
  const endsAt: number = Math.min(phaseEnd, sessionEnd);
  const remaining: number = Math.max(0, endsAt - now);
  const span: number = endsAt - snapshot.phaseStartedAt;
  const progress: number =
    span <= 0 ? 1 : Math.min(1, Math.max(0, (now - snapshot.phaseStartedAt) / span));
  if (remaining === 0) return { text: 'Updating session', endsAt, progress };
  const duration: string =
    remaining < 60_000 ? 'Less than a minute' : `${Math.ceil(remaining / 60_000)} min`;
  const suffix: string = hasUpcomingBreak(snapshot, phaseEnd, sessionEnd)
    ? 'until your break'
    : 'left in this session';
  return { text: `${duration} ${suffix}`, endsAt, progress };
}

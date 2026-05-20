import type { SessionSnapshot } from './types';

export interface FocusDisplay {
  text: string;
  endsAt: number | null;
  progress: number;
}

/** Present the next focus boundary without a constantly changing seconds display. */
export function focusDisplay(snapshot: SessionSnapshot, now: number): FocusDisplay {
  const phaseEnd: number | null = snapshot.phaseEndsAt;
  const sessionEnd: number | null = snapshot.sessionEndsAt;
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
  const suffix: string = phaseEnd < sessionEnd ? 'until your break' : 'left in this session';
  return { text: `${duration} ${suffix}`, endsAt, progress };
}

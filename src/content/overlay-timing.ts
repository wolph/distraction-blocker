/**
 * The numbers the blocked page may work out on its own from a frozen active view: how much of
 * this focus block is left, how far along it is, and how the bank has grown since capture. Every
 * word around those numbers comes from the view's copy. Nothing here reads the public snapshot.
 */
import type { DocumentOverlayView } from '../shared/enforcement-v2';
import { growBank } from '../shared/live';

export type ActiveOverlayView = Extract<DocumentOverlayView, { presentation: 'active' }>;

/** The earlier of the two deadlines, or null when neither bounds this focus block. */
export function focusBoundary(view: ActiveOverlayView): number | null {
  const phaseEndsAt: number | null = view.timing.phaseEndsAt;
  const sessionEndsAt: number | null = view.timing.sessionEndsAt;
  if (phaseEndsAt === null) return sessionEndsAt;
  if (sessionEndsAt === null) return phaseEndsAt;
  return Math.min(phaseEndsAt, sessionEndsAt);
}

/** Milliseconds until the focus boundary, never negative, null when the block has no end. */
export function remainingFocusMs(view: ActiveOverlayView, now: number): number | null {
  const endsAt: number | null = focusBoundary(view);
  return endsAt === null ? null : Math.max(0, endsAt - now);
}

/** How far this focus block has run, from 0 to 1. An unbounded block never advances. */
export function focusProgress(view: ActiveOverlayView, now: number): number {
  const endsAt: number | null = focusBoundary(view);
  if (endsAt === null) return 0;
  const startedAt: number = view.timing.phaseStartedAt;
  const span: number = endsAt - startedAt;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (now - startedAt) / span));
}

/**
 * The calm time line: `18 min left in this session`, `Less than a minute until your break`,
 * `Until stopped`, or the updating label once the boundary has passed and the worker's next
 * view has not yet arrived. The words are the view's, the number is this module's.
 */
export function remainingLabel(view: ActiveOverlayView, now: number): string {
  const suffix: string | null = view.copy.remainingSuffix;
  const remaining: number | null = remainingFocusMs(view, now);
  if (suffix === null || remaining === null) return view.copy.status.text;
  if (remaining === 0) return view.copy.updatingLabel;
  const amount: string =
    remaining < 60_000
      ? view.copy.underMinuteLabel
      : `${Math.ceil(remaining / 60_000)} ${view.copy.minuteLabel}`;
  return `${amount} ${suffix}`;
}

/** Grows the frozen bank forward from the capture time, through the shared rule. */
export function bankAt(view: ActiveOverlayView, now: number): number {
  return growBank(
    view.economy.bankMs,
    view.economy.bankAccrualPerMs,
    view.economy.bankCapMs,
    view.timing.capturedAt,
    now,
  );
}

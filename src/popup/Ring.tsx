import type { VNode } from 'preact';
import { phaseProgress, remainingPhaseMs } from '../shared/live';
import { formatClock } from '../shared/time';
import type { CycleConfig, SessionDuration, SessionSnapshot } from '../shared/types';

const RING_SIZE: number = 140;
const RING_RADIUS: number = 62;
const RING_CIRCUMFERENCE: number = 2 * Math.PI * RING_RADIUS;

/** Phase colors from the icon language: green focus, teal break, amber pause. */
const PHASE_COLORS: Record<'focus' | 'break' | 'paused', string> = {
  focus: '#22c55e',
  break: '#14b8a6',
  paused: '#f59e0b',
};

function phaseLabel(snapshot: SessionSnapshot): string {
  if (snapshot.phase === 'paused') {
    const backAt: Date = new Date(snapshot.phaseEndsAt ?? snapshot.at);
    const hh: string = String(backAt.getHours()).padStart(2, '0');
    const mm: string = String(backAt.getMinutes()).padStart(2, '0');
    return `paused, back at ${hh}:${mm}`;
  }
  if (snapshot.phase === 'break') return 'break';
  return 'focusing';
}

/** An indefinite session has no total to divide, so it reports the cycle it is in and no estimate. */
function cycleLabel(snapshot: SessionSnapshot): string | null {
  const cycling: CycleConfig | null = snapshot.config?.cycling ?? null;
  if (cycling === null || snapshot.config === null) return null;
  const duration: SessionDuration = snapshot.config.duration;
  if (duration.kind === 'until-stopped') return `cycle ${snapshot.cycleIndex + 1}`;
  const perCycleMin: number = cycling.focusMin + cycling.shortBreakMin;
  const estimate: number = Math.max(
    snapshot.cycleIndex + 1,
    Math.ceil(duration.minutes / perCycleMin),
  );
  return `cycle ${snapshot.cycleIndex + 1} of ~${estimate}`;
}

export function Ring({ snapshot, now }: { snapshot: SessionSnapshot; now: number }): VNode {
  const phase: 'focus' | 'break' | 'paused' = snapshot.phase === 'idle' ? 'focus' : snapshot.phase;
  const color: string = PHASE_COLORS[phase];
  const progress: number = phaseProgress(snapshot, now);
  const dash: number = progress * RING_CIRCUMFERENCE;
  const cycle: string | null = cycleLabel(snapshot);

  return (
    <div class="ring-wrap">
      <svg
        class="ring"
        width={RING_SIZE}
        height={RING_SIZE}
        viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
        aria-hidden="true"
      >
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          fill="none"
          stroke="var(--border)"
          stroke-width="8"
        />
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          fill="none"
          stroke={color}
          stroke-width="8"
          stroke-linecap="round"
          stroke-dasharray={`${dash} ${RING_CIRCUMFERENCE}`}
          transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
        />
      </svg>
      <div class="ring-center">
        <span class="clock">{formatClock(remainingPhaseMs(snapshot, now))}</span>
      </div>
      <p class={`phase-label phase-label-${phase}`}>
        {phaseLabel(snapshot)}
        {cycle !== null ? <span class="cycle-note">{cycle}</span> : null}
      </p>
    </div>
  );
}

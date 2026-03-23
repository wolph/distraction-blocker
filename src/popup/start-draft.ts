import { isRelativeMinuteDuration } from '../shared/numeric-validation';
import { MODE_LABELS, START_UNTIL_STOPPED_LABEL } from '../shared/session-copy';
import type {
  CycleConfig,
  ListsConfig,
  SessionConfigV2,
  SessionDuration,
  SessionMode,
  SessionRuleSnapshot,
  SettingsV2,
  Strictness,
} from '../shared/types';
import { createSessionDraft, type SessionDraft } from './session-draft';

/**
 * The current duration selection. The until-stopped variant carries the unsent timed
 * preset and custom-minute draft, so a detour through Until stopped never destroys the
 * timed duration, session type, or cycle choice the user had chosen.
 */
export type DraftDuration =
  | { kind: 'timed'; presetMin: number | null; customMin: string }
  | { kind: 'until-stopped'; timed: { presetMin: number | null; customMin: string } };

export type TimedDurationDraft = { presetMin: number | null; customMin: string };

export interface StartDraft {
  mode: SessionMode;
  timedStrictness: Strictness;
  timedCycling: CycleConfig | null;
  duration: DraftDuration;
  frictionGate: { delayMs: number; requireTypedPhrase: boolean };
  intention: string;
  rules: SessionRuleSnapshot;
}

const INVALID_DURATION_LABEL: string = 'invalid time';

export function createStartDraft(settings: SettingsV2, lists: ListsConfig): StartDraft {
  const base: SessionDraft = createSessionDraft(settings, lists);
  return {
    mode: base.mode,
    timedStrictness: base.strictness,
    timedCycling: base.cycling,
    duration: { kind: 'timed', presetMin: settings.presetsMin[1], customMin: '' },
    frictionGate: base.frictionGate,
    intention: base.intention,
    rules: base.rules,
  };
}

/** The timed duration the draft holds, whether selected or stored behind Until stopped. */
export function timedDurationOf(duration: DraftDuration): TimedDurationDraft {
  return duration.kind === 'timed'
    ? { presetMin: duration.presetMin, customMin: duration.customMin }
    : duration.timed;
}

/** Stores the timed duration. Selecting Until stopped again keeps the stored one. */
export function selectUntilStopped(draft: StartDraft): StartDraft {
  if (draft.duration.kind === 'until-stopped') return draft;
  return { ...draft, duration: { kind: 'until-stopped', timed: timedDurationOf(draft.duration) } };
}

/** Brings the stored timed duration back verbatim. A no-op on a timed draft. */
export function restoreTimedDuration(draft: StartDraft): StartDraft {
  if (draft.duration.kind === 'timed') return draft;
  return { ...draft, duration: { kind: 'timed', ...draft.duration.timed } };
}

export function selectTimedPreset(draft: StartDraft, minutes: number): StartDraft {
  return { ...draft, duration: { kind: 'timed', presetMin: minutes, customMin: '' } };
}

/** Restores the stored timed duration first, so the selected preset survives the detour. */
export function setCustomMinutes(draft: StartDraft, raw: string): StartDraft {
  const timed: TimedDurationDraft = timedDurationOf(draft.duration);
  return { ...draft, duration: { kind: 'timed', presetMin: timed.presetMin, customMin: raw } };
}

export function setTimedStrictness(draft: StartDraft, strictness: Strictness): StartDraft {
  return { ...draft, timedStrictness: strictness };
}

export function setTimedCycling(draft: StartDraft, cycling: CycleConfig | null): StartDraft {
  return { ...draft, timedCycling: cycling === null ? null : structuredClone(cycling) };
}

/** Until stopped forces Flexible. The unsent timed session type survives untouched. */
export function effectiveStrictness(draft: StartDraft): Strictness {
  return draft.duration.kind === 'until-stopped' ? 'flexible' : draft.timedStrictness;
}

/** Until stopped forces cycles off. The unsent timed cycle choice survives untouched. */
export function effectiveCycling(draft: StartDraft): CycleConfig | null {
  return draft.duration.kind === 'until-stopped' ? null : draft.timedCycling;
}

/**
 * Submitted minutes for a timed draft: custom minutes when the field holds anything,
 * the selected preset otherwise. null means the draft cannot start.
 */
export function effectiveTimedMinutes(draft: StartDraft): number | null {
  if (draft.duration.kind === 'until-stopped') return null;
  const typed: string = draft.duration.customMin.trim();
  const minutes: number | null = typed === '' ? draft.duration.presetMin : Number(typed);
  return isRelativeMinuteDuration(minutes) ? minutes : null;
}

function effectiveDuration(draft: StartDraft): SessionDuration | null {
  if (draft.duration.kind === 'until-stopped') return { kind: 'until-stopped' };
  const minutes: number | null = effectiveTimedMinutes(draft);
  return minutes === null ? null : { kind: 'timed', minutes };
}

export function startLabel(draft: StartDraft): string {
  if (draft.duration.kind === 'until-stopped') return START_UNTIL_STOPPED_LABEL;
  const minutes: number | null = effectiveTimedMinutes(draft);
  const durationLabel: string = minutes === null ? INVALID_DURATION_LABEL : `${minutes} min`;
  return `Start ${durationLabel} - ${MODE_LABELS[draft.mode]}`;
}

/** null when the timed draft has no usable length. Until stopped always submits. */
export function toSessionConfigV2(draft: StartDraft): SessionConfigV2 | null {
  const duration: SessionDuration | null = effectiveDuration(draft);
  if (duration === null) return null;
  const cycling: CycleConfig | null = effectiveCycling(draft);
  return {
    mode: draft.mode,
    strictness: effectiveStrictness(draft),
    duration,
    cycling: cycling === null ? null : structuredClone(cycling),
    intention: draft.intention.trim(),
    source: 'manual',
    scheduleOccurrence: null,
    rules: structuredClone(draft.rules),
  };
}

import type { VNode } from 'preact';
import {
  DEEP_WORK_NOTE,
  INFINITY_GLYPH,
  PRESET_LABELS,
  UNTIL_STOPPED_LABEL,
} from '../shared/session-copy';
import { Chip } from './form-controls';
import { type DraftDuration, type TimedDurationDraft, timedDurationOf } from './start-draft';

/** The third preset is deep work. Its research note is a hover explanation, not a label. */
const DEEP_WORK_INDEX: number = 2;

export interface DurationControlProps {
  presets: readonly [number, number, number];
  value: DraftDuration;
  onChange(next: DraftDuration): void;
}

/**
 * The integrated duration row: timed presets, custom minutes, and Until stopped as one
 * chip group. Until stopped carries the timed draft along and keeps showing its custom
 * minutes, and the pressed chip is the return gesture that hands that draft back.
 */
export function DurationControl({ presets, value, onChange }: DurationControlProps): VNode {
  const timed: TimedDurationDraft = timedDurationOf(value);
  const indefinite: boolean = value.kind === 'until-stopped';
  const presetSelected: (min: number) => boolean = (min: number): boolean =>
    !indefinite && timed.customMin.trim() === '' && timed.presetMin === min;

  return (
    <fieldset class="duration-control" aria-label="Session length">
      {presets.map(
        (min: number, index: number): VNode => (
          <Chip
            key={min}
            label={`${min} ${PRESET_LABELS[index] ?? ''}`.trim()}
            hint={index === DEEP_WORK_INDEX ? DEEP_WORK_NOTE : undefined}
            selected={presetSelected(min)}
            onClick={(): void => onChange({ kind: 'timed', presetMin: min, customMin: '' })}
          />
        ),
      )}
      <input
        class="custom-min"
        type="number"
        min="1"
        inputMode="numeric"
        aria-label="Custom minutes"
        placeholder="min"
        value={timed.customMin}
        onInput={(event: Event): void =>
          onChange({
            kind: 'timed',
            presetMin: timed.presetMin,
            customMin: (event.currentTarget as HTMLInputElement).value,
          })
        }
      />
      <Chip
        label={INFINITY_GLYPH}
        accessibleLabel={UNTIL_STOPPED_LABEL}
        selected={indefinite}
        onClick={(): void =>
          onChange(indefinite ? { kind: 'timed', ...timed } : { kind: 'until-stopped', timed })
        }
      />
    </fieldset>
  );
}

import type { VNode } from 'preact';
import { UNTIL_STOPPED_LABEL } from '../shared/session-copy';
import { Chip } from './form-controls';
import { type DraftDuration, timedDurationOf } from './start-draft';

/** Preset labels, matching the timed duration row the popup already ships. */
const PRESET_LABELS: readonly [string, string, string] = [
  'short',
  'focus',
  'deep work (preference, not science)',
];

export interface DurationControlProps {
  presets: readonly [number, number, number];
  value: DraftDuration;
  onChange(next: DraftDuration): void;
}

/**
 * The integrated duration row: timed presets, custom minutes, and Until stopped as one
 * chip group. Until stopped carries the timed draft along, so returning to a timed
 * duration restores the preset and the typed minutes the user had chosen.
 */
export function DurationControl({ presets, value, onChange }: DurationControlProps): VNode {
  const customMin: string = value.kind === 'timed' ? value.customMin : '';
  const presetSelected: (min: number) => boolean = (min: number): boolean =>
    value.kind === 'timed' && value.customMin.trim() === '' && value.presetMin === min;

  return (
    <fieldset class="duration-control" aria-label="Session length">
      {presets.map(
        (min: number, index: number): VNode => (
          <Chip
            key={min}
            label={`${min} ${PRESET_LABELS[index] ?? ''}`.trim()}
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
        value={customMin}
        onInput={(event: Event): void =>
          onChange({
            kind: 'timed',
            presetMin: timedDurationOf(value).presetMin,
            customMin: (event.currentTarget as HTMLInputElement).value,
          })
        }
      />
      <Chip
        label={UNTIL_STOPPED_LABEL}
        selected={value.kind === 'until-stopped'}
        onClick={(): void => onChange({ kind: 'until-stopped', timed: timedDurationOf(value) })}
      />
    </fieldset>
  );
}

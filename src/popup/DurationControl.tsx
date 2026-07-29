import type { VNode } from 'preact';
import { DEEP_WORK_NOTE, UNTIL_STOPPED_LABEL } from '../shared/session-copy';
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
 * The preset and custom controls share one reversible duration draft. Until stopped keeps
 * the timed draft and its custom minutes. Pressing the chip again restores that draft.
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
            label={`${min} min`}
            hint={index === DEEP_WORK_INDEX ? DEEP_WORK_NOTE : undefined}
            selected={presetSelected(min)}
            onClick={(): void => onChange({ kind: 'timed', presetMin: min, customMin: '' })}
          />
        ),
      )}
      <Chip
        label={UNTIL_STOPPED_LABEL}
        accessibleLabel={UNTIL_STOPPED_LABEL}
        selected={indefinite}
        onClick={(): void =>
          onChange(indefinite ? { kind: 'timed', ...timed } : { kind: 'until-stopped', timed })
        }
      />
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
    </fieldset>
  );
}

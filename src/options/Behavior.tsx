import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useState } from 'preact/hooks';
import {
  isRelativeMinuteDuration,
  isSafeDayCount,
  MAX_RELATIVE_DURATION_MS,
  MAX_RELATIVE_MINUTES,
  MAX_SAFE_DAY_COUNT,
  MIN_RELATIVE_MINUTES,
} from '../shared/numeric-validation';
import { minToMs } from '../shared/time';
import type { Settings } from '../shared/types';

export interface BehaviorProps {
  settings: Settings;
  onChange: (next: Settings) => void;
}

interface NumberFieldProps {
  label: string;
  value: number;
  onValue: (value: number) => void;
  allowZero?: boolean;
  allowFraction?: boolean;
  errorMessage?: string;
  isValid?: (value: number) => boolean;
  max?: number;
  min?: number;
}

function NumberField(props: NumberFieldProps): VNode {
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const allowZero: boolean = props.allowZero ?? false;
  const allowFraction: boolean = props.allowFraction ?? false;
  const errorMessage: string =
    props.errorMessage ??
    (allowFraction
      ? `${props.label} must be zero or greater.`
      : allowZero
        ? `${props.label} must be a whole number of zero or greater.`
        : `${props.label} must be a positive whole number.`);
  return (
    <label class="field">
      {props.label}
      <input
        type="number"
        min={String(props.min ?? (allowZero ? 0 : 1))}
        max={props.max === undefined ? undefined : String(props.max)}
        step={allowFraction ? 'any' : '1'}
        value={props.value}
        onInput={(event: Event): void => {
          const raw: string = (event.currentTarget as HTMLInputElement).value;
          const value: number = Number(raw);
          const valid: boolean =
            raw.trim() !== '' &&
            Number.isFinite(value) &&
            (allowZero ? value >= 0 : value > 0) &&
            (allowFraction || Number.isInteger(value)) &&
            (props.isValid?.(value) ?? true);
          if (!valid) {
            setError(errorMessage);
            return;
          }
          setError(null);
          props.onValue(value);
        }}
      />
      {error !== null ? (
        <span class="field-error" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}

/** Default mode, strictness, cycling numbers, and the deliberation gate. */
export function BehaviorDefaults(props: BehaviorProps): VNode {
  const s: Settings = props.settings;
  const delayIsPreset: boolean =
    s.gate.delayMs === 0 || s.gate.delayMs === 10_000 || s.gate.delayMs === 30_000;
  const [customDelaySeconds, setCustomDelaySeconds]: [number, Dispatch<StateUpdater<number>>] =
    useState<number>(delayIsPreset ? 60 : s.gate.delayMs / 1_000);
  return (
    <div>
      <h3>Session defaults</h3>
      <p class="help">
        Mode and strictness are fixed when a session starts. These are the values the start form
        opens with.
      </p>
      <NumberField
        label="Short session preset (minutes)"
        value={s.presetsMin[0]}
        allowFraction
        min={MIN_RELATIVE_MINUTES}
        max={MAX_RELATIVE_MINUTES}
        isValid={isRelativeMinuteDuration}
        errorMessage="Short session preset (minutes) must be within the supported minute range."
        onValue={(value: number): void => {
          props.onChange({ ...s, presetsMin: [value, s.presetsMin[1], s.presetsMin[2]] });
        }}
      />
      <NumberField
        label="Default session preset (minutes)"
        value={s.presetsMin[1]}
        allowFraction
        min={MIN_RELATIVE_MINUTES}
        max={MAX_RELATIVE_MINUTES}
        isValid={isRelativeMinuteDuration}
        errorMessage="Default session preset (minutes) must be within the supported minute range."
        onValue={(value: number): void => {
          props.onChange({ ...s, presetsMin: [s.presetsMin[0], value, s.presetsMin[2]] });
        }}
      />
      <NumberField
        label="Deep session preset (minutes)"
        value={s.presetsMin[2]}
        allowFraction
        min={MIN_RELATIVE_MINUTES}
        max={MAX_RELATIVE_MINUTES}
        isValid={isRelativeMinuteDuration}
        errorMessage="Deep session preset (minutes) must be within the supported minute range."
        onValue={(value: number): void => {
          props.onChange({ ...s, presetsMin: [s.presetsMin[0], s.presetsMin[1], value] });
        }}
      />
      <div class="field">
        <label class="check">
          <input
            type="radio"
            name="default-mode"
            checked={s.defaultMode === 'blacklist'}
            onClick={(): void => {
              props.onChange({ ...s, defaultMode: 'blacklist' });
            }}
          />
          Blacklist: block listed sites
        </label>
        <label class="check">
          <input
            type="radio"
            name="default-mode"
            checked={s.defaultMode === 'whitelist'}
            onClick={(): void => {
              props.onChange({ ...s, defaultMode: 'whitelist' });
            }}
          />
          Whitelist: allow only listed sites
        </label>
      </div>
      <div class="field">
        <label class="check">
          <input
            type="radio"
            name="default-strictness"
            checked={s.defaultStrictness === 'friction'}
            onClick={(): void => {
              props.onChange({ ...s, defaultStrictness: 'friction' });
            }}
          />
          Friction: stopping early uses the configured deliberation gate
        </label>
        <label class="check">
          <input
            type="radio"
            name="default-strictness"
            checked={s.defaultStrictness === 'hard'}
            onClick={(): void => {
              props.onChange({ ...s, defaultStrictness: 'hard' });
            }}
          />
          Hard: no early end, temporary site access only
        </label>
      </div>
      <h3>Focus and break cycle</h3>
      <p class="help">
        Defaults: 25 minute focus, 5 minute break, 15 minute long break every 4th cycle. Breaks on a
        schedule beat break-when-you-feel-like-it for mood and focus in study samples. The exact
        minutes are convention, not science.
      </p>
      <label class="check">
        <input
          type="checkbox"
          checked={s.cyclingOnByDefault}
          onClick={(): void => {
            props.onChange({ ...s, cyclingOnByDefault: !s.cyclingOnByDefault });
          }}
        />
        Cycle focus and breaks by default
      </label>
      <NumberField
        label="Focus minutes"
        value={s.defaultCycling.focusMin}
        onValue={(value: number): void => {
          props.onChange({ ...s, defaultCycling: { ...s.defaultCycling, focusMin: value } });
        }}
      />
      <NumberField
        label="Short break minutes"
        value={s.defaultCycling.shortBreakMin}
        onValue={(value: number): void => {
          props.onChange({ ...s, defaultCycling: { ...s.defaultCycling, shortBreakMin: value } });
        }}
      />
      <NumberField
        label="Long break minutes"
        value={s.defaultCycling.longBreakMin}
        onValue={(value: number): void => {
          props.onChange({ ...s, defaultCycling: { ...s.defaultCycling, longBreakMin: value } });
        }}
      />
      <NumberField
        label="Long break every Nth cycle"
        value={s.defaultCycling.longEvery}
        onValue={(value: number): void => {
          props.onChange({ ...s, defaultCycling: { ...s.defaultCycling, longEvery: value } });
        }}
      />
      <h3>Deliberation gate</h3>
      <p class="help">
        A 10 second wait with an explicit back-to-work button measurably reduces impulse visits
        (field study, PNAS 2023). The longer wait and the typed sentence roughly double the effect.
      </p>
      <div class="field">
        <label class="check">
          <input
            type="radio"
            name="gate-delay"
            checked={s.gate.delayMs === 0}
            onClick={(): void => {
              props.onChange({ ...s, gate: { ...s.gate, delayMs: 0 } });
            }}
          />
          Wait 0 seconds
        </label>
        <label class="check">
          <input
            type="radio"
            name="gate-delay"
            checked={s.gate.delayMs === 10_000}
            onClick={(): void => {
              props.onChange({ ...s, gate: { ...s.gate, delayMs: 10_000 } });
            }}
          />
          Wait 10 seconds
        </label>
        <label class="check">
          <input
            type="radio"
            name="gate-delay"
            checked={s.gate.delayMs === 30_000}
            onClick={(): void => {
              props.onChange({ ...s, gate: { ...s.gate, delayMs: 30_000 } });
            }}
          />
          Wait 30 seconds
        </label>
        <label class="check">
          <input
            type="radio"
            name="gate-delay"
            checked={!delayIsPreset}
            onClick={(): void => {
              props.onChange({
                ...s,
                gate: { ...s.gate, delayMs: customDelaySeconds * 1_000 },
              });
            }}
          />
          Custom
        </label>
      </div>
      <NumberField
        label="Custom delay (seconds)"
        value={customDelaySeconds}
        max={MAX_RELATIVE_DURATION_MS / 1_000}
        isValid={(value: number): boolean => Number.isSafeInteger(value * 1_000)}
        errorMessage="Custom delay must be a positive whole number of seconds."
        onValue={(value: number): void => {
          setCustomDelaySeconds(value);
          props.onChange({ ...s, gate: { ...s.gate, delayMs: value * 1_000 } });
        }}
      />
      <label class="check">
        <input
          type="checkbox"
          checked={s.gate.requireTypedPhrase}
          onClick={(): void => {
            props.onChange({
              ...s,
              gate: { ...s.gate, requireTypedPhrase: !s.gate.requireTypedPhrase },
            });
          }}
        />
        Also require typing a sentence
      </label>
      <label class="check">
        <input
          type="checkbox"
          checked={s.gate.allowForceEnd}
          onClick={(): void => {
            props.onChange({
              ...s,
              gate: { ...s.gate, allowForceEnd: !s.gate.allowForceEnd },
            });
          }}
        />
        Enable "Ignore timeout and end anyway" button
      </label>
    </div>
  );
}

/** Earn rate, bank cap, spend lengths, streak goal, retention. */
export function PauseEconomy(props: BehaviorProps): VNode {
  const s: Settings = props.settings;
  const earnPer30: number = Math.round(s.pause.earnRatio * 30 * 100) / 100;
  return (
    <div>
      <p class="help">
        Site access credit accrues while you focus. Both access to all sites and a single-site
        unlock spend from the same balance. You can step away at any time without spending credit.
      </p>
      <NumberField
        label="Minutes of site access per 30 minutes of focus"
        value={earnPer30}
        allowZero
        allowFraction
        onValue={(value: number): void => {
          props.onChange({ ...s, pause: { ...s.pause, earnRatio: value / 30 } });
        }}
      />
      <NumberField
        label="Site access credit limit (minutes)"
        value={s.pause.capMs / 60_000}
        allowZero
        onValue={(value: number): void => {
          props.onChange({ ...s, pause: { ...s.pause, capMs: minToMs(value) } });
        }}
      />
      <NumberField
        label="All-site access length (minutes)"
        value={s.pause.pauseMs / 60_000}
        onValue={(value: number): void => {
          props.onChange({ ...s, pause: { ...s.pause, pauseMs: minToMs(value) } });
        }}
      />
      <NumberField
        label="Site unlock length (minutes)"
        value={s.pause.unlockMs / 60_000}
        onValue={(value: number): void => {
          props.onChange({ ...s, pause: { ...s.pause, unlockMs: minToMs(value) } });
        }}
      />
      <h3>Streak and retention</h3>
      <p class="help">
        The streak counts days that reach the goal. One default session keeps the chain alive, and a
        freeze token repairs a missed day.
      </p>
      <NumberField
        label="Daily streak goal (focus minutes)"
        value={s.streakGoalMin}
        onValue={(value: number): void => {
          props.onChange({ ...s, streakGoalMin: value });
        }}
      />
      <NumberField
        label="Freeze token interval (days)"
        value={s.streakFreezeIntervalDays}
        max={MAX_SAFE_DAY_COUNT}
        isValid={isSafeDayCount}
        errorMessage="Freeze token interval (days) must be within the supported day range."
        onValue={(value: number): void => {
          props.onChange({ ...s, streakFreezeIntervalDays: value });
        }}
      />
      <NumberField
        label="Keep daily stats (days)"
        value={s.retentionDays}
        max={MAX_SAFE_DAY_COUNT}
        isValid={isSafeDayCount}
        errorMessage="Keep daily stats (days) must be within the supported day range."
        onValue={(value: number): void => {
          props.onChange({ ...s, retentionDays: value });
        }}
      />
    </div>
  );
}

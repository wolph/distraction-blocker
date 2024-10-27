import type { VNode } from 'preact';
import { minToMs } from '../shared/time';
import type { Settings } from '../shared/types';

export interface BehaviorProps {
  settings: Settings;
  onChange: (next: Settings) => void;
}

/** Parsed non-negative number from a number input, null for anything else. */
function numberFrom(event: Event): number | null {
  const raw: string = (event.currentTarget as HTMLInputElement).value;
  const value: number = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

interface MinutesFieldProps {
  label: string;
  value: number;
  onValue: (value: number) => void;
}

function NumberField(props: MinutesFieldProps): VNode {
  return (
    <label class="field">
      {props.label}
      <input
        type="number"
        min="0"
        value={props.value}
        onInput={(event: Event): void => {
          const value: number | null = numberFrom(event);
          if (value !== null) props.onValue(value);
        }}
      />
    </label>
  );
}

/** Default mode, strictness, cycling numbers, and the deliberation gate. */
export function BehaviorDefaults(props: BehaviorProps): VNode {
  const s: Settings = props.settings;
  return (
    <div>
      <h3>Session defaults</h3>
      <p class="help">
        Mode and strictness are fixed when a session starts. These are the values the start form
        opens with.
      </p>
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
          Friction: cancel costs a 30 second wait and a typed sentence
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
          Hard: no cancel, pauses and site unlocks are the only escapes
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
      </div>
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
        Pause minutes accrue while you focus and spend from one bank, whether you pause everything
        or unlock a single site. The cap keeps a saved-up bank from funding a binge.
      </p>
      <label class="field">
        Minutes of pause per 30 minutes of focus
        <input
          type="number"
          min="0"
          value={earnPer30}
          onInput={(event: Event): void => {
            const value: number | null = numberFrom(event);
            if (value !== null) {
              props.onChange({ ...s, pause: { ...s.pause, earnRatio: value / 30 } });
            }
          }}
        />
      </label>
      <NumberField
        label="Pause bank cap (minutes)"
        value={s.pause.capMs / 60_000}
        onValue={(value: number): void => {
          props.onChange({ ...s, pause: { ...s.pause, capMs: minToMs(value) } });
        }}
      />
      <NumberField
        label="Pause length (minutes)"
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
        weekly freeze token repairs a missed day.
      </p>
      <NumberField
        label="Daily streak goal (focus minutes)"
        value={s.streakGoalMin}
        onValue={(value: number): void => {
          props.onChange({ ...s, streakGoalMin: value });
        }}
      />
      <NumberField
        label="Keep daily stats (days)"
        value={s.retentionDays}
        onValue={(value: number): void => {
          props.onChange({ ...s, retentionDays: value });
        }}
      />
    </div>
  );
}

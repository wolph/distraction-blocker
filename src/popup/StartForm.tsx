import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useState } from 'preact/hooks';
import { rulesFromLists } from '../shared/constants';
import type { Ack } from '../shared/messages';
import { sendRequest } from '../shared/messages';
import { ackError, isListsConfig } from '../shared/runtime-validation';
import type {
  CycleConfig,
  ListsConfig,
  SessionConfig,
  SessionMode,
  Settings,
  Strictness,
} from '../shared/types';
import { CategoryControls } from './category-controls';
import { Chip, RadioRow } from './form-controls';

/** Positional labels for the three presets, per the weak-evidence ledger. */
const PRESET_LABELS: readonly [string, string, string] = [
  'short',
  'focus',
  'deep work (preference, not science)',
];

type VisibleStrictness = Exclude<Strictness, 'flexible'>;

const STRICTNESS_HINTS: Record<VisibleStrictness, string> = {
  friction: 'can end early after 30 s wait typing sentence',
  hard: 'no way out until timer ends, pauses excepted',
};

const MODE_HINTS: Record<SessionMode, string> = {
  blacklist: 'block the listed sites, allow the rest',
  whitelist: 'allow the listed sites, block the rest',
};

export function StartForm({
  settings,
  lists,
  categoriesEditable = true,
}: {
  settings: Settings;
  lists: ListsConfig;
  categoriesEditable?: boolean;
}): VNode {
  const [selectedMin, setSelectedMin]: [number, Dispatch<StateUpdater<number>>] = useState<number>(
    settings.presetsMin[1],
  );
  const [customMin, setCustomMin]: [string, Dispatch<StateUpdater<string>>] = useState<string>('');
  const [intention, setIntention]: [string, Dispatch<StateUpdater<string>>] = useState<string>('');
  const [mode, setMode]: [SessionMode, Dispatch<StateUpdater<SessionMode>>] = useState<SessionMode>(
    settings.defaultMode,
  );
  const [strictness, setStrictness]: [Strictness, Dispatch<StateUpdater<Strictness>>] =
    useState<Strictness>(settings.defaultStrictness);
  const [cyclingOn, setCyclingOn]: [boolean, Dispatch<StateUpdater<boolean>>] = useState<boolean>(
    settings.cyclingOnByDefault,
  );
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const [starting, setStarting]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const [categoryUpdatePending, setCategoryUpdatePending]: [
    boolean,
    Dispatch<StateUpdater<boolean>>,
  ] = useState<boolean>(false);

  const durationMin: number = customMin.trim() === '' ? selectedMin : Number(customMin);

  const start: () => Promise<void> = async (): Promise<void> => {
    if (starting || categoryUpdatePending) return;
    if (!Number.isFinite(durationMin) || durationMin <= 0) {
      setError('enter a session length in minutes');
      return;
    }
    setError(null);
    setStarting(true);
    try {
      let currentLists: ListsConfig = lists;
      try {
        const loadedLists: ListsConfig = await sendRequest({ type: 'getLists' });
        if (isListsConfig(loadedLists)) currentLists = loadedLists;
      } catch {
        // The worker validates the fallback freshness token before starting.
      }
      const config: SessionConfig = {
        mode,
        strictness,
        durationMin,
        cycling: cyclingOn ? settings.defaultCycling : null,
        intention: intention.trim(),
        source: 'manual',
        scheduleEntryId: null,
        rules: rulesFromLists(currentLists),
      };
      const ack: Ack = await sendRequest({ type: 'startSession', config });
      const responseError: string | null = ackError(ack, 'Could not start session. Try again.');
      if (responseError !== null) setError(responseError);
    } catch {
      setError('Could not start the session. Try again.');
    } finally {
      setStarting(false);
    }
  };

  const c: CycleConfig = settings.defaultCycling;
  const cyclingLabel: string = `cycles: ${c.focusMin} min focus, ${c.shortBreakMin} min break, ${c.longBreakMin} min long break every ${c.longEvery}th`;

  return (
    <section class="view start-form">
      <fieldset class="chip-row" aria-label="Session length">
        {settings.presetsMin.map(
          (min: number, i: number): VNode => (
            <Chip
              key={min}
              label={`${min} ${PRESET_LABELS[i] ?? ''}`.trim()}
              selected={customMin.trim() === '' && selectedMin === min}
              onClick={(): void => {
                setSelectedMin(min);
                setCustomMin('');
              }}
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
          onInput={(e: Event): void => setCustomMin((e.currentTarget as HTMLInputElement).value)}
        />
      </fieldset>

      <input
        class="intention-input"
        type="text"
        placeholder="What you working on?"
        value={intention}
        onInput={(e: Event): void => setIntention((e.currentTarget as HTMLInputElement).value)}
      />

      <CategoryControls
        lists={lists}
        editable={categoriesEditable}
        onError={setError}
        onPendingChange={setCategoryUpdatePending}
      />

      <details class="options">
        <summary>Session options</summary>
        <fieldset>
          <legend>Mode</legend>
          {(['blacklist', 'whitelist'] as const).map(
            (m: SessionMode): VNode => (
              <RadioRow
                key={m}
                name="mode"
                label={m}
                hint={MODE_HINTS[m]}
                checked={mode === m}
                onSelect={(): void => setMode(m)}
              />
            ),
          )}
        </fieldset>
        <fieldset>
          <legend>Strictness</legend>
          {(['friction', 'hard'] as const).map(
            (s: VisibleStrictness): VNode => (
              <RadioRow
                key={s}
                name="strictness"
                label={s}
                hint={STRICTNESS_HINTS[s]}
                checked={strictness === s}
                onSelect={(): void => setStrictness(s)}
              />
            ),
          )}
        </fieldset>
        <label class="check-row">
          <input
            type="checkbox"
            checked={cyclingOn}
            onChange={(e: Event): void =>
              setCyclingOn((e.currentTarget as HTMLInputElement).checked)
            }
          />
          <span>{cyclingLabel}</span>
        </label>
      </details>

      <button
        type="button"
        class="start-button"
        disabled={starting || categoryUpdatePending}
        onClick={(): void => void start()}
      >
        Start focusing
      </button>
      {error !== null ? (
        <p class="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

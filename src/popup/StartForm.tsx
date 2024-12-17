import type { VNode } from 'preact';
import { useState } from 'preact/hooks';
import { ALL_CATEGORIES } from '../core/categories';
import { sendRequest } from '../shared/messages';
import type {
  CategoryId,
  CycleConfig,
  ListsConfig,
  SessionConfig,
  SessionMode,
  Settings,
  Strictness,
} from '../shared/types';
import { Chip, RadioRow } from './form-controls';

/** Positional labels for the three presets, per the weak-evidence ledger. */
const PRESET_LABELS: readonly [string, string, string] = [
  'short',
  'focus',
  'deep work (preference, not science)',
];

const STRICTNESS_HINTS: Record<Strictness, string> = {
  friction: 'can end early after a 30 s wait and typing a sentence',
  hard: 'no way out until the timer ends, pauses excepted',
};

const MODE_HINTS: Record<SessionMode, string> = {
  blacklist: 'block the listed sites, allow the rest',
  whitelist: 'allow the listed sites, block the rest',
};

export function StartForm({ settings, lists }: { settings: Settings; lists: ListsConfig }): VNode {
  const [selectedMin, setSelectedMin] = useState<number>(settings.presetsMin[1]);
  const [customMin, setCustomMin] = useState<string>('');
  const [intention, setIntention] = useState<string>('');
  const [mode, setMode] = useState<SessionMode>(settings.defaultMode);
  const [strictness, setStrictness] = useState<Strictness>(settings.defaultStrictness);
  const [cyclingOn, setCyclingOn] = useState<boolean>(settings.cyclingOnByDefault);
  const [localLists, setLocalLists] = useState<ListsConfig>(lists);
  const [pendingCategory, setPendingCategory] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const durationMin: number = customMin.trim() === '' ? selectedMin : Number(customMin);

  const toggleCategory = async (id: CategoryId): Promise<void> => {
    if (pendingCategory) return;
    const next: ListsConfig = {
      ...localLists,
      categories: { ...localLists.categories, [id]: !localLists.categories[id] },
    };
    setPendingCategory(true);
    setError(null);
    const ack = await sendRequest({ type: 'updateLists', lists: next });
    if (ack.ok) {
      setLocalLists(next);
    } else {
      setLocalLists(lists);
      setError(ack.error);
    }
    setPendingCategory(false);
  };

  const start = async (): Promise<void> => {
    if (!Number.isFinite(durationMin) || durationMin <= 0) {
      setError('enter a session length in minutes');
      return;
    }
    setError(null);
    const config: SessionConfig = {
      mode,
      strictness,
      durationMin,
      cycling: cyclingOn ? settings.defaultCycling : null,
      intention: intention.trim(),
      source: 'manual',
      scheduleEntryId: null,
    };
    const ack = await sendRequest({ type: 'startSession', config });
    if (!ack.ok) setError(ack.error);
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
        placeholder="What are you working on?"
        value={intention}
        onInput={(e: Event): void => setIntention((e.currentTarget as HTMLInputElement).value)}
      />

      {ALL_CATEGORIES.length > 0 ? (
        <fieldset
          class="pill-row"
          aria-label="Blocked categories"
          aria-busy={pendingCategory}
          disabled={pendingCategory}
        >
          {ALL_CATEGORIES.map(
            (cat): VNode => (
              <Chip
                key={cat.id}
                label={cat.title}
                selected={localLists.categories[cat.id]}
                onClick={(): void => {
                  void toggleCategory(cat.id);
                }}
              />
            ),
          )}
        </fieldset>
      ) : null}

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
            (s: Strictness): VNode => (
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

      <button type="button" class="start-button" onClick={(): void => void start()}>
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

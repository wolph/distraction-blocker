import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useRef, useState } from 'preact/hooks';
import { ALL_CATEGORIES } from '../core/categories';
import type { Ack } from '../shared/messages';
import { sendRequest } from '../shared/messages';
import { ackError } from '../shared/runtime-validation';
import type {
  CategoryId,
  CategoryList,
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

interface PendingCategoryChange {
  id: CategoryId;
  desired: boolean;
}

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
  const [localLists, setLocalLists]: [ListsConfig, Dispatch<StateUpdater<ListsConfig>>] =
    useState<ListsConfig>(lists);
  const [pendingCategories, setPendingCategories]: [
    ReadonlySet<CategoryId>,
    Dispatch<StateUpdater<ReadonlySet<CategoryId>>>,
  ] = useState<ReadonlySet<CategoryId>>(new Set());
  const localListsRef: { current: ListsConfig } = useRef<ListsConfig>(lists);
  const pendingCategoriesRef: { current: Set<CategoryId> } = useRef<Set<CategoryId>>(new Set());
  const categoryQueueRef: { current: PendingCategoryChange[] } = useRef<PendingCategoryChange[]>(
    [],
  );
  const categoryUpdateInFlightRef: { current: boolean } = useRef<boolean>(false);
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const [starting, setStarting]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);

  const durationMin: number = customMin.trim() === '' ? selectedMin : Number(customMin);

  const dispatchNextCategoryUpdate: () => Promise<void> = async (): Promise<void> => {
    if (categoryUpdateInFlightRef.current) return;
    const change: PendingCategoryChange | undefined = categoryQueueRef.current.shift();
    if (change === undefined) return;
    categoryUpdateInFlightRef.current = true;
    const next: ListsConfig = {
      ...localListsRef.current,
      categories: { ...localListsRef.current.categories, [change.id]: change.desired },
    };
    try {
      const ack: Ack = await sendRequest({ type: 'updateLists', lists: next });
      const responseError: string | null = ackError(ack, 'Could not update categories. Try again.');
      if (responseError === null) {
        const committed: ListsConfig = {
          ...localListsRef.current,
          categories: { ...localListsRef.current.categories, [change.id]: change.desired },
        };
        localListsRef.current = committed;
        setLocalLists(committed);
      } else setError(responseError);
    } catch {
      setError('Could not update categories. Try again.');
    } finally {
      const remainingPending: Set<CategoryId> = new Set(pendingCategoriesRef.current);
      remainingPending.delete(change.id);
      pendingCategoriesRef.current = remainingPending;
      setPendingCategories(remainingPending);
      categoryUpdateInFlightRef.current = false;
      void dispatchNextCategoryUpdate();
    }
  };

  const toggleCategory: (id: CategoryId) => void = (id: CategoryId): void => {
    if (!categoriesEditable || pendingCategoriesRef.current.has(id)) return;
    const desired: boolean = !localListsRef.current.categories[id];
    const nextPending: Set<CategoryId> = new Set(pendingCategoriesRef.current);
    nextPending.add(id);
    pendingCategoriesRef.current = nextPending;
    setPendingCategories(nextPending);
    categoryQueueRef.current.push({ id, desired });
    setError(null);
    void dispatchNextCategoryUpdate();
  };

  const start: () => Promise<void> = async (): Promise<void> => {
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
    setStarting(true);
    try {
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
        placeholder="What are you working on?"
        value={intention}
        onInput={(e: Event): void => setIntention((e.currentTarget as HTMLInputElement).value)}
      />

      {ALL_CATEGORIES.length > 0 ? (
        <fieldset
          class="pill-row"
          aria-label="Blocked categories"
          aria-busy={pendingCategories.size > 0}
        >
          {ALL_CATEGORIES.map(
            (cat: CategoryList): VNode => (
              <button
                type="button"
                key={cat.id}
                class={localLists.categories[cat.id] ? 'chip chip-selected' : 'chip'}
                aria-pressed={localLists.categories[cat.id]}
                disabled={!categoriesEditable || pendingCategories.has(cat.id)}
                onClick={(): void => {
                  toggleCategory(cat.id);
                }}
              >
                {cat.title}
              </button>
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

      <button
        type="button"
        class="start-button"
        disabled={starting}
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

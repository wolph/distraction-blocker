import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useState } from 'preact/hooks';
import type { Ack } from '../shared/messages';
import { sendRequest } from '../shared/messages';
import { ackError } from '../shared/runtime-validation';
import type { CycleConfig, ListsConfig, SessionMode, Settings, Strictness } from '../shared/types';
import { DomainInput } from './DomainInput';
import { Chip, RadioRow } from './form-controls';
import { RuleSummary } from './RuleSummary';
import { SessionTypeControl } from './SessionTypeControl';
import {
  addDraftAllowHost,
  createSessionDraft,
  type DraftUpdate,
  type SessionDraft,
  toggleDraftCategory,
  toSessionConfig,
} from './session-draft';

const PRESET_LABELS: readonly [string, string, string] = [
  'short',
  'focus',
  'deep work (preference, not science)',
];

interface ModeChoice {
  value: SessionMode;
  label: string;
  hint: string;
}

const MODE_CHOICES: readonly ModeChoice[] = [
  {
    value: 'blacklist',
    label: 'Block selected sites',
    hint: 'The selected categories and extra rules are blocked. Other sites remain available.',
  },
  {
    value: 'whitelist',
    label: 'Allow selected sites only',
    hint: 'Only the listed sites are available. Every other website is blocked.',
  },
];

const MODE_START_LABELS: Record<SessionMode, string> = {
  blacklist: 'Block selected sites',
  whitelist: 'Allow selected sites only',
};

export interface StartFormProps {
  settings: Settings;
  lists: ListsConfig;
  categoriesEditable?: boolean;
}

export function StartForm({ settings, lists, categoriesEditable = true }: StartFormProps): VNode {
  const [draft, setDraft]: [SessionDraft, Dispatch<StateUpdater<SessionDraft>>] =
    useState<SessionDraft>(() => createSessionDraft(settings, lists));
  const [selectedMin, setSelectedMin]: [number, Dispatch<StateUpdater<number>>] = useState<number>(
    settings.presetsMin[1],
  );
  const [customMin, setCustomMin]: [string, Dispatch<StateUpdater<string>>] = useState<string>('');
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const [starting, setStarting]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);

  const durationMin: number = customMin.trim() === '' ? selectedMin : Number(customMin);
  const durationLabel: string = Number.isFinite(durationMin)
    ? `${durationMin} min`
    : 'invalid time';
  const startLabel: string = `Start ${durationLabel} - ${MODE_START_LABELS[draft.mode]}`;

  const start: () => Promise<void> = async (): Promise<void> => {
    if (starting) return;
    if (!Number.isFinite(durationMin) || durationMin <= 0) {
      setError('Enter a session length greater than zero minutes.');
      return;
    }

    setError(null);
    setStarting(true);
    try {
      const ack: Ack = await sendRequest({
        type: 'startSession',
        config: toSessionConfig({ ...draft, durationMin }),
      });
      const responseError: string | null = ackError(ack, 'Could not start session. Try again.');
      if (responseError !== null) setError(responseError);
    } catch {
      setError('Could not start the session. Try again.');
    } finally {
      setStarting(false);
    }
  };

  const addAllowedDomain: (raw: string) => string | null = (raw: string): string | null => {
    const update: DraftUpdate = addDraftAllowHost(draft, raw);
    if (update.draft !== draft) setDraft(update.draft);
    return update.error;
  };

  const openPermanentSettings: () => Promise<void> = async (): Promise<void> => {
    setError(null);
    try {
      await chrome.runtime.openOptionsPage();
    } catch {
      setError('Could not open Settings. Try again.');
    }
  };

  const cycle: CycleConfig = settings.defaultCycling;
  const cyclingLabel: string = `Cycles: ${cycle.focusMin} min focus, ${cycle.shortBreakMin} min break, ${cycle.longBreakMin} min long break every ${cycle.longEvery}th`;

  return (
    <section class="view start-form">
      <div class="start-form__scroll">
        <fieldset class="chip-row" aria-label="Session length">
          {settings.presetsMin.map(
            (min: number, index: number): VNode => (
              <Chip
                key={min}
                label={`${min} ${PRESET_LABELS[index] ?? ''}`.trim()}
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
            onInput={(event: Event): void =>
              setCustomMin((event.currentTarget as HTMLInputElement).value)
            }
          />
        </fieldset>

        <div class="field-control">
          <label class="field-label" for="session-intention">
            Intention
          </label>
          <input
            id="session-intention"
            class="intention-input"
            type="text"
            placeholder="What are you working on?"
            value={draft.intention}
            onInput={(event: Event): void =>
              setDraft({ ...draft, intention: (event.currentTarget as HTMLInputElement).value })
            }
          />
        </div>

        <SessionTypeControl
          value={draft.strictness}
          frictionDelayMs={draft.frictionGate.delayMs}
          requireTypedPhrase={draft.frictionGate.requireTypedPhrase}
          onChange={(strictness: Strictness): void => setDraft({ ...draft, strictness })}
        />

        <fieldset class="mode-control" aria-label="Blocking mode">
          <legend>Blocking mode</legend>
          {MODE_CHOICES.map(
            (choice: ModeChoice): VNode => (
              <RadioRow
                key={choice.value}
                name="mode"
                label={choice.label}
                hint={choice.hint}
                checked={draft.mode === choice.value}
                onSelect={(): void => setDraft({ ...draft, mode: choice.value })}
              />
            ),
          )}
        </fieldset>

        {draft.mode === 'whitelist' ? <DomainInput onAdd={addAllowedDomain} /> : null}

        <RuleSummary
          draft={draft}
          categoriesEditable={categoriesEditable}
          onCategoryToggle={(id): void => {
            if (categoriesEditable) setDraft(toggleDraftCategory(draft, id));
          }}
          onOpenSettings={(): void => void openPermanentSettings()}
        />

        <details class="options">
          <summary>Cycle options</summary>
          <label class="check-row">
            <input
              type="checkbox"
              checked={draft.cycling !== null}
              onChange={(event: Event): void => {
                const enabled: boolean = (event.currentTarget as HTMLInputElement).checked;
                setDraft({ ...draft, cycling: enabled ? structuredClone(cycle) : null });
              }}
            />
            <span>{cyclingLabel}</span>
          </label>
        </details>
      </div>

      <div class="start-form__actions">
        <button
          type="button"
          class="start-button"
          disabled={starting}
          onClick={(): void => void start()}
        >
          {startLabel}
        </button>
        {error !== null ? (
          <p class="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

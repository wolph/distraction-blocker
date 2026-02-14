import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useEffect, useState } from 'preact/hooks';
import { ForcedControl } from '../shared/ForcedControl';
import {
  STALE_SESSION_RULES_ERROR,
  type StartSessionResponseV2,
  sendRequest,
} from '../shared/messages';
import { isListsConfig } from '../shared/runtime-validation';
import { UNTIL_STOPPED_DISCLOSURE, UNTIL_STOPPED_FORCED_HINT } from '../shared/session-copy';
import type {
  CategoryId,
  CycleConfig,
  ListsConfig,
  SessionConfigV2,
  SessionMode,
  SettingsV2,
  Strictness,
} from '../shared/types';
import { START_FAILED_COPY, startErrorMessage } from './command-errors';
import { DomainInput } from './DomainInput';
import { DurationControl } from './DurationControl';
import { RadioRow } from './form-controls';
import { RuleSummary } from './RuleSummary';
import { SessionTypeControl } from './SessionTypeControl';
import {
  addDraftAllowHost,
  type DraftUpdate,
  rebaseSessionDraft,
  toggleDraftCategory,
} from './session-draft';
import {
  createStartDraft,
  type DraftDuration,
  effectiveCycling,
  effectiveStrictness,
  restoreTimedDuration,
  type StartDraft,
  selectTimedPreset,
  selectUntilStopped,
  setCustomMinutes,
  setTimedCycling,
  setTimedStrictness,
  startLabel,
  toSessionConfigV2,
} from './start-draft';

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

const FORCED_TYPE_LABEL: string = 'Session type forced by Until stopped';
const FORCED_CYCLES_LABEL: string = 'Cycles forced by Until stopped';
const INVALID_DURATION_ERROR: string = 'Enter a session length greater than zero minutes.';
const STALE_LISTS_UNAVAILABLE_COPY: string =
  'Defaults changed, but current lists could not be loaded. Reload the popup.';

export interface StartFormProps {
  settings: SettingsV2;
  lists: ListsConfig;
  categoriesEditable?: boolean;
  startsDisabled?: boolean;
}

/**
 * Routes the duration control's next value onto the reversible draft helpers. Every timed
 * value returns the stored timed duration first, so the pressed Until stopped chip lands
 * on `restoreTimedDuration` and a preset or a typed minute is the edit that follows it.
 */
function applyDraftDuration(draft: StartDraft, next: DraftDuration): StartDraft {
  if (next.kind === 'until-stopped') return selectUntilStopped(draft);
  const restored: StartDraft = restoreTimedDuration(draft);
  if (next.presetMin !== null && next.customMin === '') {
    return selectTimedPreset(restored, next.presetMin);
  }
  return setCustomMinutes(restored, next.customMin);
}

export function StartForm({
  settings,
  lists,
  categoriesEditable = true,
  startsDisabled = false,
}: StartFormProps): VNode {
  const [draft, setDraft]: [StartDraft, Dispatch<StateUpdater<StartDraft>>] = useState<StartDraft>(
    (): StartDraft => createStartDraft(settings, lists),
  );
  /** The lists the draft is rebased onto, which a stale start refreshes from the worker. */
  const [activeLists, setActiveLists]: [ListsConfig, Dispatch<StateUpdater<ListsConfig>>] =
    useState<ListsConfig>(lists);
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const [starting, setStarting]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);

  useEffect((): void => {
    setActiveLists(lists);
    setDraft((current: StartDraft): StartDraft => rebaseSessionDraft(current, lists));
  }, [lists]);

  const indefinite: boolean = draft.duration.kind === 'until-stopped';
  const cycle: CycleConfig = settings.defaultCycling;
  const cyclingLabel: string = `Cycles: ${cycle.focusMin} min focus, ${cycle.shortBreakMin} min break, ${cycle.longBreakMin} min long break every ${cycle.longEvery}th`;

  const rebaseFromWorker: () => Promise<void> = async (): Promise<void> => {
    const refreshed: unknown = await sendRequest({ type: 'getLists' });
    if (!isListsConfig(refreshed)) {
      setError(STALE_LISTS_UNAVAILABLE_COPY);
      return;
    }
    setActiveLists(refreshed);
    setDraft((current: StartDraft): StartDraft => rebaseSessionDraft(current, refreshed));
    setError(STALE_SESSION_RULES_ERROR);
  };

  const start: () => Promise<void> = async (): Promise<void> => {
    if (starting || startsDisabled) return;
    const config: SessionConfigV2 | null = toSessionConfigV2(draft);
    if (config === null) {
      setError(INVALID_DURATION_ERROR);
      return;
    }

    setError(null);
    setStarting(true);
    try {
      const response: StartSessionResponseV2 = await sendRequest({
        type: 'startSession',
        config,
      });
      const message: string | null = startErrorMessage(response);
      if (message === STALE_SESSION_RULES_ERROR) {
        await rebaseFromWorker();
        return;
      }
      if (message !== null) {
        setError(message);
        return;
      }
      setDraft(createStartDraft(settings, activeLists));
    } catch {
      setError(START_FAILED_COPY);
    } finally {
      setStarting(false);
    }
  };

  const addAllowedDomain: (raw: string) => string | null = (raw: string): string | null => {
    const update: DraftUpdate<StartDraft> = addDraftAllowHost(draft, raw);
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

  const sessionType: VNode = (
    <SessionTypeControl
      value={effectiveStrictness(draft)}
      frictionDelayMs={draft.frictionGate.delayMs}
      requireTypedPhrase={draft.frictionGate.requireTypedPhrase}
      onChange={(strictness: Strictness): void => setDraft(setTimedStrictness(draft, strictness))}
    />
  );

  const cycleRow: VNode = (
    <label class="check-row">
      <input
        type="checkbox"
        checked={effectiveCycling(draft) !== null}
        onChange={(event: Event): void => {
          const enabled: boolean = (event.currentTarget as HTMLInputElement).checked;
          setDraft(setTimedCycling(draft, enabled ? cycle : null));
        }}
      />
      <span>{cyclingLabel}</span>
    </label>
  );

  return (
    <section class="view start-form">
      <div class="start-form__scroll">
        <DurationControl
          presets={settings.presetsMin}
          value={draft.duration}
          onChange={(next: DraftDuration): void =>
            setDraft((current: StartDraft): StartDraft => applyDraftDuration(current, next))
          }
        />

        {indefinite ? <span class="radio-hint">{UNTIL_STOPPED_FORCED_HINT}</span> : null}

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

        {indefinite ? (
          <ForcedControl label={FORCED_TYPE_LABEL} explanation={UNTIL_STOPPED_DISCLOSURE}>
            {sessionType}
          </ForcedControl>
        ) : (
          sessionType
        )}

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
          onCategoryToggle={(id: CategoryId): void => {
            if (categoriesEditable) setDraft(toggleDraftCategory(draft, id));
          }}
          onOpenSettings={(): void => void openPermanentSettings()}
        />

        <details class="options">
          <summary>Cycle options</summary>
          {indefinite ? (
            <ForcedControl label={FORCED_CYCLES_LABEL} explanation={UNTIL_STOPPED_DISCLOSURE}>
              {cycleRow}
            </ForcedControl>
          ) : (
            cycleRow
          )}
        </details>
      </div>

      <div class="start-form__actions">
        <button
          type="button"
          class="start-button"
          disabled={starting || startsDisabled}
          onClick={(): void => void start()}
        >
          {startLabel(draft)}
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

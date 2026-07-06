import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useId, useState } from 'preact/hooks';
import { scheduleEntriesOverlap, validateEntry } from '../core/schedule';
import { ForcedControl } from '../shared/ForcedControl';
import {
  FORCED_CYCLES_LABEL,
  HARD_UNAVAILABLE_REASON,
  SCHEDULE_UNTIL_STOPPED_COPY,
  SCHEDULE_WINDOW_LABEL,
  UNTIL_STOPPED_DISCLOSURE,
  UNTIL_STOPPED_LABEL,
} from '../shared/session-copy';
import type { CycleConfig, ScheduleEntryV2, SettingsV2, Strictness } from '../shared/types';

export interface ScheduleProps {
  entries: ScheduleEntryV2[];
  /** current settings, source of the defaults for a new entry and for a dropped draft */
  defaults: SettingsV2;
  onChange(next: ScheduleEntryV2[]): void;
}

/** Date.getDay convention: 0 = Sunday. Rendered Monday first. */
const DAY_LABELS: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, 0];

const CYCLES_LABEL: string = 'Cycle focus and breaks';

interface StrictnessChoice {
  value: Strictness;
  label: string;
}

const STRICTNESS_CHOICES: readonly StrictnessChoice[] = [
  { value: 'flexible', label: 'Flexible: end the session whenever you choose' },
  { value: 'friction', label: 'Friction: stopping early uses the configured deliberation gate' },
  { value: 'hard', label: 'Hard: no early end, temporary site access only' },
];

/**
 * The choices a window entry submits and an indefinite entry holds back: cycling always, and the
 * session type only when it was Hard, which an indefinite entry cannot carry.
 */
interface TimedChoices {
  strictness: Strictness;
  cycling: CycleConfig | null;
}

/** The editor draft: the entry a save emits, plus the timed choices it holds back. */
interface EntryDraft {
  entry: ScheduleEntryV2;
  timed: TimedChoices;
}

/** An indefinite entry keeps Flexible or Friction. Hard has no manual end, so it becomes Friction. */
function indefiniteStrictness(strictness: Strictness): Exclude<Strictness, 'hard'> {
  return strictness === 'hard' ? 'friction' : strictness;
}

function defaultTimedChoices(defaults: SettingsV2): TimedChoices {
  return {
    strictness: defaults.defaultStrictness,
    cycling: defaults.cyclingOnByDefault ? structuredClone(defaults.defaultCycling) : null,
  };
}

function newEntry(defaults: SettingsV2): ScheduleEntryV2 {
  const timed: TimedChoices = defaultTimedChoices(defaults);
  return {
    id: crypto.randomUUID(),
    days: [1, 2, 3, 4, 5],
    start: '09:00',
    end: '12:00',
    duration: { kind: 'window' },
    mode: defaults.defaultMode,
    strictness: timed.strictness,
    cycling: timed.cycling,
    intention: '',
    enabled: true,
  };
}

/**
 * A saved indefinite entry persists its session type but no hidden cycle choice, so editing one
 * starts its timed cycles from the current schedule defaults. A window entry keeps its own values.
 */
function draftOf(entry: ScheduleEntryV2, defaults: SettingsV2): EntryDraft {
  const copy: ScheduleEntryV2 = structuredClone(entry);
  return {
    entry: copy,
    timed:
      copy.duration.kind === 'window'
        ? { strictness: copy.strictness, cycling: copy.cycling }
        : { strictness: copy.strictness, cycling: defaultTimedChoices(defaults).cycling },
  };
}

/**
 * Indefinite entries keep their session type, clamp Hard to Friction, and submit cycles off. The
 * pre-detour type and cycles wait in `timed` for the duration to toggle back.
 */
function selectUntilStopped(draft: EntryDraft): EntryDraft {
  if (draft.entry.duration.kind === 'until-stopped') return draft;
  return {
    entry: {
      ...draft.entry,
      duration: { kind: 'until-stopped' },
      strictness: indefiniteStrictness(draft.entry.strictness),
      cycling: null,
    },
    timed: { strictness: draft.entry.strictness, cycling: draft.entry.cycling },
  };
}

/** Brings the held timed choices back verbatim. A no-op on a window entry. */
function selectWindow(draft: EntryDraft): EntryDraft {
  if (draft.entry.duration.kind === 'window') return draft;
  return {
    entry: {
      ...draft.entry,
      duration: { kind: 'window' },
      strictness: draft.timed.strictness,
      cycling: draft.timed.cycling,
    },
    timed: draft.timed,
  };
}

/**
 * A session type edit reaches the entry and the held timed choices alike, so a type chosen
 * during an indefinite detour is the type the window duration comes back to. Hard is refused
 * while the entry is indefinite: the radio is disabled, and a bypassed click changes nothing. The
 * invariant `isScheduleEntryV2` enforces at the boundary holds here structurally.
 */
function setStrictness(draft: EntryDraft, strictness: Strictness): EntryDraft {
  if (draft.entry.duration.kind === 'until-stopped' && strictness === 'hard') return draft;
  return {
    entry: { ...draft.entry, strictness },
    timed: { ...draft.timed, strictness },
  };
}

/** An indefinite entry submits cycles off, so a cycle edit reaches only the held choice. */
function setCycling(draft: EntryDraft, cycling: CycleConfig | null): EntryDraft {
  const timed: TimedChoices = { ...draft.timed, cycling };
  if (draft.entry.duration.kind === 'until-stopped') return { entry: draft.entry, timed };
  return { entry: { ...draft.entry, cycling }, timed };
}

function overlapError(candidate: ScheduleEntryV2, entries: ScheduleEntryV2[]): string | null {
  for (const entry of entries) {
    if (!scheduleEntriesOverlap(candidate, entry)) continue;
    const day: number | undefined = DAY_ORDER.find(
      (value: number): boolean => candidate.days.includes(value) && entry.days.includes(value),
    );
    if (day !== undefined) return `Overlaps another enabled entry on ${DAY_LABELS[day]}.`;
  }
  return null;
}

interface DayPickerProps {
  days: number[];
  onChange: (days: number[]) => void;
}

function DayPicker(props: DayPickerProps): VNode {
  const toggle: (day: number) => void = (day: number): void => {
    const next: number[] = props.days.includes(day)
      ? props.days.filter((d: number): boolean => d !== day)
      : [...props.days, day].sort((a: number, b: number): number => a - b);
    props.onChange(next);
  };
  return (
    <div class="day-pills">
      {DAY_ORDER.map(
        (day: number): VNode => (
          <button
            type="button"
            key={day}
            class="day-pill"
            aria-pressed={props.days.includes(day)}
            onClick={(): void => {
              toggle(day);
            }}
          >
            {DAY_LABELS[day]}
          </button>
        ),
      )}
    </div>
  );
}

interface EntryFormProps {
  draft: EntryDraft;
  defaults: SettingsV2;
  error: string | null;
  onDraft: (next: EntryDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}

function EntryForm(props: EntryFormProps): VNode {
  const entry: ScheduleEntryV2 = props.draft.entry;
  const indefinite: boolean = entry.duration.kind === 'until-stopped';
  const hardReasonId: string = `schedule-hard-reason-${useId()}`;

  const strictnessField: VNode = (
    <fieldset class="field" aria-label="Session type">
      {STRICTNESS_CHOICES.map((choice: StrictnessChoice): VNode => {
        const unavailable: boolean = indefinite && choice.value === 'hard';
        return (
          <label class="check" key={choice.value}>
            <input
              type="radio"
              name="entry-v2-strictness"
              checked={entry.strictness === choice.value}
              disabled={unavailable}
              aria-describedby={unavailable ? hardReasonId : undefined}
              onClick={(): void => {
                props.onDraft(setStrictness(props.draft, choice.value));
              }}
            />
            {choice.label}
          </label>
        );
      })}
      {indefinite ? (
        <p class="schedule-duration-note" id={hardReasonId}>
          {HARD_UNAVAILABLE_REASON}
        </p>
      ) : null}
    </fieldset>
  );

  const cyclingField: VNode = (
    <label class="check">
      <input
        type="checkbox"
        checked={entry.cycling !== null}
        onClick={(): void => {
          props.onDraft(
            setCycling(
              props.draft,
              entry.cycling === null ? structuredClone(props.defaults.defaultCycling) : null,
            ),
          );
        }}
      />
      {CYCLES_LABEL}
    </label>
  );

  return (
    <fieldset>
      <legend>Schedule entry</legend>
      <DayPicker
        days={entry.days}
        onChange={(days: number[]): void => {
          props.onDraft({ ...props.draft, entry: { ...entry, days } });
        }}
      />
      <label class="field">
        Start
        <input
          type="time"
          value={entry.start}
          onInput={(event: Event): void => {
            props.onDraft({
              ...props.draft,
              entry: { ...entry, start: (event.currentTarget as HTMLInputElement).value },
            });
          }}
        />
      </label>
      <label class="field">
        End
        <input
          type="time"
          value={entry.end}
          onInput={(event: Event): void => {
            props.onDraft({
              ...props.draft,
              entry: { ...entry, end: (event.currentTarget as HTMLInputElement).value },
            });
          }}
        />
      </label>
      <fieldset class="schedule-duration">
        <legend>Duration</legend>
        <label class="check">
          <input
            type="radio"
            name="entry-v2-duration"
            checked={!indefinite}
            onClick={(): void => {
              props.onDraft(selectWindow(props.draft));
            }}
          />
          {SCHEDULE_WINDOW_LABEL}
        </label>
        <label class="check">
          <input
            type="radio"
            name="entry-v2-duration"
            checked={indefinite}
            onClick={(): void => {
              props.onDraft(selectUntilStopped(props.draft));
            }}
          />
          {UNTIL_STOPPED_LABEL}
        </label>
      </fieldset>
      {indefinite ? <p class="schedule-duration-note">{SCHEDULE_UNTIL_STOPPED_COPY}</p> : null}
      <div class="field">
        <label class="check">
          <input
            type="radio"
            name="entry-v2-mode"
            checked={entry.mode === 'blacklist'}
            onClick={(): void => {
              props.onDraft({ ...props.draft, entry: { ...entry, mode: 'blacklist' } });
            }}
          />
          Blacklist: block listed sites
        </label>
        <label class="check">
          <input
            type="radio"
            name="entry-v2-mode"
            checked={entry.mode === 'whitelist'}
            onClick={(): void => {
              props.onDraft({ ...props.draft, entry: { ...entry, mode: 'whitelist' } });
            }}
          />
          Whitelist: allow only listed sites
        </label>
      </div>
      {strictnessField}
      {indefinite ? (
        <ForcedControl label={FORCED_CYCLES_LABEL} explanation={UNTIL_STOPPED_DISCLOSURE}>
          {cyclingField}
        </ForcedControl>
      ) : (
        cyclingField
      )}
      <label class="field">
        Intention
        <input
          type="text"
          value={entry.intention}
          placeholder="what this time is for"
          onInput={(event: Event): void => {
            props.onDraft({
              ...props.draft,
              entry: { ...entry, intention: (event.currentTarget as HTMLInputElement).value },
            });
          }}
        />
      </label>
      {props.error !== null ? (
        <p class="field-error" role="alert">
          {props.error}
        </p>
      ) : null}
      <div class="save-row">
        <button type="button" class="primary" onClick={props.onSave}>
          Save entry
        </button>
        <button type="button" class="secondary" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </fieldset>
  );
}

/**
 * Schedule entry list plus a single editor form. The duration choice is the entry's own,
 * `validateEntry` and the overlap check gate every save, and an indefinite entry submits its
 * Flexible or Friction type with cycles off while its timed cycles wait for the duration to
 * toggle back.
 */
export function Schedule(props: ScheduleProps): VNode {
  const [draft, setDraft]: [EntryDraft | null, Dispatch<StateUpdater<EntryDraft | null>>] =
    useState<EntryDraft | null>(null);
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);

  const save: () => void = (): void => {
    if (draft === null) return;
    const entry: ScheduleEntryV2 = draft.entry;
    const message: string | null = validateEntry(entry);
    if (message !== null) {
      setError(message);
      return;
    }
    const overlap: string | null = overlapError(entry, props.entries);
    if (overlap !== null) {
      setError(overlap);
      return;
    }
    const exists: boolean = props.entries.some(
      (candidate: ScheduleEntryV2): boolean => candidate.id === entry.id,
    );
    const next: ScheduleEntryV2[] = exists
      ? props.entries.map(
          (candidate: ScheduleEntryV2): ScheduleEntryV2 =>
            candidate.id === entry.id ? entry : candidate,
        )
      : [...props.entries, entry];
    setError(null);
    setDraft(null);
    props.onChange(next);
  };

  const setEnabled: (id: string, enabled: boolean) => void = (
    id: string,
    enabled: boolean,
  ): void => {
    const entry: ScheduleEntryV2 | undefined = props.entries.find(
      (candidate: ScheduleEntryV2): boolean => candidate.id === id,
    );
    if (entry === undefined) return;
    const nextEntry: ScheduleEntryV2 = { ...entry, enabled };
    const overlap: string | null = overlapError(nextEntry, props.entries);
    if (overlap !== null) {
      setError(overlap);
      return;
    }
    setError(null);
    props.onChange(
      props.entries.map(
        (candidate: ScheduleEntryV2): ScheduleEntryV2 =>
          candidate.id === id ? nextEntry : candidate,
      ),
    );
  };

  const remove: (id: string) => void = (id: string): void => {
    props.onChange(
      props.entries.filter((candidate: ScheduleEntryV2): boolean => candidate.id !== id),
    );
  };

  return (
    <div class="schedule">
      {props.entries.length === 0 && draft === null ? (
        <p class="help">No scheduled sessions yet.</p>
      ) : null}
      {props.entries.map(
        (entry: ScheduleEntryV2): VNode => (
          <div class="entry-row" key={entry.id}>
            <fieldset class="entry-days" aria-label="Selected days">
              {DAY_ORDER.filter((day: number): boolean => entry.days.includes(day)).map(
                (day: number): VNode => (
                  <span class="entry-day-pill" key={day}>
                    {DAY_LABELS[day]}
                  </span>
                ),
              )}
            </fieldset>
            <span>
              {entry.start} to {entry.end}
            </span>
            <span class="schedule-duration-note">
              {entry.duration.kind === 'until-stopped'
                ? SCHEDULE_UNTIL_STOPPED_COPY
                : SCHEDULE_WINDOW_LABEL}
            </span>
            <span>{entry.mode}</span>
            <span>{entry.strictness}</span>
            {entry.intention !== '' ? <span class="entry-intention">{entry.intention}</span> : null}
            <span class="spacer" />
            <label class="check">
              <input
                type="checkbox"
                checked={entry.enabled}
                onClick={(event: Event): void => {
                  // A refused toggle must not leave the browser's flip on screen.
                  event.preventDefault();
                  setEnabled(entry.id, !entry.enabled);
                }}
              />
              Enabled
            </label>
            <button
              type="button"
              class="secondary"
              onClick={(): void => {
                setError(null);
                setDraft(draftOf(entry, props.defaults));
              }}
            >
              Edit
            </button>
            <button
              type="button"
              class="ghost"
              onClick={(): void => {
                remove(entry.id);
              }}
            >
              Delete
            </button>
          </div>
        ),
      )}
      {draft === null && error !== null ? (
        <p class="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {draft !== null ? (
        <EntryForm
          draft={draft}
          defaults={props.defaults}
          error={error}
          onDraft={setDraft}
          onSave={save}
          onCancel={(): void => {
            setError(null);
            setDraft(null);
          }}
        />
      ) : (
        <div class="save-row">
          <button
            type="button"
            class="secondary"
            onClick={(): void => {
              setError(null);
              setDraft(draftOf(newEntry(props.defaults), props.defaults));
            }}
          >
            Add schedule entry
          </button>
        </div>
      )}
    </div>
  );
}

import type { VNode } from 'preact';
import { useState } from 'preact/hooks';
import { scheduleEntriesOverlap, validateEntry } from '../core/schedule';
import type { ScheduleEntry, Settings } from '../shared/types';

export interface ScheduleProps {
  entries: ScheduleEntry[];
  /** current settings, source of the defaults for a new entry */
  defaults: Settings;
  onChange: (next: ScheduleEntry[]) => void;
}

/** Date.getDay convention: 0 = Sunday. Rendered Monday first. */
const DAY_LABELS: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, 0];

function newEntry(defaults: Settings): ScheduleEntry {
  return {
    id: crypto.randomUUID(),
    days: [1, 2, 3, 4, 5],
    start: '09:00',
    end: '12:00',
    mode: defaults.defaultMode,
    strictness: defaults.defaultStrictness,
    cycling: defaults.cyclingOnByDefault ? defaults.defaultCycling : null,
    intention: '',
    enabled: true,
  };
}

function overlapError(candidate: ScheduleEntry, entries: ScheduleEntry[]): string | null {
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
  const toggle = (day: number): void => {
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
  draft: ScheduleEntry;
  defaults: Settings;
  error: string | null;
  onDraft: (next: ScheduleEntry) => void;
  onSave: () => void;
  onCancel: () => void;
}

function EntryForm(props: EntryFormProps): VNode {
  const draft: ScheduleEntry = props.draft;
  return (
    <fieldset>
      <legend>Schedule entry</legend>
      <DayPicker
        days={draft.days}
        onChange={(days: number[]): void => {
          props.onDraft({ ...draft, days });
        }}
      />
      <label class="field">
        Start
        <input
          type="time"
          value={draft.start}
          onInput={(event: Event): void => {
            props.onDraft({ ...draft, start: (event.currentTarget as HTMLInputElement).value });
          }}
        />
      </label>
      <label class="field">
        End
        <input
          type="time"
          value={draft.end}
          onInput={(event: Event): void => {
            props.onDraft({ ...draft, end: (event.currentTarget as HTMLInputElement).value });
          }}
        />
      </label>
      <div class="field">
        <label class="check">
          <input
            type="radio"
            name="entry-mode"
            checked={draft.mode === 'blacklist'}
            onClick={(): void => {
              props.onDraft({ ...draft, mode: 'blacklist' });
            }}
          />
          Blacklist: block listed sites
        </label>
        <label class="check">
          <input
            type="radio"
            name="entry-mode"
            checked={draft.mode === 'whitelist'}
            onClick={(): void => {
              props.onDraft({ ...draft, mode: 'whitelist' });
            }}
          />
          Whitelist: allow only listed sites
        </label>
      </div>
      <div class="field">
        <label class="check">
          <input
            type="radio"
            name="entry-strictness"
            checked={draft.strictness === 'friction'}
            onClick={(): void => {
              props.onDraft({ ...draft, strictness: 'friction' });
            }}
          />
          Friction: cancel costs a wait and a typed sentence
        </label>
        <label class="check">
          <input
            type="radio"
            name="entry-strictness"
            checked={draft.strictness === 'hard'}
            onClick={(): void => {
              props.onDraft({ ...draft, strictness: 'hard' });
            }}
          />
          Hard: no cancel, pauses and unlocks are the only escapes
        </label>
      </div>
      <label class="check">
        <input
          type="checkbox"
          checked={draft.cycling !== null}
          onClick={(): void => {
            props.onDraft({
              ...draft,
              cycling: draft.cycling === null ? props.defaults.defaultCycling : null,
            });
          }}
        />
        Cycle focus and breaks
      </label>
      <label class="field">
        Intention
        <input
          type="text"
          value={draft.intention}
          placeholder="what this time is for"
          onInput={(event: Event): void => {
            props.onDraft({
              ...draft,
              intention: (event.currentTarget as HTMLInputElement).value,
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
 * Schedule entry list plus a single editor form. validateEntry gates every
 * save, so an invalid entry never reaches settings.schedule.
 */
export function Schedule(props: ScheduleProps): VNode {
  const [draft, setDraft] = useState<ScheduleEntry | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = (): void => {
    if (draft === null) return;
    const message: string | null = validateEntry(draft);
    if (message !== null) {
      setError(message);
      return;
    }
    const overlap: string | null = overlapError(draft, props.entries);
    if (overlap !== null) {
      setError(overlap);
      return;
    }
    const exists: boolean = props.entries.some((e: ScheduleEntry): boolean => e.id === draft.id);
    const next: ScheduleEntry[] = exists
      ? props.entries.map((e: ScheduleEntry): ScheduleEntry => (e.id === draft.id ? draft : e))
      : [...props.entries, draft];
    setError(null);
    setDraft(null);
    props.onChange(next);
  };

  const setEnabled = (id: string, enabled: boolean): void => {
    const entry: ScheduleEntry | undefined = props.entries.find(
      (candidate: ScheduleEntry): boolean => candidate.id === id,
    );
    if (entry === undefined) return;
    const nextEntry: ScheduleEntry = { ...entry, enabled };
    const overlap: string | null = overlapError(nextEntry, props.entries);
    if (overlap !== null) {
      setError(overlap);
      return;
    }
    setError(null);
    props.onChange(
      props.entries.map(
        (candidate: ScheduleEntry): ScheduleEntry => (candidate.id === id ? nextEntry : candidate),
      ),
    );
  };

  const remove = (id: string): void => {
    props.onChange(props.entries.filter((e: ScheduleEntry): boolean => e.id !== id));
  };

  return (
    <div class="schedule">
      {props.entries.length === 0 && draft === null ? (
        <p class="help">No scheduled sessions yet.</p>
      ) : null}
      {props.entries.map(
        (entry: ScheduleEntry): VNode => (
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
            <span>{entry.mode}</span>
            <span>{entry.strictness}</span>
            {entry.intention !== '' ? <span class="entry-intention">{entry.intention}</span> : null}
            <span class="spacer" />
            <label class="check">
              <input
                type="checkbox"
                checked={entry.enabled}
                onClick={(): void => {
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
                setDraft({ ...entry });
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
              setDraft(newEntry(props.defaults));
            }}
          >
            Add schedule entry
          </button>
        </div>
      )}
    </div>
  );
}

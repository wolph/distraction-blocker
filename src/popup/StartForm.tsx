import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useEffect, useRef, useState } from 'preact/hooks';
import type { StartSessionResult } from '../shared/messages';
import { sendRequest } from '../shared/messages';
import { isSessionSnapshot } from '../shared/runtime-validation';
import type {
  CycleConfig,
  GateSettings,
  ListsConfig,
  SessionConfig,
  SessionMode,
  Settings,
  Strictness,
} from '../shared/types';
import { parseStartSessionResult, type WorkTab } from '../shared/work-target';
import { CategoryControls } from './category-controls';
import { Chip, RadioRow } from './form-controls';
import { ThisTabButton } from './ThisTabButton';
import { useWorkTabs, type WorkTabsState } from './use-work-tabs';

/** Positional labels for the three presets. */
const PRESET_LABELS: readonly [string, string, string] = ['short', 'focus', 'deep work'];

const MODE_HINTS: Record<SessionMode, string> = {
  blacklist: 'block the listed sites, allow the rest',
  whitelist: 'allow the listed sites, block the rest',
};

function unlockRequirements(gate: GateSettings): string | null {
  const requirements: string[] = [];
  if (gate.delayMs > 0) requirements.push(`${gate.delayMs / 1_000} s wait`);
  if (gate.requireTypedPhrase) requirements.push('typing the confirmation phrase');
  return requirements.length === 0 ? null : requirements.join(' and ');
}

export function StartForm({
  settings,
  lists,
  categoriesEditable = true,
  onStartFeedback,
}: {
  settings: Settings;
  lists: ListsConfig;
  categoriesEditable?: boolean;
  onStartFeedback?: (error: string | null) => void;
}): VNode {
  const [selectedMin, setSelectedMin]: [number | null, Dispatch<StateUpdater<number | null>>] =
    useState<number | null>(settings.presetsMin[1]);
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

  const work: WorkTabsState = useWorkTabs(mode, categoryUpdatePending);
  const [workTabId, setWorkTabId]: [string, Dispatch<StateUpdater<string>>] = useState<string>('');
  const explicitChoice: { current: boolean } = useRef<boolean>(false);
  const startInFlight: { current: boolean } = useRef<boolean>(false);
  useEffect((): void => {
    if (explicitChoice.current) return;
    const activeTabId: number | null = work.context?.activeTabId ?? null;
    setWorkTabId(
      work.tabs.some((tab: WorkTab): boolean => tab.tabId === activeTabId)
        ? String(activeTabId)
        : '',
    );
  }, [work]);

  const durationMin: number | null = customMin.trim() === '' ? selectedMin : Number(customMin);
  const indefinite: boolean = durationMin === null;
  const confirmation: string | null = unlockRequirements(settings.gate);
  const strictnessHints: Record<Strictness, string> = {
    friction:
      confirmation === null
        ? 'can end early without waiting or typing a phrase'
        : `can end early after ${confirmation}`,
    hard: 'sites stay locked until the timer ends, paid access excepted',
  };

  const start: () => Promise<void> = async (): Promise<void> => {
    if (startInFlight.current || starting || categoryUpdatePending) return;
    if (durationMin !== null && (!Number.isFinite(durationMin) || durationMin <= 0)) {
      setError('enter a session length in minutes');
      return;
    }
    setError(null);
    const config: SessionConfig = {
      mode,
      strictness: indefinite ? 'friction' : strictness,
      durationMin,
      cycling: !indefinite && cyclingOn ? settings.defaultCycling : null,
      intention: intention.trim(),
      source: 'manual',
      scheduleEntryId: null,
    };
    startInFlight.current = true;
    setStarting(true);
    onStartFeedback?.(null);
    let sessionStarted: boolean = false;
    try {
      const result: StartSessionResult | null = parseStartSessionResult(
        await sendRequest({
          type: 'startSession',
          config,
          ...(workTabId !== '' && work.context !== null
            ? { workTabId: Number(workTabId), windowId: work.context.windowId }
            : {}),
        }),
      );
      sessionStarted =
        result?.ok === true ||
        (result !== null && 'sessionStarted' in result && result.sessionStarted);
      const responseError: string | null =
        result === null ? 'Could not start session. Try again.' : result.ok ? null : result.error;
      if (responseError !== null && onStartFeedback === undefined) setError(responseError);
      onStartFeedback?.(responseError);
    } catch {
      const message: string = 'Could not start the session. Try again.';
      if (onStartFeedback === undefined) setError(message);
      onStartFeedback?.(message);
    } finally {
      try {
        const snapshot: unknown = await sendRequest({ type: 'getSnapshot' });
        if (isSessionSnapshot(snapshot)) sessionStarted = snapshot.phase !== 'idle';
      } catch {
        /* Keep the acknowledged start locked against duplicate requests. */
      }
      startInFlight.current = sessionStarted;
      setStarting(sessionStarted);
    }
  };

  const c: CycleConfig = settings.defaultCycling;
  const cyclingLabel: string = `cycles: ${c.focusMin} min focus, ${c.shortBreakMin} min break, ${c.longBreakMin} min long break every ${c.longEvery}th`;
  const timingSummary: string | null =
    durationMin === null
      ? 'Locked until you manually unlock'
      : !Number.isFinite(durationMin) || durationMin <= 0
        ? null
        : cyclingOn && c.focusMin < durationMin
          ? `${durationMin} min total, with ${c.focusMin} min focus blocks`
          : `${durationMin} min uninterrupted focus`;

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
                if (i === 2) setCyclingOn(false);
              }}
            />
          ),
        )}
        <Chip
          label="∞"
          accessibleLabel="Until manual unlock"
          selected={indefinite}
          onClick={(): void => {
            setSelectedMin(null);
            setCustomMin('');
          }}
        />
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

      {timingSummary !== null ? (
        <p class="session-timing" role="status">
          {timingSummary}
        </p>
      ) : null}
      {indefinite ? (
        <p class="unlock-confirmation">Unlock confirmation: {confirmation ?? 'none'}.</p>
      ) : null}

      <label class="work-tab-label" htmlFor="next-step">
        What's your next small step?
      </label>
      <input
        id="next-step"
        class="intention-input"
        type="text"
        placeholder="Continue your current task"
        value={intention}
        onInput={(e: Event): void => setIntention((e.currentTarget as HTMLInputElement).value)}
      />

      <ThisTabButton
        key={mode}
        choiceKey={workTabId}
        mode={mode}
        work={work}
        disabled={starting || categoryUpdatePending}
        onSelect={(tabId: number): void => {
          explicitChoice.current = true;
          setWorkTabId(String(tabId));
        }}
      />
      <label class="work-tab-label">
        Or choose another tab
        <select
          aria-label="Work tab"
          value={workTabId}
          disabled={work.context === null || starting || work.loading}
          onChange={(event: Event): void => {
            explicitChoice.current = true;
            setWorkTabId((event.currentTarget as HTMLSelectElement).value);
          }}
        >
          <option value="">No work tab (optional)</option>
          {workTabId !== '' &&
          !work.tabs.some((tab: WorkTab): boolean => String(tab.tabId) === workTabId) ? (
            <option value={workTabId}>Selected tab unavailable - choose another</option>
          ) : null}
          {work.tabs.map(
            (tab: WorkTab): VNode => (
              <option key={tab.tabId} value={tab.tabId}>
                {tab.title}
              </option>
            ),
          )}
        </select>
      </label>

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
            (s: Strictness): VNode => (
              <RadioRow
                key={s}
                name="strictness"
                label={s}
                hint={strictnessHints[s]}
                checked={(indefinite ? 'friction' : strictness) === s}
                disabled={indefinite && s === 'hard'}
                describedBy={indefinite && s === 'hard' ? 'manual-unlock-options' : undefined}
                onSelect={(): void => setStrictness(s)}
              />
            ),
          )}
        </fieldset>
        <label class="check-row">
          <input
            type="checkbox"
            checked={!indefinite && cyclingOn}
            disabled={indefinite}
            aria-describedby={indefinite ? 'manual-unlock-options' : undefined}
            onChange={(e: Event): void =>
              setCyclingOn((e.currentTarget as HTMLInputElement).checked)
            }
          />
          <span>{cyclingLabel}</span>
        </label>
        {indefinite ? (
          <p id="manual-unlock-options" class="radio-hint">
            Manual unlock requires friction and has no automatic breaks.
          </p>
        ) : null}
      </details>

      <button
        type="button"
        class="start-button"
        disabled={starting || categoryUpdatePending}
        onClick={(): void => void start()}
      >
        {indefinite ? 'Lock until manual unlock' : 'Start focusing'}
      </button>
      {error !== null ? (
        <p class="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

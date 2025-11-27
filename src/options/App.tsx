import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useEffect, useRef, useState } from 'preact/hooks';
import {
  parseSettingsSectionHash,
  SETTINGS_SECTIONS,
  SettingsNav,
  type SettingsSectionId,
} from '../shared/SettingsNav';
import { applyTheme } from '../shared/theme';
import type { ListsConfig, Rule, ScheduleEntry, Settings } from '../shared/types';
import { BehaviorDefaults, PauseEconomy } from './Behavior';
import { Categories } from './Categories';
import { DirtySaveBar } from './DirtySaveBar';
import { PrivacyData } from './PrivacyData';
import { RulesEditor } from './RulesEditor';
import { Schedule } from './Schedule';
import { SessionStatus } from './SessionStatus';
import { SoundsBadge } from './SoundsBadge';
import type { SettingsStore } from './use-settings';
import { type SettingsMutation, useSettingsStore } from './use-settings';

interface SectionProps {
  section: SettingsSectionId;
  settings: Settings;
  lists: ListsConfig;
  store: SettingsStore;
  onSettings: (next: Settings) => void;
  onLists: (next: ListsConfig) => void;
}

function BlockingSection(props: SectionProps): VNode {
  return (
    <section>
      <h2>Blocking</h2>
      <p class="help">
        Custom rules block during blacklist sessions. The whitelist is what stays reachable during
        whitelist sessions. Bundled categories block common time sinks.
      </p>
      <RulesEditor
        title="Custom blacklist"
        rules={props.lists.custom}
        onChange={(next: Rule[]): void => {
          props.onLists({ ...props.lists, custom: next });
        }}
      />
      <RulesEditor
        title="Whitelist"
        rules={props.lists.whitelist}
        onChange={(next: Rule[]): void => {
          props.onLists({ ...props.lists, whitelist: next });
        }}
      />
      <div class="lists-categories-section">
        <h3>Bundled categories</h3>
        <p class="help">
          Bundled lists of common time sinks. Toggle a whole category, then open it to keep single
          sites available.
        </p>
        <Categories lists={props.lists} onChange={props.onLists} />
      </div>
    </section>
  );
}

function ScheduleSection(props: SectionProps): VNode {
  return (
    <section>
      <h2>Schedule</h2>
      <p class="help">
        Sessions start on their own inside these windows. Strictness set here applies for the whole
        window.
      </p>
      <Schedule
        entries={props.settings.schedule}
        defaults={props.settings}
        onChange={(next: ScheduleEntry[]): void => {
          props.onSettings({ ...props.settings, schedule: next });
        }}
      />
    </section>
  );
}

function BehaviorSection(props: SectionProps): VNode {
  return (
    <section>
      <h2>Session behavior</h2>
      <BehaviorDefaults settings={props.settings} onChange={props.onSettings} />
    </section>
  );
}

function BudgetSection(props: SectionProps): VNode {
  return (
    <section>
      <h2>Pause budget</h2>
      <PauseEconomy settings={props.settings} onChange={props.onSettings} />
    </section>
  );
}

function NotificationsSection(props: SectionProps): VNode {
  return (
    <section>
      <h2>Notifications</h2>
      <SoundsBadge settings={props.settings} onChange={props.onSettings} />
    </section>
  );
}

function PrivacySection(props: SectionProps): VNode {
  return (
    <section>
      <h2>Privacy and data</h2>
      {props.store.setup === null ? (
        <p>Loading privacy settings</p>
      ) : (
        <PrivacyData
          setup={props.store.setup}
          onReconcileWebsiteAccess={props.store.reconcileWebsiteAccess}
          onStorageModeChange={props.store.setStorageMode}
          onRetrySync={props.store.retrySync}
          onClearData={props.store.clearData}
        />
      )}
    </section>
  );
}

function SectionBody(props: SectionProps): VNode {
  switch (props.section) {
    case 'blocking':
      return <BlockingSection {...props} />;
    case 'schedule':
      return <ScheduleSection {...props} />;
    case 'behavior':
      return <BehaviorSection {...props} />;
    case 'budget':
      return <BudgetSection {...props} />;
    case 'notifications':
      return <NotificationsSection {...props} />;
    case 'privacy':
      return <PrivacySection {...props} />;
  }
}

function SectionPanels(props: SectionProps): VNode {
  return (
    <>
      {SETTINGS_SECTIONS.map(
        ({ id }: { id: SettingsSectionId }): VNode => (
          <div key={id} data-settings-section={id} hidden={props.section !== id}>
            <SectionBody {...props} section={id} />
          </div>
        ),
      )}
    </>
  );
}

function settingsSlice(section: SettingsSectionId, settings: Settings): unknown {
  switch (section) {
    case 'schedule':
      return { schedule: settings.schedule };
    case 'behavior':
      return {
        presetsMin: settings.presetsMin,
        defaultMode: settings.defaultMode,
        defaultStrictness: settings.defaultStrictness,
        defaultCycling: settings.defaultCycling,
        cyclingOnByDefault: settings.cyclingOnByDefault,
        gate: settings.gate,
      };
    case 'budget':
      return {
        pause: settings.pause,
        streakGoalMin: settings.streakGoalMin,
        streakFreezeIntervalDays: settings.streakFreezeIntervalDays,
        retentionDays: settings.retentionDays,
      };
    case 'notifications':
      return {
        sounds: settings.sounds,
        badgeCountdown: settings.badgeCountdown,
        sessionCompleteNotification: settings.sessionCompleteNotification,
      };
    case 'blocking':
    case 'privacy':
      return null;
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sectionIsDirty(
  section: SettingsSectionId,
  draftSettings: Settings,
  committedSettings: Settings,
  draftLists: ListsConfig,
  committedLists: ListsConfig,
): boolean {
  if (section === 'blocking') return !sameValue(draftLists, committedLists);
  if (section === 'privacy') return false;
  return !sameValue(
    settingsSlice(section, draftSettings),
    settingsSlice(section, committedSettings),
  );
}

function settingsWithDraftSection(
  section: SettingsSectionId,
  committed: Settings,
  draft: Settings,
): Settings {
  switch (section) {
    case 'schedule':
      return { ...committed, schedule: draft.schedule };
    case 'behavior':
      return {
        ...committed,
        presetsMin: draft.presetsMin,
        defaultMode: draft.defaultMode,
        defaultStrictness: draft.defaultStrictness,
        defaultCycling: draft.defaultCycling,
        cyclingOnByDefault: draft.cyclingOnByDefault,
        gate: draft.gate,
      };
    case 'budget':
      return {
        ...committed,
        pause: draft.pause,
        streakGoalMin: draft.streakGoalMin,
        streakFreezeIntervalDays: draft.streakFreezeIntervalDays,
        retentionDays: draft.retentionDays,
      };
    case 'notifications':
      return {
        ...committed,
        sounds: draft.sounds,
        badgeCountdown: draft.badgeCountdown,
        sessionCompleteNotification: draft.sessionCompleteNotification,
      };
    case 'blocking':
    case 'privacy':
      return committed;
  }
}

function settingsWithCommittedSection(
  section: SettingsSectionId,
  draft: Settings,
  committed: Settings,
): Settings {
  return settingsWithDraftSection(section, draft, committed);
}

function settingsMutationFromDraft(
  section: SettingsSectionId,
  draft: Settings,
): SettingsMutation | null {
  switch (section) {
    case 'schedule':
      return { section, value: { schedule: structuredClone(draft.schedule) } };
    case 'behavior':
      return {
        section,
        value: {
          presetsMin: [...draft.presetsMin],
          defaultMode: draft.defaultMode,
          defaultStrictness: draft.defaultStrictness,
          defaultCycling: structuredClone(draft.defaultCycling),
          cyclingOnByDefault: draft.cyclingOnByDefault,
          gate: { ...draft.gate },
        },
      };
    case 'budget':
      return {
        section,
        value: {
          pause: { ...draft.pause },
          streakGoalMin: draft.streakGoalMin,
          streakFreezeIntervalDays: draft.streakFreezeIntervalDays,
          retentionDays: draft.retentionDays,
        },
      };
    case 'notifications':
      return {
        section,
        value: {
          sounds: { ...draft.sounds },
          badgeCountdown: draft.badgeCountdown,
          sessionCompleteNotification: draft.sessionCompleteNotification,
        },
      };
    case 'blocking':
    case 'privacy':
      return null;
  }
}

interface DestinationSaveState {
  transactionId: number;
  source: SettingsSectionId;
  pending: boolean;
  error: string | null;
}

type DestinationSaveStates = Record<SettingsSectionId, DestinationSaveState>;

function initialSaveStates(): DestinationSaveStates {
  return Object.fromEntries(
    SETTINGS_SECTIONS.map(
      ({ id }: { id: SettingsSectionId }): [SettingsSectionId, DestinationSaveState] => [
        id,
        { transactionId: 0, source: id, pending: false, error: null },
      ],
    ),
  ) as DestinationSaveStates;
}

export function App(): VNode {
  const store: SettingsStore = useSettingsStore();
  const [section, setSection]: [SettingsSectionId, Dispatch<StateUpdater<SettingsSectionId>>] =
    useState<SettingsSectionId>(
      (): SettingsSectionId => parseSettingsSectionHash(window.location.hash),
    );
  const [draftSettings, setDraftSettings]: [
    Settings | null,
    Dispatch<StateUpdater<Settings | null>>,
  ] = useState<Settings | null>(null);
  const [draftLists, setDraftLists]: [
    ListsConfig | null,
    Dispatch<StateUpdater<ListsConfig | null>>,
  ] = useState<ListsConfig | null>(null);
  const [saveStates, setSaveStates]: [
    DestinationSaveStates,
    Dispatch<StateUpdater<DestinationSaveStates>>,
  ] = useState<DestinationSaveStates>(initialSaveStates);
  const nextTransactionId: { current: number } = useRef<number>(1);
  const pendingTransactions: { current: Map<SettingsSectionId, number> } = useRef<
    Map<SettingsSectionId, number>
  >(new Map<SettingsSectionId, number>());

  useEffect((): void => {
    const loaded: Settings | null = store.settings;
    if (loaded !== null) {
      setDraftSettings(
        (current: Settings | null): Settings =>
          current === null ? loaded : { ...current, theme: loaded.theme },
      );
    }
  }, [store.settings]);
  useEffect((): (() => void) => {
    const onHashChange: () => void = (): void => {
      setSection(parseSettingsSectionHash(window.location.hash));
    };
    window.addEventListener('hashchange', onHashChange);
    return (): void => window.removeEventListener('hashchange', onHashChange);
  }, []);
  useEffect((): void => {
    if (store.settings !== null) applyTheme(document.documentElement, store.settings.theme);
  }, [store.settings]);
  useEffect((): void => {
    const loaded: ListsConfig | null = store.lists;
    if (loaded !== null) {
      setDraftLists((current: ListsConfig | null): ListsConfig => current ?? loaded);
    }
  }, [store.lists]);

  const loaded: boolean =
    draftSettings !== null &&
    draftLists !== null &&
    store.settings !== null &&
    store.lists !== null;
  const dirty: boolean =
    draftSettings !== null && draftLists !== null && store.settings !== null && store.lists !== null
      ? sectionIsDirty(section, draftSettings, store.settings, draftLists, store.lists)
      : false;
  const activeSaveState: DestinationSaveState = saveStates[section];
  const savePending: boolean = activeSaveState.pending;
  const saveError: string | null = activeSaveState.error;
  const stickySave: boolean = dirty || savePending || saveError !== null;

  const saveSection: () => Promise<void> = async (): Promise<void> => {
    if (
      draftSettings === null ||
      draftLists === null ||
      store.settings === null ||
      store.lists === null ||
      !dirty ||
      savePending
    ) {
      return;
    }
    const source: SettingsSectionId = section;
    if (pendingTransactions.current.has(source)) return;
    const transactionId: number = nextTransactionId.current;
    nextTransactionId.current += 1;
    pendingTransactions.current.set(source, transactionId);
    setSaveStates(
      (current: DestinationSaveStates): DestinationSaveStates => ({
        ...current,
        [source]: { transactionId, source, pending: true, error: null },
      }),
    );
    let error: string | null = null;
    try {
      let result: string | null;
      if (source === 'blocking') {
        result = await store.saveLists(draftLists);
      } else {
        const mutation: SettingsMutation | null = settingsMutationFromDraft(source, draftSettings);
        result =
          mutation === null ? 'Could not save. Try again.' : await store.saveSettings(mutation);
      }
      error = result;
    } catch {
      error = 'Could not save. Try again.';
    } finally {
      if (pendingTransactions.current.get(source) === transactionId) {
        pendingTransactions.current.delete(source);
      }
      setSaveStates(
        (current: DestinationSaveStates): DestinationSaveStates =>
          current[source].transactionId === transactionId
            ? {
                ...current,
                [source]: { transactionId, source, pending: false, error },
              }
            : current,
      );
    }
  };

  const discardSection: () => void = (): void => {
    if (
      draftSettings === null ||
      draftLists === null ||
      store.settings === null ||
      store.lists === null ||
      savePending
    ) {
      return;
    }
    setSaveStates(
      (current: DestinationSaveStates): DestinationSaveStates => ({
        ...current,
        [section]: { ...current[section], error: null },
      }),
    );
    if (section === 'blocking') {
      setDraftLists(store.lists);
      return;
    }
    setDraftSettings(settingsWithCommittedSection(section, draftSettings, store.settings));
  };

  return (
    <div class={`options${stickySave ? ' options--sticky-save' : ''}`}>
      <SettingsNav
        page="options"
        section={section}
        theme={store.settings?.theme ?? null}
        onThemeChange={store.saveTheme}
        onSectionChange={setSection}
      />
      <main class="content">
        <div class="content-body">
          <h1>Focus Lock settings</h1>
          {store.snapshot === null ? null : <SessionStatus snapshot={store.snapshot} />}
          {store.loadError !== null ? (
            <p class="save-error" role="alert">
              {store.loadError}
            </p>
          ) : draftSettings === null || draftLists === null ? (
            <p>Loading settings</p>
          ) : (
            <SectionPanels
              section={section}
              settings={draftSettings}
              lists={draftLists}
              store={store}
              onSettings={setDraftSettings}
              onLists={setDraftLists}
            />
          )}
        </div>
        {loaded && section !== 'privacy' ? (
          <DirtySaveBar
            dirty={dirty}
            pending={savePending}
            error={saveError}
            onSave={(): void => {
              void saveSection();
            }}
            onDiscard={discardSection}
          />
        ) : null}
      </main>
    </div>
  );
}

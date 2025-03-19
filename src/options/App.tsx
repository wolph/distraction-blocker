import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useEffect, useState } from 'preact/hooks';
import {
  parseSettingsSectionHash,
  SETTINGS_SECTIONS,
  SettingsNav,
  type SettingsSectionId,
} from '../shared/SettingsNav';
import { applyTheme } from '../shared/theme';
import type { ListsConfig, Rule, ScheduleEntry, SessionSnapshot, Settings } from '../shared/types';
import { BehaviorDefaults, PauseEconomy } from './Behavior';
import { Categories } from './Categories';
import { Data } from './Data';
import { RulesEditor } from './RulesEditor';
import { SaveRow } from './SaveRow';
import { Schedule } from './Schedule';
import { SoundsBadge } from './SoundsBadge';
import type { SettingsStore } from './use-settings';
import { useSettingsStore } from './use-settings';

function formatWallTime(atMs: number): string {
  const d: Date = new Date(atMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function hardBanner(snapshot: SessionSnapshot | null): VNode | null {
  if (snapshot === null || snapshot.phase === 'idle') return null;
  if (snapshot.config === null || snapshot.config.strictness !== 'hard') return null;
  if (snapshot.sessionEndsAt === null) return null;
  const text: string = `Changes that weaken blocking will be rejected until ${formatWallTime(snapshot.sessionEndsAt)}.`;
  return (
    <p class="hard-banner" role="status">
      {text}
    </p>
  );
}

interface SectionProps {
  section: SettingsSectionId;
  settings: Settings;
  lists: ListsConfig;
  onSettings: (next: Settings) => void;
  onLists: (next: ListsConfig) => void;
  store: SettingsStore;
}

function ListsSection(props: SectionProps): VNode {
  const committed: ListsConfig = props.store.lists ?? props.lists;
  return (
    <section>
      <h2>Lists</h2>
      <p class="help">
        Custom rules block during blacklist sessions. The whitelist is what stays reachable during
        whitelist sessions.
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
      <SaveRow
        label="Save lists"
        onSave={(): Promise<string | null> =>
          props.store.saveLists({
            ...committed,
            custom: props.lists.custom,
            whitelist: props.lists.whitelist,
          })
        }
      />
    </section>
  );
}

function CategoriesSection(props: SectionProps): VNode {
  const committed: ListsConfig = props.store.lists ?? props.lists;
  return (
    <section>
      <h2>Categories</h2>
      <p class="help">
        Bundled lists of common time sinks. Toggle a whole category, then open it to keep single
        sites available.
      </p>
      <Categories lists={props.lists} onChange={props.onLists} />
      <SaveRow
        label="Save categories"
        onSave={(): Promise<string | null> =>
          props.store.saveLists({
            ...committed,
            categories: props.lists.categories,
            exclusions: props.lists.exclusions,
          })
        }
      />
    </section>
  );
}

function ScheduleSection(props: SectionProps): VNode {
  const committed: Settings = props.store.settings ?? props.settings;
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
      <SaveRow
        label="Save schedule"
        onSave={(): Promise<string | null> =>
          props.store.saveSettings({ ...committed, schedule: props.settings.schedule })
        }
      />
    </section>
  );
}

function StrictnessSection(props: SectionProps): VNode {
  const committed: Settings = props.store.settings ?? props.settings;
  return (
    <section>
      <h2>Strictness and gate</h2>
      <BehaviorDefaults settings={props.settings} onChange={props.onSettings} />
      <SaveRow
        label="Save strictness and gate"
        onSave={(): Promise<string | null> =>
          props.store.saveSettings({
            ...committed,
            presetsMin: props.settings.presetsMin,
            defaultMode: props.settings.defaultMode,
            defaultStrictness: props.settings.defaultStrictness,
            defaultCycling: props.settings.defaultCycling,
            cyclingOnByDefault: props.settings.cyclingOnByDefault,
            gate: props.settings.gate,
          })
        }
      />
    </section>
  );
}

function PauseSection(props: SectionProps): VNode {
  const committed: Settings = props.store.settings ?? props.settings;
  return (
    <section>
      <h2>Pause economy</h2>
      <PauseEconomy settings={props.settings} onChange={props.onSettings} />
      <SaveRow
        label="Save pause economy"
        onSave={(): Promise<string | null> =>
          props.store.saveSettings({
            ...committed,
            pause: props.settings.pause,
            streakGoalMin: props.settings.streakGoalMin,
            streakFreezeIntervalDays: props.settings.streakFreezeIntervalDays,
            retentionDays: props.settings.retentionDays,
          })
        }
      />
    </section>
  );
}

function SoundsSection(props: SectionProps): VNode {
  const committed: Settings = props.store.settings ?? props.settings;
  return (
    <section>
      <h2>Sounds and badge</h2>
      <SoundsBadge settings={props.settings} onChange={props.onSettings} />
      <SaveRow
        label="Save sounds and badge"
        onSave={(): Promise<string | null> =>
          props.store.saveSettings({
            ...committed,
            sounds: props.settings.sounds,
            badgeCountdown: props.settings.badgeCountdown,
            sessionCompleteNotification: props.settings.sessionCompleteNotification,
          })
        }
      />
    </section>
  );
}

function DataSection(): VNode {
  return (
    <section>
      <h2>Data</h2>
      <Data />
    </section>
  );
}

function SectionBody(props: SectionProps): VNode {
  switch (props.section) {
    case 'lists':
      return <ListsSection {...props} />;
    case 'categories':
      return <CategoriesSection {...props} />;
    case 'schedule':
      return <ScheduleSection {...props} />;
    case 'strictness':
      return <StrictnessSection {...props} />;
    case 'pause':
      return <PauseSection {...props} />;
    case 'sounds':
      return <SoundsSection {...props} />;
    case 'data':
      return <DataSection />;
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

  return (
    <div class="options">
      <SettingsNav
        page="options"
        section={section}
        theme={store.settings?.theme ?? null}
        onThemeChange={store.saveTheme}
        onSectionChange={setSection}
      />
      <main class="content">
        {hardBanner(store.snapshot)}
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
            onSettings={setDraftSettings}
            onLists={setDraftLists}
            store={store}
          />
        )}
      </main>
    </div>
  );
}

import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
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

type SectionId = 'lists' | 'categories' | 'schedule' | 'strictness' | 'pause' | 'sounds' | 'data';

const SECTIONS: ReadonlyArray<{ id: SectionId; label: string }> = [
  { id: 'lists', label: 'Lists' },
  { id: 'categories', label: 'Categories' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'strictness', label: 'Strictness and gate' },
  { id: 'pause', label: 'Pause economy' },
  { id: 'sounds', label: 'Sounds and badge' },
  { id: 'data', label: 'Data' },
];

function formatWallTime(atMs: number): string {
  const d: Date = new Date(atMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function hardBanner(snapshot: SessionSnapshot | null): VNode | null {
  if (snapshot === null || snapshot.phase === 'idle') return null;
  if (snapshot.config === null || snapshot.config.strictness !== 'hard') return null;
  if (snapshot.sessionEndsAt === null) return null;
  const text: string = `Hard session until ${formatWallTime(snapshot.sessionEndsAt)}. Changes that weaken blocking will be rejected until then.`;
  return (
    <p class="hard-banner" role="status">
      {text}
    </p>
  );
}

interface SectionProps {
  section: SectionId;
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

export function App(): VNode {
  const store: SettingsStore = useSettingsStore();
  const [section, setSection] = useState<SectionId>('lists');
  const [draftSettings, setDraftSettings] = useState<Settings | null>(null);
  const [draftLists, setDraftLists] = useState<ListsConfig | null>(null);

  useEffect((): void => {
    const loaded: Settings | null = store.settings;
    if (loaded !== null) {
      setDraftSettings((current: Settings | null): Settings => current ?? loaded);
    }
  }, [store.settings]);
  useEffect((): void => {
    const loaded: ListsConfig | null = store.lists;
    if (loaded !== null) {
      setDraftLists((current: ListsConfig | null): ListsConfig => current ?? loaded);
    }
  }, [store.lists]);

  return (
    <div class="options">
      <nav class="nav" aria-label="Settings sections">
        <h1>Focus Lock</h1>
        {SECTIONS.map(
          (s: { id: SectionId; label: string }): VNode => (
            <button
              type="button"
              key={s.id}
              class={section === s.id ? 'nav-item current' : 'nav-item'}
              aria-current={section === s.id ? 'true' : undefined}
              onClick={(): void => {
                setSection(s.id);
              }}
            >
              {s.label}
            </button>
          ),
        )}
      </nav>
      <main class="content">
        {hardBanner(store.snapshot)}
        {store.loadError !== null ? (
          <p class="save-error" role="alert">
            {store.loadError}
          </p>
        ) : draftSettings === null || draftLists === null ? (
          <p>Loading settings</p>
        ) : (
          <SectionBody
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

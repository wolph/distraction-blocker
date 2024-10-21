import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ListsConfig, Rule, ScheduleEntry, SessionSnapshot, Settings } from '../shared/types';
import { Categories } from './Categories';
import { RulesEditor } from './RulesEditor';
import { SaveRow } from './SaveRow';
import { Schedule } from './Schedule';
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
        onSave={(): Promise<string | null> => props.store.saveLists(props.lists)}
      />
    </section>
  );
}

function CategoriesSection(props: SectionProps): VNode {
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
        onSave={(): Promise<string | null> => props.store.saveLists(props.lists)}
      />
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
      <SaveRow
        label="Save schedule"
        onSave={(): Promise<string | null> => props.store.saveSettings(props.settings)}
      />
    </section>
  );
}

function SectionBody(props: SectionProps): VNode {
  if (props.section === 'lists') return <ListsSection {...props} />;
  if (props.section === 'categories') return <CategoriesSection {...props} />;
  if (props.section === 'schedule') return <ScheduleSection {...props} />;
  const label: string =
    SECTIONS.find((s: { id: SectionId; label: string }): boolean => s.id === props.section)
      ?.label ?? '';
  return (
    <section>
      <h2>{label}</h2>
    </section>
  );
}

export function App(): VNode {
  const store: SettingsStore = useSettingsStore();
  const [section, setSection] = useState<SectionId>('lists');
  const [draftSettings, setDraftSettings] = useState<Settings | null>(null);
  const [draftLists, setDraftLists] = useState<ListsConfig | null>(null);

  useEffect((): void => {
    setDraftSettings(store.settings);
  }, [store.settings]);
  useEffect((): void => {
    setDraftLists(store.lists);
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
        {draftSettings === null || draftLists === null ? (
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

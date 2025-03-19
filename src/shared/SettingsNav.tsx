import type { VNode } from 'preact';
import { ThemeControl } from './ThemeControl';
import type { ThemeMode } from './types';

export type SettingsSectionId =
  | 'lists'
  | 'categories'
  | 'schedule'
  | 'strictness'
  | 'pause'
  | 'sounds'
  | 'data';

export const SETTINGS_SECTIONS: ReadonlyArray<{ id: SettingsSectionId; label: string }> = [
  { id: 'lists', label: 'Lists' },
  { id: 'categories', label: 'Categories' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'strictness', label: 'Strictness and gate' },
  { id: 'pause', label: 'Pause economy' },
  { id: 'sounds', label: 'Sounds and badge' },
  { id: 'data', label: 'Data' },
];

export function parseSettingsSectionHash(hash: string): SettingsSectionId {
  const candidate: string = hash.startsWith('#') ? hash.slice(1) : hash;
  return SETTINGS_SECTIONS.some(({ id }: { id: SettingsSectionId }): boolean => id === candidate)
    ? (candidate as SettingsSectionId)
    : 'lists';
}

interface SettingsNavProps {
  page: 'options' | 'stats';
  section?: SettingsSectionId;
  theme: ThemeMode | null;
  onThemeChange: (next: ThemeMode) => Promise<string | null>;
  onSectionChange?: (next: SettingsSectionId) => void;
}

export function SettingsNav(props: SettingsNavProps): VNode {
  return (
    <nav class="settings-nav" aria-label="Settings sections">
      <div class="settings-nav-heading">
        <h1>Focus Lock</h1>
        <ThemeControl mode={props.theme} onChange={props.onThemeChange} />
      </div>
      <a
        class={`settings-nav-item${props.page === 'stats' ? ' current' : ''}`}
        href="../stats/stats.html"
        aria-current={props.page === 'stats' ? 'page' : undefined}
      >
        Stats
      </a>
      {SETTINGS_SECTIONS.map(({ id, label }: { id: SettingsSectionId; label: string }): VNode => {
        const current: boolean = props.page === 'options' && props.section === id;
        return (
          <a
            key={id}
            class={`settings-nav-item${current ? ' current' : ''}`}
            href={props.page === 'options' ? `#${id}` : `../options/options.html#${id}`}
            aria-current={current ? 'page' : undefined}
            onClick={
              props.page === 'options'
                ? (): void => {
                    props.onSectionChange?.(id);
                  }
                : undefined
            }
          >
            {label}
          </a>
        );
      })}
    </nav>
  );
}

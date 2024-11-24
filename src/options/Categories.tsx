import type { VNode } from 'preact';
import { useState } from 'preact/hooks';
import { ALL_CATEGORIES } from '../core/categories';
import type { CategoryId, CategoryList, ListsConfig } from '../shared/types';

export interface CategoriesProps {
  lists: ListsConfig;
  onChange: (next: ListsConfig) => void;
}

/**
 * One row per bundled category: toggle, title, entry count, expander.
 * Expanded rows list every host with a checkbox. Unchecked hosts land in
 * lists.exclusions so a single site stays available while the category
 * blocks. Exclusions survive the category being toggled off.
 */
export function Categories(props: CategoriesProps): VNode {
  const [expanded, setExpanded] = useState<Set<CategoryId>>(new Set());

  const toggleCategory = (id: CategoryId, on: boolean): void => {
    props.onChange({
      ...props.lists,
      categories: { ...props.lists.categories, [id]: on },
    });
  };

  const toggleHost = (id: CategoryId, host: string, active: boolean): void => {
    const current: string[] = props.lists.exclusions[id] ?? [];
    const next: string[] = active
      ? current.filter((h: string): boolean => h !== host)
      : [...current, host];
    props.onChange({
      ...props.lists,
      exclusions: { ...props.lists.exclusions, [id]: next },
    });
  };

  const toggleExpanded = (id: CategoryId): void => {
    const next: Set<CategoryId> = new Set(expanded);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setExpanded(next);
  };

  return (
    <div class="categories">
      {ALL_CATEGORIES.map((category: CategoryList): VNode => {
        const enabled: boolean = props.lists.categories[category.id];
        const excluded: string[] = props.lists.exclusions[category.id] ?? [];
        const open: boolean = expanded.has(category.id);
        return (
          <div key={category.id}>
            <div class="cat-row">
              <label class="check">
                <input
                  type="checkbox"
                  checked={enabled}
                  onClick={(): void => {
                    toggleCategory(category.id, !enabled);
                  }}
                />
                {category.title}
              </label>
              <span class="cat-count">{category.hosts.length} sites</span>
              <span class="spacer" />
              <button
                type="button"
                class="ghost"
                aria-expanded={open}
                onClick={(): void => {
                  toggleExpanded(category.id);
                }}
              >
                {open ? `Hide ${category.title} sites` : `Show ${category.title} sites`}
              </button>
            </div>
            {open ? (
              <div>
                <p class="help">
                  Uncheck a site to keep it available while the rest of the category is blocked.
                </p>
                <ul class="cat-hosts">
                  {category.hosts.map((host: string): VNode => {
                    const active: boolean = !excluded.includes(host);
                    return (
                      <li key={host}>
                        <label class="check">
                          <input
                            type="checkbox"
                            checked={active}
                            onClick={(): void => {
                              toggleHost(category.id, host, !active);
                            }}
                          />
                          {host}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

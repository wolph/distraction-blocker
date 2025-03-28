import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useState } from 'preact/hooks';
import { ALL_CATEGORIES } from '../core/categories';
import type { CategoryId, CategoryList, ListsConfig } from '../shared/types';

export interface CategoriesProps {
  lists: ListsConfig;
  onChange: (next: ListsConfig) => void;
}

function siteCountLabel(count: number): string {
  return count === 1 ? '1 site' : `${count} sites`;
}

function categoryCountLabel(count: number): string {
  return count === 1 ? '1 category' : `${count} categories`;
}

/**
 * One row per bundled category: toggle, title, entry count, expander.
 * Expanded rows list every host with a checkbox. Unchecked hosts land in
 * lists.exclusions so a single site stays available while the category
 * blocks. Exclusions survive the category being toggled off.
 */
export function Categories(props: CategoriesProps): VNode {
  const [expanded, setExpanded]: [Set<CategoryId>, Dispatch<StateUpdater<Set<CategoryId>>>] =
    useState<Set<CategoryId>>(new Set());

  const toggleCategory: (id: CategoryId, on: boolean) => void = (
    id: CategoryId,
    on: boolean,
  ): void => {
    props.onChange({
      ...props.lists,
      categories: { ...props.lists.categories, [id]: on },
    });
  };

  const setAllCategories: (enabled: boolean) => void = (enabled: boolean): void => {
    const categories: Record<CategoryId, boolean> = { ...props.lists.categories };
    ALL_CATEGORIES.forEach((category: CategoryList): void => {
      categories[category.id] = enabled;
    });
    props.onChange({ ...props.lists, categories });
  };

  const toggleHost: (id: CategoryId, host: string, active: boolean) => void = (
    id: CategoryId,
    host: string,
    active: boolean,
  ): void => {
    const current: string[] = props.lists.exclusions[id] ?? [];
    const next: string[] = active
      ? current.filter((h: string): boolean => h !== host)
      : [...current, host];
    props.onChange({
      ...props.lists,
      exclusions: { ...props.lists.exclusions, [id]: next },
    });
  };

  const setAllHosts: (category: CategoryList, active: boolean) => void = (
    category: CategoryList,
    active: boolean,
  ): void => {
    const current: string[] = props.lists.exclusions[category.id] ?? [];
    const bundledHosts: Set<string> = new Set(category.hosts);
    const next: string[] = active
      ? [...new Set(current.filter((host: string): boolean => !bundledHosts.has(host)))]
      : [...new Set([...current, ...category.hosts])];
    props.onChange({
      ...props.lists,
      exclusions: { ...props.lists.exclusions, [category.id]: next },
    });
  };

  const toggleExpanded: (id: CategoryId) => void = (id: CategoryId): void => {
    const next: Set<CategoryId> = new Set(expanded);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setExpanded(next);
  };

  const allCategoriesSelected: boolean = ALL_CATEGORIES.every(
    (category: CategoryList): boolean => props.lists.categories[category.id],
  );
  const allCategoriesDeselected: boolean = ALL_CATEGORIES.every(
    (category: CategoryList): boolean => !props.lists.categories[category.id],
  );
  const selectedCategoryCount: number = ALL_CATEGORIES.filter(
    (category: CategoryList): boolean => props.lists.categories[category.id],
  ).length;
  const deselectedCategoryCount: number = ALL_CATEGORIES.length - selectedCategoryCount;

  return (
    <div class="categories">
      <fieldset class="cat-bulk-actions" aria-label="Category bulk actions">
        <span
          class="selection-count selected"
          role="status"
          aria-label={`Selected ${categoryCountLabel(selectedCategoryCount)}`}
        >
          Selected {selectedCategoryCount}
        </span>
        <span
          class="selection-count deselected"
          role="status"
          aria-label={`Deselected ${categoryCountLabel(deselectedCategoryCount)}`}
        >
          Deselected {deselectedCategoryCount}
        </span>
        <span class="spacer" />
        <button
          type="button"
          class="ghost"
          aria-label="Select all categories"
          disabled={allCategoriesSelected}
          onClick={(): void => {
            setAllCategories(true);
          }}
        >
          Select all
        </button>
        <button
          type="button"
          class="ghost"
          aria-label="Deselect all categories"
          disabled={allCategoriesDeselected}
          onClick={(): void => {
            setAllCategories(false);
          }}
        >
          Deselect all
        </button>
      </fieldset>

      {ALL_CATEGORIES.map((category: CategoryList): VNode => {
        const enabled: boolean = props.lists.categories[category.id];
        const excluded: string[] = props.lists.exclusions[category.id] ?? [];
        const excludedHosts: Set<string> = new Set(excluded);
        const deselectedHostCount: number = category.hosts.filter((host: string): boolean =>
          excludedHosts.has(host),
        ).length;
        const selectedHostCount: number = category.hosts.length - deselectedHostCount;
        const partial: boolean = selectedHostCount > 0 && deselectedHostCount > 0;
        const open: boolean = partial || expanded.has(category.id);
        const allHostsSelected: boolean = category.hosts.every(
          (host: string): boolean => !excluded.includes(host),
        );
        const allHostsDeselected: boolean = category.hosts.every((host: string): boolean =>
          excluded.includes(host),
        );
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
              <span
                class="selection-count selected"
                role="status"
                aria-label={`${category.title}: selected ${siteCountLabel(selectedHostCount)}`}
              >
                Selected {selectedHostCount}
              </span>
              <span
                class="selection-count deselected"
                role="status"
                aria-label={`${category.title}: deselected ${siteCountLabel(deselectedHostCount)}`}
              >
                Deselected {deselectedHostCount}
              </span>
              <span class="spacer" />
              <button
                type="button"
                class="ghost"
                aria-expanded={open}
                aria-label={
                  partial
                    ? `${category.title} sites are shown because the category is partially selected`
                    : undefined
                }
                disabled={partial}
                onClick={(): void => {
                  toggleExpanded(category.id);
                }}
              >
                {partial
                  ? 'Partially selected'
                  : open
                    ? `Hide ${category.title} sites`
                    : `Show ${category.title} sites`}
              </button>
            </div>
            {open ? (
              <div>
                <p class="help">
                  Uncheck a site to keep it available while the rest of the category is blocked.
                </p>
                <fieldset
                  class="cat-bulk-actions cat-site-actions"
                  aria-label={`${category.title} site bulk actions`}
                >
                  <button
                    type="button"
                    class="ghost"
                    aria-label={`Select all ${category.title} sites`}
                    disabled={allHostsSelected}
                    onClick={(): void => {
                      setAllHosts(category, true);
                    }}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    class="ghost"
                    aria-label={`Deselect all ${category.title} sites`}
                    disabled={allHostsDeselected}
                    onClick={(): void => {
                      setAllHosts(category, false);
                    }}
                  >
                    Deselect all
                  </button>
                </fieldset>
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

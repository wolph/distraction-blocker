import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useState } from 'preact/hooks';
import { ALL_CATEGORIES } from '../core/categories';
import { MODE_LABELS } from '../shared/session-copy';
import type { CategoryId, CategoryList, ListsConfig } from '../shared/types';

export interface StartingListsStepProps {
  lists: ListsConfig;
  pending: boolean;
  onListsChange: (lists: ListsConfig) => void | Promise<void>;
  onContinue: () => void | Promise<void>;
}

export function StartingListsStep(props: StartingListsStepProps): VNode {
  const [expanded, setExpanded]: [Set<CategoryId>, Dispatch<StateUpdater<Set<CategoryId>>>] =
    useState<Set<CategoryId>>(new Set<CategoryId>());

  const toggleCategory: (categoryId: CategoryId) => void = (categoryId: CategoryId): void => {
    const lists: ListsConfig = {
      ...props.lists,
      categories: {
        ...props.lists.categories,
        [categoryId]: !props.lists.categories[categoryId],
      },
    };
    void props.onListsChange(lists);
  };

  const toggleExpanded: (categoryId: CategoryId) => void = (categoryId: CategoryId): void => {
    setExpanded((current: Set<CategoryId>): Set<CategoryId> => {
      const next: Set<CategoryId> = new Set<CategoryId>(current);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      return next;
    });
  };

  return (
    <section aria-labelledby="starting-lists-heading">
      <h1 id="starting-lists-heading" tabIndex={-1}>
        Choose your starting block list
      </h1>
      <p>
        In <strong>{MODE_LABELS.blacklist}</strong>, enabled categories and extra blocked sites are
        unavailable. In <strong>{MODE_LABELS.whitelist}</strong>, every site is unavailable except
        your allow list.
      </p>
      <p>These choices become defaults for future sessions. You can edit them later.</p>
      <fieldset class="category-list" disabled={props.pending}>
        <legend>Recommended website categories</legend>
        {ALL_CATEGORIES.map((category: CategoryList): VNode => {
          const open: boolean = expanded.has(category.id);
          const regionId: string = `category-domains-${category.id}`;
          return (
            <div class="category-card" key={category.id}>
              <div class="category-card-summary">
                <label class="category-choice">
                  <input
                    type="checkbox"
                    checked={props.lists.categories[category.id]}
                    onChange={(): void => toggleCategory(category.id)}
                  />
                  <span>{category.title}</span>
                </label>
                <span class="category-site-count">{category.hosts.length} sites</span>
                <button
                  type="button"
                  class="disclosure-button"
                  aria-expanded={open}
                  aria-controls={regionId}
                  onClick={(): void => toggleExpanded(category.id)}
                >
                  {open ? `Hide ${category.title} sites` : `Show ${category.title} sites`}
                </button>
              </div>
              {open ? (
                <section
                  id={regionId}
                  class="category-domains-scroll"
                  aria-label={`${category.title} domains`}
                >
                  <ul>
                    {category.hosts.map(
                      (host: string): VNode => (
                        <li key={host}>{host}</li>
                      ),
                    )}
                  </ul>
                </section>
              ) : null}
            </div>
          );
        })}
      </fieldset>
      <button
        type="button"
        class="primary-button"
        disabled={props.pending}
        onClick={(): void => void props.onContinue()}
      >
        Continue
      </button>
    </section>
  );
}

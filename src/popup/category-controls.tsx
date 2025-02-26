import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useEffect, useRef, useState } from 'preact/hooks';
import { ALL_CATEGORIES } from '../core/categories';
import type { Ack } from '../shared/messages';
import { sendRequest } from '../shared/messages';
import { ackError } from '../shared/runtime-validation';
import type { CategoryId, CategoryList, ListsConfig } from '../shared/types';

interface PendingCategoryChange {
  id: CategoryId;
  desired: boolean;
}

interface CategoryControlsProps {
  lists: ListsConfig;
  editable: boolean;
  onError: (message: string | null) => void;
}

function updateCategory(lists: ListsConfig, id: CategoryId, desired: boolean): ListsConfig {
  return {
    ...lists,
    categories: { ...lists.categories, [id]: desired },
  };
}

export function CategoryControls({
  lists,
  editable,
  onError,
}: CategoryControlsProps): VNode | null {
  const [localLists, setLocalLists]: [ListsConfig, Dispatch<StateUpdater<ListsConfig>>] =
    useState<ListsConfig>(lists);
  const [pendingCategories, setPendingCategories]: [
    ReadonlySet<CategoryId>,
    Dispatch<StateUpdater<ReadonlySet<CategoryId>>>,
  ] = useState<ReadonlySet<CategoryId>>(new Set());
  const localListsRef: { current: ListsConfig } = useRef<ListsConfig>(lists);
  const pendingCategoriesRef: { current: Set<CategoryId> } = useRef<Set<CategoryId>>(new Set());
  const categoryQueueRef: { current: PendingCategoryChange[] } = useRef<PendingCategoryChange[]>(
    [],
  );
  const updateInFlightRef: { current: boolean } = useRef<boolean>(false);
  const deferredListsRef: { current: ListsConfig | null } = useRef<ListsConfig | null>(null);
  const acceptedChangesRef: { current: Map<CategoryId, boolean> } = useRef<
    Map<CategoryId, boolean>
  >(new Map());

  useEffect((): void => {
    if (updateInFlightRef.current || categoryQueueRef.current.length > 0) {
      deferredListsRef.current = lists;
      return;
    }
    localListsRef.current = lists;
    setLocalLists(lists);
    acceptedChangesRef.current.clear();
  }, [lists]);

  const reconcileDeferredLists: () => void = (): void => {
    const deferred: ListsConfig | null = deferredListsRef.current;
    if (deferred === null) return;
    let reconciled: ListsConfig = deferred;
    for (const [id, desired] of acceptedChangesRef.current) {
      reconciled = updateCategory(reconciled, id, desired);
    }
    deferredListsRef.current = null;
    acceptedChangesRef.current.clear();
    localListsRef.current = reconciled;
    setLocalLists(reconciled);
  };

  const dispatchNextUpdate: () => Promise<void> = async (): Promise<void> => {
    if (updateInFlightRef.current) return;
    const change: PendingCategoryChange | undefined = categoryQueueRef.current.shift();
    if (change === undefined) return;
    updateInFlightRef.current = true;
    const next: ListsConfig = updateCategory(localListsRef.current, change.id, change.desired);
    try {
      const ack: Ack = await sendRequest({ type: 'updateLists', lists: next });
      const responseError: string | null = ackError(ack, 'Could not update categories. Try again.');
      if (responseError === null) {
        const committed: ListsConfig = updateCategory(
          localListsRef.current,
          change.id,
          change.desired,
        );
        localListsRef.current = committed;
        setLocalLists(committed);
        acceptedChangesRef.current.set(change.id, change.desired);
      } else onError(responseError);
    } catch {
      onError('Could not update categories. Try again.');
    } finally {
      const remainingPending: Set<CategoryId> = new Set(pendingCategoriesRef.current);
      remainingPending.delete(change.id);
      pendingCategoriesRef.current = remainingPending;
      setPendingCategories(remainingPending);
      updateInFlightRef.current = false;
      if (categoryQueueRef.current.length === 0) reconcileDeferredLists();
      else void dispatchNextUpdate();
    }
  };

  const toggleCategory: (id: CategoryId) => void = (id: CategoryId): void => {
    if (!editable || pendingCategoriesRef.current.has(id)) return;
    if (!updateInFlightRef.current && categoryQueueRef.current.length === 0) {
      acceptedChangesRef.current.clear();
    }
    const desired: boolean = !localListsRef.current.categories[id];
    const nextPending: Set<CategoryId> = new Set(pendingCategoriesRef.current);
    nextPending.add(id);
    pendingCategoriesRef.current = nextPending;
    setPendingCategories(nextPending);
    categoryQueueRef.current.push({ id, desired });
    onError(null);
    void dispatchNextUpdate();
  };

  if (ALL_CATEGORIES.length === 0) return null;
  return (
    <fieldset
      class="pill-row"
      aria-label="Blocked categories"
      aria-busy={pendingCategories.size > 0}
    >
      {ALL_CATEGORIES.map(
        (category: CategoryList): VNode => (
          <button
            type="button"
            key={category.id}
            class={localLists.categories[category.id] ? 'chip chip-selected' : 'chip'}
            aria-pressed={localLists.categories[category.id]}
            disabled={!editable || pendingCategories.has(category.id)}
            onClick={(): void => {
              toggleCategory(category.id);
            }}
          >
            {category.title}
          </button>
        ),
      )}
    </fieldset>
  );
}

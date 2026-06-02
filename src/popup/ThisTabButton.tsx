import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useEffect, useRef, useState } from 'preact/hooks';
import { sendRequest } from '../shared/messages';
import type { SessionMode } from '../shared/types';
import type { WorkTab } from '../shared/work-target';
import { parseWorkTabsResult, type WorkTabsResult } from '../shared/work-target';
import type { WorkTabsState } from './use-work-tabs';

export function ThisTabButton({
  work,
  disabled = false,
  mode,
  choiceKey,
  onSelect,
}: {
  work: WorkTabsState;
  disabled?: boolean;
  mode: SessionMode;
  choiceKey: string;
  onSelect: (tabId: number) => void;
}): VNode {
  const current: WorkTab | undefined = work.tabs.find(
    (tab: WorkTab): boolean => tab.tabId === work.context?.activeTabId,
  );
  const [pending, setPending]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const latestChoice: { current: string } = useRef<string>(choiceKey);
  latestChoice.current = choiceKey;
  const generation: { current: number } = useRef<number>(0);
  const inFlight: { current: boolean } = useRef<boolean>(false);
  useEffect((): (() => void) => {
    return (): void => {
      generation.current += 1;
    };
  }, []);
  const choose: () => Promise<void> = async (): Promise<void> => {
    if (inFlight.current || work.context === null) return;
    const request: number = ++generation.current;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const active: chrome.tabs.Tab | undefined = (
        await chrome.tabs.query({ active: true, currentWindow: true })
      )[0];
      const available: WorkTabsResult | null = parseWorkTabsResult(
        await sendRequest({ type: 'getWorkTabs', mode, windowId: work.context.windowId }),
      );
      if (request !== generation.current || latestChoice.current !== choiceKey) return;
      if (
        active?.windowId !== work.context.windowId ||
        !available?.ok ||
        !available.tabs.some((tab: WorkTab): boolean => tab.tabId === active?.id)
      ) {
        setError('This tab is not available for work. Choose another open tab.');
        return;
      }
      onSelect(active.id as number);
    } catch {
      if (request === generation.current) setError('Could not load your current tab. Try again.');
    } finally {
      if (request === generation.current) {
        inFlight.current = false;
        setPending(false);
      }
    }
  };
  return (
    <div class="this-tab-choice">
      <button
        type="button"
        class="this-tab-button"
        disabled={disabled || current === undefined || work.loading || pending}
        aria-describedby="this-tab-hint"
        onClick={(): void => {
          void choose();
        }}
      >
        Use this tab
      </button>
      <p id="this-tab-hint" class="work-tab-hint">
        {pending
          ? 'Checking current tab...'
          : (error ??
            (work.loading
              ? 'Finding your current tab...'
              : (work.error ??
                current?.title ??
                'This tab is not available for work. Choose another open tab.')))}
      </p>
    </div>
  );
}

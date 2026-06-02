import { type Dispatch, type StateUpdater, useEffect, useRef, useState } from 'preact/hooks';
import { sendRequest } from '../shared/messages';
import type { SessionMode, SessionSnapshot } from '../shared/types';
import {
  isBrowserTabId,
  parseWorkTabsResult,
  parseWorkTargetResult,
  type WorkTab,
  type WorkTabsResult,
  type WorkTargetResult,
} from '../shared/work-target';

interface WorkContext {
  windowId: number;
  activeTabId: number | null;
}
export interface WorkTabsState {
  loading: boolean;
  context: WorkContext | null;
  tabs: WorkTab[];
  error: string | null;
}

async function currentContext(): Promise<WorkContext> {
  const tabs: chrome.tabs.Tab[] = await chrome.tabs.query({ active: true, currentWindow: true });
  const active: chrome.tabs.Tab | undefined = tabs[0];
  const windowId: number | undefined = active?.windowId ?? (await chrome.windows.getCurrent()).id;
  if (!isBrowserTabId(windowId)) throw new Error('No popup window');
  return { windowId, activeTabId: isBrowserTabId(active?.id) ? active.id : null };
}

function isWorkNotification(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    (value.type === 'stateChanged' || value.type === 'workTargetChanged')
  );
}

export function useWorkTabs(mode: SessionMode, refreshKey: unknown = null): WorkTabsState {
  const [state, setState]: [WorkTabsState, Dispatch<StateUpdater<WorkTabsState>>] =
    useState<WorkTabsState>({ loading: true, context: null, tabs: [], error: null });
  useEffect((): (() => void) => {
    let generation: number = 0;
    const refresh: () => Promise<void> = async (): Promise<void> => {
      const request: number = ++generation;
      setState((previous: WorkTabsState): WorkTabsState => ({ ...previous, loading: true }));
      try {
        const context: WorkContext = await currentContext();
        const result: WorkTabsResult | null = parseWorkTabsResult(
          await sendRequest({ type: 'getWorkTabs', mode, windowId: context.windowId }),
        );
        if (request !== generation) return;
        setState({
          loading: false,
          context,
          tabs: result?.ok ? result.tabs : [],
          error: result?.ok ? null : 'Could not load work tabs. Reopen the popup to try again.',
        });
      } catch {
        if (request === generation)
          setState({
            loading: false,
            context: null,
            tabs: [],
            error: 'Could not load work tabs. Reopen the popup to try again.',
          });
      }
    };
    const listener: (value: unknown) => void = (value: unknown): void => {
      if (isWorkNotification(value)) void refresh();
    };
    chrome.runtime.onMessage.addListener(listener);
    void refresh();
    return (): void => {
      generation += 1;
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, [mode, refreshKey]);
  return state;
}

export interface WorkTargetState {
  target: WorkTargetResult | null;
  windowId: number | null;
  refresh: () => void;
}
export function useWorkTarget(snapshot: SessionSnapshot): WorkTargetState {
  const [target, setTarget]: [
    WorkTargetResult | null,
    Dispatch<StateUpdater<WorkTargetResult | null>>,
  ] = useState<WorkTargetResult | null>(null);
  const [windowId, setWindowId]: [number | null, Dispatch<StateUpdater<number | null>>] = useState<
    number | null
  >(null);
  const refreshRef: { current: () => void } = useRef<() => void>((): void => {});
  useEffect((): (() => void) => {
    let generation: number = 0;
    const refresh: () => Promise<void> = async (): Promise<void> => {
      const request: number = ++generation;
      try {
        const context: WorkContext = await currentContext();
        const result: WorkTargetResult | null = parseWorkTargetResult(
          await sendRequest({ type: 'getWorkTarget', windowId: context.windowId }),
        );
        if (request !== generation) return;
        setWindowId(context.windowId);
        setTarget(result);
      } catch {
        if (request === generation) setTarget(null);
      }
    };
    refreshRef.current = (): void => {
      void refresh();
    };
    const listener: (value: unknown) => void = (value: unknown): void => {
      if (isWorkNotification(value)) void refresh();
    };
    chrome.runtime.onMessage.addListener(listener);
    void refresh();
    return (): void => {
      generation += 1;
      chrome.runtime.onMessage.removeListener(listener);
      refreshRef.current = (): void => {};
    };
  }, [snapshot]);
  return { target, windowId, refresh: (): void => refreshRef.current() };
}

import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useState } from 'preact/hooks';
import { sendRequest } from '../shared/messages';
import { ackError } from '../shared/runtime-validation';
import type { SessionSnapshot } from '../shared/types';
import type { WorkTab } from '../shared/work-target';
import { useWorkTabs, type WorkTabsState, type WorkTargetState } from './use-work-tabs';

export function WorkTabControl({
  snapshot,
  work,
}: {
  snapshot: SessionSnapshot;
  work: WorkTargetState;
}): VNode {
  const candidates: WorkTabsState = useWorkTabs(snapshot.config?.mode ?? 'blacklist');
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const [pending, setPending]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const sessionId: string | null = work.target?.ok ? work.target.sessionId : null;
  const select: (tabId: number) => Promise<void> = async (tabId: number): Promise<void> => {
    if (sessionId === null || work.windowId === null || pending) return;
    setPending(true);
    setError(null);
    try {
      setError(
        ackError(
          await sendRequest({ type: 'setWorkTarget', sessionId, tabId, windowId: work.windowId }),
          'Could not save the work tab. Try again.',
        ),
      );
    } catch {
      setError('Could not save the work tab. Try again.');
    } finally {
      setPending(false);
      work.refresh();
    }
  };
  return (
    <div class="work-tab-control">
      <p class="work-target">
        {work.target?.ok && work.target.state === 'ready'
          ? work.target.title
          : 'Choose or replace your work tab.'}
      </p>
      <label class="work-tab-label">
        Work tab
        <select
          aria-label="Work tab"
          value=""
          disabled={pending || sessionId === null || candidates.context === null}
          onChange={(event: Event): void => {
            const value: string = (event.currentTarget as HTMLSelectElement).value;
            if (value !== '') void select(Number(value));
          }}
        >
          <option value="">Choose an open tab</option>
          {candidates.tabs.map(
            (tab: WorkTab): VNode => (
              <option key={tab.tabId} value={tab.tabId}>
                {tab.title}
              </option>
            ),
          )}
        </select>
      </label>
      {error !== null ? (
        <p class="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {candidates.error !== null ? <p class="work-tab-hint">{candidates.error}</p> : null}
    </div>
  );
}

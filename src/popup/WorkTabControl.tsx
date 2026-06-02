import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useEffect, useRef, useState } from 'preact/hooks';
import { sendRequest } from '../shared/messages';
import { ackError } from '../shared/runtime-validation';
import type { SessionSnapshot } from '../shared/types';
import type { WorkTab } from '../shared/work-target';
import { ThisTabButton } from './ThisTabButton';
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
  const identity: string = JSON.stringify([sessionId, snapshot.startedAt, snapshot.sessionEndsAt]);
  const currentIdentity: { current: string } = useRef<string>(identity);
  currentIdentity.current = identity;
  const generation: { current: number } = useRef<number>(0);
  const inFlight: { current: boolean } = useRef<boolean>(false);
  useEffect((): (() => void) => {
    inFlight.current = false;
    setPending(false);
    setError(null);
    return (): void => {
      generation.current += 1;
    };
  }, [identity]);
  const select: (tabId: number) => Promise<void> = async (tabId: number): Promise<void> => {
    if (sessionId === null || work.windowId === null || pending || inFlight.current) return;
    const request: number = ++generation.current;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const response: unknown = await sendRequest({
        type: 'setWorkTarget',
        sessionId,
        tabId,
        windowId: work.windowId,
      });
      if (request !== generation.current || currentIdentity.current !== identity) return;
      setError(ackError(response, 'Could not save the work tab. Try again.'));
    } catch {
      if (request !== generation.current || currentIdentity.current !== identity) return;
      setError('Could not save the work tab. Try again.');
    } finally {
      if (request === generation.current && currentIdentity.current === identity) {
        inFlight.current = false;
        setPending(false);
        work.refresh();
      }
    }
  };
  return (
    <div class="work-tab-control">
      <p class="work-target">
        {work.target?.ok && work.target.state === 'ready'
          ? `Work tab: ${work.target.title}`
          : 'Choose or replace your work tab.'}
      </p>
      <ThisTabButton
        key={identity}
        choiceKey={String(generation.current)}
        mode={snapshot.config?.mode ?? 'blacklist'}
        work={candidates}
        disabled={pending || sessionId === null}
        onSelect={(tabId: number): void => {
          void select(tabId);
        }}
      />
      <label class="work-tab-label">
        Or choose another tab
        <select
          aria-label="Work tab"
          value=""
          disabled={
            pending || sessionId === null || candidates.context === null || candidates.loading
          }
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
      {pending ? (
        <p class="work-tab-hint" role="status">
          Saving work tab...
        </p>
      ) : null}
    </div>
  );
}

import type { TargetedEvent, VNode } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { LOCAL_ONLY_DATA_ITEMS, SYNCED_DATA_ITEMS } from '../shared/privacy-copy';

export interface SyncChoiceStepProps {
  syncEnabled: boolean;
  pending: boolean;
  error: string | null;
  onSyncChange: (enabled: boolean) => void | Promise<void>;
  onComplete: () => void | Promise<void>;
}

function DataList(props: { id: string; title: string; items: readonly string[] }): VNode {
  const headingId: string = `${props.id}-heading`;
  return (
    <section class="storage-data-list" aria-labelledby={headingId}>
      <h2 id={headingId}>{props.title}</h2>
      <ul>
        {props.items.map(
          (item: string): VNode => (
            <li key={item}>{item}</li>
          ),
        )}
      </ul>
    </section>
  );
}

export function SyncChoiceStep(props: SyncChoiceStepProps): VNode {
  const completionLabel: string = props.syncEnabled
    ? 'Finish setup with sync enabled'
    : 'Finish setup without sync';
  const syncControl: { current: HTMLInputElement | null } = useRef<HTMLInputElement>(null);
  const restoreSyncFocus: { current: boolean } = useRef<boolean>(false);
  useLayoutEffect((): void => {
    if (props.pending || !restoreSyncFocus.current) return;
    restoreSyncFocus.current = false;
    syncControl.current?.focus();
  }, [props.pending, props.syncEnabled]);

  const changeSync: (event: TargetedEvent<HTMLInputElement>) => void = (
    event: TargetedEvent<HTMLInputElement>,
  ): void => {
    restoreSyncFocus.current = true;
    void props.onSyncChange(event.currentTarget.checked);
  };

  return (
    <section aria-labelledby="sync-choice-heading">
      <h1 id="sync-choice-heading" tabIndex={-1}>
        Choose where your settings are stored
      </h1>
      <label class="sync-choice">
        <input
          ref={syncControl}
          type="checkbox"
          role="switch"
          aria-label="Sync across Chrome devices"
          aria-checked={props.syncEnabled}
          checked={props.syncEnabled}
          disabled={props.pending}
          onChange={changeSync}
        />
        <span>
          <strong>Sync across Chrome devices</strong>
          <small>
            {props.syncEnabled
              ? 'The approved data below will use Chrome Sync after you finish setup.'
              : 'All Focus Lock data stays in this Chrome profile.'}
          </small>
        </span>
      </label>
      <div class="storage-data-grid">
        <DataList id="synced-data" title="Synced" items={SYNCED_DATA_ITEMS} />
        <DataList id="local-data" title="Local only" items={LOCAL_ONLY_DATA_ITEMS} />
      </div>
      <p class="developer-data-note">Nothing is sent to the Focus Lock developer.</p>
      {props.error !== null ? <p role="alert">{props.error}</p> : null}
      <button
        type="button"
        class="primary-button"
        disabled={props.pending}
        onClick={(): void => void props.onComplete()}
      >
        {completionLabel}
      </button>
    </section>
  );
}

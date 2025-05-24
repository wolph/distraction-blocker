import type { TargetedEvent, VNode } from 'preact';

export interface SyncChoiceStepProps {
  syncEnabled: boolean;
  pending: boolean;
  error: string | null;
  onSyncChange: (enabled: boolean) => void | Promise<void>;
  onComplete: () => void | Promise<void>;
}

const SYNCED_DATA: readonly string[] = [
  'Settings',
  'Block and allow lists',
  'Pause balance',
  'Streaks',
  'Domain-level blocked-attempt aggregates',
];

const LOCAL_DATA: readonly string[] = [
  'Full URLs',
  'Focus intentions',
  'Detailed session events',
  'Active runtime session',
];

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
  return (
    <section aria-labelledby="sync-choice-heading">
      <h1 id="sync-choice-heading" tabIndex={-1}>
        Choose where your settings are stored
      </h1>
      <label class="sync-choice">
        <input
          type="checkbox"
          role="switch"
          aria-label="Sync across Chrome devices"
          aria-checked={props.syncEnabled}
          checked={props.syncEnabled}
          disabled={props.pending}
          onChange={(event: TargetedEvent<HTMLInputElement>): void =>
            void props.onSyncChange(event.currentTarget.checked)
          }
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
        <DataList id="synced-data" title="Synced" items={SYNCED_DATA} />
        <DataList id="local-data" title="Local only" items={LOCAL_DATA} />
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

import type { VNode } from 'preact';

export interface DirtySaveBarProps {
  dirty: boolean;
  pending: boolean;
  onSave: () => void;
  onDiscard: () => void;
}

export function DirtySaveBar(props: DirtySaveBarProps): VNode {
  const disabled: boolean = !props.dirty || props.pending;
  const message: string = props.pending
    ? 'Saving changes'
    : props.dirty
      ? 'Unsaved changes'
      : 'No unsaved changes';

  return (
    <div class="dirty-save-bar">
      <p class="dirty-save-state" aria-live="polite">
        {message}
      </p>
      <div class="dirty-save-actions">
        <button type="button" class="secondary" disabled={disabled} onClick={props.onDiscard}>
          Discard changes
        </button>
        <button type="button" class="primary" disabled={disabled} onClick={props.onSave}>
          Save changes
        </button>
      </div>
    </div>
  );
}

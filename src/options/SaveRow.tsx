import type { VNode } from 'preact';
import { useState } from 'preact/hooks';

export interface SaveRowProps {
  label: string;
  /** resolves null on success, the worker's rejection string otherwise */
  onSave: () => Promise<string | null>;
}

/**
 * Save button plus result line. A worker rejection renders verbatim, which
 * is how the hard-session guard reaches the user on every save path.
 */
export function SaveRow(props: SaveRowProps): VNode {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<boolean>(false);

  const save = async (): Promise<void> => {
    setSaved(false);
    setError(null);
    const result: string | null = await props.onSave();
    if (result === null) {
      setSaved(true);
    } else {
      setError(result);
    }
  };

  return (
    <div class="save-row">
      <button
        type="button"
        class="primary"
        onClick={(): void => {
          void save();
        }}
      >
        {props.label}
      </button>
      {error !== null ? (
        <p class="save-error" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p class="save-ok" role="status">
          Saved.
        </p>
      ) : null}
    </div>
  );
}

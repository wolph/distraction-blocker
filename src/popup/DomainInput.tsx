import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useEffect, useState } from 'preact/hooks';

export interface DomainInputProps {
  onError?: (error: string | null) => void;
  onAdd: (raw: string) => string | null;
}

export function DomainInput({ onAdd, onError }: DomainInputProps): VNode {
  const [value, setValue]: [string, Dispatch<StateUpdater<string>>] = useState<string>('');
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);

  useEffect((): (() => void) => (): void => onError?.(null), [onError]);

  const submit: () => void = (): void => {
    const nextError: string | null = onAdd(value);
    setError(nextError);
    onError?.(nextError);
    if (nextError === null) setValue('');
  };

  return (
    <div class="domain-input-control">
      <label class="field-label" for="session-allow-domain">
        Add an allowed domain
      </label>
      <div class="domain-input-row">
        <input
          id="session-allow-domain"
          type="text"
          inputMode="url"
          autocomplete="url"
          placeholder="docs.example.com"
          value={value}
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : 'session-allow-domain-error'}
          onInput={(event: Event): void =>
            setValue((event.currentTarget as HTMLInputElement).value)
          }
          onKeyDown={(event: KeyboardEvent): void => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            submit();
          }}
        />
        <button type="button" onClick={submit} aria-label="Add allowed domain">
          <span aria-hidden="true">+</span>
          <span>Add</span>
        </button>
      </div>
      {onError === undefined && error !== null ? (
        <p id="session-allow-domain-error" class="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

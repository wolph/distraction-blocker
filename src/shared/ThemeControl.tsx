import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useState } from 'preact/hooks';
import { nextTheme } from './theme';
import type { ThemeMode } from './types';

interface ThemeControlProps {
  mode: ThemeMode | null;
  onChange: (next: ThemeMode) => Promise<string | null>;
  className?: string;
}

const MODE_LABELS: Readonly<Record<ThemeMode, string>> = {
  auto: 'Auto',
  light: 'Light',
  dark: 'Dark',
};

function ThemeIcon({ mode }: { mode: ThemeMode }): VNode {
  if (mode === 'auto') {
    return (
      <svg data-icon="theme-auto" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <rect
          x="3"
          y="4"
          width="18"
          height="13"
          rx="2"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        />
        <path
          d="M8 21h8M12 17v4"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        />
      </svg>
    );
  }
  if (mode === 'light') {
    return (
      <svg data-icon="theme-light" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2" />
        <path
          d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        />
      </svg>
    );
  }
  return (
    <svg data-icon="theme-dark" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M20.5 15.3A8.5 8.5 0 0 1 8.7 3.5 8.5 8.5 0 1 0 20.5 15.3Z"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linejoin="round"
      />
    </svg>
  );
}

export function ThemeControl(props: ThemeControlProps): VNode {
  const [pending, setPending]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const current: ThemeMode = props.mode ?? 'auto';
  const next: ThemeMode = nextTheme(current);

  const changeTheme: () => Promise<void> = async (): Promise<void> => {
    if (props.mode === null || pending) return;
    setPending(true);
    setError(null);
    try {
      setError(await props.onChange(next));
    } catch {
      setError('Could not save theme. Reload page and try again.');
    } finally {
      setPending(false);
    }
  };

  return (
    <span class={`theme-control${props.className === undefined ? '' : ` ${props.className}`}`}>
      <button
        type="button"
        class="theme-button"
        aria-label={`Theme: ${MODE_LABELS[current]}. Switch to ${MODE_LABELS[next]}`}
        disabled={props.mode === null || pending}
        onClick={(): void => {
          void changeTheme();
        }}
      >
        <ThemeIcon mode={current} />
      </button>
      {error === null ? null : (
        <span class="theme-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

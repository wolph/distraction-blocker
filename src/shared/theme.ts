import { sendRequest } from './messages';
import { ackError } from './runtime-validation';
import type { ThemeMode } from './types';

const THEME_ORDER: readonly ThemeMode[] = ['auto', 'light', 'dark'];

const THEME_SAVE_ERROR: string = 'Could not save theme. Reload page and try again.';

export function nextTheme(theme: ThemeMode): ThemeMode {
  const index: number = THEME_ORDER.indexOf(theme);
  return THEME_ORDER[(index + 1) % THEME_ORDER.length] ?? 'auto';
}

export function applyTheme(target: HTMLElement, theme: ThemeMode): void {
  target.dataset.theme = theme;
  target.style.setProperty('color-scheme', theme === 'auto' ? 'light dark' : theme, 'important');
}

export async function updateTheme(theme: ThemeMode): Promise<string | null> {
  try {
    const response: unknown = await sendRequest({ type: 'updateTheme', theme });
    return ackError(response, THEME_SAVE_ERROR);
  } catch {
    return THEME_SAVE_ERROR;
  }
}

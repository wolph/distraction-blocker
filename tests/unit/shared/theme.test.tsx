/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeControl } from '../../../src/shared/ThemeControl';
import { applyTheme, nextTheme, updateTheme } from '../../../src/shared/theme';
import type { ThemeMode } from '../../../src/shared/types';

afterEach((): void => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('theme helpers', (): void => {
  it('cycles auto, light, dark, then auto', (): void => {
    expect(nextTheme('auto')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('auto');
  });

  it.each([
    ['auto' as const, 'light dark'],
    ['light' as const, 'light'],
    ['dark' as const, 'dark'],
  ])('applies %s to the target dataset and color scheme', (mode, colorScheme): void => {
    const target: HTMLElement = document.createElement('div');
    applyTheme(target, mode);
    expect(target.dataset.theme).toBe(mode);
    expect(target.style.colorScheme).toBe(colorScheme);
  });

  it('returns exact worker and stable transport errors for theme persistence', async (): Promise<void> => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'theme denied' })
      .mockRejectedValueOnce(new Error('disconnected'));
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    await expect(updateTheme('dark')).resolves.toBe('theme denied');
    await expect(updateTheme('light')).resolves.toBe(
      'Could not save theme. Reload page and try again.',
    );
  });
});

describe('ThemeControl', (): void => {
  it('uses the approved dial, sun, and constellation artwork', (): void => {
    const onChange = async (): Promise<null> => null;
    const auto = render(<ThemeControl mode="auto" onChange={onChange} />);
    expect(auto.container.querySelector('[data-icon="theme-auto"] circle')).toBeTruthy();
    expect(
      auto.container.querySelector('[data-icon="theme-auto"] path[d="M12 4a8 8 0 0 0 0 16Z"]'),
    ).toBeTruthy();
    auto.unmount();

    const light = render(<ThemeControl mode="light" onChange={onChange} />);
    expect(light.container.querySelector('[data-icon="theme-light"] circle[r="3.5"]')).toBeTruthy();
    light.unmount();

    const dark = render(<ThemeControl mode="dark" onChange={onChange} />);
    expect(dark.container.querySelectorAll('[data-icon="theme-dark"] path')).toHaveLength(2);
    expect(dark.container.querySelector('[data-icon="theme-dark"] path[d*="A8.5"]')).toBeNull();
  });

  it.each([
    ['auto' as const, 'light' as const, 'theme-auto'],
    ['light' as const, 'dark' as const, 'theme-light'],
    ['dark' as const, 'auto' as const, 'theme-dark'],
  ])('names and requests the next mode from %s', async (mode, expected, icon): Promise<void> => {
    const onChange = vi.fn<(next: ThemeMode) => Promise<string | null>>(
      async (): Promise<null> => null,
    );
    const { getByRole, container } = render(<ThemeControl mode={mode} onChange={onChange} />);
    const button: HTMLButtonElement = getByRole('button', {
      name: new RegExp(`Theme: ${mode}.*Switch to ${expected}`, 'i'),
    }) as HTMLButtonElement;
    expect(container.querySelector(`[data-icon="${icon}"]`)).toBeTruthy();
    fireEvent.click(button);
    await waitFor((): void => expect(onChange).toHaveBeenCalledWith(expected));
  });

  it('disables while unavailable and while a write is pending', async (): Promise<void> => {
    let resolve: (value: string | null) => void = (): void => {};
    const onChange = vi.fn(
      async (): Promise<string | null> =>
        new Promise<string | null>((done: (value: string | null) => void): void => {
          resolve = done;
        }),
    );
    const unavailable = render(<ThemeControl mode={null} onChange={onChange} />);
    expect((unavailable.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    unavailable.unmount();

    const available = render(<ThemeControl mode="auto" onChange={onChange} />);
    const button: HTMLButtonElement = available.getByRole('button') as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    resolve(null);
    await waitFor((): void => expect(button.disabled).toBe(false));
  });

  it('keeps the controlled mode and reports a failed write', async (): Promise<void> => {
    const { getByRole, container } = render(
      <ThemeControl mode="auto" onChange={async (): Promise<string> => 'Could not save theme.'} />,
    );
    fireEvent.click(getByRole('button'));
    await waitFor((): void => {
      expect(getByRole('alert').textContent).toBe('Could not save theme.');
    });
    expect(container.querySelector('[data-icon="theme-auto"]')).toBeTruthy();
  });
});

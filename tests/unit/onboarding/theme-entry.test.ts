/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, emptySnapshot } from '../../../src/shared/constants';
import type { Request } from '../../../src/shared/messages';

const mocks = vi.hoisted((): { sendRequest: ReturnType<typeof vi.fn> } => ({
  sendRequest: vi.fn(),
}));

vi.mock('../../../src/shared/messages', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/shared/messages')>();
  return { ...original, sendRequest: mocks.sendRequest };
});

vi.mock('../../../src/onboarding/App', (): { App: () => null } => ({
  App: (): null => null,
}));

let broadcast: (message: unknown) => void = (): void => {};

beforeEach((): void => {
  vi.resetModules();
  mocks.sendRequest.mockReset();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('style');
  document.body.innerHTML = '<div id="app"></div>';
  broadcast = (): void => {};
  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: {
        addListener(listener: (message: unknown) => void): void {
          broadcast = listener;
        },
      },
    },
  });
});

afterEach((): void => {
  vi.unstubAllGlobals();
});

describe('onboarding theme entrypoint', (): void => {
  it.each(['light' as const, 'dark' as const])(
    'applies saved explicit %s independently of system media',
    async (theme): Promise<void> => {
      mocks.sendRequest.mockImplementation(async (request: Request): Promise<unknown> => {
        if (request.type === 'getSettings') return { ...DEFAULT_SETTINGS, theme };
        throw new Error(`unexpected request: ${request.type}`);
      });

      await import('../../../src/onboarding/main');

      await waitFor((): void => expect(document.documentElement.dataset.theme).toBe(theme));
      expect(document.documentElement.style.colorScheme).toBe(theme);
    },
  );

  it.each([
    ['invalid settings', async (): Promise<unknown> => ({ theme: 'sepia' })],
    ['failed settings', async (): Promise<unknown> => Promise.reject(new Error('offline'))],
  ])('keeps the safe Auto fallback for %s', async (_label, response): Promise<void> => {
    mocks.sendRequest.mockImplementation(response);

    await import('../../../src/onboarding/main');

    expect(document.documentElement.dataset.theme).toBe('auto');
    expect(document.documentElement.style.colorScheme).toBe('light dark');
    await new Promise<void>((resolve: () => void): void => queueMicrotask(resolve));
    expect(document.documentElement.dataset.theme).toBe('auto');
  });

  it('follows a validated live snapshot theme', async (): Promise<void> => {
    mocks.sendRequest.mockResolvedValue({ ...DEFAULT_SETTINGS, theme: 'light' });
    await import('../../../src/onboarding/main');
    await waitFor((): void => expect(document.documentElement.dataset.theme).toBe('light'));

    broadcast({ type: 'stateChanged', snapshot: { ...emptySnapshot(Date.now()), theme: 'dark' } });

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('defines explicit themes outside the Auto media query', (): void => {
    const styles: string = readFileSync(resolve('src/onboarding/onboarding.css'), 'utf8');
    expect(styles).toContain(':root[data-theme="light"]');
    expect(styles).toContain(':root[data-theme="dark"]');
    expect(styles).toContain(':root[data-theme="auto"]');
    expect(styles.indexOf(':root[data-theme="light"]')).toBeLessThan(
      styles.indexOf('@media (prefers-color-scheme: dark)'),
    );
    expect(styles.indexOf(':root[data-theme="dark"]')).toBeGreaterThan(
      styles.indexOf('@media (prefers-color-scheme: dark)'),
    );
  });
});

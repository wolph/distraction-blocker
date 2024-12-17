/** @vitest-environment jsdom */
import './chrome-fake';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LISTS, DEFAULT_SETTINGS } from '../../../src/shared/constants';
import type { Request } from '../../../src/shared/messages';
import { resetChromeFake, sendMessageMock } from './chrome-fake';

vi.mock('../../../src/core/categories', () => ({
  ALL_CATEGORIES: [
    { id: 'social', title: 'Social', hosts: ['facebook.com'] },
    { id: 'video', title: 'Video and streaming', hosts: ['youtube.com'] },
  ],
}));

import { StartForm } from '../../../src/popup/StartForm';

describe('StartForm category acknowledgement', () => {
  beforeEach((): void => {
    resetChromeFake();
  });

  afterEach((): void => {
    cleanup();
  });

  it('keeps category controls pending until the worker responds', async (): Promise<void> => {
    let resolveUpdate: (value: { ok: true }) => void = (): void => {};
    sendMessageMock.mockImplementation(async (req: Request): Promise<unknown> => {
      if (req.type !== 'updateLists') return { ok: true };
      return new Promise<{ ok: true }>((resolve: (value: { ok: true }) => void): void => {
        resolveUpdate = resolve;
      });
    });
    const { getByRole } = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );
    fireEvent.click(getByRole('button', { name: 'Social' }));
    expect(
      (getByRole('group', { name: 'Blocked categories' }) as HTMLFieldSetElement).disabled,
    ).toBe(true);
    await waitFor((): void => {
      expect(sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'updateLists' }),
      );
    });
    resolveUpdate({ ok: true });
    await waitFor((): void => {
      expect(
        (getByRole('group', { name: 'Blocked categories' }) as HTMLFieldSetElement).disabled,
      ).toBe(false);
    });
  });

  it('restores authoritative category state and shows a hard-guard rejection', async (): Promise<void> => {
    sendMessageMock.mockImplementation(async (req: Request): Promise<unknown> => {
      if (req.type === 'updateLists') {
        return { ok: false, error: 'Changes that weaken blocking are locked until 16:45.' };
      }
      return { ok: true };
    });
    const { getByRole } = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );
    fireEvent.click(getByRole('button', { name: 'Social' }));
    await waitFor((): void => {
      expect(getByRole('alert').textContent).toBe(
        'Changes that weaken blocking are locked until 16:45.',
      );
    });
    expect(getByRole('button', { name: 'Social' }).getAttribute('aria-pressed')).toBe('false');
  });
});

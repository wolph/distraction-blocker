/** @vitest-environment jsdom */
import './chrome-fake';

import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StartForm } from '../../../src/popup/StartForm';
import { DEFAULT_LISTS, DEFAULT_SETTINGS, rulesFromLists } from '../../../src/shared/constants';
import type { Request } from '../../../src/shared/messages';
import type { ListsConfig } from '../../../src/shared/types';
import { resetChromeFake, sendMessageMock } from './chrome-fake';

vi.mock('../../../src/core/categories', () => ({
  ALL_CATEGORIES: [
    { id: 'social', title: 'Social', hosts: ['facebook.com'] },
    { id: 'video', title: 'Video and streaming', hosts: ['youtube.com'] },
  ],
}));

function requests(): Request[] {
  return sendMessageMock.mock.calls.map(([request]: unknown[]): Request => request as Request);
}

describe('StartForm session draft isolation', (): void => {
  beforeEach((): void => {
    resetChromeFake();
    sendMessageMock.mockResolvedValue({ ok: true });
  });

  afterEach((): void => {
    cleanup();
  });

  it('applies rapid category changes locally without acknowledgement traffic', (): void => {
    const view = render(h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }));

    fireEvent.click(view.getByRole('button', { name: 'Social' }));
    fireEvent.click(view.getByRole('button', { name: 'Video and streaming' }));

    expect(view.getByRole('button', { name: 'Social' }).getAttribute('aria-pressed')).toBe('true');
    expect(
      view.getByRole('button', { name: 'Video and streaming' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(requests()).toHaveLength(0);
  });

  it('rebases refreshed defaults without overwriting explicit category changes', async (): Promise<void> => {
    const refreshed: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, video: true },
    };
    const view = render(h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }));

    fireEvent.click(view.getByRole('button', { name: 'Social' }));
    view.rerender(h(StartForm, { settings: DEFAULT_SETTINGS, lists: refreshed }));
    fireEvent.click(view.getByRole('button', { name: 'Start 25 min - Block selected sites' }));

    await waitFor((): void => {
      const start: Extract<Request, { type: 'startSession' }> | undefined = requests().find(
        (request: Request): request is Extract<Request, { type: 'startSession' }> =>
          request.type === 'startSession',
      );
      expect(start?.config.rules.categories).toMatchObject({ social: true, video: true });
      expect(start?.config.rules.baselineRevision).not.toBe(
        rulesFromLists(DEFAULT_LISTS).baselineRevision,
      );
    });
  });

  it('rebases authoritative list fields before retrying a stale start', async (): Promise<void> => {
    const refreshed: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, video: true },
      custom: [{ kind: 'host', pattern: 'fresh.example' }],
    };
    sendMessageMock
      .mockResolvedValueOnce({
        ok: false,
        error: 'Your default blocking lists changed. Review this session and start again.',
      })
      .mockResolvedValue({ ok: true });
    const view = render(h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }));

    fireEvent.click(view.getByRole('button', { name: 'Social' }));
    fireEvent.click(view.getByRole('button', { name: 'Start 25 min - Block selected sites' }));
    await view.findByRole('alert');
    view.rerender(h(StartForm, { settings: DEFAULT_SETTINGS, lists: refreshed }));
    fireEvent.click(view.getByRole('button', { name: 'Start 25 min - Block selected sites' }));

    await waitFor((): void => {
      const starts: Array<Extract<Request, { type: 'startSession' }>> = requests().filter(
        (request: Request): request is Extract<Request, { type: 'startSession' }> =>
          request.type === 'startSession',
      );
      expect(starts).toHaveLength(2);
      expect(starts[1]?.config.rules).toEqual(
        expect.objectContaining({
          baselineRevision: rulesFromLists(refreshed).baselineRevision,
          baselineCategories: refreshed.categories,
          permanentBlacklist: refreshed.custom,
          categories: expect.objectContaining({ social: true, video: true }),
        }),
      );
    });
  });

  it('prevents fallback category controls from changing the draft', (): void => {
    const view = render(
      h(StartForm, {
        settings: DEFAULT_SETTINGS,
        lists: DEFAULT_LISTS,
        categoriesEditable: false,
      }),
    );
    const social: HTMLButtonElement = view.getByRole('button', {
      name: 'Social',
    }) as HTMLButtonElement;

    expect(social.disabled).toBe(true);
    fireEvent.click(social);
    expect(social.getAttribute('aria-pressed')).toBe('false');
    expect(requests()).toHaveLength(0);
  });
});

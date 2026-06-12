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

function ackByType(): void {
  sendMessageMock.mockImplementation(async (req: Request): Promise<unknown> => {
    if (req.type === 'startSession' || req.type === 'updateLists') return { ok: true };
    return undefined;
  });
}

describe('StartForm', () => {
  beforeEach((): void => {
    resetChromeFake();
    ackByType();
  });

  afterEach((): void => {
    cleanup();
  });

  it('labels the presets concisely', (): void => {
    const { getByRole } = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );
    expect(getByRole('button', { name: '15 short' })).toBeTruthy();
    expect(getByRole('button', { name: '25 focus' })).toBeTruthy();
    expect(getByRole('button', { name: '50 deep work' })).toBeTruthy();
  });

  it('renders the prescribed strictness hints exactly', (): void => {
    const { getByPlaceholderText, getByText } = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );

    expect(getByPlaceholderText('Continue your current task')).toBeTruthy();
    expect(getByText('can end early after 30 s wait typing sentence')).toBeTruthy();
    expect(getByText('sites stay locked until the timer ends, paid access excepted')).toBeTruthy();
  });

  it('starts a session from the chosen preset and typed intention', async (): Promise<void> => {
    const { getByRole, getByPlaceholderText } = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );

    fireEvent.click(getByRole('button', { name: '25 focus' }));
    fireEvent.input(getByPlaceholderText('Continue your current task'), {
      target: { value: 'write the report' },
    });
    fireEvent.click(getByRole('button', { name: 'Start focusing' }));

    await waitFor((): void => {
      expect(sendMessageMock).toHaveBeenCalledWith({
        type: 'startSession',
        config: {
          mode: 'blacklist',
          strictness: 'friction',
          durationMin: 25,
          cycling: DEFAULT_SETTINGS.defaultCycling,
          intention: 'write the report',
          source: 'manual',
          scheduleEntryId: null,
        },
      });
    });
  });

  it('toggles a category pill by sending updateLists immediately', async (): Promise<void> => {
    const { getByRole } = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );

    fireEvent.click(getByRole('button', { name: 'Social' }));

    await waitFor((): void => {
      expect(sendMessageMock).toHaveBeenCalledWith({
        type: 'updateLists',
        lists: { ...DEFAULT_LISTS, categories: { ...DEFAULT_LISTS.categories, social: true } },
      });
    });
  });

  it('shows the worker rejection inline under the start button', async (): Promise<void> => {
    sendMessageMock.mockImplementation(async (req: Request): Promise<unknown> => {
      if (req.type === 'startSession') return { ok: false, error: 'a session is already running' };
      return { ok: true };
    });
    const { getByRole, getByText } = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );

    fireEvent.click(getByRole('button', { name: 'Start focusing' }));

    await waitFor((): void => {
      expect(getByText('a session is already running')).toBeTruthy();
    });
  });
});

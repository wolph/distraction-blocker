/** @vitest-environment jsdom */
import './chrome-fake';

import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LISTS, DEFAULT_SETTINGS } from '../../../src/shared/constants';
import type { Request } from '../../../src/shared/messages';
import type { CycleConfig } from '../../../src/shared/types';
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

  it('renders the configured strictness hints', (): void => {
    const { getByPlaceholderText, getByText, getByRole } = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );

    expect(getByPlaceholderText('Continue your current task')).toBeTruthy();
    expect(getByText('can end early after 10 s wait')).toBeTruthy();
    expect(getByText('sites stay locked until the timer ends, paid access excepted')).toBeTruthy();
    fireEvent.click(getByRole('button', { name: 'Until manual unlock' }));
    expect(getByText('Unlock confirmation: 10 s wait.')).toBeTruthy();
  });

  it.each([
    {
      delayMs: 1250,
      requireTypedPhrase: true,
      hint: 'can end early after 1.25 s wait and typing the confirmation phrase',
      detail: 'Unlock confirmation: 1.25 s wait and typing the confirmation phrase.',
    },
    {
      delayMs: 0,
      requireTypedPhrase: false,
      hint: 'can end early without waiting or typing a phrase',
      detail: 'Unlock confirmation: none.',
    },
  ])(
    'explains custom confirmation delay $delayMs and typed phrase $requireTypedPhrase',
    ({
      delayMs,
      requireTypedPhrase,
      hint,
      detail,
    }: {
      delayMs: number;
      requireTypedPhrase: boolean;
      hint: string;
      detail: string;
    }): void => {
      const view: ReturnType<typeof render> = render(
        h(StartForm, {
          settings: {
            ...DEFAULT_SETTINGS,
            gate: { ...DEFAULT_SETTINGS.gate, delayMs, requireTypedPhrase },
          },
          lists: DEFAULT_LISTS,
        }),
      );
      expect(view.getByText(hint)).toBeTruthy();
      expect(view.queryByText(detail)).toBeNull();
      fireEvent.click(view.getByRole('button', { name: 'Until manual unlock' }));
      const confirmation: HTMLElement = view.getByText(detail);
      expect(confirmation.closest('details')).toBeNull();
      expect(view.getByText('Locked until you manually unlock')).toBeTruthy();
      fireEvent.click(view.getByRole('button', { name: '25 focus' }));
      expect(view.getByText(hint)).toBeTruthy();
      expect(view.queryByText(detail)).toBeNull();
    },
  );

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

  it('starts the deep work preset as uninterrupted focus despite default cycling', async (): Promise<void> => {
    const view: ReturnType<typeof render> = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );
    fireEvent.click(view.getByRole('button', { name: '50 deep work' }));
    expect(view.getByText('50 min uninterrupted focus')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Start focusing' }));
    await waitFor((): void => {
      expect(sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'startSession',
          config: expect.objectContaining({ durationMin: 50, cycling: null }),
        }),
      );
    });
  });

  it('starts manual unlock without a deadline, hard strictness or cycles', async (): Promise<void> => {
    const view: ReturnType<typeof render> = render(
      h(StartForm, {
        settings: { ...DEFAULT_SETTINGS, defaultStrictness: 'hard' },
        lists: DEFAULT_LISTS,
      }),
    );
    const preset: HTMLButtonElement = view.getByRole('button', {
      name: 'Until manual unlock',
    }) as HTMLButtonElement;
    expect(preset.textContent).toBe('∞');
    expect(preset.title).toBe('Until manual unlock');
    fireEvent.click(preset);
    expect(preset.getAttribute('aria-pressed')).toBe('true');
    expect(view.getByText('Locked until you manually unlock')).toBeTruthy();
    const hard: HTMLInputElement = view.getByRole('radio', { name: /^hard/ }) as HTMLInputElement;
    const cycles: HTMLInputElement = view.getByRole('checkbox', {
      name: /cycles:/,
    }) as HTMLInputElement;
    expect(hard.disabled).toBe(true);
    expect(hard.checked).toBe(false);
    expect(cycles.disabled).toBe(true);
    expect(cycles.checked).toBe(false);
    expect(
      view.getByText('Manual unlock requires friction and has no automatic breaks.'),
    ).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Lock until manual unlock' }));
    await waitFor((): void => {
      expect(sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'startSession',
          config: expect.objectContaining({
            durationMin: null,
            cycling: null,
            strictness: 'friction',
            source: 'manual',
            scheduleEntryId: null,
          }),
        }),
      );
    });
  });

  it.each([
    { label: '25 focus', durationMin: 25, cycling: DEFAULT_SETTINGS.defaultCycling },
    { label: '50 deep work', durationMin: 50, cycling: null },
  ])(
    'restores timed strictness and the $label cycle behaviour after infinity',
    async ({
      label,
      durationMin,
      cycling,
    }: {
      label: string;
      durationMin: number;
      cycling: CycleConfig | null;
    }): Promise<void> => {
      const view: ReturnType<typeof render> = render(
        h(StartForm, {
          settings: { ...DEFAULT_SETTINGS, defaultStrictness: 'hard' },
          lists: DEFAULT_LISTS,
        }),
      );
      fireEvent.click(view.getByRole('button', { name: 'Until manual unlock' }));
      fireEvent.click(view.getByRole('button', { name: label }));
      expect((view.getByRole('radio', { name: /^hard/ }) as HTMLInputElement).checked).toBe(true);
      fireEvent.click(view.getByRole('button', { name: 'Start focusing' }));
      await waitFor((): void => {
        expect(sendMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'startSession',
            config: expect.objectContaining({ durationMin, cycling, strictness: 'hard' }),
          }),
        );
      });
    },
  );

  it('returns to timed settings when custom minutes replace infinity', async (): Promise<void> => {
    const view: ReturnType<typeof render> = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );
    fireEvent.click(view.getByRole('button', { name: 'Until manual unlock' }));
    fireEvent.input(view.getByRole('spinbutton', { name: 'Custom minutes' }), {
      target: { value: '40' },
    });
    expect(view.getByText('40 min total, with 25 min focus blocks')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Start focusing' }));
    await waitFor((): void => {
      expect(sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'startSession',
          config: expect.objectContaining({
            durationMin: 40,
            cycling: DEFAULT_SETTINGS.defaultCycling,
          }),
        }),
      );
    });
  });

  it('allows an explicit cycling choice after selecting deep work and explains its timer', async (): Promise<void> => {
    const view: ReturnType<typeof render> = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );
    fireEvent.click(view.getByRole('button', { name: '50 deep work' }));
    const checkbox: HTMLInputElement = view.getByRole('checkbox', {
      name: /cycles:/,
    }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    expect(view.getByText('50 min total, with 25 min focus blocks')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Start focusing' }));
    await waitFor((): void => {
      expect(sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'startSession',
          config: expect.objectContaining({
            durationMin: 50,
            cycling: DEFAULT_SETTINGS.defaultCycling,
          }),
        }),
      );
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

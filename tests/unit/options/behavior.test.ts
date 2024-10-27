// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BehaviorDefaults, PauseEconomy } from '../../../src/options/Behavior';
import { Data } from '../../../src/options/Data';
import { SoundsBadge } from '../../../src/options/SoundsBadge';
import { DEFAULT_SETTINGS } from '../../../src/shared/constants';
import type { Settings } from '../../../src/shared/types';
import type { ChromeFake } from './chrome-fake';
import { installChromeFake } from './chrome-fake';

let fake: ChromeFake;

beforeEach((): void => {
  fake = installChromeFake();
  fake.respond('previewSound', { ok: true });
  fake.respond('exportEvents', { json: '[]' });
});

afterEach((): void => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PauseEconomy', () => {
  it('maps the earn-rate input to earnRatio = value / 30', (): void => {
    const onChange = vi.fn();
    const { getByLabelText } = render(h(PauseEconomy, { settings: DEFAULT_SETTINGS, onChange }));
    fireEvent.input(getByLabelText('Minutes of pause per 30 minutes of focus'), {
      target: { value: '10' },
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next: Settings = onChange.mock.calls[0]?.[0] as Settings;
    expect(next.pause.earnRatio).toBeCloseTo(10 / 30);
    expect(next.pause.capMs).toBe(DEFAULT_SETTINGS.pause.capMs);
  });

  it('ignores input that is not a non-negative number', (): void => {
    const onChange = vi.fn();
    const { getByLabelText } = render(h(PauseEconomy, { settings: DEFAULT_SETTINGS, onChange }));
    fireEvent.input(getByLabelText('Minutes of pause per 30 minutes of focus'), {
      target: { value: '-3' },
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('BehaviorDefaults', () => {
  it('switches the gate delay to 30 seconds', (): void => {
    const onChange = vi.fn();
    const { getByLabelText } = render(
      h(BehaviorDefaults, { settings: DEFAULT_SETTINGS, onChange }),
    );
    fireEvent.click(getByLabelText('Wait 30 seconds'));
    const next: Settings = onChange.mock.calls[0]?.[0] as Settings;
    expect(next.gate.delayMs).toBe(30_000);
  });
});

describe('SoundsBadge', () => {
  it('sends previewSound for the play button', (): void => {
    const onChange = vi.fn();
    const { getByRole } = render(h(SoundsBadge, { settings: DEFAULT_SETTINGS, onChange }));
    fireEvent.click(getByRole('button', { name: 'Preview Session complete' }));
    expect(fake.sent).toContainEqual({ type: 'previewSound', sound: 'sessionComplete' });
  });

  it('maps the volume slider 0-100 to masterVolume 0-1', (): void => {
    const onChange = vi.fn();
    const { getByLabelText } = render(h(SoundsBadge, { settings: DEFAULT_SETTINGS, onChange }));
    fireEvent.input(getByLabelText('Master volume'), { target: { value: '40' } });
    const next: Settings = onChange.mock.calls[0]?.[0] as Settings;
    expect(next.sounds.masterVolume).toBeCloseTo(0.4);
  });
});

describe('Data', () => {
  it('shows the local device id and exports the event log', async (): Promise<void> => {
    const createObjectURL = vi.fn((): string => 'blob:fake');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation((): void => {});

    const { getByText, getByRole } = render(h(Data, null));
    await waitFor((): void => {
      expect(getByText('test-device-id')).toBeTruthy();
    });
    fireEvent.click(getByRole('button', { name: 'Export event log' }));
    await waitFor((): void => {
      expect(fake.sent).toContainEqual({ type: 'exportEvents' });
    });
    await waitFor((): void => {
      expect(createObjectURL).toHaveBeenCalledTimes(1);
    });
  });
});

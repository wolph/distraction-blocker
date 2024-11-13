/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
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
    const { getByLabelText } = render(
      <PauseEconomy settings={DEFAULT_SETTINGS} onChange={onChange} />,
    );
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
    const { getByLabelText } = render(
      <PauseEconomy settings={DEFAULT_SETTINGS} onChange={onChange} />,
    );
    fireEvent.input(getByLabelText('Minutes of pause per 30 minutes of focus'), {
      target: { value: '-3' },
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('accepts zero as a legitimate pause earn rate', (): void => {
    const onChange = vi.fn();
    const { getByLabelText } = render(
      <PauseEconomy settings={DEFAULT_SETTINGS} onChange={onChange} />,
    );
    fireEvent.input(getByLabelText('Minutes of pause per 30 minutes of focus'), {
      target: { value: '0' },
    });
    const next: Settings = onChange.mock.calls[0]?.[0] as Settings;
    expect(next.pause.earnRatio).toBe(0);
  });

  it('rejects a fractional pause length with a field-specific error', (): void => {
    const onChange = vi.fn();
    const { getByLabelText, getByText } = render(
      <PauseEconomy settings={DEFAULT_SETTINGS} onChange={onChange} />,
    );
    fireEvent.input(getByLabelText('Pause length (minutes)'), { target: { value: '1.5' } });
    expect(onChange).not.toHaveBeenCalled();
    expect(getByText('Pause length (minutes) must be a positive whole number.')).toBeTruthy();
  });
});

describe('BehaviorDefaults', () => {
  it('switches the gate delay to 30 seconds', (): void => {
    const onChange = vi.fn();
    const { getByLabelText } = render(
      <BehaviorDefaults settings={DEFAULT_SETTINGS} onChange={onChange} />,
    );
    fireEvent.click(getByLabelText('Wait 30 seconds'));
    const next: Settings = onChange.mock.calls[0]?.[0] as Settings;
    expect(next.gate.delayMs).toBe(30_000);
  });

  it('rejects zero focus minutes with a field-specific error', (): void => {
    const onChange = vi.fn();
    const { getByLabelText, getByText } = render(
      <BehaviorDefaults settings={DEFAULT_SETTINGS} onChange={onChange} />,
    );
    fireEvent.input(getByLabelText('Focus minutes'), { target: { value: '0' } });
    expect(onChange).not.toHaveBeenCalled();
    expect(getByText('Focus minutes must be a positive whole number.')).toBeTruthy();
  });

  it('rejects a fractional long-break cadence with a field-specific error', (): void => {
    const onChange = vi.fn();
    const { getByLabelText, getByText } = render(
      <BehaviorDefaults settings={DEFAULT_SETTINGS} onChange={onChange} />,
    );
    fireEvent.input(getByLabelText('Long break every Nth cycle'), {
      target: { value: '2.5' },
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(getByText('Long break every Nth cycle must be a positive whole number.')).toBeTruthy();
  });
});

describe('SoundsBadge', () => {
  it('sends previewSound for the play button', (): void => {
    const onChange = vi.fn();
    const { getByRole } = render(<SoundsBadge settings={DEFAULT_SETTINGS} onChange={onChange} />);
    fireEvent.click(getByRole('button', { name: 'Preview Session complete' }));
    expect(fake.sent).toContainEqual({ type: 'previewSound', sound: 'sessionComplete' });
  });

  it('maps the volume slider 0-100 to masterVolume 0-1', (): void => {
    const onChange = vi.fn();
    const { getByLabelText } = render(
      <SoundsBadge settings={DEFAULT_SETTINGS} onChange={onChange} />,
    );
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

    const { getByText, getByRole } = render(<Data />);
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

  it('shows a quiet error and does not download a malformed export response', async (): Promise<void> => {
    fake.respond('exportEvents', { ok: false, error: 'worker unavailable' });
    const createObjectURL = vi.fn((): string => 'blob:fake');
    Object.assign(URL, { createObjectURL });
    const { getByRole } = render(<Data />);
    fireEvent.click(getByRole('button', { name: 'Export event log' }));
    await waitFor((): void => {
      expect(getByRole('alert').textContent).toBe('Could not export the event log. Try again.');
    });
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('shows a quiet error when the export request rejects', async (): Promise<void> => {
    fake.respond('exportEvents', (): never => {
      throw new Error('worker unavailable');
    });
    const { getByRole } = render(<Data />);
    fireEvent.click(getByRole('button', { name: 'Export event log' }));
    await waitFor((): void => {
      expect(getByRole('alert').textContent).toBe('Could not export the event log. Try again.');
    });
  });
});

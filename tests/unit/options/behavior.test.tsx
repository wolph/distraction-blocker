/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
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
  it('edits the freeze token interval in calendar days', (): void => {
    const onChange: Mock<(next: Settings) => void> = vi.fn<(next: Settings) => void>();
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      streakFreezeIntervalDays: 7,
    };
    const { getByLabelText }: ReturnType<typeof render> = render(
      <PauseEconomy settings={settings} onChange={onChange} />,
    );

    fireEvent.input(getByLabelText('Freeze token interval (days)'), {
      target: { value: '10' },
    });

    const next: Settings = onChange.mock.calls[0]?.[0] as Settings;
    expect(next.streakFreezeIntervalDays).toBe(10);
  });

  it('accepts the exact upper freeze cadence boundary', (): void => {
    const onChange: Mock<(next: Settings) => void> = vi.fn<(next: Settings) => void>();
    const { getByLabelText }: ReturnType<typeof render> = render(
      <PauseEconomy settings={DEFAULT_SETTINGS} onChange={onChange} />,
    );
    const input: HTMLInputElement = getByLabelText(
      'Freeze token interval (days)',
    ) as HTMLInputElement;

    expect(input.max).toBe('100000000');
    fireEvent.input(input, { target: { value: '100000000' } });

    const next: Settings = onChange.mock.calls[0]?.[0] as Settings;
    expect(next.streakFreezeIntervalDays).toBe(100_000_000);
  });

  it.each([
    ['maximum safe integer days', String(Number.MAX_SAFE_INTEGER)],
    ['past the Date range', '100000001'],
  ])('rejects %s for the freeze cadence', (_label: string, value: string): void => {
    const onChange: Mock<(next: Settings) => void> = vi.fn<(next: Settings) => void>();
    const { getByLabelText, getByText }: ReturnType<typeof render> = render(
      <PauseEconomy settings={DEFAULT_SETTINGS} onChange={onChange} />,
    );

    fireEvent.input(getByLabelText('Freeze token interval (days)'), { target: { value } });

    expect(onChange).not.toHaveBeenCalled();
    expect(
      getByText('Freeze token interval (days) must be within the supported day range.'),
    ).toBeTruthy();
  });

  it('accepts the exact upper retention boundary', (): void => {
    const onChange: Mock<(next: Settings) => void> = vi.fn<(next: Settings) => void>();
    const { getByLabelText }: ReturnType<typeof render> = render(
      <PauseEconomy settings={DEFAULT_SETTINGS} onChange={onChange} />,
    );
    const input: HTMLInputElement = getByLabelText('Keep daily stats (days)') as HTMLInputElement;

    expect(input.max).toBe('100000000');
    fireEvent.input(input, { target: { value: '100000000' } });

    const next: Settings = onChange.mock.calls[0]?.[0] as Settings;
    expect(next.retentionDays).toBe(100_000_000);
  });

  it.each([['0'], ['1.5'], [String(Number.MAX_SAFE_INTEGER)], ['100000001']])(
    'rejects unsafe retention %s with a field-specific error',
    (value: string): void => {
      const onChange: Mock<(next: Settings) => void> = vi.fn<(next: Settings) => void>();
      const { getByLabelText, getByText }: ReturnType<typeof render> = render(
        <PauseEconomy settings={DEFAULT_SETTINGS} onChange={onChange} />,
      );

      fireEvent.input(getByLabelText('Keep daily stats (days)'), { target: { value } });

      expect(onChange).not.toHaveBeenCalled();
      expect(
        getByText('Keep daily stats (days) must be within the supported day range.'),
      ).toBeTruthy();
    },
  );

  it('maps the earn-rate input to earnRatio = value / 30', (): void => {
    const onChange: Mock<(next: Settings) => void> = vi.fn<(next: Settings) => void>();
    const { getByLabelText }: ReturnType<typeof render> = render(
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
    const onChange: Mock<(next: Settings) => void> = vi.fn<(next: Settings) => void>();
    const { getByLabelText }: ReturnType<typeof render> = render(
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
    const onChange: Mock<(next: Settings) => void> = vi.fn<(next: Settings) => void>();
    const { getByLabelText, getByText }: ReturnType<typeof render> = render(
      <PauseEconomy settings={DEFAULT_SETTINGS} onChange={onChange} />,
    );
    fireEvent.input(getByLabelText('Pause length (minutes)'), { target: { value: '1.5' } });
    expect(onChange).not.toHaveBeenCalled();
    expect(getByText('Pause length (minutes) must be a positive whole number.')).toBeTruthy();
  });
});

describe('BehaviorDefaults', () => {
  it('edits each positive session preset independently', (): void => {
    const onChange: Mock<(next: Settings) => void> = vi.fn<(next: Settings) => void>();
    const { getByLabelText }: ReturnType<typeof render> = render(
      <BehaviorDefaults settings={DEFAULT_SETTINGS} onChange={onChange} />,
    );

    fireEvent.input(getByLabelText('Short session preset (minutes)'), {
      target: { value: '10' },
    });
    fireEvent.input(getByLabelText('Default session preset (minutes)'), {
      target: { value: '35' },
    });
    fireEvent.input(getByLabelText('Deep session preset (minutes)'), {
      target: { value: '75' },
    });

    const shortPreset: Settings = onChange.mock.calls[0]?.[0] as Settings;
    const defaultPreset: Settings = onChange.mock.calls[1]?.[0] as Settings;
    const deepPreset: Settings = onChange.mock.calls[2]?.[0] as Settings;
    expect(shortPreset.presetsMin).toEqual([10, 25, 50]);
    expect(defaultPreset.presetsMin).toEqual([15, 35, 50]);
    expect(deepPreset.presetsMin).toEqual([15, 25, 75]);
  });

  it('accepts positive fractional session presets', (): void => {
    const onChange: Mock<(next: Settings) => void> = vi.fn<(next: Settings) => void>();
    const { getByLabelText }: ReturnType<typeof render> = render(
      <BehaviorDefaults settings={DEFAULT_SETTINGS} onChange={onChange} />,
    );

    fireEvent.input(getByLabelText('Short session preset (minutes)'), {
      target: { value: '0.1' },
    });

    const next: Settings = onChange.mock.calls[0]?.[0] as Settings;
    expect(next.presetsMin).toEqual([0.1, 25, 50]);
  });

  it('accepts the exact upper session preset boundary', (): void => {
    const onChange: Mock<(next: Settings) => void> = vi.fn<(next: Settings) => void>();
    const { getByLabelText }: ReturnType<typeof render> = render(
      <BehaviorDefaults settings={DEFAULT_SETTINGS} onChange={onChange} />,
    );
    const input: HTMLInputElement = getByLabelText(
      'Short session preset (minutes)',
    ) as HTMLInputElement;

    expect(input.max).toBe('72000000000');
    fireEvent.input(input, { target: { value: '72000000000' } });

    const next: Settings = onChange.mock.calls[0]?.[0] as Settings;
    expect(next.presetsMin).toEqual([72_000_000_000, 25, 50]);
  });

  it.each([
    ['sub-millisecond', '0.000001'],
    ['maximum safe integer', String(Number.MAX_SAFE_INTEGER)],
    ['past the relative-duration cap', '72000000001'],
  ])('rejects a %s session preset', (_label: string, value: string): void => {
    const onChange: Mock<(next: Settings) => void> = vi.fn<(next: Settings) => void>();
    const { getByLabelText, getByText }: ReturnType<typeof render> = render(
      <BehaviorDefaults settings={DEFAULT_SETTINGS} onChange={onChange} />,
    );

    fireEvent.input(getByLabelText('Short session preset (minutes)'), { target: { value } });

    expect(onChange).not.toHaveBeenCalled();
    expect(
      getByText('Short session preset (minutes) must be within the supported minute range.'),
    ).toBeTruthy();
  });

  it('rejects a zero session preset with a field-specific error', (): void => {
    const onChange: Mock<(next: Settings) => void> = vi.fn<(next: Settings) => void>();
    const { getByLabelText, getByText }: ReturnType<typeof render> = render(
      <BehaviorDefaults settings={DEFAULT_SETTINGS} onChange={onChange} />,
    );

    fireEvent.input(getByLabelText('Short session preset (minutes)'), {
      target: { value: '0' },
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(
      getByText('Short session preset (minutes) must be within the supported minute range.'),
    ).toBeTruthy();
  });

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
  it('toggles the session-complete system notification independently of sounds', (): void => {
    const onChange: Mock<(next: Settings) => void> = vi.fn<(next: Settings) => void>();
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      sessionCompleteNotification: true,
    };
    const { getByLabelText }: ReturnType<typeof render> = render(
      <SoundsBadge settings={settings} onChange={onChange} />,
    );

    fireEvent.click(getByLabelText('Show a system notification when a session completes'));

    const next: Settings = onChange.mock.calls[0]?.[0] as Settings;
    expect(next.sessionCompleteNotification).toBe(false);
    expect(next.sounds).toEqual(DEFAULT_SETTINGS.sounds);
  });

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
  it('settles rejected device id loading with readable feedback', async (): Promise<void> => {
    fake.storageGet.mockRejectedValue(new Error('storage unavailable'));
    const { getByRole, queryByText } = render(<Data />);

    await waitFor((): void => {
      expect(getByRole('alert').textContent).toBe(
        'Could not load this device id. Reload the page to try again.',
      );
    });
    expect(queryByText('Loading device id.')).toBeNull();
  });

  it('shows the local device id and exports the event log', async (): Promise<void> => {
    const createObjectURL = vi.fn((): string => 'blob:fake');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation((): void => {});

    const { getByText, getByRole } = render(<Data />);
    await waitFor((): void => {
      expect(getByText('123e4567-e89b-42d3-a456-426614174000')).toBeTruthy();
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

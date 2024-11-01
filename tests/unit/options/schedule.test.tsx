/** @vitest-environment jsdom */
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Schedule } from '../../../src/options/Schedule';
import { DEFAULT_SETTINGS } from '../../../src/shared/constants';
import type { ScheduleEntry } from '../../../src/shared/types';

vi.mock('../../../src/core/schedule', () => ({
  // Stand-in for plan 02's validator: same contract, minimal checks.
  validateEntry: (entry: ScheduleEntry): string | null => {
    if (entry.days.length === 0) return 'pick at least one day';
    if (entry.end <= entry.start) return 'end must be after start';
    return null;
  },
}));

afterEach((): void => {
  cleanup();
});

function existingEntry(): ScheduleEntry {
  return {
    id: 'entry-1',
    days: [1, 2, 3],
    start: '09:00',
    end: '12:30',
    mode: 'blacklist',
    strictness: 'hard',
    cycling: null,
    intention: 'morning deep work',
    enabled: true,
  };
}

describe('Schedule', () => {
  it('creates an entry with the defaults: weekdays, 09:00 to 12:00', (): void => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <Schedule entries={[]} defaults={DEFAULT_SETTINGS} onChange={onChange} />,
    );
    fireEvent.click(getByRole('button', { name: 'Add schedule entry' }));
    fireEvent.click(getByRole('button', { name: 'Save entry' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next: ScheduleEntry[] = onChange.mock.calls[0]?.[0] as ScheduleEntry[];
    expect(next).toHaveLength(1);
    const entry: ScheduleEntry = next[0] as ScheduleEntry;
    expect(entry.days).toEqual([1, 2, 3, 4, 5]);
    expect(entry.start).toBe('09:00');
    expect(entry.end).toBe('12:00');
    expect(entry.mode).toBe(DEFAULT_SETTINGS.defaultMode);
    expect(entry.strictness).toBe(DEFAULT_SETTINGS.defaultStrictness);
    expect(entry.cycling).toEqual(DEFAULT_SETTINGS.defaultCycling);
    expect(entry.enabled).toBe(true);
    expect(entry.id.length).toBeGreaterThan(0);
  });

  it('shows the validation error inline for inverted times and never calls onChange', (): void => {
    const onChange = vi.fn();
    const { getByRole, getByLabelText, getByText } = render(
      <Schedule entries={[]} defaults={DEFAULT_SETTINGS} onChange={onChange} />,
    );
    fireEvent.click(getByRole('button', { name: 'Add schedule entry' }));
    fireEvent.input(getByLabelText('End'), { target: { value: '08:00' } });
    fireEvent.click(getByRole('button', { name: 'Save entry' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(getByText('end must be after start')).toBeTruthy();
  });

  it('toggles an entry enabled state in place', (): void => {
    const onChange = vi.fn();
    const { getByLabelText } = render(
      <Schedule entries={[existingEntry()]} defaults={DEFAULT_SETTINGS} onChange={onChange} />,
    );
    fireEvent.click(getByLabelText('Enabled'));
    const next: ScheduleEntry[] = onChange.mock.calls[0]?.[0] as ScheduleEntry[];
    expect(next[0]?.enabled).toBe(false);
  });

  it('deletes an entry', (): void => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <Schedule entries={[existingEntry()]} defaults={DEFAULT_SETTINGS} onChange={onChange} />,
    );
    fireEvent.click(getByRole('button', { name: 'Delete' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('edits an existing entry through the form', (): void => {
    const onChange = vi.fn();
    const { getByRole, getByLabelText } = render(
      <Schedule entries={[existingEntry()]} defaults={DEFAULT_SETTINGS} onChange={onChange} />,
    );
    fireEvent.click(getByRole('button', { name: 'Edit' }));
    fireEvent.input(getByLabelText('Intention'), { target: { value: 'write the report' } });
    fireEvent.click(getByRole('button', { name: 'Save entry' }));
    const next: ScheduleEntry[] = onChange.mock.calls[0]?.[0] as ScheduleEntry[];
    expect(next).toHaveLength(1);
    expect(next[0]?.intention).toBe('write the report');
    expect(next[0]?.id).toBe('entry-1');
  });
});

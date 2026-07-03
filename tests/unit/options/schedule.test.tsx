/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import { Schedule } from '../../../src/options/Schedule';
import { DEFAULT_SETTINGS } from '../../../src/shared/constants';
import { isScheduleEntryV2 } from '../../../src/shared/runtime-validation';
import {
  HARD_UNAVAILABLE_REASON,
  SCHEDULE_UNTIL_STOPPED_COPY,
  SCHEDULE_WINDOW_LABEL,
  UNTIL_STOPPED_DISCLOSURE,
  UNTIL_STOPPED_LABEL,
} from '../../../src/shared/session-copy';
import type { ScheduleEntryV2, SettingsV2 } from '../../../src/shared/types';

const DEFAULTS: SettingsV2 = { ...DEFAULT_SETTINGS, schedule: [] };
const FORCED_CYCLES_LABEL: string = 'Cycles forced by Until stopped';

function windowEntry(): ScheduleEntryV2 {
  return {
    id: 'entry-1',
    days: [1, 2, 3],
    start: '09:00',
    end: '12:30',
    duration: { kind: 'window' },
    mode: 'blacklist',
    strictness: 'friction',
    cycling: null,
    intention: 'morning deep work',
    enabled: true,
  };
}

function indefiniteEntry(): ScheduleEntryV2 {
  return {
    ...windowEntry(),
    id: 'entry-2',
    duration: { kind: 'until-stopped' },
    strictness: 'flexible',
    cycling: null,
  };
}

function savedEntries(onChange: Mock): ScheduleEntryV2[] {
  return (onChange.mock.calls[0]?.[0] ?? []) as ScheduleEntryV2[];
}

afterEach((): void => {
  cleanup();
});

describe('Schedule duration choices', (): void => {
  it('offers exactly two duration choices', (): void => {
    const view = render(<Schedule entries={[]} defaults={DEFAULTS} onChange={vi.fn()} />);

    fireEvent.click(view.getByRole('button', { name: 'Add schedule entry' }));

    const group: HTMLElement = view.getByRole('group', { name: 'Duration' });
    const choices: HTMLElement[] = within(group).getAllByRole('radio');
    expect(choices).toHaveLength(2);
    expect(view.getByRole('radio', { name: SCHEDULE_WINDOW_LABEL })).toBeTruthy();
    expect(view.getByRole('radio', { name: UNTIL_STOPPED_LABEL })).toBeTruthy();
    expect(
      (view.getByRole('radio', { name: SCHEDULE_WINDOW_LABEL }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it('keeps the entry type, disables Hard with its reason, and forces no cycles when indefinite', (): void => {
    const onChange: Mock = vi.fn();
    const view = render(<Schedule entries={[]} defaults={DEFAULTS} onChange={onChange} />);

    fireEvent.click(view.getByRole('button', { name: 'Add schedule entry' }));
    fireEvent.click(view.getByRole('radio', { name: UNTIL_STOPPED_LABEL }));

    const friction: HTMLInputElement = view.getByRole('radio', {
      name: /Friction/,
    }) as HTMLInputElement;
    const hard: HTMLInputElement = view.getByRole('radio', { name: /Hard/ }) as HTMLInputElement;
    expect(friction.checked).toBe(true);
    expect(friction.disabled).toBe(false);
    expect(friction.closest('.forced-control')).toBeNull();
    expect(hard.disabled).toBe(true);
    expect(view.getByText(HARD_UNAVAILABLE_REASON)).toBeTruthy();
    expect(hard.getAttribute('aria-describedby')).toBe(view.getByText(HARD_UNAVAILABLE_REASON).id);

    const forcedCycles: HTMLElement = view.getByRole('group', { name: FORCED_CYCLES_LABEL });
    const cycles: HTMLInputElement = view.getByRole('checkbox', {
      name: /Cycle focus and breaks/,
    }) as HTMLInputElement;
    expect(forcedCycles.getAttribute('aria-disabled')).toBe('true');
    expect(forcedCycles.contains(cycles)).toBe(true);
    expect(cycles.checked).toBe(false);

    expect(view.getAllByText(SCHEDULE_UNTIL_STOPPED_COPY).length).toBeGreaterThan(0);

    fireEvent.click(view.getByRole('button', { name: 'Save entry' }));

    const saved: ScheduleEntryV2[] = savedEntries(onChange);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.duration).toEqual({ kind: 'until-stopped' });
    expect(saved[0]?.strictness).toBe(DEFAULTS.defaultStrictness);
    expect(saved[0]?.cycling).toBeNull();
    expect(isScheduleEntryV2(saved[0])).toBe(true);
  });

  it('accepts Flexible, refuses Hard and cycles, while the entry is indefinite', (): void => {
    const onChange: Mock = vi.fn();
    const view = render(<Schedule entries={[]} defaults={DEFAULTS} onChange={onChange} />);

    fireEvent.click(view.getByRole('button', { name: 'Add schedule entry' }));
    fireEvent.click(view.getByRole('radio', { name: UNTIL_STOPPED_LABEL }));
    fireEvent.click(view.getByRole('radio', { name: /Flexible/ }));
    fireEvent.click(view.getByRole('radio', { name: /Hard/ }));
    fireEvent.click(view.getByRole('checkbox', { name: /Cycle focus and breaks/ }));
    fireEvent.click(view.getByRole('button', { name: 'Save entry' }));

    const saved: ScheduleEntryV2[] = savedEntries(onChange);
    expect(saved[0]?.strictness).toBe('flexible');
    expect(saved[0]?.cycling).toBeNull();
    expect(isScheduleEntryV2(saved[0])).toBe(true);
  });

  it('clamps a Hard entry to Friction when it becomes indefinite and restores Hard for a window', (): void => {
    const onChange: Mock = vi.fn();
    const view = render(<Schedule entries={[]} defaults={DEFAULTS} onChange={onChange} />);

    fireEvent.click(view.getByRole('button', { name: 'Add schedule entry' }));
    fireEvent.click(view.getByRole('radio', { name: /Hard/ }));
    fireEvent.click(view.getByRole('radio', { name: UNTIL_STOPPED_LABEL }));

    expect((view.getByRole('radio', { name: /Friction/ }) as HTMLInputElement).checked).toBe(true);
    expect((view.getByRole('radio', { name: /Hard/ }) as HTMLInputElement).checked).toBe(false);

    fireEvent.click(view.getByRole('radio', { name: SCHEDULE_WINDOW_LABEL }));

    expect((view.getByRole('radio', { name: /Hard/ }) as HTMLInputElement).checked).toBe(true);
    expect((view.getByRole('radio', { name: /Hard/ }) as HTMLInputElement).disabled).toBe(false);
    expect(view.queryByText(HARD_UNAVAILABLE_REASON)).toBeNull();
  });

  it('keeps an indefinite entry away from Hard when the disabled radio is bypassed', (): void => {
    const onChange: Mock = vi.fn();
    const view = render(<Schedule entries={[]} defaults={DEFAULTS} onChange={onChange} />);

    fireEvent.click(view.getByRole('button', { name: 'Add schedule entry' }));
    fireEvent.click(view.getByRole('radio', { name: UNTIL_STOPPED_LABEL }));

    // Out of the form, so nothing stands between the synthetic click and the draft.
    const hard: HTMLElement = view.getByRole('radio', { name: /Hard/ });
    document.body.appendChild(hard);
    fireEvent.click(hard);
    fireEvent.click(view.getByRole('button', { name: 'Save entry' }));

    const saved: ScheduleEntryV2[] = savedEntries(onChange);
    expect(saved[0]?.duration).toEqual({ kind: 'until-stopped' });
    expect(saved[0]?.strictness).toBe(DEFAULTS.defaultStrictness);
    expect(saved[0]?.cycling).toBeNull();
    expect(isScheduleEntryV2(saved[0])).toBe(true);
    hard.remove();
  });

  it('keeps an indefinite entry cycle-free when the forced wrapper is bypassed', (): void => {
    const onChange: Mock = vi.fn();
    const view = render(<Schedule entries={[]} defaults={DEFAULTS} onChange={onChange} />);

    fireEvent.click(view.getByRole('button', { name: 'Add schedule entry' }));
    fireEvent.click(view.getByRole('radio', { name: UNTIL_STOPPED_LABEL }));

    const cycles: HTMLElement = view.getByRole('checkbox', { name: /Cycle focus and breaks/ });
    document.body.appendChild(cycles);
    fireEvent.click(cycles);
    cycles.remove();
    fireEvent.click(view.getByRole('button', { name: 'Save entry' }));

    const saved: ScheduleEntryV2[] = savedEntries(onChange);
    expect(saved[0]?.duration).toEqual({ kind: 'until-stopped' });
    expect(saved[0]?.cycling).toBeNull();
    expect(isScheduleEntryV2(saved[0])).toBe(true);
  });

  it('carries a type chosen while indefinite back to the window duration', (): void => {
    const onChange: Mock = vi.fn();
    const view = render(<Schedule entries={[]} defaults={DEFAULTS} onChange={onChange} />);

    fireEvent.click(view.getByRole('button', { name: 'Add schedule entry' }));
    fireEvent.click(view.getByRole('radio', { name: UNTIL_STOPPED_LABEL }));
    fireEvent.click(view.getByRole('radio', { name: /Flexible/ }));
    fireEvent.click(view.getByRole('radio', { name: SCHEDULE_WINDOW_LABEL }));
    fireEvent.click(view.getByRole('button', { name: 'Save entry' }));

    const saved: ScheduleEntryV2[] = savedEntries(onChange);
    expect(saved[0]?.duration).toEqual({ kind: 'window' });
    expect(saved[0]?.strictness).toBe('flexible');
    expect(isScheduleEntryV2(saved[0])).toBe(true);
  });

  it('restores the unsent timed draft when the duration toggles back', (): void => {
    const onChange: Mock = vi.fn();
    const view = render(<Schedule entries={[]} defaults={DEFAULTS} onChange={onChange} />);

    fireEvent.click(view.getByRole('button', { name: 'Add schedule entry' }));
    fireEvent.click(view.getByRole('radio', { name: /Hard/ }));
    fireEvent.click(view.getByRole('radio', { name: UNTIL_STOPPED_LABEL }));
    fireEvent.click(view.getByRole('radio', { name: SCHEDULE_WINDOW_LABEL }));

    expect((view.getByRole('radio', { name: /Hard/ }) as HTMLInputElement).checked).toBe(true);
    expect(
      (view.getByRole('checkbox', { name: /Cycle focus and breaks/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(view.queryByRole('group', { name: FORCED_CYCLES_LABEL })).toBeNull();
    expect(view.queryByText(SCHEDULE_UNTIL_STOPPED_COPY)).toBeNull();

    fireEvent.click(view.getByRole('button', { name: 'Save entry' }));

    const saved: ScheduleEntryV2[] = savedEntries(onChange);
    expect(saved[0]?.duration).toEqual({ kind: 'window' });
    expect(saved[0]?.strictness).toBe('hard');
    expect(saved[0]?.cycling).toEqual(DEFAULTS.defaultCycling);
    expect(isScheduleEntryV2(saved[0])).toBe(true);
  });

  it('keeps its own type and takes the default cycles when a saved indefinite entry becomes timed', (): void => {
    const onChange: Mock = vi.fn();
    const view = render(
      <Schedule entries={[indefiniteEntry()]} defaults={DEFAULTS} onChange={onChange} />,
    );

    fireEvent.click(view.getByRole('button', { name: 'Edit' }));
    expect((view.getByRole('radio', { name: /Flexible/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(view.getByRole('radio', { name: SCHEDULE_WINDOW_LABEL }));
    fireEvent.click(view.getByRole('button', { name: 'Save entry' }));

    const saved: ScheduleEntryV2[] = savedEntries(onChange);
    expect(saved[0]?.strictness).toBe('flexible');
    expect(saved[0]?.cycling).toEqual(DEFAULTS.defaultCycling);
  });

  it('honours cyclingOnByDefault when a saved indefinite entry becomes timed', (): void => {
    const defaults: SettingsV2 = { ...DEFAULTS, cyclingOnByDefault: false };
    const onChange: Mock = vi.fn();
    const view = render(
      <Schedule entries={[indefiniteEntry()]} defaults={defaults} onChange={onChange} />,
    );

    fireEvent.click(view.getByRole('button', { name: 'Edit' }));
    fireEvent.click(view.getByRole('radio', { name: SCHEDULE_WINDOW_LABEL }));
    fireEvent.click(view.getByRole('button', { name: 'Save entry' }));

    expect(savedEntries(onChange)[0]?.cycling).toBeNull();
  });

  it('explains the forced values through the shared disclosure', (): void => {
    const view = render(<Schedule entries={[]} defaults={DEFAULTS} onChange={vi.fn()} />);

    fireEvent.click(view.getByRole('button', { name: 'Add schedule entry' }));
    fireEvent.click(view.getByRole('radio', { name: UNTIL_STOPPED_LABEL }));
    fireEvent.pointerEnter(view.getByRole('group', { name: FORCED_CYCLES_LABEL }));

    expect(view.getByRole('tooltip').textContent).toContain(UNTIL_STOPPED_DISCLOSURE);
  });
});

describe('Schedule rows and validation', (): void => {
  it('creates a window entry from the settings defaults', (): void => {
    const onChange: Mock = vi.fn();
    const view = render(<Schedule entries={[]} defaults={DEFAULTS} onChange={onChange} />);

    fireEvent.click(view.getByRole('button', { name: 'Add schedule entry' }));
    fireEvent.click(view.getByRole('button', { name: 'Save entry' }));

    const saved: ScheduleEntryV2[] = savedEntries(onChange);
    expect(saved[0]?.duration).toEqual({ kind: 'window' });
    expect(saved[0]?.days).toEqual([1, 2, 3, 4, 5]);
    expect(saved[0]?.start).toBe('09:00');
    expect(saved[0]?.end).toBe('12:00');
    expect(saved[0]?.strictness).toBe(DEFAULTS.defaultStrictness);
    expect(saved[0]?.cycling).toEqual(DEFAULTS.defaultCycling);
  });

  it('renders the schedule copy on an indefinite row only', (): void => {
    const view = render(
      <Schedule
        entries={[windowEntry(), indefiniteEntry()]}
        defaults={DEFAULTS}
        onChange={vi.fn()}
      />,
    );

    expect(view.getAllByText(SCHEDULE_UNTIL_STOPPED_COPY)).toHaveLength(1);
    expect(view.getAllByText(SCHEDULE_WINDOW_LABEL)).toHaveLength(1);
  });

  it('keeps validateEntry gating every save', (): void => {
    const onChange: Mock = vi.fn();
    const view = render(<Schedule entries={[]} defaults={DEFAULTS} onChange={onChange} />);

    fireEvent.click(view.getByRole('button', { name: 'Add schedule entry' }));
    fireEvent.input(view.getByLabelText('End'), { target: { value: '08:00' } });
    fireEvent.click(view.getByRole('button', { name: 'Save entry' }));

    expect(onChange).not.toHaveBeenCalled();
    expect(view.getByText('start must be before end')).toBeTruthy();
  });

  it('keeps the overlap check gating every save', (): void => {
    const onChange: Mock = vi.fn();
    const view = render(
      <Schedule entries={[windowEntry()]} defaults={DEFAULTS} onChange={onChange} />,
    );

    fireEvent.click(view.getByRole('button', { name: 'Add schedule entry' }));
    fireEvent.input(view.getByLabelText('Start'), { target: { value: '12:00' } });
    fireEvent.input(view.getByLabelText('End'), { target: { value: '13:00' } });
    fireEvent.click(view.getByRole('button', { name: 'Save entry' }));

    expect(onChange).not.toHaveBeenCalled();
    expect(view.getByText('Overlaps another enabled entry on Mon.')).toBeTruthy();
  });

  it('rejects enabling an entry that overlaps another enabled entry', (): void => {
    const onChange: Mock = vi.fn();
    const disabled: ScheduleEntryV2 = {
      ...windowEntry(),
      id: 'entry-3',
      days: [1],
      start: '12:00',
      end: '13:00',
      enabled: false,
    };
    const view = render(
      <Schedule entries={[windowEntry(), disabled]} defaults={DEFAULTS} onChange={onChange} />,
    );
    const toggles: HTMLInputElement[] = view.getAllByLabelText('Enabled') as HTMLInputElement[];
    const refused: HTMLInputElement | undefined = toggles[1];
    if (refused === undefined) throw new Error('the second entry row was not rendered');

    fireEvent.click(refused);

    expect(onChange).not.toHaveBeenCalled();
    expect(view.getByRole('alert').textContent).toBe('Overlaps another enabled entry on Mon.');
    // A refused toggle must not leave the browser's flip on screen.
    expect(refused.checked).toBe(false);
  });

  it('edits, toggles, and deletes saved entries in place', (): void => {
    const onChange: Mock = vi.fn();
    const view = render(
      <Schedule entries={[indefiniteEntry()]} defaults={DEFAULTS} onChange={onChange} />,
    );

    fireEvent.click(view.getByLabelText('Enabled'));
    expect(savedEntries(onChange)[0]?.enabled).toBe(false);
    onChange.mockReset();

    fireEvent.click(view.getByRole('button', { name: 'Delete' }));
    expect(onChange).toHaveBeenCalledWith([]);
    onChange.mockReset();

    fireEvent.click(view.getByRole('button', { name: 'Edit' }));
    fireEvent.input(view.getByLabelText('Intention'), { target: { value: 'write the report' } });
    fireEvent.click(view.getByRole('button', { name: 'Save entry' }));

    const saved: ScheduleEntryV2[] = savedEntries(onChange);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.id).toBe('entry-2');
    expect(saved[0]?.intention).toBe('write the report');
    expect(saved[0]?.duration).toEqual({ kind: 'until-stopped' });
  });

  it('carries the schedule duration styles in the Options stylesheet', (): void => {
    const view = render(<Schedule entries={[]} defaults={DEFAULTS} onChange={vi.fn()} />);
    fireEvent.click(view.getByRole('button', { name: 'Add schedule entry' }));
    expect(
      view.getByRole('group', { name: 'Duration' }).classList.contains('schedule-duration'),
    ).toBe(true);
    fireEvent.click(view.getByRole('radio', { name: UNTIL_STOPPED_LABEL }));
    expect(
      view.getByText(SCHEDULE_UNTIL_STOPPED_COPY).classList.contains('schedule-duration-note'),
    ).toBe(true);

    const css: string = readFileSync(resolve('src/options/options.css'), 'utf8');

    expect(css).toMatch(/\.schedule-duration\s*\{/s);
    expect(css).toMatch(/\.schedule-duration-note\s*\{/s);
  });
});

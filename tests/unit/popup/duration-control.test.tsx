/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import './chrome-fake';

import { cleanup, fireEvent, render, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import { DurationControl } from '../../../src/popup/DurationControl';
import type { DraftDuration } from '../../../src/popup/start-draft';
import { UNTIL_STOPPED_LABEL } from '../../../src/shared/session-copy';

const PRESETS: readonly [number, number, number] = [15, 25, 50];

function timed(presetMin: number | null, customMin: string): DraftDuration {
  return { kind: 'timed', presetMin, customMin };
}

function untilStopped(presetMin: number | null, customMin: string): DraftDuration {
  return { kind: 'until-stopped', timed: { presetMin, customMin } };
}

afterEach((): void => {
  cleanup();
});

describe('DurationControl', (): void => {
  it('renders the presets, the custom input, and Until stopped in one Session length group', (): void => {
    const onChange: Mock = vi.fn();
    const view = render(
      <DurationControl presets={PRESETS} value={timed(25, '')} onChange={onChange} />,
    );

    const group: HTMLElement = view.getByRole('group', { name: 'Session length' });
    const chips: HTMLElement[] = within(group).getAllByRole('button');
    expect(chips.map((chip: HTMLElement): string | null => chip.textContent)).toEqual([
      '15 short',
      '25 focus',
      '50 deep work (preference, not science)',
      UNTIL_STOPPED_LABEL,
    ]);
    const custom: HTMLInputElement = within(group).getByLabelText(
      'Custom minutes',
    ) as HTMLInputElement;
    expect(custom.type).toBe('number');
  });

  it('emits the clicked preset and clears typed custom minutes', (): void => {
    const onChange: Mock = vi.fn();
    const view = render(
      <DurationControl presets={PRESETS} value={timed(25, '42')} onChange={onChange} />,
    );

    fireEvent.click(view.getByRole('button', { name: '50 deep work (preference, not science)' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ kind: 'timed', presetMin: 50, customMin: '' });
  });

  it('emits the timed duration with the typed custom minutes', (): void => {
    const onChange: Mock = vi.fn();
    const view = render(
      <DurationControl presets={PRESETS} value={timed(25, '')} onChange={onChange} />,
    );

    fireEvent.input(view.getByLabelText('Custom minutes'), { target: { value: '42' } });

    expect(onChange).toHaveBeenCalledWith({ kind: 'timed', presetMin: 25, customMin: '42' });
  });

  it('types custom minutes onto the timed duration stored behind Until stopped', (): void => {
    const onChange: Mock = vi.fn();
    const view = render(
      <DurationControl presets={PRESETS} value={untilStopped(15, '')} onChange={onChange} />,
    );

    fireEvent.input(view.getByLabelText('Custom minutes'), { target: { value: '9' } });

    expect(onChange).toHaveBeenCalledWith({ kind: 'timed', presetMin: 15, customMin: '9' });
  });

  it('carries the current timed duration into Until stopped', (): void => {
    const onChange: Mock = vi.fn();
    const view = render(
      <DurationControl presets={PRESETS} value={timed(25, '42')} onChange={onChange} />,
    );

    fireEvent.click(view.getByRole('button', { name: UNTIL_STOPPED_LABEL }));

    expect(onChange).toHaveBeenCalledWith({
      kind: 'until-stopped',
      timed: { presetMin: 25, customMin: '42' },
    });
  });

  it('hands the stored timed duration back when the pressed chip is clicked', (): void => {
    const onChange: Mock = vi.fn();
    const view = render(
      <DurationControl presets={PRESETS} value={untilStopped(15, '7')} onChange={onChange} />,
    );

    fireEvent.click(view.getByRole('button', { name: UNTIL_STOPPED_LABEL }));

    expect(onChange).toHaveBeenCalledWith({ kind: 'timed', presetMin: 15, customMin: '7' });
  });

  it('presses Until stopped alone and keeps showing the stored custom minutes', (): void => {
    const onChange: Mock = vi.fn();
    const view = render(
      <DurationControl presets={PRESETS} value={untilStopped(25, '42')} onChange={onChange} />,
    );

    const group: HTMLElement = view.getByRole('group', { name: 'Session length' });
    const pressed: (string | null)[] = within(group)
      .getAllByRole('button')
      .map((chip: HTMLElement): string | null => chip.getAttribute('aria-pressed'));
    expect(pressed).toEqual(['false', 'false', 'false', 'true']);
    expect((view.getByLabelText('Custom minutes') as HTMLInputElement).value).toBe('42');
  });

  it('shows an empty custom field when Until stopped stores no typed minutes', (): void => {
    const onChange: Mock = vi.fn();
    const view = render(
      <DurationControl presets={PRESETS} value={untilStopped(25, '')} onChange={onChange} />,
    );

    expect((view.getByLabelText('Custom minutes') as HTMLInputElement).value).toBe('');

    fireEvent.click(view.getByRole('button', { name: UNTIL_STOPPED_LABEL }));

    expect(onChange).toHaveBeenCalledWith({ kind: 'timed', presetMin: 25, customMin: '' });
  });

  it('presses no preset while custom minutes are typed', (): void => {
    const onChange: Mock = vi.fn();
    const view = render(
      <DurationControl presets={PRESETS} value={timed(25, '42')} onChange={onChange} />,
    );

    expect(view.getByRole('button', { name: '25 focus' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(
      view.getByRole('button', { name: UNTIL_STOPPED_LABEL }).getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('lays the integrated duration row out as one wrapping chip row', (): void => {
    const css: string = readFileSync(resolve('src/popup/popup.css'), 'utf8');

    expect(css).toMatch(/\.duration-control[^{]*\{[^}]*display:\s*flex/s);
    expect(css).toMatch(/\.duration-control[^{]*\{[^}]*flex-wrap:\s*wrap/s);
  });
});

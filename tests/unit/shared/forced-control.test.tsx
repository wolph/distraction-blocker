/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import type { VNode } from 'preact';
import { afterEach, describe, expect, it, type Mock, type MockInstance, vi } from 'vitest';
import { SessionTypeControl } from '../../../src/popup/SessionTypeControl';
import { ForcedControl } from '../../../src/shared/ForcedControl';
import { HelpPopover } from '../../../src/shared/HelpPopover';
import { UNTIL_STOPPED_DISCLOSURE } from '../../../src/shared/session-copy';
import type { Strictness } from '../../../src/shared/types';

const GROUP_LABEL: string = 'Session type';
const FRICTION_CONSEQUENCE: string = 'Ending early requires a 10-second wait.';
const OUTSIDE_HELP_LABEL: string = 'Unrelated help';
const OUTSIDE_HELP_TEXT: string = 'This popover lives outside the forced control.';

function forcedChoice(onClick: () => void): VNode {
  return (
    <ForcedControl label={GROUP_LABEL} explanation={UNTIL_STOPPED_DISCLOSURE}>
      <button type="button" onClick={onClick}>
        Flexible
      </button>
    </ForcedControl>
  );
}

/** The shape the schedule editor renders: live radios with no help of their own. */
function forcedRadios(): VNode {
  return (
    <ForcedControl label={GROUP_LABEL} explanation={UNTIL_STOPPED_DISCLOSURE}>
      <fieldset>
        <legend>Session type</legend>
        <label>
          <input type="radio" name="strictness" value="flexible" checked />
          Flexible
        </label>
        <label>
          <input type="radio" name="strictness" value="friction" />
          Friction
        </label>
        <label>
          <input type="checkbox" name="cycling" />
          Run cycles
        </label>
      </fieldset>
    </ForcedControl>
  );
}

/**
 * SessionTypeControl fuses each choice's help trigger with its value button, so it is the
 * hostile composition for a forced wrapper: the disclosure must open, the value must not.
 */
function forcedSessionType(onChange: (value: Strictness) => void): VNode {
  return (
    <ForcedControl label={GROUP_LABEL} explanation={UNTIL_STOPPED_DISCLOSURE}>
      <SessionTypeControl
        value="flexible"
        frictionDelayMs={10_000}
        requireTypedPhrase={false}
        onChange={onChange}
      />
    </ForcedControl>
  );
}

afterEach((): void => {
  vi.useRealTimers();
  cleanup();
});

describe('ForcedControl', (): void => {
  it('exposes a focusable aria-disabled group described by the explanation', (): void => {
    const onClick: Mock = vi.fn();
    const view = render(forcedChoice(onClick));

    const group: HTMLElement = view.getByRole('group', { name: GROUP_LABEL });
    expect(group.tagName).toBe('DIV');
    expect(group.getAttribute('aria-disabled')).toBe('true');
    expect(group.tabIndex).toBe(0);

    const describedBy: string = group.getAttribute('aria-describedby') ?? '';
    expect(describedBy).not.toBe('');
    expect(document.getElementById(describedBy)?.textContent).toBe(UNTIL_STOPPED_DISCLOSURE);
  });

  it('announces every forced child as disabled and takes it out of the tab order', (): void => {
    // ARIA does not inherit `aria-disabled` from the group, so without this a screen reader
    // reads a live radio, the person presses Space, and nothing happens or is said.
    const view = render(forcedRadios());

    const controls: HTMLInputElement[] = [...view.container.querySelectorAll('input')];
    expect(controls).toHaveLength(3);
    for (const control of controls) {
      expect(control.getAttribute('aria-disabled')).toBe('true');
      expect(control.tabIndex).toBe(-1);
    }
  });

  it('keeps a value button that is also its own help trigger focusable', (): void => {
    // Spec 1711's other permitted shape. This button opens the per-choice explanation, so
    // removing its tab stop would take that explanation off the keyboard path entirely.
    const onChange: Mock = vi.fn();
    const view = render(forcedSessionType(onChange));

    const triggers: HTMLButtonElement[] = [
      ...view.container.querySelectorAll<HTMLButtonElement>(
        '.forced-control__body .help-popover__trigger',
      ),
    ];
    expect(triggers.length).toBeGreaterThan(0);
    for (const trigger of triggers) {
      expect(trigger.getAttribute('aria-disabled')).toBe('true');
      expect(trigger.tabIndex).toBe(0);
    }

    // The wrapper's own help is the one control in here that is not forced, so it must not be
    // announced as disabled: it is how the person finds out why the rest refuses.
    const groupHelp: HTMLButtonElement = view.container.querySelector(
      '.forced-control__help .help-popover__trigger',
    ) as HTMLButtonElement;
    expect(groupHelp.getAttribute('aria-disabled')).toBeNull();
    expect(groupHelp.tabIndex).toBe(0);
  });

  it('never renders a native disabled attribute', (): void => {
    const onClick: Mock = vi.fn();
    const view = render(forcedChoice(onClick));

    expect(view.container.querySelectorAll('[disabled]')).toHaveLength(0);
  });

  it('discloses the explanation on hover and hides it again when the pointer leaves', (): void => {
    vi.useFakeTimers();
    const onClick: Mock = vi.fn();
    const view = render(forcedChoice(onClick));
    const group: HTMLElement = view.getByRole('group', { name: GROUP_LABEL });

    fireEvent.pointerEnter(group);
    expect(view.getByRole('tooltip').textContent).toContain(UNTIL_STOPPED_DISCLOSURE);

    fireEvent.pointerLeave(group);
    act((): void => {
      vi.advanceTimersByTime(150);
    });
    expect(view.queryByRole('tooltip')).toBeNull();
  });

  it('discloses the explanation when keyboard focus reaches the group', async (): Promise<void> => {
    const onClick: Mock = vi.fn();
    const view = render(forcedChoice(onClick));
    const group: HTMLElement = view.getByRole('group', { name: GROUP_LABEL });

    group.focus();

    expect(document.activeElement).toBe(group);
    const tooltip: HTMLElement = await view.findByRole('tooltip');
    expect(tooltip.textContent).toContain(UNTIL_STOPPED_DISCLOSURE);
  });

  it('opens the help popover on click while preventing the child value change', (): void => {
    const onClick: Mock = vi.fn();
    const view = render(forcedChoice(onClick));
    const child: HTMLElement = view.getByRole('button', { name: 'Flexible' });
    const click: MouseEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    const stopPropagation: MockInstance<() => void> = vi.spyOn(click, 'stopPropagation');

    fireEvent(child, click);

    expect(onClick).not.toHaveBeenCalled();
    expect(click.defaultPrevented).toBe(true);
    expect(stopPropagation).toHaveBeenCalled();
    expect(view.getByRole('tooltip').textContent).toContain(UNTIL_STOPPED_DISCLOSURE);
  });

  it('opens the help popover on Enter', (): void => {
    const onClick: Mock = vi.fn();
    const view = render(forcedChoice(onClick));
    const group: HTMLElement = view.getByRole('group', { name: GROUP_LABEL });

    fireEvent.keyDown(group, { key: 'Enter' });

    expect(onClick).not.toHaveBeenCalled();
    expect(view.getByRole('tooltip').textContent).toContain(UNTIL_STOPPED_DISCLOSURE);
  });

  it('never invokes a hostile child handler that throws on click', (): void => {
    const hostile: Mock = vi.fn((): never => {
      throw new Error('forced child must never run');
    });
    const view = render(
      <ForcedControl label={GROUP_LABEL} explanation={UNTIL_STOPPED_DISCLOSURE}>
        <button type="button" onClick={(): void => hostile()}>
          Hard lock
        </button>
      </ForcedControl>,
    );

    fireEvent.click(view.getByRole('button', { name: 'Hard lock' }));

    expect(hostile).not.toHaveBeenCalled();
  });

  it('keeps the help trigger itself interactive', (): void => {
    const onClick: Mock = vi.fn();
    const view = render(forcedChoice(onClick));

    fireEvent.click(view.getByRole('button', { name: GROUP_LABEL }));

    expect(view.getByRole('tooltip').textContent).toContain(UNTIL_STOPPED_DISCLOSURE);
  });

  it('discloses a forced choice help on click without changing the value', (): void => {
    const onChange: Mock = vi.fn();
    const view = render(forcedSessionType(onChange));

    fireEvent.click(view.getByRole('button', { name: 'Friction' }));

    expect(onChange).not.toHaveBeenCalled();
    expect(view.getByRole('tooltip').textContent).toContain(FRICTION_CONSEQUENCE);
  });

  it('discloses a forced choice help on Enter without changing the value', (): void => {
    const onChange: Mock = vi.fn();
    const view = render(forcedSessionType(onChange));

    fireEvent.keyDown(view.getByRole('button', { name: 'Friction' }), { key: 'Enter' });

    expect(onChange).not.toHaveBeenCalled();
    expect(view.getByRole('tooltip').textContent).toContain(FRICTION_CONSEQUENCE);
  });

  it('dismisses a popover open elsewhere when a forced choice discloses its own help', (): void => {
    const onChange: Mock = vi.fn();
    const view = render(
      <div>
        <HelpPopover label={OUTSIDE_HELP_LABEL}>{OUTSIDE_HELP_TEXT}</HelpPopover>
        {forcedSessionType(onChange)}
      </div>,
    );

    fireEvent.click(view.getByRole('button', { name: OUTSIDE_HELP_LABEL }));
    expect(view.getByRole('tooltip').textContent).toContain(OUTSIDE_HELP_TEXT);

    fireEvent.click(view.getByRole('button', { name: 'Friction' }));

    expect(onChange).not.toHaveBeenCalled();
    const tooltips: HTMLElement[] = view.getAllByRole('tooltip');
    expect(tooltips).toHaveLength(1);
    expect(tooltips[0]?.textContent).toContain(FRICTION_CONSEQUENCE);
  });

  it('styles the forced wrapper and hides the described explanation', (): void => {
    // One stylesheet for every page that renders the component, imported by the component
    // itself, so neither page can carry a copy that drifts.
    const css: string = readFileSync(resolve('src/shared/forced-control.css'), 'utf8');
    const view = render(forcedChoice(vi.fn()));
    const group: HTMLElement = view.getByRole('group', { name: GROUP_LABEL });

    expect(group.classList.contains('forced-control')).toBe(true);
    expect(group.querySelector('.forced-control__body')).not.toBeNull();
    expect(group.querySelector('.forced-control__explanation')).not.toBeNull();
    expect(css).toMatch(/\.forced-control\s*\{[^}]*cursor:\s*not-allowed/s);
    expect(css).toMatch(/\.forced-control:focus-visible\s*\{[^}]*outline:\s*2px solid/s);
    expect(css).toMatch(/\.forced-control__body\s*\{[^}]*pointer-events:\s*none/s);
    expect(css).toMatch(/\.forced-control__body\s+\.help-popover\s*\{[^}]*pointer-events:\s*auto/s);
    expect(css).toMatch(/\.forced-control__explanation\s*\{[^}]*position:\s*absolute/s);
  });
});

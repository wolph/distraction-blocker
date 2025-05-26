/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { HelpPopover } from '../../../src/shared/HelpPopover';

afterEach((): void => {
  cleanup();
  document.body.replaceChildren();
});

describe('HelpPopover', (): void => {
  it('opens the controlled tooltip on focus with a stable accessible relationship', async (): Promise<void> => {
    const view = render(
      <HelpPopover label="Friction help">Ending early requires a 10-second wait.</HelpPopover>,
    );
    const button: HTMLButtonElement = view.getByRole('button', {
      name: 'Friction help',
    }) as HTMLButtonElement;
    const contentId: string | null = button.getAttribute('aria-controls');

    expect(contentId).toBeTruthy();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    button.focus();
    fireEvent.focus(button);

    const tooltip: HTMLElement = await view.findByRole('tooltip');
    expect(tooltip.textContent).toContain('10-second wait');
    expect(tooltip.id).toBe(contentId);
    expect(button.getAttribute('aria-controls')).toBe(contentId);
    expect(button.getAttribute('aria-describedby')).toBe(contentId);
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('opens on pointer enter and closes on pointer leave when focus is outside', (): void => {
    const view = render(<HelpPopover label="Flexible help">Choose your own rules.</HelpPopover>);
    const button: HTMLElement = view.getByRole('button', { name: 'Flexible help' });

    fireEvent.pointerEnter(button);
    expect(view.getByRole('tooltip').textContent).toContain('own rules');

    fireEvent.pointerLeave(button);
    expect(view.queryByRole('tooltip')).toBeNull();
  });

  it('keeps pointer-open content visible while focus remains within the disclosure', async (): Promise<void> => {
    const view = render(<HelpPopover label="Flexible help">Choose your own rules.</HelpPopover>);
    const button: HTMLButtonElement = view.getByRole('button', {
      name: 'Flexible help',
    }) as HTMLButtonElement;
    const outside: HTMLButtonElement = document.createElement('button');
    document.body.appendChild(outside);

    fireEvent.pointerEnter(button);
    button.focus();
    fireEvent.focus(button);
    fireEvent.pointerLeave(button);
    expect(view.getByRole('tooltip')).toBeTruthy();

    outside.focus();
    fireEvent.blur(button, { relatedTarget: outside });
    await waitFor((): void => expect(view.queryByRole('tooltip')).toBeNull());
    outside.remove();
  });

  it('opens on click and closes after a click outside', (): void => {
    const view = render(<HelpPopover label="Social sites help">See bundled sites.</HelpPopover>);
    const button: HTMLButtonElement = view.getByRole('button', {
      name: 'Social sites help',
    }) as HTMLButtonElement;
    const outside: HTMLButtonElement = document.createElement('button');
    document.body.appendChild(outside);

    fireEvent.click(button);
    expect(view.getByRole('tooltip')).toBeTruthy();

    fireEvent.click(outside);
    expect(view.queryByRole('tooltip')).toBeNull();
    outside.remove();
  });

  it('closes on Escape without moving focus', async (): Promise<void> => {
    const view = render(
      <HelpPopover label="Friction help">Ending early requires a 10-second wait.</HelpPopover>,
    );
    const button: HTMLButtonElement = view.getByRole('button', {
      name: 'Friction help',
    }) as HTMLButtonElement;

    button.focus();
    fireEvent.focus(button);
    expect(await view.findByRole('tooltip')).toBeTruthy();
    fireEvent.keyDown(button, { key: 'Escape' });

    await waitFor((): void => expect(view.queryByRole('tooltip')).toBeNull());
    expect(document.activeElement).toBe(button);
  });
});

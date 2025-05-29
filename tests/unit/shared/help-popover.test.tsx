/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HelpPopover } from '../../../src/shared/HelpPopover';

const originalInnerWidth: number = window.innerWidth;
const originalInnerHeight: number = window.innerHeight;

function rectangle(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: (): Record<string, number> => ({ left, top, width, height }),
  };
}

afterEach((): void => {
  cleanup();
  document.body.replaceChildren();
  document.documentElement.removeAttribute('dir');
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
  vi.restoreAllMocks();
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

  it('clamps fixed logical placement at both viewport edges and on resize', async (): Promise<void> => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 480 });
    let triggerLeft: number = 2;
    let triggerTop: number = 40;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ): DOMRect {
      if (this.classList.contains('help-popover__trigger')) {
        return rectangle(triggerLeft, triggerTop, 20, 20);
      }
      if (this.classList.contains('help-popover__content')) {
        return rectangle(0, 0, 240, 64);
      }
      return rectangle(0, 0, 0, 0);
    });
    const view = render(
      <HelpPopover label="Edge help">
        Long help content must remain inside the viewport.
      </HelpPopover>,
    );

    const button: HTMLElement = view.getByRole('button', { name: 'Edge help' });
    fireEvent.click(button);
    const tooltip: HTMLElement = await view.findByRole('tooltip');
    await waitFor((): void => expect(tooltip.style.insetInlineStart).toBe('16px'));
    expect(tooltip.style.insetBlockStart).toBe('68px');

    triggerLeft = 298;
    fireEvent(window, new Event('resize'));
    await waitFor((): void => expect(tooltip.style.insetInlineStart).toBe('64px'));

    const root: HTMLElement = button.closest('.help-popover') as HTMLElement;
    root.style.direction = 'rtl';
    triggerTop = 450;
    fireEvent(window, new Event('resize'));
    await waitFor((): void => expect(tooltip.style.insetInlineStart).toBe('16px'));
    expect(tooltip.style.insetBlockStart).toBe('378px');
  });

  it('uses fixed logical insets without transform-based edge overflow', (): void => {
    const css: string = readFileSync(resolve('src/shared/help-popover.css'), 'utf8');

    expect(css).toMatch(/\.help-popover__content\s*\{[^}]*position:\s*fixed/s);
    expect(css).toMatch(/\.help-popover__content\s*\{[^}]*max-inline-size:/s);
    expect(css).toMatch(/\.help-popover__content\s*\{[^}]*max-block-size:/s);
    expect(css).not.toMatch(/translateX\s*\(/);
    expect(css).not.toContain('clamp(0rem, 50%, 100%)');
  });
});

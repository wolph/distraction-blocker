/** @vitest-environment jsdom */
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionTypeControl } from '../../../src/popup/SessionTypeControl';
import type { Strictness } from '../../../src/shared/types';

const EXPLANATIONS: Record<Strictness, string> = {
  flexible: 'End the session immediately whenever you choose.',
  friction: 'Ending early requires a 30-second wait and typed confirmation.',
  hard: 'The session cannot end early. Earned pauses still work.',
};

afterEach((): void => {
  cleanup();
});

describe('SessionTypeControl', (): void => {
  it.each([
    ['focus', 'Flexible'],
    ['pointer', 'Friction'],
    ['click', 'Hard lock'],
  ] as const)(
    'uses the %s on the choice itself to reveal its shared explanation',
    async (interaction: 'focus' | 'pointer' | 'click', label: string): Promise<void> => {
      const view = render(
        <SessionTypeControl value="flexible" onChange={vi.fn<(value: Strictness) => void>()} />,
      );
      const button: HTMLButtonElement = view.getByRole('button', {
        name: label,
      }) as HTMLButtonElement;

      if (interaction === 'focus') {
        button.focus();
        fireEvent.focus(button);
      }
      if (interaction === 'pointer') {
        fireEvent.pointerEnter(button.closest('.help-popover') as HTMLElement);
      }
      if (interaction === 'click') fireEvent.click(button);

      const strictness: Strictness =
        label === 'Flexible' ? 'flexible' : label === 'Friction' ? 'friction' : 'hard';
      const tooltip: HTMLElement = await view.findByRole('tooltip');
      expect(tooltip.textContent).toContain(EXPLANATIONS[strictness]);
      expect(button.getAttribute('aria-controls')).toBe(tooltip.id);
    },
  );

  it('makes each choice the selection and disclosure control without extra help buttons', (): void => {
    const onChange = vi.fn<(value: Strictness) => void>();
    const view = render(<SessionTypeControl value="friction" onChange={onChange} />);
    const hard: HTMLButtonElement = view.getByRole('button', {
      name: 'Hard lock',
    }) as HTMLButtonElement;

    expect(view.getAllByRole('button')).toHaveLength(3);
    expect(view.queryByRole('button', { name: /help/i })).toBeNull();
    expect(view.getByRole('button', { name: 'Friction' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(hard);
    expect(onChange).toHaveBeenCalledWith('hard');
  });
});

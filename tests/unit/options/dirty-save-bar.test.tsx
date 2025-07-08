/** @vitest-environment jsdom */
import { render } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';
import { DirtySaveBar } from '../../../src/options/DirtySaveBar';

const noop = (): void => {};

describe('DirtySaveBar sticky state', () => {
  it('keeps the clean save row in normal document flow', (): void => {
    const { container } = render(
      <DirtySaveBar dirty={false} pending={false} error={null} onSave={noop} onDiscard={noop} />,
    );

    expect(
      container.querySelector('.dirty-save-bar')?.classList.contains('dirty-save-bar--sticky'),
    ).toBe(false);
  });

  it.each([
    { dirty: true, error: null, pending: false, state: 'dirty' },
    { dirty: false, error: null, pending: true, state: 'pending' },
    { dirty: false, error: 'save rejected', pending: false, state: 'error' },
  ])('keeps the $state save row sticky', ({ dirty, error, pending }): void => {
    const { container } = render(
      <DirtySaveBar dirty={dirty} pending={pending} error={error} onSave={noop} onDiscard={noop} />,
    );

    expect(
      container.querySelector('.dirty-save-bar')?.classList.contains('dirty-save-bar--sticky'),
    ).toBe(true);
  });
});

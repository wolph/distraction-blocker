import { describe, expect, it } from 'vitest';
import { storageValuesEqual } from '../../../src/background/storage-value-equality';

describe('storageValuesEqual', (): void => {
  it('treats reordered nested object keys as equal', (): void => {
    expect(
      storageValuesEqual(
        { outer: { beta: 2, alpha: { right: true, left: false } } },
        { outer: { alpha: { left: false, right: true }, beta: 2 } },
      ),
    ).toBe(true);
  });

  it('orders composed and decomposed object keys by exact code units', (): void => {
    const composed: string = '\u00e9';
    const decomposed: string = 'e\u0301';
    expect(
      storageValuesEqual(
        {
          nested: {
            [composed]: { order: ['first', 'second'] },
            [decomposed]: 'decomposed',
          },
        },
        {
          nested: {
            [decomposed]: 'decomposed',
            [composed]: { order: ['first', 'second'] },
          },
        },
      ),
    ).toBe(true);
  });

  it('does not treat changed nested values as equal', (): void => {
    expect(storageValuesEqual({ outer: { value: 1 } }, { outer: { value: 2 } })).toBe(false);
  });

  it('does not treat reordered arrays as equal', (): void => {
    expect(
      storageValuesEqual({ values: ['first', 'second'] }, { values: ['second', 'first'] }),
    ).toBe(false);
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Categories } from '../../../src/options/Categories';
import { DEFAULT_LISTS } from '../../../src/shared/constants';
import type { ListsConfig } from '../../../src/shared/types';

vi.mock('../../../src/core/categories', () => ({
  // Plan 02 fills the real list from src/lists JSON. The component only
  // needs the shape, so a two-category fixture stands in.
  ALL_CATEGORIES: [
    {
      id: 'social',
      title: 'Social',
      hosts: ['facebook.com', 'instagram.com', 'x.com'],
    },
    { id: 'news', title: 'News', hosts: ['nu.nl', 'tweakers.net'] },
  ],
}));

afterEach((): void => {
  cleanup();
});

describe('Categories', () => {
  it('toggling a category on fires onChange with the toggle set', (): void => {
    const onChange = vi.fn();
    const { getByLabelText } = render(h(Categories, { lists: DEFAULT_LISTS, onChange }));
    fireEvent.click(getByLabelText('Social'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next: ListsConfig = onChange.mock.calls[0]?.[0] as ListsConfig;
    expect(next.categories.social).toBe(true);
    expect(next.categories.news).toBe(false);
  });

  it('unchecking an entry writes it into the exclusion set', (): void => {
    const lists: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, social: true },
    };
    const onChange = vi.fn();
    const { getByLabelText, getByRole } = render(h(Categories, { lists, onChange }));
    fireEvent.click(getByRole('button', { name: 'Show Social sites' }));
    fireEvent.click(getByLabelText('facebook.com'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next: ListsConfig = onChange.mock.calls[0]?.[0] as ListsConfig;
    expect(next.exclusions.social).toEqual(['facebook.com']);
  });

  it('rechecking an excluded entry removes it from the exclusion set', (): void => {
    const lists: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, social: true },
      exclusions: { social: ['facebook.com', 'x.com'] },
    };
    const onChange = vi.fn();
    const { getByLabelText, getByRole } = render(h(Categories, { lists, onChange }));
    fireEvent.click(getByRole('button', { name: 'Show Social sites' }));
    fireEvent.click(getByLabelText('facebook.com'));
    const next: ListsConfig = onChange.mock.calls[0]?.[0] as ListsConfig;
    expect(next.exclusions.social).toEqual(['x.com']);
  });

  it('toggling a category off keeps the stored exclusions untouched', (): void => {
    const lists: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, social: true },
      exclusions: { social: ['facebook.com'] },
    };
    const onChange = vi.fn();
    const { getByLabelText } = render(h(Categories, { lists, onChange }));
    fireEvent.click(getByLabelText('Social'));
    const next: ListsConfig = onChange.mock.calls[0]?.[0] as ListsConfig;
    expect(next.categories.social).toBe(false);
    expect(next.exclusions.social).toEqual(['facebook.com']);
  });
});

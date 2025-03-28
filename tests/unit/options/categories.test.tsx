/** @vitest-environment jsdom */
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALL_CATEGORIES } from '../../../src/core/categories';
import { Categories } from '../../../src/options/Categories';
import { DEFAULT_LISTS } from '../../../src/shared/constants';
import type { CategoryList, ListsConfig } from '../../../src/shared/types';

afterEach((): void => {
  cleanup();
});

describe('Categories', () => {
  it('shows overall category counts and per-category bundled-site counts', (): void => {
    const social: CategoryList = ALL_CATEGORIES.find(
      (category: CategoryList): boolean => category.id === 'social',
    ) as CategoryList;
    const lists: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, social: true, video: true },
      exclusions: { social: [social.hosts[0] as string, 'retired.example'] },
    };

    const { getByLabelText } = render(<Categories lists={lists} onChange={vi.fn()} />);

    expect(getByLabelText('Selected 2 categories').textContent).toBe('Selected 2');
    expect(getByLabelText('Deselected 5 categories').textContent).toBe('Deselected 5');
    expect(
      getByLabelText(`Social media: selected ${social.hosts.length - 1} sites`).textContent,
    ).toBe(`Selected ${social.hosts.length - 1}`);
    expect(getByLabelText('Social media: deselected 1 site').textContent).toBe('Deselected 1');
  });

  it('keeps a partially selected category expanded and refuses to collapse it', (): void => {
    const social: CategoryList = ALL_CATEGORIES.find(
      (category: CategoryList): boolean => category.id === 'social',
    ) as CategoryList;
    const lists: ListsConfig = {
      ...DEFAULT_LISTS,
      exclusions: { social: [social.hosts[0] as string] },
    };
    const { getByLabelText, getByRole } = render(<Categories lists={lists} onChange={vi.fn()} />);

    const toggle: HTMLButtonElement = getByRole('button', {
      name: 'Social media sites are shown because the category is partially selected',
    }) as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.disabled).toBe(true);
    expect(getByLabelText(social.hosts[0] as string)).toBeTruthy();
  });

  it('opens a category when a prop update makes it partially selected', (): void => {
    const social: CategoryList = ALL_CATEGORIES.find(
      (category: CategoryList): boolean => category.id === 'social',
    ) as CategoryList;
    const { getByRole, rerender } = render(<Categories lists={DEFAULT_LISTS} onChange={vi.fn()} />);
    expect(
      getByRole('button', { name: 'Show Social media sites' }).getAttribute('aria-expanded'),
    ).toBe('false');

    rerender(
      <Categories
        lists={{ ...DEFAULT_LISTS, exclusions: { social: [social.hosts[0] as string] } }}
        onChange={vi.fn()}
      />,
    );

    expect(
      getByRole('button', {
        name: 'Social media sites are shown because the category is partially selected',
      }).getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('toggling a category on fires onChange with the toggle set', (): void => {
    const onChange = vi.fn();
    const { getByLabelText } = render(<Categories lists={DEFAULT_LISTS} onChange={onChange} />);
    fireEvent.click(getByLabelText('Social media'));
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
    const { getByLabelText, getByRole } = render(<Categories lists={lists} onChange={onChange} />);
    fireEvent.click(getByRole('button', { name: 'Show Social media sites' }));
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
    const { getByLabelText } = render(<Categories lists={lists} onChange={onChange} />);
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
    const { getByLabelText } = render(<Categories lists={lists} onChange={onChange} />);
    fireEvent.click(getByLabelText('Social media'));
    const next: ListsConfig = onChange.mock.calls[0]?.[0] as ListsConfig;
    expect(next.categories.social).toBe(false);
    expect(next.exclusions.social).toEqual(['facebook.com']);
  });

  it('selects every category without changing exclusions', (): void => {
    const lists: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, social: true },
      exclusions: { social: ['facebook.com'], video: ['youtube.com'] },
    };
    const onChange = vi.fn();
    const { getByRole } = render(<Categories lists={lists} onChange={onChange} />);

    fireEvent.click(getByRole('button', { name: 'Select all categories' }));

    const next: ListsConfig = onChange.mock.calls[0]?.[0] as ListsConfig;
    expect(next.categories).toEqual({
      social: true,
      video: true,
      news: true,
      mail: true,
      shopping: true,
      gaming: true,
      forums: true,
    });
    expect(next.exclusions).toEqual(lists.exclusions);
  });

  it('deselects every category without changing exclusions', (): void => {
    const lists: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: {
        social: true,
        video: true,
        news: true,
        mail: true,
        shopping: true,
        gaming: true,
        forums: true,
      },
      exclusions: { social: ['facebook.com'], video: ['youtube.com'] },
    };
    const onChange = vi.fn();
    const { getByRole } = render(<Categories lists={lists} onChange={onChange} />);

    fireEvent.click(getByRole('button', { name: 'Deselect all categories' }));

    const next: ListsConfig = onChange.mock.calls[0]?.[0] as ListsConfig;
    expect(next.categories).toEqual({
      social: false,
      video: false,
      news: false,
      mail: false,
      shopping: false,
      gaming: false,
      forums: false,
    });
    expect(next.exclusions).toEqual(lists.exclusions);
  });

  it('disables a global bulk action when every category already has that state', (): void => {
    const allSelected: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: {
        social: true,
        video: true,
        news: true,
        mail: true,
        shopping: true,
        gaming: true,
        forums: true,
      },
    };
    const onChange = vi.fn();
    const { getByRole, rerender } = render(
      <Categories lists={DEFAULT_LISTS} onChange={onChange} />,
    );

    expect(
      (getByRole('button', { name: 'Select all categories' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (getByRole('button', { name: 'Deselect all categories' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    rerender(<Categories lists={allSelected} onChange={onChange} />);

    expect(
      (getByRole('button', { name: 'Select all categories' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (getByRole('button', { name: 'Deselect all categories' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('selects every known site while preserving stale exclusions and the parent state', (): void => {
    const social: CategoryList = ALL_CATEGORIES.find(
      (category: CategoryList): boolean => category.id === 'social',
    ) as CategoryList;
    const lists: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, social: true, news: true },
      exclusions: {
        social: [social.hosts[0] as string, social.hosts[1] as string, 'retired.example'],
      },
    };
    const onChange = vi.fn();
    const { getByRole } = render(<Categories lists={lists} onChange={onChange} />);

    fireEvent.click(getByRole('button', { name: 'Select all Social media sites' }));

    const next: ListsConfig = onChange.mock.calls[0]?.[0] as ListsConfig;
    expect(next.categories).toEqual(lists.categories);
    expect(next.exclusions.social).toEqual(['retired.example']);
  });

  it('deselects every known site without duplicates while preserving stale exclusions and parent state', (): void => {
    const social: CategoryList = ALL_CATEGORIES.find(
      (category: CategoryList): boolean => category.id === 'social',
    ) as CategoryList;
    const firstHost: string = social.hosts[0] as string;
    const lists: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, social: false, news: true },
      exclusions: { social: [firstHost, 'retired.example', firstHost] },
    };
    const onChange = vi.fn();
    const { getByRole } = render(<Categories lists={lists} onChange={onChange} />);

    fireEvent.click(getByRole('button', { name: 'Deselect all Social media sites' }));

    const next: ListsConfig = onChange.mock.calls[0]?.[0] as ListsConfig;
    expect(next.categories).toEqual(lists.categories);
    expect(next.exclusions.social).toEqual([
      firstHost,
      'retired.example',
      ...social.hosts.slice(1),
    ]);
    expect(new Set(next.exclusions.social).size).toBe(next.exclusions.social?.length);
  });

  it('disables a site bulk action when every known site already has that state', (): void => {
    const social: CategoryList = ALL_CATEGORIES.find(
      (category: CategoryList): boolean => category.id === 'social',
    ) as CategoryList;
    const allDeselected: ListsConfig = {
      ...DEFAULT_LISTS,
      exclusions: { social: [...social.hosts, 'retired.example'] },
    };
    const onChange = vi.fn();
    const { getByRole, rerender } = render(
      <Categories lists={DEFAULT_LISTS} onChange={onChange} />,
    );
    fireEvent.click(getByRole('button', { name: 'Show Social media sites' }));

    expect(
      (getByRole('button', { name: 'Select all Social media sites' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (getByRole('button', { name: 'Deselect all Social media sites' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    rerender(<Categories lists={allDeselected} onChange={onChange} />);

    expect(
      (getByRole('button', { name: 'Select all Social media sites' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (getByRole('button', { name: 'Deselect all Social media sites' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

/** @vitest-environment jsdom */
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALL_CATEGORIES } from '../../../src/core/categories';
import { HOST_PAGE_SIZE } from '../../../src/core/host-search';
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

    const { container, getAllByRole } = render(<Categories lists={lists} onChange={vi.fn()} />);

    const bulk: Element = container.querySelector('.cat-bulk-actions') as Element;
    expect(bulk.querySelector('.selected')?.textContent).toBe('Selected 2');
    expect(bulk.querySelector('.deselected')?.textContent).toBe('Deselected 5');
    const socialRow: Element = container.querySelector('.cat-row') as Element;
    expect(socialRow.querySelector('.selected')?.textContent).toBe(
      `Selected ${social.hosts.length - 1}`,
    );
    expect(socialRow.querySelector('.deselected')?.textContent).toBe('Deselected 1');
    expect(getAllByRole('status')).toHaveLength(1);
  });

  it('lets a partially selected category expand and collapse independently', (): void => {
    const social: CategoryList = ALL_CATEGORIES.find(
      (category: CategoryList): boolean => category.id === 'social',
    ) as CategoryList;
    const lists: ListsConfig = {
      ...DEFAULT_LISTS,
      exclusions: { social: [social.hosts[0] as string] },
    };
    const { getByLabelText, getByRole } = render(<Categories lists={lists} onChange={vi.fn()} />);

    const toggle: HTMLButtonElement = getByRole('button', {
      name: 'Show Social media sites',
    }) as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.disabled).toBe(false);
    expect((): HTMLElement => getByLabelText(social.hosts[0] as string)).toThrow();
    fireEvent.click(toggle);
    expect(getByLabelText(social.hosts[0] as string)).toBeTruthy();
    fireEvent.click(getByRole('button', { name: 'Hide Social media sites' }));
    expect((): HTMLElement => getByLabelText(social.hosts[0] as string)).toThrow();
  });

  it('does not force a category open when a prop update makes it partial', (): void => {
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
      getByRole('button', { name: 'Show Social media sites' }).getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('describes a disabled category without implying it currently blocks sites', (): void => {
    const social: CategoryList = ALL_CATEGORIES.find(
      (category: CategoryList): boolean => category.id === 'social',
    ) as CategoryList;
    const { getAllByText } = render(<Categories lists={DEFAULT_LISTS} onChange={vi.fn()} />);

    expect(getAllByText('Category off')).toHaveLength(ALL_CATEGORIES.length);
    expect(getAllByText(`${social.hosts.length} included when enabled`).length).toBeGreaterThan(0);
  });

  it('renders one page of a large category and reaches the rest through its search', (): void => {
    const news: CategoryList = ALL_CATEGORIES.find(
      (category: CategoryList): boolean => category.id === 'news',
    ) as CategoryList;
    const beyondFirstPage: string = news.hosts[news.hosts.length - 1] as string;
    expect(news.hosts.indexOf(beyondFirstPage)).toBeGreaterThanOrEqual(HOST_PAGE_SIZE);
    const lists: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, news: true },
    };
    const onChange = vi.fn();
    const { getByLabelText, getByRole } = render(<Categories lists={lists} onChange={onChange} />);

    fireEvent.click(getByRole('button', { name: 'Show News sites' }));
    const region: HTMLElement = getByRole('region', { name: 'News sites' });
    expect(region.querySelectorAll('input[type="checkbox"]')).toHaveLength(HOST_PAGE_SIZE);
    expect((): HTMLElement => getByLabelText(beyondFirstPage)).toThrow();

    fireEvent.input(getByLabelText('Search News sites'), { target: { value: beyondFirstPage } });
    fireEvent.click(getByLabelText(beyondFirstPage));

    const next: ListsConfig = onChange.mock.calls[0]?.[0] as ListsConfig;
    expect(next.exclusions.news).toEqual([beyondFirstPage]);
  });

  it('keeps the category bulk actions on the whole category while a search narrows the view', (): void => {
    const news: CategoryList = ALL_CATEGORIES.find(
      (category: CategoryList): boolean => category.id === 'news',
    ) as CategoryList;
    const onChange = vi.fn();
    const { getByLabelText, getByRole } = render(
      <Categories lists={DEFAULT_LISTS} onChange={onChange} />,
    );

    fireEvent.click(getByRole('button', { name: 'Show News sites' }));
    fireEvent.input(getByLabelText('Search News sites'), { target: { value: 'bbc' } });
    fireEvent.click(getByRole('button', { name: 'Deselect all News sites' }));

    const next: ListsConfig = onChange.mock.calls[0]?.[0] as ListsConfig;
    expect(next.exclusions.news).toEqual(news.hosts);
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
    const { getByLabelText, getByRole } = render(<Categories lists={lists} onChange={onChange} />);
    fireEvent.click(getByRole('button', { name: 'Show Social media sites' }));
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

    fireEvent.click(getByRole('button', { name: 'Show Social media sites' }));
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

    fireEvent.click(getByRole('button', { name: 'Show Social media sites' }));
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

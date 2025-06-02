/** @vitest-environment jsdom */
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuleSummary } from '../../../src/popup/RuleSummary';
import {
  addDraftAllowHost,
  createSessionDraft,
  toggleDraftCategory,
} from '../../../src/popup/session-draft';
import { DEFAULT_LISTS, DEFAULT_SETTINGS } from '../../../src/shared/constants';
import type { ListsConfig } from '../../../src/shared/types';

vi.mock('../../../src/core/categories', () => ({
  ALL_CATEGORIES: [
    { id: 'social', title: 'Social media', hosts: ['facebook.com', 'instagram.com'] },
    { id: 'video', title: 'Video and streaming', hosts: ['youtube.com'] },
  ],
}));

afterEach((): void => {
  cleanup();
});

describe('session draft helpers', (): void => {
  it('toggles categories immutably without changing the source lists', (): void => {
    const lists: ListsConfig = structuredClone(DEFAULT_LISTS);
    const draft = createSessionDraft(DEFAULT_SETTINGS, lists);
    const changed = toggleDraftCategory(draft, 'social');

    expect(changed).not.toBe(draft);
    expect(changed.rules.categories.social).toBe(true);
    expect(draft.rules.categories.social).toBe(false);
    expect(lists.categories.social).toBe(false);
  });

  it('normalizes valid allow hosts, deduplicates them, and rejects unsafe input', (): void => {
    const initial = createSessionDraft(DEFAULT_SETTINGS, DEFAULT_LISTS);
    const first = addDraftAllowHost(initial, 'HTTPS://Docs.Python.org/3/library/');
    const duplicate = addDraftAllowHost(first.draft, 'docs.python.org');
    const invalid = addDraftAllowHost(duplicate.draft, 'https://user@example.com/');

    expect(first.error).toBeNull();
    expect(first.draft.rules.sessionAllowlist).toEqual([
      { kind: 'host', pattern: 'docs.python.org' },
    ]);
    expect(duplicate.draft.rules.sessionAllowlist).toHaveLength(1);
    expect(invalid.error).toContain('valid domain');
    expect(invalid.draft).toBe(duplicate.draft);
  });
});

describe('RuleSummary', (): void => {
  it('shows category counts, exact membership, exceptions, host rules, and regex rules in block mode', (): void => {
    const lists: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, social: true },
      exclusions: { social: ['facebook.com'] },
      custom: [
        { kind: 'host', pattern: 'news.example' },
        { kind: 'regex', pattern: '^https://example\\.com/private' },
      ],
    };
    const view = render(
      <RuleSummary
        draft={createSessionDraft(DEFAULT_SETTINGS, lists)}
        categoriesEditable={true}
        onCategoryToggle={vi.fn()}
      />,
    );

    expect(view.getByText('1 of 2 categories selected')).toBeTruthy();
    expect(view.getByText('2 extra blocked rules')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Social media' })).toBeTruthy();
    expect(view.getByText('2 sites')).toBeTruthy();
    expect(view.getAllByText('facebook.com')).toHaveLength(2);
    expect(view.getByText('instagram.com')).toBeTruthy();
    expect(view.getByText('Allowed exceptions')).toBeTruthy();
    expect(view.getByText('news.example')).toBeTruthy();
    expect(view.getByText('^https://example\\.com/private')).toBeTruthy();
    expect(view.getByText('Regular expression')).toBeTruthy();
  });

  it('hides categories and shows every permanent and session allow rule in allow-only mode', (): void => {
    const lists: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, social: true },
      whitelist: [
        { kind: 'host', pattern: 'docs.python.org' },
        { kind: 'regex', pattern: '^https://example\\.com/docs' },
      ],
    };
    const draft = addDraftAllowHost(
      { ...createSessionDraft(DEFAULT_SETTINGS, lists), mode: 'whitelist' },
      'developer.mozilla.org',
    ).draft;
    const view = render(
      <RuleSummary draft={draft} categoriesEditable={true} onCategoryToggle={vi.fn()} />,
    );

    expect(view.queryByRole('button', { name: 'Social media' })).toBeNull();
    expect(view.queryByText('facebook.com')).toBeNull();
    expect(view.getByText('docs.python.org')).toBeTruthy();
    expect(view.getByText('^https://example\\.com/docs')).toBeTruthy();
    expect(view.getByText('developer.mozilla.org')).toBeTruthy();
    expect(view.getByText('3 allowed rules')).toBeTruthy();
  });

  it('supports arrow and page keyboard scrolling inside a contained region', (): void => {
    const view = render(
      <RuleSummary
        draft={createSessionDraft(DEFAULT_SETTINGS, DEFAULT_LISTS)}
        categoriesEditable={true}
        onCategoryToggle={vi.fn()}
      />,
    );
    const region: HTMLElement = view.getByRole('region', { name: 'Session rule details' });
    Object.defineProperty(region, 'clientHeight', { configurable: true, value: 120 });
    region.scrollTop = 0;

    fireEvent.keyDown(region, { key: 'ArrowDown' });
    expect(region.scrollTop).toBe(40);
    fireEvent.keyDown(region, { key: 'PageDown' });
    expect(region.scrollTop).toBe(160);
    fireEvent.keyDown(region, { key: 'PageUp' });
    expect(region.scrollTop).toBe(40);
  });

  it('exposes full long values while allowing them to wrap', (): void => {
    const longDomain: string = `${'very-long-label-'.repeat(8)}example.com`;
    const lists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: longDomain }],
    };
    const view = render(
      <RuleSummary
        draft={createSessionDraft(DEFAULT_SETTINGS, lists)}
        categoriesEditable={true}
        onCategoryToggle={vi.fn()}
      />,
    );
    const value: HTMLElement = view.getByText(longDomain);

    expect(value.getAttribute('title')).toBe(longDomain);
    expect(value.textContent).toBe(longDomain);
    expect(value.classList.contains('rule-value')).toBe(true);
  });
});

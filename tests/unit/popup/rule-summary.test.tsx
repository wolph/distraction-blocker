/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuleSummary } from '../../../src/popup/RuleSummary';
import {
  addDraftAllowHost,
  createSessionDraft,
  type SessionDraft,
  toggleDraftCategory,
} from '../../../src/popup/session-draft';
import { DEFAULT_LISTS, DEFAULT_SETTINGS } from '../../../src/shared/constants';
import type { ListsConfig, Settings } from '../../../src/shared/types';

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
  it('isolates configured friction gate values with the session draft', (): void => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      gate: { ...DEFAULT_SETTINGS.gate, delayMs: 30_000, requireTypedPhrase: true },
    };

    const draft: SessionDraft = createSessionDraft(settings, DEFAULT_LISTS);

    expect(draft.frictionGate).toEqual({ delayMs: 30_000, requireTypedPhrase: true });
    expect(draft.frictionGate).not.toBe(settings.gate);
  });

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
        onOpenSettings={vi.fn()}
      />,
    );

    expect(view.getByText('1 of 2 categories selected')).toBeTruthy();
    expect(view.getByText('2 extra blocked rules')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Social media' }).textContent).toContain('1 site');
    expect(view.getAllByText('facebook.com')).toHaveLength(1);
    expect(view.getByText('instagram.com')).toBeTruthy();
    expect(view.getByText('Allowed exceptions')).toBeTruthy();
    expect(view.getByText('news.example')).toBeTruthy();
    expect(view.getByText('^https://example\\.com/private')).toBeTruthy();
    expect(view.getByText('Regular expression')).toBeTruthy();
    expect(
      view.getByText('Category and rule changes here apply only to this session.'),
    ).toBeTruthy();
    expect(view.getByRole('button', { name: 'Open Settings for permanent defaults' })).toBeTruthy();
  });

  it('does not show exceptions for a disabled category', (): void => {
    const lists: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, social: false },
      exclusions: { social: ['facebook.com'] },
    };
    const view = render(
      <RuleSummary
        draft={createSessionDraft(DEFAULT_SETTINGS, lists)}
        categoriesEditable={true}
        onCategoryToggle={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(view.queryByText('Allowed exceptions')).toBeNull();
    expect(view.queryByText('facebook.com')).toBeNull();
  });

  it('applies whole-host overrides without hiding a protocol-specific regex exception', (): void => {
    const lists: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, social: true },
      exclusions: { social: ['facebook.com', 'instagram.com'] },
      custom: [
        { kind: 'host', pattern: 'facebook.com' },
        { kind: 'regex', pattern: '^https://instagram\\.com/' },
      ],
    };
    const view = render(
      <RuleSummary
        draft={createSessionDraft(DEFAULT_SETTINGS, lists)}
        categoriesEditable={true}
        onCategoryToggle={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(view.getByRole('button', { name: 'Social media' }).textContent).toContain('1 site');
    expect(view.getByText('Allowed exceptions')).toBeTruthy();
    expect(view.getAllByText('facebook.com')).toHaveLength(2);
    expect(view.getAllByText('instagram.com')).toHaveLength(1);
    expect(view.getByText('^https://instagram\\.com/')).toBeTruthy();
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
      <RuleSummary
        draft={draft}
        categoriesEditable={true}
        onCategoryToggle={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(view.queryByRole('button', { name: 'Social media' })).toBeNull();
    expect(view.queryByText('facebook.com')).toBeNull();
    expect(view.getByText('docs.python.org')).toBeTruthy();
    expect(view.getByText('^https://example\\.com/docs')).toBeTruthy();
    expect(view.getByText('developer.mozilla.org')).toBeTruthy();
    expect(view.getByText('3 allowed rules')).toBeTruthy();
    expect(
      view.getByText(
        'Allowed-site and rule changes here apply only to this session. Everything else is blocked.',
      ),
    ).toBeTruthy();
  });

  it('supports arrow and page keyboard scrolling inside a contained region', (): void => {
    const view = render(
      <RuleSummary
        draft={createSessionDraft(DEFAULT_SETTINGS, DEFAULT_LISTS)}
        categoriesEditable={true}
        onCategoryToggle={vi.fn()}
        onOpenSettings={vi.fn()}
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

  it('opens long host detail on focus and closes it with Escape', async (): Promise<void> => {
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
        onOpenSettings={vi.fn()}
      />,
    );
    const detail: HTMLButtonElement = view.getByRole('button', {
      name: `Show full domain: ${longDomain}`,
    }) as HTMLButtonElement;

    detail.focus();
    fireEvent.focus(detail);

    const tooltip: HTMLElement = await view.findByRole('tooltip');
    expect(tooltip.textContent).toContain(longDomain);
    expect(detail.textContent).toBe(longDomain);
    expect(detail.getAttribute('title')).toBeNull();
    fireEvent.keyDown(detail, { key: 'Escape' });

    expect(view.queryByRole('tooltip')).toBeNull();
    expect(document.activeElement).toBe(detail);
  });

  it('opens long regular-expression detail on click for touch-sized disclosure', async (): Promise<void> => {
    const longRegex: string = `^https://example\\.com/${'private-section/'.repeat(8)}`;
    const lists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'regex', pattern: longRegex }],
    };
    const view = render(
      <RuleSummary
        draft={createSessionDraft(DEFAULT_SETTINGS, lists)}
        categoriesEditable={true}
        onCategoryToggle={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    const detail: HTMLButtonElement = view.getByRole('button', {
      name: `Show full regular expression: ${longRegex}`,
    }) as HTMLButtonElement;

    fireEvent.click(detail);

    const tooltip: HTMLElement = await view.findByRole('tooltip');
    expect(tooltip.textContent).toContain(longRegex);
    expect(detail.textContent).toBe(longRegex);
  });

  it('lets wrapped detail triggers grow instead of overlapping adjacent rules', (): void => {
    const css: string = readFileSync(resolve('src/popup/popup.css'), 'utf8');

    expect(css).toMatch(/\.help-popover__trigger\.rule-detail\s*\{[^}]*height:\s*auto/s);
    expect(css).toMatch(/\.help-popover__trigger\.rule-detail\s*\{[^}]*font-weight:\s*500/s);
  });

  it('uses viewport-owned popup layout without fixed header arithmetic', (): void => {
    const css: string = readFileSync(resolve('src/popup/popup.css'), 'utf8');

    expect(css).not.toContain('calc(100vh - 86px)');
    expect(css).toMatch(/body\s*\{[^}]*block-size:\s*100vh/s);
    expect(css).toMatch(/#app\s*\{[^}]*min-block-size:\s*0/s);
    expect(css).toMatch(/\.app\s*\{[^}]*min-block-size:\s*0/s);
    expect(css).toMatch(/\.start-form\s*\{[^}]*min-block-size:\s*0/s);
  });
});

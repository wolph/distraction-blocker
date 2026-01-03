/**
 * The provenance sentence every blocked page shows. `overlay-view-v2.ts` authors
 * `copy.verdictProvenance` from `verdictLabel`, and the only surviving reference asserted
 * `toBe(verdictLabel(BLOCKED_VERDICT))`, which passes for an implementation that returns ''.
 * These are the strings, stated. Ported from the deleted `tests/unit/content/overlay.test.ts`
 * case `formats category and allow-list provenance truthfully` (39113e9) and widened to every
 * branch, so it lives beside the blocked-page tests that consume it.
 */
import { describe, expect, it } from 'vitest';
import type { CategoryId, Verdict } from '../../../src/shared/types';
import { verdictLabel } from '../../../src/shared/verdict-label';

function blocked(overrides: Partial<Verdict> = {}): Verdict {
  return {
    blocked: true,
    reason: 'category',
    categoryId: 'social',
    matchedPattern: 'instagram.com',
    ...overrides,
  };
}

function allowed(overrides: Partial<Verdict> = {}): Verdict {
  return {
    blocked: false,
    reason: 'default',
    categoryId: null,
    matchedPattern: null,
    ...overrides,
  };
}

describe('verdictLabel', (): void => {
  it('formats category and allow-list provenance truthfully', (): void => {
    expect(verdictLabel(blocked())).toBe('Blocked by Social media: instagram.com');
    expect(verdictLabel(blocked({ reason: 'whitelist-miss', categoryId: null }))).toBe(
      'Not on your allow list',
    );
  });

  it.each([
    ['social', 'Blocked by Social media: x.com'],
    ['video', 'Blocked by Video and streaming: x.com'],
    ['news', 'Blocked by News: x.com'],
    ['mail', 'Blocked by Mail: x.com'],
    ['shopping', 'Blocked by Shopping: x.com'],
    ['gaming', 'Blocked by Gaming: x.com'],
    ['forums', 'Blocked by Forums and boredom: x.com'],
  ])('names the %s category by its display name', (categoryId: string, label: string): void => {
    expect(
      verdictLabel(blocked({ categoryId: categoryId as CategoryId, matchedPattern: 'x.com' })),
    ).toBe(label);
  });

  it('drops the separator when a category block matched no pattern', (): void => {
    expect(verdictLabel(blocked({ matchedPattern: null }))).toBe('Blocked by Social media');
  });

  it('names the block list for a custom rule, with and without a pattern', (): void => {
    expect(verdictLabel(blocked({ reason: 'custom', categoryId: null }))).toBe(
      'Blocked by your block list: instagram.com',
    );
    expect(
      verdictLabel(blocked({ reason: 'custom', categoryId: null, matchedPattern: null })),
    ).toBe('Blocked by your block list');
  });

  it.each(['no-session', 'always-allow', 'unlock', 'excluded', 'whitelist', 'default'])(
    'falls back to the session for a blocked %s verdict',
    (reason: string): void => {
      expect(verdictLabel(blocked({ reason: reason as Verdict['reason'] }))).toBe(
        'Blocked by this session',
      );
    },
  );

  it('falls back to the session for a category block with no category', (): void => {
    expect(verdictLabel(blocked({ categoryId: null }))).toBe('Blocked by this session');
  });

  it('names the allow list for an allowed verdict, with and without a pattern', (): void => {
    expect(verdictLabel(allowed({ reason: 'whitelist', matchedPattern: 'docs.example.com' }))).toBe(
      'On your allow list: docs.example.com',
    );
    expect(verdictLabel(allowed({ reason: 'whitelist' }))).toBe('On your allow list');
  });

  it.each([
    ['always-allow', 'Always allowed'],
    ['unlock', 'Temporarily unlocked'],
    ['excluded', 'Excluded from a selected category'],
    ['no-session', 'No active focus session'],
    ['default', 'Allowed by this session'],
    ['category', 'Allowed by this session'],
    ['custom', 'Allowed by this session'],
    ['whitelist-miss', 'Allowed by this session'],
  ])('explains an allowed %s verdict', (reason: string, label: string): void => {
    expect(verdictLabel(allowed({ reason: reason as Verdict['reason'] }))).toBe(label);
  });
});

import type { CategoryId, Verdict } from './types';

const CATEGORY_LABELS: Readonly<Record<CategoryId, string>> = {
  social: 'Social media',
  video: 'Video and streaming',
  news: 'News',
  mail: 'Mail',
  shopping: 'Shopping',
  gaming: 'Gaming',
  forums: 'Forums and boredom',
};

function withPattern(label: string, matchedPattern: string | null): string {
  return matchedPattern === null ? label : `${label}: ${matchedPattern}`;
}

/** Human-readable explanation for an authoritative worker verdict. */
export function verdictLabel(verdict: Verdict): string {
  if (verdict.blocked) {
    if (verdict.reason === 'category' && verdict.categoryId !== null) {
      return withPattern(
        `Blocked by ${CATEGORY_LABELS[verdict.categoryId]}`,
        verdict.matchedPattern,
      );
    }
    if (verdict.reason === 'custom') {
      return withPattern('Blocked by your block list', verdict.matchedPattern);
    }
    if (verdict.reason === 'whitelist-miss') return 'Not on your allow list';
    return 'Blocked by this session';
  }
  if (verdict.reason === 'whitelist') {
    return withPattern('On your allow list', verdict.matchedPattern);
  }
  if (verdict.reason === 'always-allow') return 'Always allowed';
  if (verdict.reason === 'unlock') return 'Temporarily unlocked';
  if (verdict.reason === 'excluded') return 'Excluded from a selected category';
  if (verdict.reason === 'no-session') return 'No active focus session';
  return 'Allowed by this session';
}

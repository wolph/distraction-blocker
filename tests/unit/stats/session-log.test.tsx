/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventRecord } from '../../../src/shared/types';
import { SessionLog } from '../../../src/stats/SessionLog';

afterEach(cleanup);

function started(
  at: number,
  durationMin: number,
  intention: string,
  source: 'manual' | 'schedule',
  sessionId?: string,
): EventRecord {
  return {
    t: 'sessionStarted',
    at,
    source,
    mode: 'blacklist',
    strictness: 'friction',
    durationMin,
    intention,
    sessionId,
  };
}

const T9: number = new Date(2026, 7, 28, 9, 0, 0).getTime();
const T925: number = new Date(2026, 7, 28, 9, 25, 0).getTime();
const T11: number = new Date(2026, 7, 28, 11, 0, 0).getTime();
const T1110: number = new Date(2026, 7, 28, 11, 10, 0).getTime();
const T13: number = new Date(2026, 7, 28, 13, 0, 0).getTime();

/** Newest first, matching StatsBundle.recentSessions. */
const EVENTS: EventRecord[] = [
  started(T13, 15, '', 'manual'),
  { t: 'sessionCanceled', at: T1110, focusedMs: 8 * 60_000 },
  started(T11, 50, 'email sweep', 'schedule'),
  { t: 'sessionCompleted', at: T925, focusedMs: 25 * 60_000 },
  started(T9, 25, 'thesis chapter', 'manual'),
];

describe('SessionLog', () => {
  it('renders a row per session with outcome chips', () => {
    const { container, getByRole } = render(<SessionLog events={EVENTS} />);
    expect(getByRole('heading', { level: 2 }).textContent).toBe('Recent sessions on this machine');
    expect(container.querySelectorAll('tbody tr').length).toBe(3);
    expect(container.querySelectorAll('.session-table .chip.completed').length).toBe(1);
    expect(container.querySelectorAll('.session-table .chip.neutral').length).toBe(1);
    expect(container.querySelectorAll('.session-table .chip.running').length).toBe(1);
    expect(container.textContent).toContain('thesis chapter');
    expect(container.textContent).toContain('ended early');
    expect(container.textContent).toContain('Pause');
    expect(container.textContent).toContain('Unlock');
  });

  it('renders the quiet first-run line with no sessions', () => {
    const { container, getByRole } = render(<SessionLog events={[]} />);
    expect(getByRole('heading', { level: 2 }).textContent).toBe('Recent sessions on this machine');
    expect(container.textContent).toContain('Your first session will appear here.');
  });

  it('renders mobile article records from the same session rows', () => {
    const releaseReviewEvents: EventRecord[] = [
      { t: 'sessionCompleted', at: T925, focusedMs: 23 * 60_000 },
      started(T9, 25, 'release review', 'manual'),
    ];
    const { getByRole } = render(<SessionLog events={releaseReviewEvents} />);
    const article: HTMLElement = getByRole('article', { name: /release review/i });

    expect(article.textContent).toContain('release review');
    expect(article.textContent).toContain(new Date(T9).toLocaleDateString());
    expect(article.textContent).toContain('09:00');
    expect(article.textContent).toContain('23 m');
    expect(article.textContent).toContain('completed');
  });

  it('switches from the desktop table to articles through the 768px tablet width', () => {
    const css: string = readFileSync(resolve(process.cwd(), 'src/stats/stats.css'), 'utf8');
    expect(css).toMatch(/\.session-articles\s*\{[^}]*display:\s*none/s);
    expect(css).toMatch(
      /@media\s*\(max-width:\s*768px\)[\s\S]*?\.session-table-wrap\s*\{[^}]*display:\s*none/s,
    );
    expect(css).toMatch(
      /@media\s*\(max-width:\s*768px\)[\s\S]*?\.session-articles\s*\{[^}]*display:\s*grid/s,
    );
    const mobileBlock: string | undefined = css.match(
      /@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?\n\}/,
    )?.[0];
    expect(mobileBlock).toBeDefined();
    expect(mobileBlock).not.toMatch(/overflow-x:\s*(auto|scroll)/);
  });
});

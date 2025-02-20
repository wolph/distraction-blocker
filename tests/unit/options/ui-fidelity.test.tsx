/** @vitest-environment jsdom */
import { cleanup, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../../src/options/App';
import { Schedule } from '../../../src/options/Schedule';
import { DEFAULT_LISTS, DEFAULT_SETTINGS, emptySnapshot } from '../../../src/shared/constants';
import type { ScheduleEntry, SessionSnapshot } from '../../../src/shared/types';
import { installChromeFake } from './chrome-fake';

afterEach((): void => {
  cleanup();
});

beforeEach((): void => {
  const fake = installChromeFake();
  fake.respond('getSettings', DEFAULT_SETTINGS);
  fake.respond('getLists', DEFAULT_LISTS);
  fake.respond('getSnapshot', emptySnapshot(0));
});

const entry: ScheduleEntry = {
  id: 'weekdays',
  days: [1, 2, 3],
  start: '09:00',
  end: '12:00',
  mode: 'blacklist',
  strictness: 'hard',
  cycling: null,
  intention: '',
  enabled: true,
};

describe('Schedule saved entry', () => {
  it('renders every selected day as an individual pill', (): void => {
    const { getByRole, getByText } = render(
      <Schedule entries={[entry]} defaults={DEFAULT_SETTINGS} onChange={vi.fn()} />,
    );
    const days: HTMLElement = getByRole('group', { name: 'Selected days' });
    expect(days.querySelectorAll('.entry-day-pill')).toHaveLength(3);
    expect(getByText('Mon', { selector: '.entry-day-pill' })).toBeTruthy();
    expect(getByText('Tue', { selector: '.entry-day-pill' })).toBeTruthy();
    expect(getByText('Wed', { selector: '.entry-day-pill' })).toBeTruthy();
  });
});

describe('Options navigation', () => {
  it('links visibly to the Stats page', async (): Promise<void> => {
    const { getByRole } = render(<App />);
    await waitFor((): void => {
      expect(getByRole('link', { name: 'Stats' }).getAttribute('href')).toBe('../stats/stats.html');
    });
  });

  it('uses the exact hard-blocking rejection copy', async (): Promise<void> => {
    const endsAt: number = new Date(2026, 7, 28, 16, 45).getTime();
    const snapshot: SessionSnapshot = {
      ...emptySnapshot(endsAt - 1_000),
      phase: 'focus',
      config: {
        mode: 'blacklist',
        strictness: 'hard',
        durationMin: 25,
        cycling: null,
        intention: '',
        source: 'manual',
        scheduleEntryId: null,
      },
      startedAt: endsAt - 15 * 60_000,
      phaseStartedAt: endsAt - 15 * 60_000,
      phaseEndsAt: endsAt,
      sessionEndsAt: endsAt,
    };
    const fake = installChromeFake();
    fake.respond('getSettings', DEFAULT_SETTINGS);
    fake.respond('getLists', DEFAULT_LISTS);
    fake.respond('getSnapshot', snapshot);
    const { getByRole } = render(<App />);
    await waitFor((): void => {
      expect(getByRole('status').textContent).toBe(
        'Changes that weaken blocking will be rejected until 16:45.',
      );
    });
  });
});

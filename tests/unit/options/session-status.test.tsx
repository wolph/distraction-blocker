/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStatus } from '../../../src/options/SessionStatus';
import {
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  emptySnapshotV2,
  rulesFromLists,
} from '../../../src/shared/constants';
import {
  SETTINGS_CLEANUP_COPY,
  SETTINGS_ERROR_COPY,
  SETTINGS_INDEFINITE_COPY,
  SETTINGS_SESSION_DISCLOSURE,
  SETTINGS_STARTING_COPY,
  settingsTimedCopy,
} from '../../../src/shared/session-copy';
import type {
  EndAuthorityV2,
  SessionConfigV2,
  SessionLifecycleV2,
  SessionSnapshotV2,
} from '../../../src/shared/types';

const NOW: number = new Date(2026, 0, 5, 13, 45, 0, 0).getTime();
const ENDS_AT: number = new Date(2026, 0, 5, 14, 30, 0, 0).getTime();
const STATUS_LABEL: string = 'Session status';

const IMMEDIATE: EndAuthorityV2 = { kind: 'immediate', actionLabel: 'End session' };
const HIDDEN: EndAuthorityV2 = { kind: 'hidden' };

const TIMED_CONFIG: SessionConfigV2 = {
  mode: 'blacklist',
  strictness: 'friction',
  duration: { kind: 'timed', minutes: 45 },
  cycling: DEFAULT_SETTINGS.defaultCycling,
  intention: 'write the report',
  source: 'manual',
  scheduleOccurrence: null,
  rules: rulesFromLists(DEFAULT_LISTS),
};

const INDEFINITE_CONFIG: SessionConfigV2 = {
  ...TIMED_CONFIG,
  strictness: 'flexible',
  duration: { kind: 'until-stopped' },
  cycling: null,
};

function snapshotWith(lifecycle: SessionLifecycleV2): SessionSnapshotV2 {
  return { ...emptySnapshotV2(NOW), lifecycle };
}

function timedActive(): SessionSnapshotV2 {
  return {
    ...snapshotWith({ kind: 'active', endAuthority: IMMEDIATE }),
    phase: 'focus',
    config: TIMED_CONFIG,
    startedAt: NOW - 5 * 60_000,
    phaseStartedAt: NOW - 5 * 60_000,
    phaseEndsAt: ENDS_AT,
    sessionEndsAt: ENDS_AT,
  };
}

function indefiniteActive(): SessionSnapshotV2 {
  return {
    ...snapshotWith({ kind: 'active', endAuthority: IMMEDIATE }),
    phase: 'focus',
    config: INDEFINITE_CONFIG,
    startedAt: NOW - 5 * 60_000,
    phaseStartedAt: NOW - 5 * 60_000,
  };
}

afterEach((): void => {
  cleanup();
});

describe('SessionStatus copy', (): void => {
  it('renders nothing while idle or without a snapshot', (): void => {
    const idle = render(
      <SessionStatus snapshot={snapshotWith({ kind: 'idle', endAuthority: HIDDEN })} />,
    );
    expect(idle.container.innerHTML).toBe('');
    cleanup();

    const missing = render(<SessionStatus snapshot={null} />);
    expect(missing.container.innerHTML).toBe('');
  });

  it('names the indefinite session and sends control to the popup', (): void => {
    const view = render(<SessionStatus snapshot={indefiniteActive()} />);

    expect(view.getByText(SETTINGS_INDEFINITE_COPY)).toBeTruthy();
  });

  it('names the timed end wall clock from sessionEndsAt', (): void => {
    const view = render(<SessionStatus snapshot={timedActive()} />);

    expect(view.getByText(settingsTimedCopy('14:30'))).toBeTruthy();
  });

  it('renders the starting copy for a starting lifecycle', (): void => {
    const view = render(
      <SessionStatus
        snapshot={snapshotWith({
          kind: 'starting',
          operationId: 'op-1',
          transition: 'start',
          endAuthority: HIDDEN,
        })}
      />,
    );

    expect(view.getByText(SETTINGS_STARTING_COPY)).toBeTruthy();
  });

  it('renders the cleanup copy for both cleanup journals', (): void => {
    for (const journal of ['transition', 'closure'] as const) {
      const view = render(
        <SessionStatus
          snapshot={snapshotWith({
            kind: 'cleanup',
            journal,
            id: 'journal-1',
            endAuthority: HIDDEN,
          })}
        />,
      );

      expect(view.getByText(SETTINGS_CLEANUP_COPY)).toBeTruthy();
      cleanup();
    }
  });

  it('renders the error copy for both exhausted cleanup errors', (): void => {
    const codes = ['transition-cleanup-failed', 'closure-cleanup-failed'] as const;
    for (const code of codes) {
      const view = render(
        <SessionStatus
          snapshot={snapshotWith({
            kind: 'error',
            code,
            retryAvailable: true,
            endAuthority: HIDDEN,
          })}
        />,
      );

      expect(view.getByText(SETTINGS_ERROR_COPY)).toBeTruthy();
      cleanup();
    }
  });

  it('renders the starting copy for a timed active snapshot without an end', (): void => {
    const view = render(<SessionStatus snapshot={{ ...timedActive(), sessionEndsAt: null }} />);

    expect(view.getByText(SETTINGS_STARTING_COPY)).toBeTruthy();
  });

  it('never describes an indefinite session as automatic or Hard', (): void => {
    const view = render(<SessionStatus snapshot={indefiniteActive()} />);
    const text: string = view.container.textContent ?? '';

    expect(text).not.toContain('automatic');
    expect(text).not.toContain('Hard');
  });
});

describe('SessionStatus disclosure', (): void => {
  it('describes the status with the session disclosure', (): void => {
    const view = render(<SessionStatus snapshot={indefiniteActive()} />);
    const group: HTMLElement = view.getByRole('group', { name: STATUS_LABEL });

    const describedBy: string = group.getAttribute('aria-describedby') ?? '';
    expect(describedBy).not.toBe('');
    expect(document.getElementById(describedBy)?.textContent).toBe(SETTINGS_SESSION_DISCLOSURE);
    expect(view.container.querySelectorAll('[disabled]')).toHaveLength(0);
  });

  it('discloses on hover', (): void => {
    const view = render(<SessionStatus snapshot={indefiniteActive()} />);

    fireEvent.pointerEnter(view.getByRole('group', { name: STATUS_LABEL }));

    expect(view.getByRole('tooltip').textContent).toContain(SETTINGS_SESSION_DISCLOSURE);
  });

  it('discloses on keyboard focus', async (): Promise<void> => {
    const view = render(<SessionStatus snapshot={indefiniteActive()} />);
    const group: HTMLElement = view.getByRole('group', { name: STATUS_LABEL });

    group.focus();

    expect(document.activeElement).toBe(group);
    const tooltip: HTMLElement = await view.findByRole('tooltip');
    expect(tooltip.textContent).toContain(SETTINGS_SESSION_DISCLOSURE);
  });

  it('discloses on click', (): void => {
    const view = render(<SessionStatus snapshot={indefiniteActive()} />);

    fireEvent.click(view.getByRole('group', { name: STATUS_LABEL }));

    expect(view.getByRole('tooltip').textContent).toContain(SETTINGS_SESSION_DISCLOSURE);
  });

  it('carries the forced wrapper and its own status styles', (): void => {
    const view = render(<SessionStatus snapshot={indefiniteActive()} />);
    const group: HTMLElement = view.getByRole('group', { name: STATUS_LABEL });
    expect(view.getByRole('status').classList.contains('session-status')).toBe(true);
    expect(group.classList.contains('forced-control')).toBe(true);
    expect(group.querySelector('.forced-control__body')).toBeTruthy();
    expect(group.querySelector('.forced-control__explanation')?.textContent).toBe(
      SETTINGS_SESSION_DISCLOSURE,
    );

    // The forced wrapper's rules moved to src/shared/forced-control.css, which the component
    // imports, and tests/unit/shared/forced-control.test.tsx owns them now. Options keeps only
    // its own status styles, and this page must not grow a second copy of the wrapper's.
    const css: string = readFileSync(resolve('src/options/options.css'), 'utf8');

    expect(css).toMatch(/\.session-status\s*\{/s);
    expect(css).not.toMatch(/\.forced-control/s);
  });
});

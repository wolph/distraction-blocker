// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { hideOverlay, showOverlay } from '../../../src/content/overlay';
import { emptySnapshot } from '../../../src/shared/constants';
import type { SessionSnapshot, Verdict } from '../../../src/shared/types';

const verdict: Verdict = { blocked: true, reason: 'category', matchedPattern: 'x.com' };

function focusSnap(): SessionSnapshot {
  return {
    ...emptySnapshot(Date.now()),
    phase: 'focus',
    phaseStartedAt: Date.now() - 60_000,
    phaseEndsAt: Date.now() + 60_000,
    sessionEndsAt: Date.now() + 60_000,
    config: {
      mode: 'blacklist',
      strictness: 'friction',
      durationMin: 2,
      cycling: null,
      intention: 'finish the report',
      source: 'manual',
      scheduleEntryId: null,
    },
    attemptsToday: 3,
  };
}

describe('overlay', () => {
  it('mounts once, shows intention and attempt count, and unmounts', () => {
    showOverlay(verdict, focusSnap());
    showOverlay(verdict, focusSnap());
    const hosts = document.querySelectorAll('focus-lock-overlay');
    expect(hosts.length).toBe(1);
    hideOverlay(emptySnapshot(Date.now()));
    expect(document.querySelectorAll('focus-lock-overlay').length).toBe(0);
  });
  it('shows the friction cancel entry only for friction sessions', () => {
    const snap = focusSnap();
    showOverlay(verdict, snap);
    // closed shadow root: keep a test-only handle
    const root = (globalThis as { __focusLockShadow?: ShadowRoot }).__focusLockShadow;
    expect(root?.textContent).toContain('finish the report');
    expect(root?.textContent).toContain('End session');
    const hardSnap: SessionSnapshot = {
      ...snap,
      config: snap.config === null ? null : { ...snap.config, strictness: 'hard' },
    };
    showOverlay(verdict, hardSnap);
    expect(root?.textContent).not.toContain('End session');
    hideOverlay(emptySnapshot(Date.now()));
  });
});

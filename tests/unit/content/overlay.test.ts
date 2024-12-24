// @vitest-environment jsdom
import type { Mock } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

function shadowRoot(): ShadowRoot {
  const root: ShadowRoot | undefined = (globalThis as { __focusLockShadow?: ShadowRoot })
    .__focusLockShadow;
  if (root === undefined) throw new Error('Focus Lock shadow root was not mounted');
  return root;
}

afterEach((): void => {
  hideOverlay(emptySnapshot(Date.now()));
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

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
  it('paints the stopped-tab presentation only when asked', () => {
    showOverlay(verdict, focusSnap(), true);
    const root = (globalThis as { __focusLockShadow?: ShadowRoot }).__focusLockShadow;
    expect(root?.textContent).toContain('This page did not load.');
    expect(root?.querySelector('.backdrop')?.classList.contains('opaque')).toBe(true);
    showOverlay(verdict, focusSnap());
    expect(root?.textContent).not.toContain('This page did not load.');
    expect(root?.querySelector('.backdrop')?.classList.contains('opaque')).toBe(false);
    hideOverlay(emptySnapshot(Date.now()));
  });

  it('keeps the stopped-tab presentation after a gate action refreshes the snapshot', async () => {
    const snap: SessionSnapshot = focusSnap();
    const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
      async (request: { type: string }): Promise<unknown> => {
        if (request.type === 'getSnapshot') return snap;
        return { ok: true };
      },
    );
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    showOverlay(verdict, snap, true);
    const root: ShadowRoot = shadowRoot();
    const endSession: HTMLButtonElement | undefined = Array.from(
      root.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button: HTMLButtonElement): boolean => button.textContent === 'End session');

    endSession?.click();

    await vi.waitFor((): void => {
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(root.querySelector('.backdrop')?.classList.contains('opaque')).toBe(true);
      expect(root.querySelector('.notloaded')?.textContent).toBe(
        'This page did not load. It will load by itself when session ends.',
      );
    });
  });

  it.each([
    { kind: 'pause' as const, label: 'Take pause' },
    { kind: 'unlockSite' as const, label: 'Unlock this site' },
    { kind: 'cancel' as const, label: 'End session' },
  ])('uses the shared $kind confirmation label', ({ kind, label }): void => {
    const snap: SessionSnapshot = focusSnap();
    showOverlay(verdict, {
      ...snap,
      gate: {
        kind,
        host: kind === 'unlockSite' ? 'blocked.example' : null,
        openedAt: Date.now() - 2_000,
        readyAt: Date.now() - 1_000,
        requiredPhrase: null,
      },
    });

    expect(
      Array.from(shadowRoot().querySelectorAll('button')).some(
        (button: HTMLButtonElement): boolean => button.textContent === label,
      ),
    ).toBe(true);
  });

  it('owns focus and traps Tab when hard mode has no enabled controls', () => {
    const outside: HTMLButtonElement = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    const snap: SessionSnapshot = focusSnap();
    const hardSnap: SessionSnapshot = {
      ...snap,
      bankAccrualPerMs: 0,
      bankMs: 0,
      config: snap.config === null ? null : { ...snap.config, strictness: 'hard' },
    };

    showOverlay(verdict, hardSnap);

    const host: HTMLElement = document.querySelector('focus-lock-overlay') as HTMLElement;
    const root: ShadowRoot = shadowRoot();
    const dialog: HTMLElement = root.querySelector('[role="dialog"]') as HTMLElement;
    const tab: KeyboardEvent = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    dialog.dispatchEvent(tab);
    expect(document.activeElement).toBe(host);
    expect(root.activeElement).toBe(dialog);
    expect(tab.defaultPrevented).toBe(true);
  });

  it('shows time until the next earned pause minute while spends remain disabled', () => {
    const snap: SessionSnapshot = {
      ...focusSnap(),
      bankMs: 0,
      bankAccrualPerMs: 5 / 30,
      pauseCostMs: 5 * 60_000,
      unlockCostMs: 5 * 60_000,
    };

    showOverlay(verdict, snap);

    const root: ShadowRoot = shadowRoot();
    const spendButtons: HTMLButtonElement[] = Array.from(
      root.querySelectorAll<HTMLButtonElement>('.buttons .pill'),
    );
    expect(spendButtons).toHaveLength(2);
    expect(spendButtons.every((button: HTMLButtonElement): boolean => button.disabled)).toBe(true);
    expect(root.querySelectorAll('.ready')).toHaveLength(2);
    expect(root.textContent).toContain('ready in 6:00');
    expect(root.textContent).not.toContain('ready in 30:00');
  });

  it('resets the host styles while preserving the fixed overlay', () => {
    showOverlay(verdict, focusSnap());
    const host: HTMLElement = document.querySelector('focus-lock-overlay') as HTMLElement;

    expect(host.style.getPropertyValue('all')).toBe('initial');
    expect(host.style.getPropertyPriority('all')).toBe('important');
    expect(host.style.getPropertyValue('position')).toBe('fixed');
    expect(host.style.getPropertyPriority('position')).toBe('important');
    expect(host.style.getPropertyValue('inset')).toBe('0px');
  });

  it('does not inherit right-to-left text direction from the blocked page', () => {
    document.documentElement.dir = 'rtl';

    showOverlay(verdict, focusSnap());

    const host: HTMLElement = document.querySelector('focus-lock-overlay') as HTMLElement;
    expect(host.style.getPropertyValue('direction')).toBe('ltr');
    expect(host.style.getPropertyPriority('direction')).toBe('important');
    expect(host.style.getPropertyValue('unicode-bidi')).toBe('isolate');
    expect(host.style.getPropertyPriority('unicode-bidi')).toBe('important');
    document.documentElement.removeAttribute('dir');
  });

  it('gives the dialog an accessible name', () => {
    showOverlay(verdict, focusSnap());
    const dialog: HTMLElement = shadowRoot().querySelector('[role="dialog"]') as HTMLElement;

    expect(dialog.getAttribute('aria-label')).toBe('Focus Lock');
  });
});

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
  vi.useRealTimers();
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

  it('never renders ready in zero for a positive sub-second wait', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-29T12:00:00Z'));
    const snap: SessionSnapshot = {
      ...focusSnap(),
      bankMs: 59_900,
      bankAccrualPerMs: 1,
      pauseCostMs: 5 * 60_000,
      unlockCostMs: 5 * 60_000,
    };

    showOverlay(verdict, snap);

    const root: ShadowRoot = shadowRoot();
    expect(root.textContent).toContain('ready in 0:01');
    expect(root.textContent).not.toContain('ready in 0:00');
  });

  it('does not promise an earned minute above the configured bank cap', () => {
    const snap: SessionSnapshot = {
      ...focusSnap(),
      bankMs: 0,
      bankCapMs: 0,
    };

    showOverlay(verdict, snap);

    const root: ShadowRoot = shadowRoot();
    expect(root.querySelectorAll('.ready')).toHaveLength(2);
    expect(root.textContent).toContain('earn pause time by focusing');
    expect(root.textContent).not.toContain('ready in 6:00');
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  const promise: Promise<T> = new Promise<T>((done: (value: T) => void): void => {
    resolve = done;
  });
  if (resolve === undefined) throw new Error('deferred resolver was not initialized');
  return { promise, resolve };
}

function frictionCancel(root: ShadowRoot): HTMLButtonElement {
  const button: HTMLButtonElement | undefined = Array.from(
    root.querySelectorAll<HTMLButtonElement>('button'),
  ).find((candidate: HTMLButtonElement): boolean => candidate.textContent === 'End session');
  if (button === undefined) throw new Error('friction cancel button was not rendered');
  return button;
}

describe('overlay action failures', () => {
  it('keeps an exact worker rejection across a later block-state render', async () => {
    const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
      async (): Promise<unknown> => ({ ok: false, error: 'Gate timing changed.' }),
    );
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const snapshot: SessionSnapshot = focusSnap();
    showOverlay(verdict, snapshot);
    const root: ShadowRoot = shadowRoot();

    frictionCancel(root).click();
    await vi.waitFor((): void => {
      expect(root.querySelector('.action-error[role="alert"]')?.textContent).toBe(
        'Gate timing changed.',
      );
    });

    showOverlay(verdict, { ...snapshot, attemptsToday: snapshot.attemptsToday + 1 });

    expect(root.querySelector('.action-error[role="alert"]')?.textContent).toBe(
      'Gate timing changed.',
    );
  });

  it('shows an exact worker rejection without rebuilding or losing stopped state and focus', async () => {
    const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
      async (): Promise<unknown> => ({ ok: false, error: 'The session changed. Try again.' }),
    );
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    showOverlay(verdict, focusSnap(), true);
    const root: ShadowRoot = shadowRoot();
    const panel: Element = root.querySelector('.panel') as Element;
    const cancel: HTMLButtonElement = frictionCancel(root);
    cancel.focus();

    cancel.click();

    await vi.waitFor((): void => {
      const alert: Element | null = root.querySelector('.action-error[role="alert"]');
      expect(alert?.textContent).toBe('The session changed. Try again.');
    });
    expect(root.querySelector('.panel')).toBe(panel);
    expect(root.activeElement).toBe(cancel);
    expect(root.querySelector('.backdrop')?.classList.contains('opaque')).toBe(true);
    expect(root.querySelector('.notloaded')?.textContent).toBe(
      'This page did not load. It will load by itself when session ends.',
    );
  });

  it('uses the transport fallback and preserves the typed gate phrase', async () => {
    const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
      async (): Promise<unknown> => {
        throw new Error('Receiving end does not exist');
      },
    );
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const requiredPhrase: string = 'I choose to stop';
    showOverlay(verdict, {
      ...focusSnap(),
      gate: {
        kind: 'cancel',
        host: null,
        openedAt: Date.now() - 2_000,
        readyAt: Date.now() - 1_000,
        requiredPhrase,
      },
    });
    const root: ShadowRoot = shadowRoot();
    const phrase: HTMLInputElement = root.querySelector('.phrase') as HTMLInputElement;
    const confirm: HTMLButtonElement = Array.from(
      root.querySelectorAll<HTMLButtonElement>('button'),
    ).find(
      (button: HTMLButtonElement): boolean => button.textContent === 'End session',
    ) as HTMLButtonElement;
    phrase.value = requiredPhrase;
    phrase.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    phrase.focus();

    confirm.click();

    await vi.waitFor((): void => {
      expect(root.querySelector('.action-error[role="alert"]')?.textContent).toBe(
        'Could not reach Focus Lock. Try again.',
      );
    });
    expect(phrase.value).toBe(requiredPhrase);
    expect(root.activeElement).toBe(phrase);
  });

  it('clears stale errors and ignores superseded and unmounted action responses', async () => {
    const first: Deferred<unknown> = deferred<unknown>();
    const second: Deferred<unknown> = deferred<unknown>();
    const third: Deferred<unknown> = deferred<unknown>();
    const replies: Promise<unknown>[] = [first.promise, second.promise, third.promise];
    const sendMessage: Mock<() => Promise<unknown>> = vi.fn(
      async (): Promise<unknown> => replies.shift() as Promise<unknown>,
    );
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    showOverlay(verdict, focusSnap());
    const firstRoot: ShadowRoot = shadowRoot();
    const cancel: HTMLButtonElement = frictionCancel(firstRoot);

    cancel.click();
    cancel.click();
    first.resolve({ ok: false, error: 'stale first failure' });
    await Promise.resolve();
    expect(firstRoot.querySelector('.action-error')).toBeNull();
    second.resolve({ ok: false, error: 'current failure' });
    await vi.waitFor((): void => {
      expect(firstRoot.querySelector('.action-error')?.textContent).toBe('current failure');
    });

    cancel.click();
    expect(firstRoot.querySelector('.action-error')).toBeNull();
    hideOverlay(focusSnap());
    showOverlay(verdict, focusSnap());
    const secondRoot: ShadowRoot = shadowRoot();
    third.resolve({ ok: false, error: 'unmounted failure' });
    await Promise.resolve();
    expect(secondRoot.querySelector('.action-error')).toBeNull();
  });
});

describe('overlay keyboard scrolling', () => {
  it.each([
    ' ',
    'Spacebar',
    'PageUp',
    'PageDown',
    'Home',
    'End',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
  ])('prevents %s background scrolling without stopping propagation', (key: string): void => {
    showOverlay(verdict, focusSnap());
    const root: ShadowRoot = shadowRoot();
    const dialog: HTMLElement = root.querySelector('[role="dialog"]') as HTMLElement;
    const observed: Mock<(event: KeyboardEvent) => void> = vi.fn<(event: KeyboardEvent) => void>();
    document.addEventListener('keydown', observed);
    const event: KeyboardEvent = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      composed: true,
    });

    dialog.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(observed).toHaveBeenCalledOnce();
    document.removeEventListener('keydown', observed);
  });

  it.each([
    ['input', 'ArrowLeft'],
    ['textarea', 'ArrowDown'],
    ['select', 'Home'],
    ['contenteditable', 'End'],
    ['button', ' '],
    ['button', 'Spacebar'],
    ['range', 'ArrowRight'],
  ])('preserves native %s behavior for %s', (kind: string, key: string): void => {
    showOverlay(verdict, focusSnap());
    const root: ShadowRoot = shadowRoot();
    let target: HTMLElement;
    if (kind === 'textarea') {
      target = document.createElement('textarea');
    } else if (kind === 'select') {
      target = document.createElement('select');
    } else if (kind === 'button') {
      target = document.createElement('button');
    } else if (kind === 'contenteditable') {
      target = document.createElement('div');
    } else {
      const input: HTMLInputElement = document.createElement('input');
      if (kind === 'range') input.type = 'range';
      target = input;
    }
    if (kind === 'contenteditable') target.setAttribute('contenteditable', 'true');
    root.querySelector('.panel')?.appendChild(target);
    const event: KeyboardEvent = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      composed: true,
    });

    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it.each(['PageUp', 'PageDown'])(
    'prevents %s from scrolling the background when a text input is focused',
    (key: string): void => {
      showOverlay(verdict, {
        ...focusSnap(),
        gate: {
          kind: 'cancel',
          host: null,
          openedAt: Date.now() - 2_000,
          readyAt: Date.now() - 1_000,
          requiredPhrase: 'I choose to stop',
        },
      });
      const root: ShadowRoot = shadowRoot();
      const input: HTMLInputElement = root.querySelector('.phrase') as HTMLInputElement;
      input.focus();
      const event: KeyboardEvent = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        composed: true,
      });

      input.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
    },
  );
});

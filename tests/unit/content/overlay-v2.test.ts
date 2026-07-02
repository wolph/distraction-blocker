// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveViewInputV2 } from '../../../src/background/overlay-view-v2';
import { buildActiveOverlayView } from '../../../src/background/overlay-view-v2';
import { clearDocumentOverlay, renderDocumentOverlay } from '../../../src/content/overlay-v2';
import { DEFAULT_LISTS, rulesFromLists } from '../../../src/shared/constants';
import type { DocumentOverlayView } from '../../../src/shared/enforcement-v2';
import { formatClock } from '../../../src/shared/time';
import type {
  GateState,
  SessionConfigV2,
  SessionStateV2,
  Verdict,
} from '../../../src/shared/types';

type StartingOverlay = Extract<DocumentOverlayView, { presentation: 'starting' }>;
type ActiveOverlay = Extract<DocumentOverlayView, { presentation: 'active' }>;
type ActiveCopy = ActiveOverlay['copy'];
type ActiveEconomy = ActiveOverlay['economy'];

const NOW: number = 1_750_000_000_000;
const SESSION_ID: string = '10000000-0000-4000-8000-000000000001';
const PROVENANCE: string = 'Blocked by Social media: example.com';
const STOPPED_COPY: NonNullable<StartingOverlay['copy']['stoppedPage']> =
  'This page did not load. It will load by itself when the session ends.';
const UNTIL_STOPPED_TEXT: Extract<ActiveCopy['status'], { kind: 'until-stopped' }>['text'] =
  'Focus Lock is active until you end it from the popup.';
const TRANSPORT_ERROR: ActiveCopy['transportError'] =
  'Focus Lock could not update this action. Try again.';
const BLOCKED_VERDICT: Verdict = {
  blocked: true,
  reason: 'category',
  categoryId: 'social',
  matchedPattern: 'example.com',
};

function affordableEconomy(overrides: Partial<ActiveEconomy> = {}): ActiveEconomy {
  return {
    bankMs: 300_000,
    bankAccrualPerMs: 0.2,
    bankCapMs: 300_000,
    pauseCostMs: 60_000,
    unlockCostMs: 120_000,
    ...overrides,
  };
}

function activeCopy(overrides: Partial<ActiveCopy> = {}): ActiveCopy {
  return {
    status: { kind: 'timed', text: 'Locked until 14:35' },
    lockedUntil: '14:35',
    intention: 'Finish the release notes',
    attempts: '2 attempts blocked today',
    verdictProvenance: PROVENANCE,
    stoppedPage: null,
    bankUnit: 'site access credit',
    pauseAction: 'Pause blocking for 1 min',
    unlockAction: 'Unlock this site for 2 min',
    endAction: 'End session',
    bankWaitFallback: 'earn site access credit by focusing',
    bankWaitPrefix: 'Ready in',
    gateTitle: null,
    gateBack: 'Never mind, back to work',
    gatePhraseLabel: 'Type this to confirm:',
    gateConfirm: null,
    transportError: TRANSPORT_ERROR,
    ...overrides,
  };
}

function activeOverlay(overrides: Partial<ActiveOverlay> = {}): ActiveOverlay {
  return {
    version: 1,
    presentation: 'active',
    theme: 'dark',
    sessionId: SESSION_ID,
    phase: 'focus',
    mode: 'blacklist',
    strictness: 'flexible',
    duration: { kind: 'timed', minutes: 25 },
    timing: {
      capturedAt: NOW,
      phaseStartedAt: NOW - 1_000,
      phaseEndsAt: NOW + 60_000,
      sessionEndsAt: NOW + 120_000,
    },
    economy: affordableEconomy(),
    gate: null,
    activeUnlocks: [],
    attemptsToday: 2,
    stoppedPage: false,
    actions: { state: 'ready', end: 'request-end', pause: 'request-gate', unlock: 'request-gate' },
    copy: activeCopy(),
    ...overrides,
  };
}

function untilStoppedOverlay(overrides: Partial<ActiveOverlay> = {}): ActiveOverlay {
  return activeOverlay({
    duration: { kind: 'until-stopped' },
    timing: {
      capturedAt: NOW,
      phaseStartedAt: NOW - 1_000,
      phaseEndsAt: null,
      sessionEndsAt: null,
    },
    actions: { state: 'ready', end: 'hidden', pause: 'request-gate', unlock: 'request-gate' },
    copy: activeCopy({
      status: { kind: 'until-stopped', text: UNTIL_STOPPED_TEXT },
      lockedUntil: null,
    }),
    ...overrides,
  });
}

function gateState(overrides: Partial<GateState> = {}): GateState {
  return {
    kind: 'pause',
    host: null,
    openedAt: NOW - 10_000,
    readyAt: NOW - 1_000,
    requiredPhrase: 'let me scroll',
    ...overrides,
  };
}

function gatedOverlay(overrides: Partial<ActiveOverlay> = {}): ActiveOverlay {
  return activeOverlay({
    gate: gateState(),
    actions: { state: 'gate', end: 'hidden', pause: 'hidden', unlock: 'hidden' },
    copy: activeCopy({ gateTitle: 'Take a 1 min pause', gateConfirm: 'Take the pause' }),
    ...overrides,
  });
}

function startingOverlay(overrides: Partial<StartingOverlay> = {}): StartingOverlay {
  return {
    version: 1,
    presentation: 'starting',
    capturedAt: NOW,
    theme: 'dark',
    stoppedPage: false,
    copy: {
      title: 'Focus Lock is starting',
      detail: 'Applying your selected rules.',
      verdictProvenance: PROVENANCE,
      stoppedPage: null,
    },
    actions: { end: 'hidden' },
    ...overrides,
  };
}

function shadowRoot(): ShadowRoot {
  const root: ShadowRoot | undefined = (globalThis as { __focusLockShadow?: ShadowRoot })
    .__focusLockShadow;
  if (root === undefined) throw new Error('Focus Lock shadow root was not mounted');
  return root;
}

function text(selector: string): string {
  const element: Element | null = shadowRoot().querySelector(selector);
  if (element === null) throw new Error(`missing overlay element: ${selector}`);
  return element.textContent ?? '';
}

function buttons(): HTMLButtonElement[] {
  return Array.from(shadowRoot().querySelectorAll<HTMLButtonElement>('button'));
}

function buttonStartingWith(label: string): HTMLButtonElement {
  const found: HTMLButtonElement | undefined = buttons().find(
    (button: HTMLButtonElement): boolean => (button.textContent ?? '').startsWith(label),
  );
  if (found === undefined) throw new Error(`missing overlay button: ${label}`);
  return found;
}

function stubWorker(response: unknown): Mock<(request: unknown) => Promise<unknown>> {
  const sendMessage: Mock<(request: unknown) => Promise<unknown>> = vi.fn(
    async (): Promise<unknown> => response,
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  return sendMessage;
}

beforeEach((): void => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach((): void => {
  clearDocumentOverlay();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('renderDocumentOverlay starting view', () => {
  it('renders the exact starting copy and no live controls', () => {
    renderDocumentOverlay(startingOverlay(), BLOCKED_VERDICT);

    expect(text('.intention')).toBe('Focus Lock is starting');
    expect(text('.until')).toBe('Applying your selected rules.');
    expect(text('.provenance')).toBe(PROVENANCE);
    expect(shadowRoot().querySelector('.clock')).toBeNull();
    expect(shadowRoot().querySelector('.meter')).toBeNull();
    expect(shadowRoot().querySelector('.bank')).toBeNull();
    expect(buttons()).toHaveLength(0);
    expect(shadowRoot().querySelector('.backdrop')?.className).toBe('backdrop');
  });

  it('paints a stopped starting page with its exact copy and an opaque backdrop', () => {
    renderDocumentOverlay(
      startingOverlay({
        stoppedPage: true,
        copy: {
          title: 'Focus Lock is starting',
          detail: 'Applying your selected rules.',
          verdictProvenance: PROVENANCE,
          stoppedPage: STOPPED_COPY,
        },
      }),
      BLOCKED_VERDICT,
    );

    expect(text('.notloaded')).toBe(STOPPED_COPY);
    expect(shadowRoot().querySelector('.backdrop')?.classList.contains('opaque')).toBe(true);
  });
});

describe('renderDocumentOverlay active view', () => {
  it('renders the timed page with a locally ticking clock and its exact copy', () => {
    renderDocumentOverlay(activeOverlay(), BLOCKED_VERDICT);

    expect(text('.until')).toBe('Locked until 14:35');
    expect(text('.until')).not.toBe('14:35');
    expect(text('.clock')).toBe(formatClock(60_000));
    expect(text('.intention')).toBe('Finish the release notes');
    expect(text('.attempts')).toBe('2 attempts blocked today');
    expect(text('.provenance')).toBe(PROVENANCE);
    expect(text('.bank')).toBe(`${formatClock(300_000)} site access credit`);
    expect(shadowRoot().querySelector('.meter-fill')?.getAttribute('style')).toContain('width');
    expect(buttonStartingWith('Pause blocking for 1 min')).toBeInstanceOf(HTMLButtonElement);
    expect(buttonStartingWith('Unlock this site for 2 min')).toBeInstanceOf(HTMLButtonElement);
    expect(buttonStartingWith('End session')).toBeInstanceOf(HTMLButtonElement);

    vi.advanceTimersByTime(5_000);

    expect(text('.clock')).toBe(formatClock(55_000));
  });

  it('hides the end action unless the view asks for it', () => {
    renderDocumentOverlay(
      activeOverlay({
        actions: { state: 'ready', end: 'hidden', pause: 'request-gate', unlock: 'request-gate' },
      }),
      BLOCKED_VERDICT,
    );

    expect(shadowRoot().textContent).not.toContain('End session');
    expect(buttons()).toHaveLength(2);
  });

  it('renders the until-stopped page without a clock, locked-until line, or end action', () => {
    renderDocumentOverlay(untilStoppedOverlay(), BLOCKED_VERDICT);

    expect(text('.until')).toBe(UNTIL_STOPPED_TEXT);
    expect(shadowRoot().textContent).not.toContain('Locked until');
    expect(shadowRoot().querySelector('.clock')).toBeNull();
    expect(shadowRoot().textContent).not.toContain('End session');
    expect(buttons()).toHaveLength(2);
  });

  it('ticks bank affordability locally from the economy row', () => {
    renderDocumentOverlay(
      activeOverlay({ economy: affordableEconomy({ bankMs: 0, bankAccrualPerMs: 0.5 }) }),
      BLOCKED_VERDICT,
    );
    const pause: HTMLButtonElement = buttonStartingWith('Pause blocking for 1 min');

    expect(pause.disabled).toBe(true);
    expect(pause.textContent).toBe('Pause blocking for 1 minReady in 2:00');

    vi.advanceTimersByTime(1_000);

    expect(pause.textContent).toBe('Pause blocking for 1 minReady in 1:59');
    expect(text('.bank')).toBe(`${formatClock(500)} site access credit`);

    vi.advanceTimersByTime(119_000);

    expect(pause.disabled).toBe(false);
    expect(pause.textContent).toBe('Pause blocking for 1 min');
  });

  it('falls back to the earned-time copy when the bank can never reach the next minute', () => {
    renderDocumentOverlay(
      activeOverlay({ economy: affordableEconomy({ bankMs: 0, bankAccrualPerMs: 0 }) }),
      BLOCKED_VERDICT,
    );
    const pause: HTMLButtonElement = buttonStartingWith('Pause blocking for 1 min');

    expect(pause.disabled).toBe(true);
    expect(pause.textContent).toBe('Pause blocking for 1 minearn site access credit by focusing');
  });

  it('renders the gate with its exact copy and hides the ordinary actions', () => {
    renderDocumentOverlay(gatedOverlay(), BLOCKED_VERDICT);

    expect(text('.gate-title')).toBe('Take a 1 min pause');
    expect(text('.primary')).toBe('Never mind, back to work');
    expect(text('.phrase-label')).toBe('Type this to confirm:');
    expect(text('.phrase-text')).toBe('let me scroll');
    expect(shadowRoot().querySelector('input.phrase')).toBeInstanceOf(HTMLInputElement);
    expect(text('.gate .pill')).toBe('Take the pause');
    expect(shadowRoot().querySelector('.buttons')).toBeNull();
    expect(shadowRoot().textContent).not.toContain('Pause blocking for 1 min');
    expect(shadowRoot().textContent).not.toContain('Unlock this site for 2 min');
    expect(shadowRoot().textContent).not.toContain('End session');
  });

  it('omits the phrase input when the gate requires no phrase', () => {
    renderDocumentOverlay(
      gatedOverlay({ gate: gateState({ requiredPhrase: null }) }),
      BLOCKED_VERDICT,
    );

    expect(shadowRoot().querySelector('input.phrase')).toBeNull();
    expect(shadowRoot().textContent).not.toContain('Type this to confirm:');
  });

  it('counts a pending gate down locally and enables confirm only when it is ready', () => {
    renderDocumentOverlay(
      gatedOverlay({ gate: gateState({ openedAt: NOW, readyAt: NOW + 5_000 }) }),
      BLOCKED_VERDICT,
    );
    const confirm: HTMLButtonElement = shadowRoot().querySelector(
      '.gate .pill',
    ) as HTMLButtonElement;

    expect(confirm.hidden).toBe(true);
    expect(text('.ring-count')).toBe('5');

    vi.advanceTimersByTime(5_000);

    expect(confirm.hidden).toBe(false);
    expect(confirm.disabled).toBe(true);
  });

  it('replaces the panel in place and applies the newer theme', () => {
    renderDocumentOverlay(activeOverlay(), BLOCKED_VERDICT);
    const host: HTMLElement = document.querySelector('focus-lock-overlay') as HTMLElement;
    const root: ShadowRoot = shadowRoot();
    const panel: Element | null = root.querySelector('.panel');

    renderDocumentOverlay(
      activeOverlay({
        theme: 'light',
        attemptsToday: 3,
        copy: activeCopy({ attempts: '3 attempts blocked today' }),
      }),
      BLOCKED_VERDICT,
    );

    expect(document.querySelector('focus-lock-overlay')).toBe(host);
    expect(shadowRoot()).toBe(root);
    expect(root.querySelector('.panel')).not.toBe(panel);
    expect(host.dataset.theme).toBe('light');
    expect(text('.attempts')).toBe('3 attempts blocked today');
  });

  it('keeps the rendered panel for a structurally identical view', () => {
    renderDocumentOverlay(activeOverlay(), BLOCKED_VERDICT);
    const panel: Element | null = shadowRoot().querySelector('.panel');

    renderDocumentOverlay(activeOverlay(), BLOCKED_VERDICT);

    expect(shadowRoot().querySelector('.panel')).toBe(panel);
  });
});

describe('clearDocumentOverlay', () => {
  it('removes the host and stops the local tick', () => {
    renderDocumentOverlay(activeOverlay(), BLOCKED_VERDICT);
    expect(vi.getTimerCount()).toBe(1);

    clearDocumentOverlay();

    expect(document.querySelector('focus-lock-overlay')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is safe with nothing mounted', () => {
    expect((): void => clearDocumentOverlay()).not.toThrow();
  });
});

describe('overlay-v2 source boundary', () => {
  it('never reads the public session snapshot', () => {
    const source: string = readFileSync(resolve('src/content/overlay-v2.ts'), 'utf8');

    expect(source).not.toMatch(/SessionSnapshot/);
  });
});

describe('overlay-v2 actions', () => {
  it('sends the exact worker request for every action control', async (): Promise<void> => {
    const sendMessage: Mock<(request: unknown) => Promise<unknown>> = stubWorker({ ok: true });
    renderDocumentOverlay(activeOverlay(), BLOCKED_VERDICT);

    buttonStartingWith('Pause blocking for 1 min').click();
    await vi.advanceTimersByTimeAsync(0);
    buttonStartingWith('Unlock this site for 2 min').click();
    await vi.advanceTimersByTimeAsync(0);
    buttonStartingWith('End session').click();
    await vi.advanceTimersByTimeAsync(0);

    expect(sendMessage.mock.calls.map((call: [unknown]): unknown => call[0])).toEqual([
      { type: 'openGate', gate: 'pause', host: null },
      { type: 'openGate', gate: 'unlockSite', host: window.location.hostname },
      { type: 'requestSessionEnd' },
    ]);
  });

  it('opens the End gate instead of ending outright when the view says so', async (): Promise<void> => {
    // The Friction route. `requestSessionEnd` is refused for any strictness but Flexible, so the
    // blocked page has to ask for the cancel gate the way the popup does, or its End control
    // answers with a transport error on every press.
    const sendMessage: Mock<(request: unknown) => Promise<unknown>> = stubWorker({ ok: true });
    renderDocumentOverlay(
      activeOverlay({
        actions: {
          state: 'ready',
          end: 'open-end-gate',
          pause: 'request-gate',
          unlock: 'request-gate',
        },
      }),
      BLOCKED_VERDICT,
    );

    buttonStartingWith('End session').click();
    await vi.advanceTimersByTimeAsync(0);

    expect(sendMessage.mock.calls.map((call: [unknown]): unknown => call[0])).toEqual([
      { type: 'openEndGate' },
    ]);
  });

  it('renders no End control when the view hides it', (): void => {
    stubWorker({ ok: true });
    renderDocumentOverlay(
      activeOverlay({
        actions: { state: 'ready', end: 'hidden', pause: 'request-gate', unlock: 'request-gate' },
      }),
      BLOCKED_VERDICT,
    );

    expect(
      [...shadowRoot().querySelectorAll('button')].some(
        (button: HTMLButtonElement): boolean => button.textContent === 'End session',
      ),
    ).toBe(false);
  });

  it('names the reason the gate confirm is refusing on the blocked page too', (): void => {
    stubWorker({ ok: true });
    renderDocumentOverlay(
      gatedOverlay({ gate: gateState({ openedAt: NOW, readyAt: NOW + 5_000 }) }),
      BLOCKED_VERDICT,
    );
    const confirm: HTMLButtonElement = shadowRoot().querySelector(
      '.gate .pill',
    ) as HTMLButtonElement;

    const waitId: string = confirm.getAttribute('aria-describedby') ?? '';
    expect(shadowRoot().getElementById(waitId)).not.toBeNull();

    renderDocumentOverlay(gatedOverlay(), BLOCKED_VERDICT);
    const ready: HTMLButtonElement = shadowRoot().querySelector('.gate .pill') as HTMLButtonElement;
    const phraseId: string = ready.getAttribute('aria-describedby') ?? '';

    expect(ready.disabled).toBe(true);
    expect(shadowRoot().getElementById(phraseId)?.textContent).toBe('let me scroll');

    const phrase: HTMLInputElement = shadowRoot().querySelector('input.phrase') as HTMLInputElement;
    phrase.value = 'let me scroll';
    phrase.dispatchEvent(new Event('input'));

    expect(ready.disabled).toBe(false);
    expect(ready.getAttribute('aria-describedby')).toBeNull();
  });

  it('keeps the typed phrase and the caret when a blocked attempt repaints the same gate', (): void => {
    stubWorker({ ok: true });
    renderDocumentOverlay(gatedOverlay(), BLOCKED_VERDICT);
    const phrase: HTMLInputElement = shadowRoot().querySelector('input.phrase') as HTMLInputElement;
    phrase.focus();
    phrase.value = 'let me scr';
    phrase.setSelectionRange(4, 7);

    // The only difference is the day's attempt count, which every open overlay carries and which
    // any blocked attempt in any tab moves.
    renderDocumentOverlay(gatedOverlay({ attemptsToday: 9 }), BLOCKED_VERDICT);

    const after: HTMLInputElement = shadowRoot().querySelector('input.phrase') as HTMLInputElement;
    expect(after.value).toBe('let me scr');
    expect(shadowRoot().activeElement).toBe(after);
    expect([after.selectionStart, after.selectionEnd]).toEqual([4, 7]);
  });

  it('drops the typed phrase when the repaint carries a different gate', (): void => {
    stubWorker({ ok: true });
    renderDocumentOverlay(gatedOverlay(), BLOCKED_VERDICT);
    const phrase: HTMLInputElement = shadowRoot().querySelector('input.phrase') as HTMLInputElement;
    phrase.value = 'let me scroll';

    // A reopened gate is a different gate, and must not inherit what was typed into the last one.
    renderDocumentOverlay(
      gatedOverlay({ gate: gateState({ openedAt: NOW + 1, readyAt: NOW + 5_000 }) }),
      BLOCKED_VERDICT,
    );

    const after: HTMLInputElement = shadowRoot().querySelector('input.phrase') as HTMLInputElement;
    expect(after.value).toBe('');
  });

  it('leaves the confirm button enabled when the carried phrase already matched', (): void => {
    stubWorker({ ok: true });
    renderDocumentOverlay(gatedOverlay(), BLOCKED_VERDICT);
    const phrase: HTMLInputElement = shadowRoot().querySelector('input.phrase') as HTMLInputElement;
    phrase.value = 'let me scroll';
    phrase.dispatchEvent(new Event('input'));

    renderDocumentOverlay(gatedOverlay({ attemptsToday: 9 }), BLOCKED_VERDICT);

    const confirm: HTMLButtonElement = shadowRoot().querySelector(
      '.gate .pill',
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
  });

  it('sends the gate requests with the typed phrase', async (): Promise<void> => {
    const sendMessage: Mock<(request: unknown) => Promise<unknown>> = stubWorker({ ok: true });
    renderDocumentOverlay(gatedOverlay(), BLOCKED_VERDICT);
    const phrase: HTMLInputElement = shadowRoot().querySelector('input.phrase') as HTMLInputElement;
    const confirm: HTMLButtonElement = shadowRoot().querySelector(
      '.gate .pill',
    ) as HTMLButtonElement;

    phrase.value = 'let me scroll';
    phrase.dispatchEvent(new Event('input'));
    confirm.click();
    await vi.advanceTimersByTimeAsync(0);
    (shadowRoot().querySelector('.primary') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(0);

    expect(sendMessage.mock.calls.map((call: [unknown]): unknown => call[0])).toEqual([
      { type: 'confirmGate', typedPhrase: 'let me scroll', expectedGate: gateState() },
      { type: 'abandonGate', expectedGate: gateState() },
    ]);
  });

  it('releases an old pending action when the authoritative gate changes and ignores its late failure', async (): Promise<void> => {
    let resolveOld!: (value: unknown) => void;
    let resolveNew!: (value: unknown) => void;
    const sendMessage: Mock<(request: unknown) => Promise<unknown>> = stubWorker({ ok: true });
    sendMessage.mockReturnValueOnce(
      new Promise<unknown>((resolve: (value: unknown) => void): void => {
        resolveOld = resolve;
      }),
    );
    sendMessage.mockReturnValueOnce(
      new Promise<unknown>((resolve: (value: unknown) => void): void => {
        resolveNew = resolve;
      }),
    );
    renderDocumentOverlay(activeOverlay(), BLOCKED_VERDICT);
    const pause: HTMLButtonElement | undefined = Array.from(
      shadowRoot().querySelectorAll('button'),
    ).find(
      (button: HTMLButtonElement): boolean =>
        button.textContent?.startsWith('Pause blocking') === true,
    );
    if (pause === undefined) throw new Error('Expected a pause button');
    pause.click();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    renderDocumentOverlay(gatedOverlay(), BLOCKED_VERDICT);
    expect((shadowRoot().querySelector('.primary') as HTMLButtonElement).disabled).toBe(false);
    (shadowRoot().querySelector('.primary') as HTMLButtonElement).click();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    resolveOld({ ok: false, error: 'old action failed' });
    await vi.advanceTimersByTimeAsync(0);
    expect(shadowRoot().querySelector('.action-error')).toBeNull();
    expect((shadowRoot().querySelector('.primary') as HTMLButtonElement).disabled).toBe(true);
    resolveNew({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect((shadowRoot().querySelector('.primary') as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(['replaced', 'cleared', 'same'] as const)(
    'handles a %s gate while its old action is pending',
    async (change: 'replaced' | 'cleared' | 'same'): Promise<void> => {
      let resolveOld!: (value: unknown) => void;
      const sendMessage: Mock<(request: unknown) => Promise<unknown>> = stubWorker({ ok: true });
      sendMessage.mockReturnValueOnce(
        new Promise<unknown>((resolve: (value: unknown) => void): void => {
          resolveOld = resolve;
        }),
      );
      renderDocumentOverlay(gatedOverlay(), BLOCKED_VERDICT);
      (shadowRoot().querySelector('.primary') as HTMLButtonElement).click();
      const next: ActiveOverlay =
        change === 'cleared'
          ? activeOverlay()
          : change === 'same'
            ? gatedOverlay({ attemptsToday: 9 })
            : gatedOverlay({ gate: gateState({ openedAt: NOW - 20_000 }) });
      renderDocumentOverlay(next, BLOCKED_VERDICT);
      const buttons: HTMLButtonElement[] = Array.from(shadowRoot().querySelectorAll('button'));
      expect(buttons.every((button: HTMLButtonElement): boolean => button.disabled)).toBe(
        change === 'same',
      );
      resolveOld({ ok: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(shadowRoot().querySelector('.action-error') !== null).toBe(change === 'same');
    },
  );

  it('shows the view transport error on a rejected action and re-enables the controls', async (): Promise<void> => {
    stubWorker({ ok: false, error: 'gate timing changed' });
    renderDocumentOverlay(activeOverlay(), BLOCKED_VERDICT);
    const pause: HTMLButtonElement = buttonStartingWith('Pause blocking for 1 min');

    pause.click();

    expect(buttons().every((button: HTMLButtonElement): boolean => button.disabled)).toBe(true);

    await vi.advanceTimersByTimeAsync(0);

    expect(shadowRoot().querySelector('.action-error[role="alert"]')?.textContent).toBe(
      TRANSPORT_ERROR,
    );
    expect(pause.disabled).toBe(false);
  });

  it('shows the view transport error when the worker channel throws', async (): Promise<void> => {
    const sendMessage: Mock<(request: unknown) => Promise<unknown>> = vi.fn(
      async (): Promise<unknown> => {
        throw new Error('receiving end does not exist');
      },
    );
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    renderDocumentOverlay(activeOverlay(), BLOCKED_VERDICT);

    buttonStartingWith('End session').click();
    await vi.advanceTimersByTimeAsync(0);

    expect(shadowRoot().querySelector('.action-error[role="alert"]')?.textContent).toBe(
      TRANSPORT_ERROR,
    );
  });
});

/**
 * The worker owns every word on this page, so one test drives the real builders through the real
 * renderer. A convention change on either side breaks here instead of on a user's blocked page.
 */
describe('renderDocumentOverlay against the worker builders', () => {
  const LOCKED_AT: number = new Date(2026, 8, 3, 14, 0).getTime();

  function builderConfig(overrides: Partial<SessionConfigV2> = {}): SessionConfigV2 {
    return {
      mode: 'blacklist',
      strictness: 'flexible',
      duration: { kind: 'timed', minutes: 35 },
      cycling: null,
      intention: 'Finish the release notes',
      source: 'manual',
      scheduleOccurrence: null,
      rules: rulesFromLists(DEFAULT_LISTS),
      ...overrides,
    };
  }

  function builderSession(overrides: Partial<SessionConfigV2> = {}): SessionStateV2 {
    return {
      version: 2,
      sessionId: SESSION_ID,
      config: builderConfig(overrides),
      startedAt: LOCKED_AT - 60_000,
      sessionEndsAt: new Date(2026, 8, 3, 14, 35).getTime(),
      phase: 'focus',
      phaseStartedAt: LOCKED_AT - 60_000,
      phaseEndsAt: LOCKED_AT + 60_000,
      cycleIndex: 0,
      pausedFrom: null,
      focusedMs: 60_000,
    };
  }

  function builderInput(session: SessionStateV2): ActiveViewInputV2 {
    return {
      targetUrl: 'https://example.com',
      capturedAt: LOCKED_AT,
      theme: 'dark',
      session,
      economy: affordableEconomy(),
      gate: null,
      activeUnlocks: [],
      attemptsToday: 2,
      stoppedPage: false,
      verdict: BLOCKED_VERDICT,
    };
  }

  it('leads a timed page with the sentence the worker wrote, never the bare clock', () => {
    vi.setSystemTime(LOCKED_AT);
    const view: DocumentOverlayView = buildActiveOverlayView(builderInput(builderSession()));

    renderDocumentOverlay(view, BLOCKED_VERDICT);

    expect(text('.until')).toBe('Locked until 14:35');
    expect(text('.until')).not.toBe('14:35');
    expect(text('.clock')).toBe(formatClock(60_000));
  });

  it('leads an until-stopped page with the popup-only sentence and no clock', () => {
    vi.setSystemTime(LOCKED_AT);
    const view: DocumentOverlayView = buildActiveOverlayView(
      builderInput({
        ...builderSession({ duration: { kind: 'until-stopped' } }),
        sessionEndsAt: null,
        phaseEndsAt: null,
      }),
    );

    renderDocumentOverlay(view, BLOCKED_VERDICT);

    expect(text('.until')).toBe(UNTIL_STOPPED_TEXT);
    expect(shadowRoot().textContent).not.toContain('Locked until');
    expect(shadowRoot().querySelector('.clock')).toBeNull();
  });
});

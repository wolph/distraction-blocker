// @vitest-environment jsdom
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import { hideOverlay, refreshWorkTarget, showOverlay } from '../../../src/content/overlay';
import { emptySnapshot } from '../../../src/shared/constants';
import type { SessionSnapshot, Verdict } from '../../../src/shared/types';

const verdict: Verdict = { blocked: true, reason: 'default', matchedPattern: null };
function snapshot(): SessionSnapshot {
  return {
    ...emptySnapshot(Date.now()),
    startedAt: 1,
    phase: 'focus',
    config: {
      mode: 'blacklist',
      strictness: 'friction',
      durationMin: 3,
      cycling: null,
      intention: '',
      source: 'manual',
      scheduleEntryId: null,
    },
    phaseStartedAt: Date.now() - 60_000,
    phaseEndsAt: Date.now() + 120_000,
    sessionEndsAt: Date.now() + 120_000,
  };
}
function root(): ShadowRoot {
  return (globalThis as unknown as { __focusLockShadow: ShadowRoot }).__focusLockShadow;
}
afterEach((): void => {
  hideOverlay(emptySnapshot(Date.now()));
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('return to work overlay', (): void => {
  it('shows a next step, collapsed site access, and no attempts', (): void => {
    showOverlay(verdict, snapshot());
    expect(root().querySelector('.intention')?.textContent).toBe('Continue your current task');
    expect(root().querySelector('summary')?.textContent).toBe('Need a break or site access?');
    expect(root().querySelector('details')?.open).toBe(false);
    expect(root().querySelector('.attempts')).toBeNull();
  });
  it('preserves the exact gate input, selection, focus and scroll on broadcasts', (): void => {
    const snap: SessionSnapshot = {
      ...snapshot(),
      gate: {
        kind: 'cancel',
        host: null,
        openedAt: 1,
        readyAt: 20_000,
        requiredPhrase: 'I choose to stop',
        forceEndAvailable: false,
      },
    };
    showOverlay(verdict, snap);
    const input: HTMLInputElement = root().querySelector('.phrase') as HTMLInputElement;
    input.value = 'I choose';
    input.focus();
    input.setSelectionRange(2, 5);
    const backdrop: HTMLElement = root().querySelector('.backdrop') as HTMLElement;
    backdrop.scrollTop = 50;
    showOverlay(verdict, { ...snap, theme: 'dark', attemptsToday: 4 });
    expect(root().querySelector('.phrase')).toBe(input);
    expect(input.value).toBe('I choose');
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(5);
    expect(root().activeElement).toBe(input);
    expect(backdrop.scrollTop).toBe(50);
  });
  it('activates the saved target without requesting block state', async (): Promise<void> => {
    const sendMessage: Mock<(req: { type: string }) => Promise<unknown>> = vi.fn(
      async (req: { type: string }): Promise<unknown> =>
        req.type === 'getWorkTarget'
          ? { ok: true, state: 'ready', title: 'Report', sessionId: 'one' }
          : { ok: true },
    );
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    showOverlay(verdict, snapshot());
    await vi.waitFor((): void =>
      expect(root().querySelector('.work-target')?.textContent).toBe('Report'),
    );
    (root().querySelector('.return-work') as HTMLButtonElement).click();
    await vi.waitFor((): void =>
      expect(sendMessage).toHaveBeenCalledWith({ type: 'returnToWork', sessionId: 'one' }),
    );
    expect(
      sendMessage.mock.calls.some(
        ([req]: [{ type: string }]): boolean => req.type === 'getBlockState',
      ),
    ).toBe(false);
  });
});

it('moves initial focus to the ready work button without stealing deliberate focus', async (): Promise<void> => {
  let resolveTarget: (value: unknown) => void = (): void => {};
  const sendMessage: Mock<() => Promise<unknown>> = vi.fn(
    async (): Promise<unknown> =>
      new Promise<unknown>((resolve: (value: unknown) => void): void => {
        resolveTarget = resolve;
      }),
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  showOverlay(verdict, snapshot());
  expect(root().activeElement).toBe(root().querySelector('[role="dialog"]'));
  resolveTarget({ ok: true, state: 'ready', title: 'Report', sessionId: 'one' });
  await vi.waitFor((): void =>
    expect(root().activeElement).toBe(root().querySelector('.return-work')),
  );
});

it('ignores an older target reply and never refreshes the target on timer ticks', async (): Promise<void> => {
  vi.useFakeTimers();
  const resolvers: Array<(value: unknown) => void> = [];
  const sendMessage: Mock<() => Promise<unknown>> = vi.fn(
    async (): Promise<unknown> =>
      new Promise<unknown>((resolve: (value: unknown) => void): void => {
        resolvers.push(resolve);
      }),
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  const snap: SessionSnapshot = snapshot();
  showOverlay(verdict, snap);
  showOverlay(verdict, { ...snap, theme: 'dark' });
  resolvers[1]?.({ ok: true, state: 'ready', title: 'New report', sessionId: 'one' });
  await Promise.resolve();
  await Promise.resolve();
  resolvers[0]?.({ ok: true, state: 'ready', title: 'Old report', sessionId: 'one' });
  await Promise.resolve();
  await Promise.resolve();
  expect(root().querySelector('.work-target')?.textContent).toBe('New report');
  await vi.advanceTimersByTimeAsync(1000);
  expect(sendMessage).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});

it('updates action costs in place while preserving expanded site access', (): void => {
  const snap: SessionSnapshot = snapshot();
  showOverlay(verdict, snap);
  const details: HTMLDetailsElement = root().querySelector('details') as HTMLDetailsElement;
  details.open = true;
  const button: HTMLButtonElement = root().querySelector('.buttons .pill') as HTMLButtonElement;
  showOverlay(verdict, { ...snap, unlockCostMs: 35_000 });
  expect(root().querySelector('details')).toBe(details);
  expect(details.open).toBe(true);
  expect(root().querySelector('.buttons .pill')).toBe(button);
  expect(button.textContent).toContain('Unlock this site 0:35 - costs 0:35 credit');
});

it.each([{ ok: false, error: 'Old return failed' }, { ok: true }])(
  'ignores a stale return reply after a new session starts: %j',
  async (reply: { ok: boolean; error?: string }): Promise<void> => {
    let resolveReturn: (value: unknown) => void = (): void => {};
    let sessionId: string = 'one';
    const sendMessage: Mock<(req: { type: string }) => Promise<unknown>> = vi.fn(
      async (req: { type: string }): Promise<unknown> => {
        if (req.type === 'getWorkTarget')
          return { ok: true, state: 'ready', title: sessionId, sessionId };
        return new Promise<unknown>((resolve: (value: unknown) => void): void => {
          resolveReturn = resolve;
        });
      },
    );
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const snap: SessionSnapshot = snapshot();
    showOverlay(verdict, snap);
    await vi.waitFor((): void =>
      expect(root().querySelector('.work-target')?.textContent).toBe('one'),
    );
    (root().querySelector('.return-work') as HTMLButtonElement).click();
    sessionId = 'two';
    showOverlay(verdict, { ...snap, startedAt: 2 });
    await vi.waitFor((): void =>
      expect(root().querySelector('.work-target')?.textContent).toBe('two'),
    );
    const requestCount: number = sendMessage.mock.calls.length;
    resolveReturn(reply);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(root().querySelector('.action-error')).toBeNull();
    expect(root().querySelector('.work-target')?.textContent).toBe('two');
    expect(sendMessage).toHaveBeenCalledTimes(requestCount);
  },
);

it.each([{ ok: false, error: 'Old return failed' }, { ok: true }])(
  'keeps a newer action result when an older return settles: %j',
  async (reply: { ok: boolean; error?: string }): Promise<void> => {
    const resolvers: Array<(value: unknown) => void> = [];
    const sendMessage: Mock<(req: { type: string }) => Promise<unknown>> = vi.fn(
      async (req: { type: string }): Promise<unknown> => {
        if (req.type === 'getWorkTarget')
          return { ok: true, state: 'ready', title: 'Report', sessionId: 'one' };
        return new Promise<unknown>((resolve: (value: unknown) => void): void => {
          resolvers.push(resolve);
        });
      },
    );
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    showOverlay(verdict, snapshot());
    await vi.waitFor((): void =>
      expect(root().querySelector('.work-target')?.textContent).toBe('Report'),
    );
    const button: HTMLButtonElement = root().querySelector('.return-work') as HTMLButtonElement;
    button.click();
    button.click();
    resolvers[1]?.({ ok: false, error: 'Newer return failed' });
    await vi.waitFor((): void =>
      expect(root().querySelector('.action-error')?.textContent).toBe('Newer return failed'),
    );
    const requestCount: number = sendMessage.mock.calls.length;
    resolvers[0]?.(reply);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(root().querySelector('.action-error')?.textContent).toBe('Newer return failed');
    expect(sendMessage).toHaveBeenCalledTimes(requestCount);
  },
);

it('allows wheel and touch scrolling inside its closed shadow root', (): void => {
  showOverlay(verdict, snapshot());
  const backdrop: HTMLElement = root().querySelector('.backdrop') as HTMLElement;
  for (const type of ['wheel', 'touchmove']) {
    const event: Event = new Event(type, { bubbles: true, composed: true, cancelable: true });
    backdrop.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }
});

it('refreshes the local gate from the worker after returning to work', async (): Promise<void> => {
  const snap: SessionSnapshot = snapshot();
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> => {
      if (request.type === 'getWorkTarget')
        return { ok: true, state: 'ready', title: 'Report', sessionId: 'one' };
      if (request.type === 'getSnapshot') return snap;
      return { ok: true };
    },
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  showOverlay(verdict, {
    ...snap,
    gate: {
      kind: 'cancel',
      host: null,
      openedAt: 1,
      readyAt: 20_000,
      requiredPhrase: 'I choose to stop',
      forceEndAvailable: false,
    },
  });
  await vi.waitFor((): void =>
    expect(root().querySelector('.work-target')?.textContent).toBe('Report'),
  );
  expect(root().querySelector('.phrase')).not.toBeNull();
  (root().querySelector('.return-work') as HTMLButtonElement).click();
  await vi.waitFor((): void => expect(root().querySelector('.phrase')).toBeNull());
  expect(sendMessage).toHaveBeenCalledWith({ type: 'getSnapshot' });
  expect(
    sendMessage.mock.calls.some(
      ([request]: [{ type: string }]): boolean => request.type === 'getBlockState',
    ),
  ).toBe(false);
});

it.each(['session', 'action'] as const)(
  'ignores a late return snapshot after a newer %s',
  async (replacement: 'session' | 'action'): Promise<void> => {
    let resolveSnapshot: (value: unknown) => void = (): void => {};
    const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
      async (request: { type: string }): Promise<unknown> => {
        if (request.type === 'getWorkTarget')
          return { ok: true, state: 'ready', title: 'Report', sessionId: 'one' };
        if (request.type === 'getSnapshot')
          return new Promise<unknown>((resolve: (value: unknown) => void): void => {
            resolveSnapshot = resolve;
          });
        if (request.type === 'openGate') return { ok: false, error: 'New action failed' };
        return { ok: true };
      },
    );
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const snap: SessionSnapshot = snapshot();
    showOverlay(verdict, snap);
    await vi.waitFor((): void =>
      expect(root().querySelector('.work-target')?.textContent).toBe('Report'),
    );
    (root().querySelector('.return-work') as HTMLButtonElement).click();
    await vi.waitFor((): void => expect(sendMessage).toHaveBeenCalledWith({ type: 'getSnapshot' }));
    if (replacement === 'session') {
      showOverlay(verdict, {
        ...snap,
        startedAt: 2,
        config: snap.config === null ? null : { ...snap.config, intention: 'New session task' },
      });
      await vi.waitFor((): void =>
        expect(root().querySelector('.work-target')?.textContent).toBe('Report'),
      );
    } else {
      (root().querySelector('.linkish') as HTMLButtonElement).click();
      await vi.waitFor((): void =>
        expect(root().querySelector('.action-error')?.textContent).toBe('New action failed'),
      );
    }
    const requestCount: number = sendMessage.mock.calls.length;
    resolveSnapshot({
      ...snap,
      config: snap.config === null ? null : { ...snap.config, intention: 'Obsolete snapshot task' },
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(root().querySelector('.intention')?.textContent).toBe(
      replacement === 'session' ? 'New session task' : 'Continue your current task',
    );
    expect(sendMessage).toHaveBeenCalledTimes(requestCount);
    if (replacement === 'action')
      expect(root().querySelector('.action-error')?.textContent).toBe('New action failed');
  },
);

it.each([true, false])(
  'preserves a return error while reconciling whether the worker abandoned the gate: %s',
  async (abandoned: boolean): Promise<void> => {
    const snap: SessionSnapshot = {
      ...snapshot(),
      gate: {
        kind: 'cancel',
        host: null,
        openedAt: 1,
        readyAt: 20_000,
        requiredPhrase: 'I choose to stop',
        forceEndAvailable: false,
      },
    };
    const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
      async (request: { type: string }): Promise<unknown> => {
        if (request.type === 'getWorkTarget')
          return { ok: true, state: 'ready', title: 'Report', sessionId: 'one' };
        if (request.type === 'getSnapshot') return { ...snap, gate: abandoned ? null : snap.gate };
        return { ok: false, error: 'Work window unavailable' };
      },
    );
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    showOverlay(verdict, snap);
    await vi.waitFor((): void =>
      expect(root().querySelector('.work-target')?.textContent).toBe('Report'),
    );
    const input: HTMLInputElement = root().querySelector('.phrase') as HTMLInputElement;
    input.value = 'I choose';
    (root().querySelector('.return-work') as HTMLButtonElement).click();
    await vi.waitFor((): void => expect(sendMessage).toHaveBeenCalledWith({ type: 'getSnapshot' }));
    await vi.waitFor((): void =>
      expect(root().querySelector('.action-error')?.textContent).toBe('Work window unavailable'),
    );
    if (abandoned) expect(root().querySelector('.phrase')).toBeNull();
    else {
      expect(root().querySelector('.phrase')).toBe(input);
      expect(input.value).toBe('I choose');
    }
  },
);

it('opens an inline picker, preserves gate editing on cancel, then saves and returns', async (): Promise<void> => {
  const snap: SessionSnapshot = {
    ...snapshot(),
    gate: {
      kind: 'cancel',
      host: null,
      openedAt: 1,
      readyAt: 20_000,
      requiredPhrase: 'I choose to stop',
      forceEndAvailable: false,
    },
  };
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> => {
      if (request.type === 'getWorkTarget')
        return { ok: true, sessionId: 'one', state: 'missing', title: null };
      if (request.type === 'getWorkTabs')
        return {
          ok: true,
          tabs: [
            { tabId: 7, title: 'Report <script>safe title</script>' },
            { tabId: 8, title: 'Notes' },
          ],
        };
      if (request.type === 'getSnapshot') return { ...snap, gate: null };
      return { ok: true };
    },
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  showOverlay(verdict, snap);
  await vi.waitFor((): void =>
    expect((root().querySelector('.return-work') as HTMLButtonElement).disabled).toBe(false),
  );
  const input: HTMLInputElement = root().querySelector('.phrase') as HTMLInputElement;
  const details: HTMLDetailsElement = root().querySelector('details') as HTMLDetailsElement;
  input.value = 'I choose';
  input.setSelectionRange(2, 5);
  const primary: HTMLButtonElement = root().querySelector('.return-work') as HTMLButtonElement;
  primary.focus();
  primary.click();
  await vi.waitFor((): void => expect(root().querySelectorAll('.work-tab-option')).toHaveLength(2));
  expect(sendMessage).toHaveBeenCalledWith({ type: 'getWorkTabs', sessionId: 'one' });
  const first: HTMLButtonElement = root().querySelector('.work-tab-option') as HTMLButtonElement;
  expect(first.textContent).toContain('Report <script>safe title</script>');
  expect(root().querySelector('script')).toBeNull();
  first.focus();
  first.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      composed: true,
      cancelable: true,
    }),
  );
  expect(root().activeElement?.textContent).toContain('Notes');
  first.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      composed: true,
      cancelable: true,
    }),
  );
  expect(root().querySelector('.work-picker')).toBeNull();
  expect(root().activeElement).toBe(primary);
  expect(root().querySelector('.phrase')).toBe(input);
  expect(input.value).toBe('I choose');
  expect(input.selectionStart).toBe(2);
  expect(root().querySelector('details')).toBe(details);
  expect(details.open).toBe(true);
  primary.click();
  await vi.waitFor((): void => expect(root().querySelector('.work-tab-option')).not.toBeNull());
  (root().querySelector('.work-tab-option') as HTMLButtonElement).click();
  await vi.waitFor((): void =>
    expect(sendMessage).toHaveBeenCalledWith({ type: 'returnToWork', sessionId: 'one' }),
  );
  expect(sendMessage).toHaveBeenCalledWith({ type: 'setWorkTarget', sessionId: 'one', tabId: 7 });
  await vi.waitFor((): void => expect(root().querySelector('.phrase')).toBeNull());
});

it.each(['cancel', 'session'] as const)(
  'ignores deferred picker selections after %s',
  async (replacement: 'cancel' | 'session'): Promise<void> => {
    let resolveSave: (value: unknown) => void = (): void => {};
    const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
      async (request: { type: string }): Promise<unknown> => {
        if (request.type === 'getWorkTarget')
          return { ok: true, sessionId: 'one', state: 'missing', title: null };
        if (request.type === 'getWorkTabs')
          return { ok: true, tabs: [{ tabId: 7, title: 'Report' }] };
        return new Promise<unknown>((resolve: (value: unknown) => void): void => {
          resolveSave = resolve;
        });
      },
    );
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const snap: SessionSnapshot = snapshot();
    showOverlay(verdict, snap);
    await vi.waitFor((): void =>
      expect((root().querySelector('.return-work') as HTMLButtonElement).disabled).toBe(false),
    );
    (root().querySelector('.return-work') as HTMLButtonElement).click();
    await vi.waitFor((): void => expect(root().querySelector('.work-tab-option')).not.toBeNull());
    (root().querySelector('.work-tab-option') as HTMLButtonElement).click();
    if (replacement === 'cancel')
      (root().querySelector('.work-picker-cancel') as HTMLButtonElement).click();
    else showOverlay(verdict, { ...snap, startedAt: 2 });
    resolveSave({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(
      sendMessage.mock.calls.some(
        ([request]: [{ type: string }]): boolean => request.type === 'returnToWork',
      ),
    ).toBe(false);
    expect(root().querySelector('.work-picker')).toBeNull();
  },
);

it('offers retry for failed listing and handles an empty list without altering the session', async (): Promise<void> => {
  let list: unknown = { ok: false, error: 'Could not load tabs' };
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> =>
      request.type === 'getWorkTarget'
        ? { ok: true, sessionId: 'one', state: 'missing', title: null }
        : list,
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  showOverlay(verdict, snapshot());
  await vi.waitFor((): void =>
    expect((root().querySelector('.return-work') as HTMLButtonElement).disabled).toBe(false),
  );
  (root().querySelector('.return-work') as HTMLButtonElement).click();
  await vi.waitFor((): void =>
    expect(root().querySelector('.work-picker [role="alert"]')).not.toBeNull(),
  );
  list = { ok: true, tabs: [] };
  (root().querySelector('.work-picker-retry') as HTMLButtonElement).click();
  await vi.waitFor((): void =>
    expect(root().querySelector('.work-picker')?.textContent).toContain('No available work tabs'),
  );
  expect(root().querySelector('.work-tab-option')).toBeNull();
});

it('can keep focusing without a selected work tab or abandoning the inline chooser gate implicitly', async (): Promise<void> => {
  const snap: SessionSnapshot = snapshot();
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> => {
      if (request.type === 'getWorkTarget')
        return { ok: true, sessionId: 'one', state: 'missing', title: null };
      if (request.type === 'getSnapshot') return snap;
      return { ok: true };
    },
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  showOverlay(verdict, {
    ...snap,
    gate: {
      kind: 'cancel',
      host: null,
      openedAt: 1,
      readyAt: 20_000,
      requiredPhrase: 'I choose to stop',
      forceEndAvailable: false,
    },
  });
  const keep: HTMLButtonElement | undefined = Array.from(root().querySelectorAll('button')).find(
    (button: HTMLButtonElement): boolean => button.textContent === 'Keep focusing',
  );
  expect(keep).toBeDefined();
  keep?.click();
  await vi.waitFor((): void => expect(sendMessage).toHaveBeenCalledWith({ type: 'abandonGate' }));
  await vi.waitFor((): void => expect(root().querySelector('.phrase')).toBeNull());
});

it('keeps the chooser open after a denied selection and never returns to that tab', async (): Promise<void> => {
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> => {
      if (request.type === 'getWorkTarget')
        return { ok: true, sessionId: 'one', state: 'ready', title: 'Previous' };
      if (request.type === 'getWorkTabs')
        return { ok: true, tabs: [{ tabId: 7, title: 'Report' }] };
      return { ok: false, error: 'That tab is no longer available.' };
    },
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  showOverlay(verdict, snapshot());
  await vi.waitFor((): void =>
    expect((root().querySelector('.change-work') as HTMLButtonElement).hidden).toBe(false),
  );
  (root().querySelector('.change-work') as HTMLButtonElement).click();
  await vi.waitFor((): void => expect(root().querySelector('.work-tab-option')).not.toBeNull());
  const row: HTMLButtonElement = root().querySelector('.work-tab-option') as HTMLButtonElement;
  row.click();
  await vi.waitFor((): void =>
    expect(root().querySelector('.work-picker [role="alert"]')?.textContent).toBe(
      'That tab is no longer available.',
    ),
  );
  expect(row.disabled).toBe(false);
  expect(root().activeElement).toBe(row);
  expect(
    sendMessage.mock.calls.some(
      ([request]: [{ type: string }]): boolean => request.type === 'returnToWork',
    ),
  ).toBe(false);
});

it('does not insert a deferred tab list after its chooser is cancelled', async (): Promise<void> => {
  let resolveList: (value: unknown) => void = (): void => {};
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> =>
      request.type === 'getWorkTarget'
        ? { ok: true, sessionId: 'one', state: 'missing', title: null }
        : new Promise<unknown>((resolve: (value: unknown) => void): void => {
            resolveList = resolve;
          }),
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  showOverlay(verdict, snapshot());
  await vi.waitFor((): void =>
    expect((root().querySelector('.return-work') as HTMLButtonElement).disabled).toBe(false),
  );
  (root().querySelector('.return-work') as HTMLButtonElement).click();
  expect(root().querySelector('.work-picker')?.textContent).toContain('Finding available tabs...');
  (root().querySelector('.work-picker-cancel') as HTMLButtonElement).click();
  resolveList({ ok: true, tabs: [{ tabId: 7, title: 'Report' }] });
  await Promise.resolve();
  await Promise.resolve();
  expect(root().querySelector('.work-picker')).toBeNull();
});

it('keeps focus inside the overlay while retrying a failed list', async (): Promise<void> => {
  let pending: boolean = false;
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> => {
      if (request.type === 'getWorkTarget')
        return { ok: true, sessionId: 'one', state: 'missing', title: null };
      if (!pending) return { ok: false, error: 'Unavailable' };
      return new Promise<unknown>((): void => {});
    },
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  showOverlay(verdict, snapshot());
  await vi.waitFor((): void =>
    expect((root().querySelector('.return-work') as HTMLButtonElement).disabled).toBe(false),
  );
  (root().querySelector('.return-work') as HTMLButtonElement).click();
  await vi.waitFor((): void => expect(root().querySelector('.work-picker-retry')).not.toBeNull());
  const retry: HTMLButtonElement = root().querySelector('.work-picker-retry') as HTMLButtonElement;
  retry.focus();
  pending = true;
  retry.click();
  expect(root().activeElement).toBe(root().querySelector('.work-picker-cancel'));
});

it('restores overlay focus before a selected work tab fails to activate', async (): Promise<void> => {
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> => {
      if (request.type === 'getWorkTarget')
        return { ok: true, sessionId: 'one', state: 'missing', title: null };
      if (request.type === 'getWorkTabs')
        return { ok: true, tabs: [{ tabId: 7, title: 'Report' }] };
      if (request.type === 'getSnapshot') return new Promise<unknown>((): void => {});
      return request.type === 'setWorkTarget'
        ? { ok: true }
        : { ok: false, error: 'Activation failed' };
    },
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  showOverlay(verdict, snapshot());
  await vi.waitFor((): void =>
    expect((root().querySelector('.return-work') as HTMLButtonElement).disabled).toBe(false),
  );
  const primary: HTMLButtonElement = root().querySelector('.return-work') as HTMLButtonElement;
  primary.click();
  await vi.waitFor((): void => expect(root().querySelector('.work-tab-option')).not.toBeNull());
  const row: HTMLButtonElement = root().querySelector('.work-tab-option') as HTMLButtonElement;
  row.focus();
  row.click();
  await vi.waitFor((): void =>
    expect(root().querySelector('.action-error')?.textContent).toBe('Activation failed'),
  );
  expect(root().activeElement).not.toBeNull();
});

it('focuses Cancel before disabling the selected row during a pending save', async (): Promise<void> => {
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> => {
      if (request.type === 'getWorkTarget')
        return { ok: true, sessionId: 'one', state: 'missing', title: null };
      if (request.type === 'getWorkTabs')
        return { ok: true, tabs: [{ tabId: 7, title: 'Report' }] };
      return new Promise<unknown>((): void => {});
    },
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  showOverlay(verdict, snapshot());
  await vi.waitFor((): void =>
    expect((root().querySelector('.return-work') as HTMLButtonElement).disabled).toBe(false),
  );
  (root().querySelector('.return-work') as HTMLButtonElement).click();
  await vi.waitFor((): void => expect(root().querySelector('.work-tab-option')).not.toBeNull());
  const row: HTMLButtonElement = root().querySelector('.work-tab-option') as HTMLButtonElement;
  row.focus();
  row.click();
  expect(row.disabled).toBe(true);
  expect(root().activeElement).toBe(root().querySelector('.work-picker-cancel'));
  root().activeElement?.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      composed: true,
      cancelable: true,
    }),
  );
  expect(root().querySelector('.work-picker')).toBeNull();
});

it('restores focus to the primary action when the picker trigger becomes hidden', async (): Promise<void> => {
  let ready: boolean = true;
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> =>
      request.type === 'getWorkTarget'
        ? {
            ok: true,
            sessionId: 'one',
            state: ready ? 'ready' : 'unavailable',
            title: ready ? 'Report' : null,
          }
        : { ok: true, tabs: [{ tabId: 7, title: 'Notes' }] },
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  const snap: SessionSnapshot = snapshot();
  showOverlay(verdict, snap);
  await vi.waitFor((): void =>
    expect((root().querySelector('.change-work') as HTMLButtonElement).hidden).toBe(false),
  );
  const change: HTMLButtonElement = root().querySelector('.change-work') as HTMLButtonElement;
  const backdrop: HTMLElement = root().querySelector('.backdrop') as HTMLElement;
  backdrop.scrollTop = 50;
  change.focus();
  change.click();
  ready = false;
  showOverlay(verdict, snap);
  await vi.waitFor((): void => expect(change.hidden).toBe(true));
  (root().querySelector('.work-picker-cancel') as HTMLButtonElement).click();
  expect(root().activeElement).toBe(root().querySelector('.return-work'));
  expect(backdrop.scrollTop).toBe(50);
});

it('lets a stopped page retry a transient work-target lookup before opening the chooser', async (): Promise<void> => {
  let lookups: number = 0;
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> => {
      if (request.type === 'getWorkTarget') {
        lookups += 1;
        if (lookups === 1) throw new Error('Message port closed');
        return { ok: true, sessionId: 'one', state: 'missing', title: null };
      }
      if (request.type === 'getWorkTabs')
        return { ok: true, tabs: [{ tabId: 7, title: 'Report' }] };
      throw new Error('Unexpected request');
    },
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  showOverlay(verdict, snapshot(), true);
  await vi.waitFor((): void =>
    expect(root().querySelector('.work-target')?.textContent).toContain('Could not'),
  );
  const choose: HTMLButtonElement = root().querySelector('.return-work') as HTMLButtonElement;
  expect(choose.disabled).toBe(false);
  choose.click();
  await vi.waitFor((): void =>
    expect(root().querySelector('.work-tab-option')?.textContent).toContain('Report'),
  );
  expect(
    sendMessage.mock.calls.map(([request]: [{ type: string }]): string => request.type),
  ).toEqual(['getWorkTarget', 'getWorkTarget', 'getWorkTabs']);
});

it.each([
  {
    reply: { ok: false, error: 'The requesting page has changed. Reload the page.' },
    message: 'The requesting page has changed. Reload the page.',
  },
  {
    reply: { ok: true, sessionId: null, state: 'missing', title: null },
    message: 'Your focus session is not available. Try again, or reload this page.',
  },
])(
  'keeps retry available without inventing a session for %j',
  async ({ reply, message }): Promise<void> => {
    const sendMessage: Mock<() => Promise<unknown>> = vi.fn(async (): Promise<unknown> => reply);
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    showOverlay(verdict, snapshot());
    await vi.waitFor((): void =>
      expect(root().querySelector('.work-target')?.textContent).toBe(message),
    );
    const choose: HTMLButtonElement = root().querySelector('.return-work') as HTMLButtonElement;
    expect(choose.disabled).toBe(false);
    choose.click();
    await vi.waitFor((): void => expect(sendMessage).toHaveBeenCalledTimes(2));
    await vi.waitFor((): void => expect(choose.disabled).toBe(false));
    expect(root().querySelector('.work-picker')).toBeNull();
    expect(sendMessage.mock.calls).toEqual([
      [{ type: 'getWorkTarget' }],
      [{ type: 'getWorkTarget' }],
    ]);
  },
);

it('keeps failed retry focus and gate editing inside the stopped overlay', async (): Promise<void> => {
  let resolveRetry: (value: unknown) => void = (): void => {};
  const sendMessage: Mock<() => Promise<unknown>> = vi
    .fn()
    .mockRejectedValueOnce(new Error('Extension context invalidated.'))
    .mockImplementationOnce(
      async (): Promise<unknown> =>
        new Promise<unknown>((resolve: (value: unknown) => void): void => {
          resolveRetry = resolve;
        }),
    );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  const snap: SessionSnapshot = {
    ...snapshot(),
    gate: {
      kind: 'cancel',
      host: null,
      openedAt: 1,
      readyAt: 20_000,
      requiredPhrase: 'I choose to stop',
      forceEndAvailable: false,
    },
  };
  showOverlay(verdict, snap, true);
  await vi.waitFor((): void =>
    expect(root().querySelector('.work-target')?.textContent).toContain('Reload this page'),
  );
  const input: HTMLInputElement = root().querySelector('.phrase') as HTMLInputElement;
  input.value = 'I choose';
  input.setSelectionRange(2, 5);
  const backdrop: HTMLElement = root().querySelector('.backdrop') as HTMLElement;
  backdrop.scrollTop = 50;
  const choose: HTMLButtonElement = root().querySelector('.return-work') as HTMLButtonElement;
  choose.focus();
  choose.click();
  expect(choose.disabled).toBe(true);
  expect(root().activeElement).toBe(backdrop);
  resolveRetry({ ok: false, error: 'The requesting page has changed. Reload the page.' });
  await vi.waitFor((): void => expect(choose.disabled).toBe(false));
  expect(root().activeElement).toBe(choose);
  expect(root().querySelector('.phrase')).toBe(input);
  expect(input.value).toBe('I choose');
  expect(input.selectionStart).toBe(2);
  expect(root().querySelector('details')?.open).toBe(true);
  expect(backdrop.scrollTop).toBe(50);
});

it('does not open a chooser from a retry reply belonging to the previous session', async (): Promise<void> => {
  let resolveRetry: (value: unknown) => void = (): void => {};
  let lookups: number = 0;
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> => {
      if (request.type !== 'getWorkTarget') throw new Error('Unexpected request');
      lookups += 1;
      if (lookups === 1) throw new Error('Message port closed');
      if (lookups === 2)
        return new Promise<unknown>((resolve: (value: unknown) => void): void => {
          resolveRetry = resolve;
        });
      return { ok: true, sessionId: 'two', state: 'ready', title: 'New task' };
    },
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  const snap: SessionSnapshot = snapshot();
  showOverlay(verdict, snap);
  await vi.waitFor((): void =>
    expect(root().querySelector('.work-target')?.textContent).toContain('Could not'),
  );
  (root().querySelector('.return-work') as HTMLButtonElement).click();
  showOverlay(verdict, { ...snap, startedAt: 2 });
  await vi.waitFor((): void =>
    expect(root().querySelector('.work-target')?.textContent).toBe('New task'),
  );
  resolveRetry({ ok: true, sessionId: 'one', state: 'missing', title: null });
  await Promise.resolve();
  await Promise.resolve();
  expect(root().querySelector('.work-target')?.textContent).toBe('New task');
  expect(root().querySelector('.work-picker')).toBeNull();
  expect(sendMessage).toHaveBeenCalledTimes(3);
});

it.each([
  { ok: false, error: 'Unavailable' },
  { malformed: true },
  { ok: true, sessionId: null, state: 'missing', title: null },
])(
  'restores visible focus when a target refresh invalidates the change picker: %j',
  async (reply: unknown): Promise<void> => {
    let current: unknown = { ok: true, sessionId: 'one', state: 'ready', title: 'Report' };
    const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
      async (request: { type: string }): Promise<unknown> =>
        request.type === 'getWorkTarget' ? current : { ok: true, tabs: [] },
    );
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    showOverlay(verdict, snapshot());
    await vi.waitFor((): void =>
      expect((root().querySelector('.change-work') as HTMLButtonElement).hidden).toBe(false),
    );
    (root().querySelector('.change-work') as HTMLButtonElement).click();
    expect(root().activeElement).toBe(root().querySelector('.work-picker-cancel'));
    current = reply;
    refreshWorkTarget();
    await vi.waitFor((): void => expect(root().querySelector('.work-picker')).toBeNull());
    expect(root().activeElement).toBe(root().querySelector('.return-work'));
  },
);

it.each([false, true])(
  'preserves focus during a background retry lookup, deliberate focus move: %s',
  async (moveFocus: boolean): Promise<void> => {
    let resolveRefresh: (value: unknown) => void = (): void => {};
    const sendMessage: Mock<() => Promise<unknown>> = vi
      .fn()
      .mockRejectedValueOnce(new Error('Unavailable'))
      .mockImplementationOnce(
        async (): Promise<unknown> =>
          new Promise<unknown>((resolve: (value: unknown) => void): void => {
            resolveRefresh = resolve;
          }),
      );
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    showOverlay(verdict, snapshot());
    await vi.waitFor((): void =>
      expect(root().querySelector('.work-target')?.textContent).toContain('Could not'),
    );
    const primary: HTMLButtonElement = root().querySelector('.return-work') as HTMLButtonElement;
    primary.focus();
    refreshWorkTarget();
    expect(primary.disabled).toBe(true);
    expect(root().activeElement).toBe(root().querySelector('[role="dialog"]'));
    const summary: HTMLElement = root().querySelector('summary') as HTMLElement;
    if (moveFocus) summary.focus();
    resolveRefresh({ ok: false, error: 'Unavailable' });
    await vi.waitFor((): void => expect(primary.disabled).toBe(false));
    expect(root().activeElement).toBe(moveFocus ? summary : primary);
  },
);

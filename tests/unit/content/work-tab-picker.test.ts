// @vitest-environment jsdom
/**
 * Master's searchable chooser suite, driven through the v2 renderer. The view is the worker's
 * frozen word, the picker's own labels are lookup results, and every request carries the view's
 * session id.
 */
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import { clearDocumentOverlay, renderDocumentOverlay } from '../../../src/content/overlay-v2';
import { activeView, root, SESSION_ID, VERDICT } from './overlay-v2-fixtures';

const candidates: unknown = {
  ok: true,
  tabs: [
    { tabId: 1, title: 'Annual report', hostname: 'work.example' },
    { tabId: 2, title: 'Review notes', hostname: 'work.example' },
    { tabId: 3, title: 'Annual report', hostname: 'other.example' },
    { tabId: 4, title: 'Legacy report' },
  ],
};
function search(): HTMLInputElement {
  return root().querySelector('[aria-label="Search work tabs"]') as HTMLInputElement;
}
function type(value: string): void {
  search().value = value;
  search().dispatchEvent(new Event('input', { bubbles: true, composed: true }));
}
function rows(): HTMLButtonElement[] {
  return Array.from(root().querySelectorAll<HTMLButtonElement>('.work-tab-option'));
}
async function open(
  list: () => unknown = (): unknown => candidates,
  select?: () => Promise<unknown>,
): Promise<Mock<(request: { type: string }) => Promise<unknown>>> {
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> => {
      if (request.type === 'getWorkTarget')
        return { ok: true, sessionId: SESSION_ID, state: 'missing', title: null };
      if (request.type === 'getWorkTabs') return list();
      if (request.type === 'getWorkTabIcon') return { ok: true, icon: null };
      return select?.() ?? { ok: false, error: 'Selection denied' };
    },
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  renderDocumentOverlay(activeView(), VERDICT);
  await vi.waitFor((): void =>
    expect((root().querySelector('.return-work') as HTMLButtonElement).disabled).toBe(false),
  );
  (root().querySelector('.return-work') as HTMLButtonElement).click();
  await vi.waitFor((): void =>
    expect(root().querySelector('.work-picker-body')?.getAttribute('aria-busy')).toBe('false'),
  );
  return sendMessage;
}
afterEach((): void => {
  clearDocumentOverlay();
  vi.unstubAllGlobals();
});

describe('searchable work tab chooser', (): void => {
  it('focuses search, matches all title and hostname terms locally, and restores all tabs when cleared', async (): Promise<void> => {
    const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = await open();
    expect(root().activeElement).toBe(search());
    expect(search()).not.toBeNull();
    expect(root().querySelector('.work-picker')).not.toBeNull();
    type('  RePoRt   WORK.EXAMPLE  ');
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.textContent).toContain('Annual report');
    expect(rows()[0]?.textContent).toContain('work.example');
    expect(root().querySelector('.work-picker-count')?.textContent).toBe('1 of 4 tabs');
    type('other.example');
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.textContent).toContain('other.example');
    type('nothing matches');
    expect(rows()).toHaveLength(0);
    expect(root().querySelector('.work-picker-body')?.textContent).toContain('No matching tabs');
    (root().querySelector('.work-picker-clear') as HTMLButtonElement).click();
    expect(search().value).toBe('');
    expect(rows()).toHaveLength(4);
    expect(root().activeElement).toBe(search());
    expect(
      sendMessage.mock.calls.filter(
        ([request]: [{ type: string }]): boolean => request.type !== 'getWorkTabIcon',
      ),
    ).toEqual([[{ type: 'getWorkTarget' }], [{ type: 'getWorkTabs', sessionId: SESSION_ID }]]);
    search().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }),
    );
    expect(root().querySelector('.work-picker')).toBeNull();
  });

  it('moves from search to the first matching row with ArrowDown without consuming text navigation', async (): Promise<void> => {
    await open();
    expect(search()).not.toBeNull();
    type('notes');
    for (const key of ['Home', 'End', 'ArrowLeft', 'ArrowRight', ' ']) {
      const event: KeyboardEvent = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        composed: true,
        cancelable: true,
      });
      search().dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    search().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
    expect(root().activeElement).toBe(rows()[0]);
  });

  it('retains the query across list refresh failure and retry', async (): Promise<void> => {
    let list: unknown = candidates;
    await open((): unknown => list);
    expect(search()).not.toBeNull();
    type('notes');
    list = { ok: false, error: 'Could not load tabs' };
    (root().querySelector('.work-picker-retry') as HTMLButtonElement).click();
    await vi.waitFor((): void =>
      expect(root().querySelector('.work-picker [role="alert"]')?.textContent).toBe(
        'Could not load tabs',
      ),
    );
    expect(search().value).toBe('notes');
    list = candidates;
    (root().querySelector('.work-picker-retry') as HTMLButtonElement).click();
    await vi.waitFor((): void => expect(rows()).toHaveLength(1));
    expect(rows()[0]?.textContent).toContain('Review notes');
    expect(search().value).toBe('notes');
  });

  it('cannot recreate selectable rows through search or refresh while a save is pending', async (): Promise<void> => {
    let resolveSave: (value: unknown) => void = (): void => {};
    const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = await open(
      undefined,
      async (): Promise<unknown> =>
        new Promise<unknown>((resolve: (value: unknown) => void): void => {
          resolveSave = resolve;
        }),
    );
    expect(search()).not.toBeNull();
    rows()[0]?.click();
    expect(search().disabled).toBe(true);
    type('notes');
    expect(rows().every((row: HTMLButtonElement): boolean => row.disabled)).toBe(true);
    (root().querySelector('.work-picker-retry') as HTMLButtonElement).click();
    expect(
      sendMessage.mock.calls.filter(
        ([request]: [{ type: string }]): boolean => request.type === 'getWorkTabs',
      ),
    ).toHaveLength(1);
    resolveSave({ ok: false, error: 'Tab closed' });
    await vi.waitFor((): void => expect(search().disabled).toBe(false));
    expect(root().querySelector('.work-picker [role="alert"]')?.textContent).toBe('Tab closed');
  });
});

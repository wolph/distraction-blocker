// @vitest-environment jsdom
import './chrome-fake';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../../src/popup/App';
import { StartForm } from '../../../src/popup/StartForm';
import { WorkTabControl } from '../../../src/popup/WorkTabControl';
import { DEFAULT_LISTS, DEFAULT_SETTINGS, emptySnapshot } from '../../../src/shared/constants';
import type { Request } from '../../../src/shared/messages';
import type { SessionSnapshot } from '../../../src/shared/types';
import { emitMessage, resetChromeFake, sendMessageMock, tabsQueryMock } from './chrome-fake';

beforeEach((): void => {
  resetChromeFake();
  tabsQueryMock.mockResolvedValue([
    { id: 12, windowId: 3, active: true, url: 'https://work.example' },
  ]);
});
afterEach(cleanup);
describe('popup work tab', (): void => {
  it('defaults to the suitable active tab and sends window context on start', async (): Promise<void> => {
    sendMessageMock.mockImplementation(
      async (req: Request): Promise<unknown> =>
        req.type === 'getWorkTabs'
          ? {
              ok: true,
              tabs: [
                { tabId: 12, title: 'Report' },
                { tabId: 14, title: 'Notes' },
              ],
            }
          : { ok: true },
    );
    const view: ReturnType<typeof render> = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );
    await waitFor((): void =>
      expect((view.getByLabelText('Work tab') as HTMLSelectElement).value).toBe('12'),
    );
    fireEvent.change(view.getByLabelText('Work tab'), { target: { value: '14' } });
    emitMessage({ type: 'workTargetChanged' });
    await waitFor((): void =>
      expect((view.getByLabelText('Work tab') as HTMLSelectElement).value).toBe('14'),
    );
    fireEvent.click(view.getByRole('button', { name: 'Start focusing' }));
    await waitFor((): void =>
      expect(sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'startSession', workTabId: 14, windowId: 3 }),
      ),
    );
  });
  it('uses the current eligible tab explicitly without losing the alternative choice', async (): Promise<void> => {
    sendMessageMock.mockImplementation(
      async (req: Request): Promise<unknown> =>
        req.type === 'getWorkTabs'
          ? {
              ok: true,
              tabs: [
                { tabId: 12, title: 'Report' },
                { tabId: 14, title: 'Notes' },
              ],
            }
          : { ok: true },
    );
    const view: ReturnType<typeof render> = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );
    await waitFor((): void =>
      expect((view.getByLabelText('Work tab') as HTMLSelectElement).value).toBe('12'),
    );
    fireEvent.change(view.getByLabelText('Work tab'), { target: { value: '14' } });
    fireEvent.click(view.getByRole('button', { name: 'Use this tab' }));
    await waitFor((): void =>
      expect((view.getByLabelText('Work tab') as HTMLSelectElement).value).toBe('12'),
    );
    tabsQueryMock.mockResolvedValue([{ id: 14, windowId: 3 }]);
    emitMessage({ type: 'workTargetChanged' });
    await waitFor((): void =>
      expect(view.getByRole('button', { name: 'Use this tab' }).textContent).toContain(
        'Use this tab',
      ),
    );
    expect((view.getByLabelText('Work tab') as HTMLSelectElement).value).toBe('12');
  });
  it('rechecks the current tab at the moment the shortcut is used', async (): Promise<void> => {
    sendMessageMock.mockResolvedValue({
      ok: true,
      tabs: [
        { tabId: 12, title: 'Report' },
        { tabId: 14, title: 'Notes' },
      ],
    });
    const view: ReturnType<typeof render> = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );
    await waitFor((): void =>
      expect((view.getByLabelText('Work tab') as HTMLSelectElement).value).toBe('12'),
    );
    tabsQueryMock.mockResolvedValue([{ id: 14, windowId: 3 }]);
    fireEvent.click(view.getByRole('button', { name: 'Use this tab' }));
    await waitFor((): void =>
      expect((view.getByLabelText('Work tab') as HTMLSelectElement).value).toBe('14'),
    );
    tabsQueryMock.mockResolvedValue([{ id: 99, windowId: 3 }]);
    fireEvent.click(view.getByRole('button', { name: 'Use this tab' }));
    await waitFor((): void =>
      expect(
        view.getByText('This tab is not available for work. Choose another open tab.'),
      ).toBeDefined(),
    );
    expect((view.getByLabelText('Work tab') as HTMLSelectElement).value).toBe('14');
  });
  it('preserves a newer explicit choice while a current-tab lookup is pending', async (): Promise<void> => {
    sendMessageMock.mockResolvedValue({
      ok: true,
      tabs: [
        { tabId: 12, title: 'Report' },
        { tabId: 14, title: 'Notes' },
      ],
    });
    const view: ReturnType<typeof render> = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );
    await waitFor((): void =>
      expect((view.getByLabelText('Work tab') as HTMLSelectElement).value).toBe('12'),
    );
    let resolveActive: (value: chrome.tabs.Tab[]) => void = (): void => {};
    tabsQueryMock.mockImplementation(
      async (): Promise<chrome.tabs.Tab[]> =>
        new Promise<chrome.tabs.Tab[]>((resolve: (value: chrome.tabs.Tab[]) => void): void => {
          resolveActive = resolve;
        }),
    );
    fireEvent.click(view.getByRole('button', { name: 'Use this tab' }));
    await waitFor((): void => expect(view.getByText('Checking current tab...')).toBeDefined());
    fireEvent.change(view.getByLabelText('Work tab'), { target: { value: '14' } });
    await act(async (): Promise<void> => {
      resolveActive([{ id: 12, windowId: 3 } as chrome.tabs.Tab]);
    });
    await waitFor((): void => expect(view.queryByText('Checking current tab...')).toBeNull());
    expect((view.getByLabelText('Work tab') as HTMLSelectElement).value).toBe('14');
  });
  it('explains an ineligible current tab while retaining eligible alternatives', async (): Promise<void> => {
    sendMessageMock.mockResolvedValue({ ok: true, tabs: [{ tabId: 14, title: 'Notes' }] });
    const view: ReturnType<typeof render> = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );
    await waitFor((): void => expect(view.getByText('Notes')).toBeDefined());
    expect((view.getByRole('button', { name: 'Use this tab' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      view.getByText('This tab is not available for work. Choose another open tab.'),
    ).toBeDefined();
    fireEvent.change(view.getByLabelText('Work tab'), { target: { value: '14' } });
    fireEvent.click(view.getByRole('button', { name: 'Start focusing' }));
    await waitFor((): void =>
      expect(sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'startSession', workTabId: 14 }),
      ),
    );
  });
  it('saves the actual current tab during a session and ignores its reply after replacement', async (): Promise<void> => {
    let resolveSave: (value: unknown) => void = (): void => {};
    sendMessageMock.mockImplementation(
      async (req: Request): Promise<unknown> =>
        req.type === 'getWorkTabs'
          ? { ok: true, tabs: [{ tabId: 12, title: 'Report' }] }
          : new Promise<unknown>((resolve: (value: unknown) => void): void => {
              resolveSave = resolve;
            }),
    );
    const snap: SessionSnapshot = { ...emptySnapshot(Date.now()), startedAt: 1 };
    const refresh: () => void = (): void => {};
    const view: ReturnType<typeof render> = render(
      h(WorkTabControl, {
        snapshot: snap,
        work: {
          target: { ok: true, sessionId: 'one', state: 'missing', title: null },
          windowId: 3,
          refresh,
        },
      }),
    );
    await waitFor((): void =>
      expect(
        (view.getByRole('button', { name: 'Use this tab' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(view.getByRole('button', { name: 'Use this tab' }));
    await waitFor((): void =>
      expect(sendMessageMock).toHaveBeenCalledWith({
        type: 'setWorkTarget',
        sessionId: 'one',
        tabId: 12,
        windowId: 3,
      }),
    );
    view.rerender(
      h(WorkTabControl, {
        snapshot: { ...snap, startedAt: 2 },
        work: {
          target: { ok: true, sessionId: 'two', state: 'missing', title: null },
          windowId: 3,
          refresh,
        },
      }),
    );
    resolveSave({ ok: false, error: 'Old save failed' });
    await Promise.resolve();
    await Promise.resolve();
    expect(view.queryByText('Old save failed')).toBeNull();
  });
  it('keeps a partial-start error visible after the form unmounts', async (): Promise<void> => {
    const idle: SessionSnapshot = emptySnapshot(Date.now());
    const active: SessionSnapshot = {
      ...idle,
      phase: 'focus',
      config: {
        mode: 'blacklist',
        strictness: 'friction',
        durationMin: 30,
        cycling: null,
        intention: '',
        source: 'manual',
        scheduleEntryId: null,
      },
      startedAt: Date.now(),
      phaseStartedAt: Date.now(),
      phaseEndsAt: Date.now() + 1800000,
      sessionEndsAt: Date.now() + 1800000,
    };
    let started: boolean = false;
    sendMessageMock.mockImplementation(async (req: Request): Promise<unknown> => {
      if (req.type === 'getSnapshot') return started ? active : idle;
      if (req.type === 'getSettings') return DEFAULT_SETTINGS;
      if (req.type === 'getLists') return DEFAULT_LISTS;
      if (req.type === 'getWorkTabs') return { ok: true, tabs: [] };
      if (req.type === 'getWorkTarget')
        return { ok: true, sessionId: 'one', state: 'missing', title: null };
      if (req.type === 'startSession') {
        started = true;
        emitMessage({ type: 'stateChanged', snapshot: active });
        await Promise.resolve();
        return { ok: false, sessionStarted: true, error: 'Work tab closed. Choose another.' };
      }
      return { ok: true };
    });
    const view: ReturnType<typeof render> = render(h(App, {}));
    await waitFor((): void =>
      expect(view.getByRole('button', { name: 'Start focusing' })).toBeDefined(),
    );
    fireEvent.click(view.getByRole('button', { name: 'Start focusing' }));
    await waitFor((): void =>
      expect(view.getByText('Work tab closed. Choose another.')).toBeDefined(),
    );
    expect(view.queryByRole('button', { name: 'Start focusing' })).toBeNull();
  });
});

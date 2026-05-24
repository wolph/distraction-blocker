// @vitest-environment jsdom
import './chrome-fake';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../../src/popup/App';
import { StartForm } from '../../../src/popup/StartForm';
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

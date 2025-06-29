/** @vitest-environment jsdom */
import './chrome-fake';

import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelPhrase,
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  rulesFromLists,
} from '../../../src/shared/constants';
import type { Request } from '../../../src/shared/messages';
import type { ListsConfig, Settings } from '../../../src/shared/types';
import { openOptionsPageMock, resetChromeFake, sendMessageMock } from './chrome-fake';

vi.mock('../../../src/core/categories', () => ({
  ALL_CATEGORIES: [
    { id: 'social', title: 'Social media', hosts: ['facebook.com', 'instagram.com'] },
    { id: 'video', title: 'Video and streaming', hosts: ['youtube.com'] },
  ],
}));

import { StartForm } from '../../../src/popup/StartForm';

function ackByType(): void {
  sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
    if (request.type === 'startSession') return { ok: true };
    return undefined;
  });
}

function startRequest(): Extract<Request, { type: 'startSession' }> | undefined {
  return sendMessageMock.mock.calls
    .map(([request]: unknown[]): Request => request as Request)
    .find(
      (request: Request): request is Extract<Request, { type: 'startSession' }> =>
        request.type === 'startSession',
    );
}

describe('StartForm', (): void => {
  beforeEach((): void => {
    resetChromeFake();
    ackByType();
  });

  afterEach((): void => {
    cleanup();
  });

  it('labels the presets per the research copy rules', (): void => {
    const { getByRole } = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );

    expect(getByRole('button', { name: '15 short' })).toBeTruthy();
    expect(getByRole('button', { name: '25 focus' })).toBeTruthy();
    expect(getByRole('button', { name: '50 deep work (preference, not science)' })).toBeTruthy();
  });

  it('uses visible labels and a start label that names duration and mode', (): void => {
    const { getByLabelText, getByRole } = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );
    const intention: HTMLElement = getByLabelText('Intention');

    expect(intention.getAttribute('placeholder')).toBe('What are you working on?');
    expect(intention.getAttribute('placeholder')).not.toContain('What you working on');
    expect(getByRole('group', { name: 'Session type' })).toBeTruthy();
    expect(getByRole('group', { name: 'Blocking mode' })).toBeTruthy();
    expect(getByRole('button', { name: 'Start 25 min - Block selected sites' })).toBeTruthy();
  });

  it('uses neutral early-ending confirmation copy with a safe empty fallback', (): void => {
    expect(cancelPhrase(' write the report ')).toBe(
      'I am ending this session before: write the report',
    );
    expect(cancelPhrase('  ')).toBe('I am ending this session before: my focus session');
    expect(cancelPhrase('write the report')).not.toContain('I choose distraction over');
  });

  it('describes configured typed confirmation without exposing the intention phrase', async (): Promise<void> => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      gate: { ...DEFAULT_SETTINGS.gate, delayMs: 30_000, requireTypedPhrase: true },
    };
    const secretLikeIntention: string = 'finish private acquisition notes';
    const { findByRole, getByLabelText, getByRole } = render(
      h(StartForm, { settings, lists: DEFAULT_LISTS }),
    );

    fireEvent.input(getByLabelText('Intention'), { target: { value: secretLikeIntention } });
    fireEvent.click(getByRole('button', { name: 'Friction' }));

    const tooltipText: string = (await findByRole('tooltip')).textContent ?? '';
    expect(tooltipText).toContain('30-second wait and typed confirmation');
    expect(tooltipText).not.toContain(secretLikeIntention);
  });

  it('keeps category changes in the draft and sends the complete rules snapshot once', async (): Promise<void> => {
    const lists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [
        { kind: 'host', pattern: 'news.example' },
        { kind: 'regex', pattern: '^https://example\\.com/private' },
      ],
      whitelist: [{ kind: 'host', pattern: 'docs.python.org' }],
      exclusions: { social: ['facebook.com'] },
    };
    const { getByLabelText, getByRole } = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists }),
    );

    fireEvent.click(getByRole('button', { name: 'Social media' }));
    fireEvent.input(getByLabelText('Intention'), { target: { value: 'write the report' } });

    expect(
      sendMessageMock.mock.calls.some(
        ([request]: unknown[]): boolean => (request as Request).type === 'updateLists',
      ),
    ).toBe(false);

    fireEvent.click(getByRole('button', { name: 'Start 25 min - Block selected sites' }));

    await waitFor((): void => {
      expect(startRequest()?.config).toEqual({
        mode: 'blacklist',
        strictness: 'friction',
        durationMin: 25,
        cycling: DEFAULT_SETTINGS.defaultCycling,
        intention: 'write the report',
        source: 'manual',
        scheduleEntryId: null,
        rules: {
          ...rulesFromLists(lists),
          categories: { ...lists.categories, social: true },
        },
      });
    });
    expect(
      sendMessageMock.mock.calls.some(
        ([request]: unknown[]): boolean => (request as Request).type === 'getLists',
      ),
    ).toBe(false);
  });

  it('adds only valid normalized allow domains to this session', async (): Promise<void> => {
    const { getByLabelText, getByRole, queryByText } = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );

    fireEvent.click(getByRole('radio', { name: /Allow selected sites only/ }));
    const input: HTMLInputElement = getByLabelText('Add an allowed domain') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'https://Docs.Python.org/3/library/' } });
    fireEvent.click(getByRole('button', { name: 'Add allowed domain' }));

    expect(queryByText('docs.python.org')).toBeTruthy();
    fireEvent.input(input, { target: { value: 'https://user@example.com/' } });
    fireEvent.click(getByRole('button', { name: 'Add allowed domain' }));
    expect(getByRole('alert').textContent).toContain('valid domain');

    fireEvent.click(getByRole('button', { name: 'Start 25 min - Allow selected sites only' }));

    await waitFor((): void => {
      expect(startRequest()?.config).toEqual(
        expect.objectContaining({
          mode: 'whitelist',
          rules: expect.objectContaining({
            sessionAllowlist: [{ kind: 'host', pattern: 'docs.python.org' }],
          }),
        }),
      );
    });
    expect(
      sendMessageMock.mock.calls.some(
        ([request]: unknown[]): boolean => (request as Request).type === 'updateLists',
      ),
    ).toBe(false);
  });

  it('keeps the start action and validation errors outside the scrollable rule list', (): void => {
    const { getByLabelText, getByRole } = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );
    const start: HTMLElement = getByRole('button', {
      name: 'Start 25 min - Block selected sites',
    });
    const scrollRegion: HTMLElement = getByRole('region', { name: 'Session rule details' });

    expect(scrollRegion.contains(start)).toBe(false);
    fireEvent.input(getByLabelText('Custom minutes'), { target: { value: '0' } });
    fireEvent.click(start);
    const error: HTMLElement = getByRole('alert');
    expect(error.textContent).toContain('session length');
    expect(scrollRegion.contains(error)).toBe(false);
  });

  it('opens extension Settings for permanent defaults without persisting the draft', (): void => {
    const { getByRole } = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );

    fireEvent.click(getByRole('button', { name: 'Open Settings for permanent defaults' }));

    expect(openOptionsPageMock).toHaveBeenCalledOnce();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('shows the worker rejection beside the start action', async (): Promise<void> => {
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type === 'startSession') {
        return { ok: false, error: 'a session is already running' };
      }
      return undefined;
    });
    const { getByRole, getByText } = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );

    fireEvent.click(getByRole('button', { name: 'Start 25 min - Block selected sites' }));

    await waitFor((): void => {
      expect(getByText('a session is already running')).toBeTruthy();
    });
  });
});

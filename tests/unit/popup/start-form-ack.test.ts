/** @vitest-environment jsdom */
import './chrome-fake';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LISTS, DEFAULT_SETTINGS } from '../../../src/shared/constants';
import type { Request } from '../../../src/shared/messages';
import { resetChromeFake, sendMessageMock } from './chrome-fake';

vi.mock('../../../src/core/categories', () => ({
  ALL_CATEGORIES: [
    { id: 'social', title: 'Social', hosts: ['facebook.com'] },
    { id: 'video', title: 'Video and streaming', hosts: ['youtube.com'] },
    { id: 'news', title: 'News', hosts: ['news.example'] },
  ],
}));

import { StartForm } from '../../../src/popup/StartForm';

type Ack = { ok: true } | { ok: false; error: string };
type ResolveAck = (ack: Ack) => void;
type UpdateListsRequest = Extract<Request, { type: 'updateLists' }>;

function updateRequests(): UpdateListsRequest[] {
  return sendMessageMock.mock.calls
    .map(([request]: unknown[]): Request => request as Request)
    .filter((request: Request): request is UpdateListsRequest => request.type === 'updateLists');
}

function deferredUpdates(): ResolveAck[] {
  const resolvers: ResolveAck[] = [];
  sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
    if (request.type !== 'updateLists') return { ok: true };
    return new Promise<Ack>((resolve: ResolveAck): void => {
      resolvers.push(resolve);
    });
  });
  return resolvers;
}

describe('StartForm category acknowledgement', () => {
  beforeEach((): void => {
    resetChromeFake();
  });

  afterEach((): void => {
    cleanup();
  });

  it('disables only the clicked category while its request is in flight', async (): Promise<void> => {
    const resolvers: ResolveAck[] = deferredUpdates();
    const { getByRole } = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );
    fireEvent.click(getByRole('button', { name: 'Social' }));
    expect((getByRole('button', { name: 'Social' }) as HTMLButtonElement).disabled).toBe(true);
    expect(
      (getByRole('button', { name: 'Video and streaming' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    await waitFor((): void => {
      expect(resolvers).toHaveLength(1);
    });
    resolvers[0]?.({ ok: true });
    await waitFor((): void => {
      expect((getByRole('button', { name: 'Social' }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('queues B after rejected A and excludes A from B worker payload', async (): Promise<void> => {
    const resolvers: ResolveAck[] = deferredUpdates();
    const { getByRole } = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );
    fireEvent.click(getByRole('button', { name: 'Social' }));
    fireEvent.click(getByRole('button', { name: 'Video and streaming' }));
    await waitFor((): void => {
      expect(resolvers).toHaveLength(1);
    });
    expect(updateRequests()).toHaveLength(1);
    expect(updateRequests()[0]?.lists.categories).toMatchObject({ social: true, video: false });
    expect((getByRole('button', { name: 'Social' }) as HTMLButtonElement).disabled).toBe(true);
    expect(
      (getByRole('button', { name: 'Video and streaming' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    resolvers[0]?.({ ok: false, error: 'Changes that weaken blocking are locked until 16:45.' });
    await waitFor((): void => {
      expect(resolvers).toHaveLength(2);
    });
    expect(updateRequests()[1]?.lists.categories).toMatchObject({ social: false, video: true });
    resolvers[1]?.({ ok: true });
    await waitFor((): void => {
      expect(
        getByRole('button', { name: 'Video and streaming' }).getAttribute('aria-pressed'),
      ).toBe('true');
    });
    expect(getByRole('button', { name: 'Social' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('renders the worker rejection and queues an unrelated third category', async (): Promise<void> => {
    const resolvers: ResolveAck[] = deferredUpdates();
    const { getByRole } = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );
    fireEvent.click(getByRole('button', { name: 'Social' }));
    fireEvent.click(getByRole('button', { name: 'Video and streaming' }));
    expect((getByRole('button', { name: 'News' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(getByRole('button', { name: 'News' }));
    expect((getByRole('button', { name: 'News' }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor((): void => {
      expect(resolvers).toHaveLength(1);
    });
    resolvers[0]?.({ ok: false, error: 'Changes that weaken blocking are locked until 16:45.' });
    await waitFor((): void => {
      expect(getByRole('alert').textContent).toBe(
        'Changes that weaken blocking are locked until 16:45.',
      );
      expect(resolvers).toHaveLength(2);
    });
    expect(updateRequests()[1]?.lists.categories).toMatchObject({
      social: false,
      video: true,
      news: false,
    });
    resolvers[1]?.({ ok: true });
    await waitFor((): void => {
      expect(resolvers).toHaveLength(3);
    });
    expect(updateRequests()[2]?.lists.categories).toMatchObject({
      social: false,
      video: true,
      news: true,
    });
    resolvers[2]?.({ ok: true });
    await waitFor((): void => {
      expect(getByRole('button', { name: 'News' }).getAttribute('aria-pressed')).toBe('true');
    });
  });

  it('keeps A acknowledged when queued B is rejected', async (): Promise<void> => {
    const resolvers: ResolveAck[] = deferredUpdates();
    const { getByRole } = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );
    fireEvent.click(getByRole('button', { name: 'Social' }));
    fireEvent.click(getByRole('button', { name: 'Video and streaming' }));
    await waitFor((): void => {
      expect(resolvers).toHaveLength(1);
    });
    resolvers[0]?.({ ok: true });
    await waitFor((): void => {
      expect(resolvers).toHaveLength(2);
    });
    expect(updateRequests()[1]?.lists.categories).toMatchObject({ social: true, video: true });
    resolvers[1]?.({ ok: false, error: 'Changes that weaken blocking are locked until 16:45.' });
    await waitFor((): void => {
      expect(getByRole('button', { name: 'Social' }).getAttribute('aria-pressed')).toBe('true');
    });
    expect(getByRole('button', { name: 'Video and streaming' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('does not queue a category twice while it is pending', async (): Promise<void> => {
    const resolvers: ResolveAck[] = deferredUpdates();
    const { getByRole } = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );
    const social: HTMLButtonElement = getByRole('button', { name: 'Social' }) as HTMLButtonElement;
    fireEvent.click(social);
    fireEvent.click(social);
    await waitFor((): void => {
      expect(resolvers).toHaveLength(1);
    });
  });
});

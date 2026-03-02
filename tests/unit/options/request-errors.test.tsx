/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrivacyData } from '../../../src/options/PrivacyData';
import { SoundsBadge } from '../../../src/options/SoundsBadge';
import { DEFAULT_SETTINGS, DEFAULT_SETUP } from '../../../src/shared/constants';
import type { Ack } from '../../../src/shared/messages';
import type { SetupState } from '../../../src/shared/types';
import { type ChromeFake, installChromeFake } from './chrome-fake';

interface Deferred<T> {
  promise: Promise<T>;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let reject: (reason?: unknown) => void = (): void => {};
  const promise: Promise<T> = new Promise<T>((_resolve, rejectPromise): void => {
    reject = rejectPromise;
  });
  return { promise, reject };
}

let fake: ChromeFake;

describe('Options request errors', (): void => {
  beforeEach((): void => {
    fake = installChromeFake();
  });

  afterEach((): void => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('settles a rejected sound preview and allows retry', async (): Promise<void> => {
    const pending: Deferred<Ack> = deferred<Ack>();
    fake.respond('previewSound', (): Promise<Ack> => pending.promise);
    const { getByRole } = render(
      <SoundsBadge settings={DEFAULT_SETTINGS} onChange={(): void => {}} />,
    );
    const preview: HTMLButtonElement = getByRole('button', {
      name: 'Preview Session complete',
    }) as HTMLButtonElement;

    fireEvent.click(preview);
    expect(preview.disabled).toBe(true);
    pending.reject(new Error('worker disconnected'));

    await waitFor((): void => {
      expect(getByRole('alert').textContent).toBe('Could not preview the sound. Try again.');
      expect(preview.disabled).toBe(false);
    });
  });

  it('settles a rejected privacy action and leaves its single switch retryable', async (): Promise<void> => {
    const pending: Deferred<string | null> = deferred<string | null>();
    const setup: SetupState = {
      ...DEFAULT_SETUP,
      completed: true,
      websiteAccess: 'granted',
      blockingRegistration: 'ready',
      storageMode: 'sync',
    };
    const { getAllByRole, getByRole } = render(
      <PrivacyData
        setup={setup}
        onReconcileWebsiteAccess={async (): Promise<string | null> => null}
        onStorageModeChange={(): Promise<string | null> => pending.promise}
        onRetrySync={async (): Promise<string | null> => null}
        onClearData={async (): Promise<string | null> => null}
      />,
    );
    const sync: HTMLInputElement = getByRole('switch', {
      name: 'Sync Focus Lock data across Chrome devices',
    }) as HTMLInputElement;

    fireEvent.click(sync);
    expect(sync.disabled).toBe(true);
    pending.reject(new Error('worker disconnected'));

    await waitFor((): void => {
      expect(getByRole('alert').textContent).toBe('The request could not be completed. Try again.');
      expect(sync.disabled).toBe(false);
    });
    expect(getAllByRole('switch')).toHaveLength(1);
  });
});

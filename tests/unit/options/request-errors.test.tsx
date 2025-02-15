/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SaveRow } from '../../../src/options/SaveRow';
import { SoundsBadge } from '../../../src/options/SoundsBadge';
import { DEFAULT_SETTINGS } from '../../../src/shared/constants';
import type { Ack } from '../../../src/shared/messages';
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

  it('settles a rejected save and allows retry', async (): Promise<void> => {
    const pending: Deferred<string | null> = deferred<string | null>();
    const { getByRole } = render(<SaveRow label="Save settings" onSave={() => pending.promise} />);
    const save: HTMLButtonElement = getByRole('button', {
      name: 'Save settings',
    }) as HTMLButtonElement;

    fireEvent.click(save);
    expect(save.disabled).toBe(true);
    pending.reject(new Error('worker disconnected'));

    await waitFor((): void => {
      expect(getByRole('alert').textContent).toBe('Could not save. Try again.');
      expect(save.disabled).toBe(false);
    });
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
});

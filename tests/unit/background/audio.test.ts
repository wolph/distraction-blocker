import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../src/shared/constants';

afterEach((): void => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe('background audio boundaries', (): void => {
  it('settles when offscreen creation rejects', async (): Promise<void> => {
    vi.stubGlobal('chrome', {
      offscreen: {
        hasDocument: vi.fn().mockResolvedValue(false),
        createDocument: vi.fn().mockRejectedValue(new Error('offscreen unavailable')),
        Reason: { AUDIO_PLAYBACK: 'AUDIO_PLAYBACK' },
      },
      runtime: { sendMessage: vi.fn() },
    });
    const { playSound }: typeof import('../../../src/background/audio') = await import(
      '../../../src/background/audio'
    );

    await expect(playSound('sessionComplete', DEFAULT_SETTINGS.sounds)).resolves.toBeUndefined();
  });

  it('attaches a rejection handler to notification creation', async (): Promise<void> => {
    const catchHandler: ReturnType<typeof vi.fn> = vi.fn();
    vi.stubGlobal('chrome', {
      notifications: {
        create: vi.fn((): { catch: ReturnType<typeof vi.fn> } => ({ catch: catchHandler })),
      },
      runtime: {
        getManifest: vi.fn((): { icons: Record<string, string> } => ({
          icons: { '128': 'icon.png' },
        })),
        getURL: vi.fn((path: string): string => `chrome-extension://id/${path}`),
      },
    });
    const { notify }: typeof import('../../../src/background/audio') = await import(
      '../../../src/background/audio'
    );

    notify('Complete', 'Take a break.');

    expect(catchHandler).toHaveBeenCalledOnce();
  });
});

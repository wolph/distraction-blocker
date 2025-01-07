import { describe, expect, it, type Mock, vi } from 'vitest';
import { closeContextOnSetupFailure } from '../../e2e/context-cleanup';

describe('closeContextOnSetupFailure', () => {
  it('closes the launched context and rethrows a setup rejection', async () => {
    const setupError: Error = new Error('popup setup failed');
    const close: Mock<() => Promise<void>> = vi.fn().mockResolvedValue(undefined);

    await expect(
      closeContextOnSetupFailure({ close }, async (): Promise<never> => {
        throw setupError;
      }),
    ).rejects.toBe(setupError);
    expect(close).toHaveBeenCalledOnce();
  });

  it('returns successful setup without closing the context', async () => {
    const close: Mock<() => Promise<void>> = vi.fn().mockResolvedValue(undefined);

    await expect(
      closeContextOnSetupFailure({ close }, async (): Promise<string> => 'ready'),
    ).resolves.toBe('ready');
    expect(close).not.toHaveBeenCalled();
  });
});

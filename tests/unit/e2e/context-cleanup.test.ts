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

  it('preserves setup and cleanup errors when closing also rejects', async () => {
    const setupError: Error = new Error('popup setup failed');
    const closeError: Error = new Error('context close failed');
    const close: Mock<() => Promise<void>> = vi.fn().mockRejectedValue(closeError);
    let caught: unknown;

    try {
      await closeContextOnSetupFailure({ close }, async (): Promise<never> => {
        throw setupError;
      });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate: AggregateError = caught as AggregateError;
    expect(aggregate.errors).toEqual([setupError, closeError]);
    expect(aggregate.cause).toBe(setupError);
    expect(aggregate.message).toContain('setup and context cleanup failed');
  });
});

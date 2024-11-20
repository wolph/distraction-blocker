import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncEchoes, SyncWriter } from '../../../src/background/sync-writer';

describe('SyncWriter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces rapid writes to the same key into one flush', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const w = new SyncWriter(10_000, write);
    w.queue('bank', { balanceMs: 1 });
    w.queue('bank', { balanceMs: 2 });
    w.queue('streak', { current: 3 });
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({ bank: { balanceMs: 2 }, streak: { current: 3 } });
  });

  it('flushNow writes immediately and cancels the timer', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const w = new SyncWriter(10_000, write);
    w.queue('bank', { balanceMs: 5 });
    await w.flushNow();
    expect(write).toHaveBeenCalledWith({ bank: { balanceMs: 5 } });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('preserves a failed batch and retries it with later writes', async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error('sync unavailable'))
      .mockResolvedValueOnce(undefined);
    const writer = new SyncWriter(10_000, write);
    writer.queue('bank', 5);

    await expect(writer.flushNow()).rejects.toThrow('sync unavailable');
    writer.queue('streak', 3);
    await writer.flushNow();

    expect(write).toHaveBeenNthCalledWith(2, { bank: 5, streak: 3 });
  });
});

describe('SyncEchoes', () => {
  it('consumes only the matching local storage echo', () => {
    const echoes = new SyncEchoes();
    echoes.remember('bank', { balanceMs: 10 });

    expect(echoes.consume('bank', { balanceMs: 20 })).toBe(false);
    expect(echoes.consume('bank', { balanceMs: 10 })).toBe(true);
    expect(echoes.consume('bank', { balanceMs: 10 })).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { accrue, msUntilAffordable, spend } from '../../../src/core/budget';
import { CoreError } from '../../../src/shared/errors';
import type { PauseEconomy } from '../../../src/shared/types';

const ECO: PauseEconomy = { earnRatio: 5 / 30, capMs: 30 * 60_000, pauseMs: 5 * 60_000, unlockMs: 5 * 60_000 };

describe('accrue', () => {
  it('earns 5 pause minutes per 30 focused minutes', () => {
    const b = accrue({ balanceMs: 0 }, 30 * 60_000, ECO);
    expect(b.balanceMs).toBe(5 * 60_000);
  });
  it('caps at capMs', () => {
    const b = accrue({ balanceMs: 29 * 60_000 }, 60 * 60_000, ECO);
    expect(b.balanceMs).toBe(30 * 60_000);
  });
});

describe('spend', () => {
  it('deducts and refuses overdraft', () => {
    expect(spend({ balanceMs: 6 * 60_000 }, 5 * 60_000).balanceMs).toBe(60_000);
    expect(() => spend({ balanceMs: 60_000 }, 5 * 60_000)).toThrow(CoreError);
  });
});

describe('msUntilAffordable', () => {
  it('is 0 when affordable and scales with the earn ratio otherwise', () => {
    expect(msUntilAffordable({ balanceMs: 5 * 60_000 }, 5 * 60_000, ECO)).toBe(0);
    expect(msUntilAffordable({ balanceMs: 0 }, 5 * 60_000, ECO)).toBe(30 * 60_000);
  });
});

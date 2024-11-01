import { describe, expect, it } from 'vitest';
import { planTabAction } from '../../../src/background/tabs';
import type { Verdict } from '../../../src/shared/types';

const blocked: Verdict = { blocked: true, reason: 'custom', matchedPattern: 'facebook.com' };
const allowed: Verdict = { blocked: false, reason: 'default', matchedPattern: null };

describe('planTabAction', () => {
  it('blocks a fresh tab: applyBlock plus mute, recording the prior state', () => {
    expect(
      planTabAction(blocked, {
        muted: false,
        wasMutedByUs: false,
        priorMuted: false,
        wasStopped: false,
      }),
    ).toEqual({ command: 'applyBlock', mute: true, reload: false });
  });

  it('blocks a tab the user muted themselves: still records and mutes once', () => {
    expect(
      planTabAction(blocked, {
        muted: true,
        wasMutedByUs: false,
        priorMuted: false,
        wasStopped: false,
      }),
    ).toEqual({ command: 'applyBlock', mute: true, reload: false });
  });

  it('does not re-mute a tab already muted by us', () => {
    expect(
      planTabAction(blocked, {
        muted: true,
        wasMutedByUs: true,
        priorMuted: false,
        wasStopped: false,
      }),
    ).toEqual({ command: 'applyBlock', mute: null, reload: false });
  });

  it('clears with mute restore: puts the recorded prior state back', () => {
    expect(
      planTabAction(allowed, {
        muted: true,
        wasMutedByUs: true,
        priorMuted: true,
        wasStopped: false,
      }),
    ).toEqual({ command: 'clearBlock', mute: true, reload: false });
  });

  it('clears a stopped tab with a reload', () => {
    expect(
      planTabAction(allowed, {
        muted: true,
        wasMutedByUs: true,
        priorMuted: false,
        wasStopped: true,
      }),
    ).toEqual({ command: 'clearBlock', mute: false, reload: true });
  });

  it('clears a tab we never touched without side effects', () => {
    expect(
      planTabAction(allowed, {
        muted: false,
        wasMutedByUs: false,
        priorMuted: false,
        wasStopped: false,
      }),
    ).toEqual({ command: 'clearBlock', mute: null, reload: false });
  });
});

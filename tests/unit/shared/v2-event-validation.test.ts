import { describe, expect, it } from 'vitest';
import {
  isSessionEndedEventV2,
  isSessionStartedEventV2,
} from '../../../src/shared/runtime-validation';
import type { SessionEndedEventV2 } from '../../../src/shared/types';
import { ENDED, OCCURRENCE, STARTED } from './v2-runtime-fixtures';

describe('v2 event validation', (): void => {
  it('accepts exact start and manual-completion events', (): void => {
    expect(isSessionStartedEventV2(STARTED)).toBe(true);
    expect(isSessionEndedEventV2(ENDED)).toBe(true);
  });

  it.each([
    { ...STARTED, eventId: 'wrong:start' },
    { ...STARTED, sessionId: 'not-a-uuid' },
    { ...STARTED, at: -1 },
    { ...STARTED, at: 0.5 },
    { ...STARTED, at: Number.MAX_SAFE_INTEGER + 1 },
    { ...STARTED, at: Number.POSITIVE_INFINITY },
    { ...STARTED, source: 'schedule', scheduleOccurrence: null },
    { ...STARTED, source: 'manual', scheduleOccurrence: OCCURRENCE },
    { ...STARTED, strictness: 'hard', duration: { kind: 'until-stopped' } },
    { ...STARTED, durationMin: 25 },
    { ...STARTED, extra: true },
  ])('rejects malformed start event %#', (value: unknown): void => {
    expect(isSessionStartedEventV2(value)).toBe(false);
  });

  it.each([
    { ...ENDED, eventId: 'wrong:end' },
    { ...ENDED, sessionId: 'not-a-uuid' },
    { ...ENDED, at: -1 },
    { ...ENDED, at: 0.5 },
    { ...ENDED, focusedMs: Number.NaN },
    { ...ENDED, focusedMs: Number.MAX_SAFE_INTEGER + 1 },
    { ...ENDED, source: 'schedule', scheduleOccurrence: null },
    { ...ENDED, extra: true },
  ])('rejects malformed end event %#', (value: unknown): void => {
    expect(isSessionEndedEventV2(value)).toBe(false);
  });

  it.each<
    [
      reason: SessionEndedEventV2['reason'],
      outcome: SessionEndedEventV2['outcome'],
      duration: SessionEndedEventV2['duration'],
    ]
  >([
    ['timer-completed', 'completed', { kind: 'timed', minutes: 25 }],
    ['manual-completed', 'completed', { kind: 'until-stopped' }],
    ['manual-canceled', 'canceled', { kind: 'timed', minutes: 25 }],
    ['website-access-lost', 'canceled', { kind: 'timed', minutes: 25 }],
    ['content-registration-failed', 'canceled', { kind: 'until-stopped' }],
    ['alarm-failed', 'canceled', { kind: 'timed', minutes: 25 }],
    ['tab-enforcement-failed', 'canceled', { kind: 'until-stopped' }],
    ['invalid-active-state', 'canceled', { kind: 'timed', minutes: 25 }],
  ])(
    'accepts the exact valid mapping for %s',
    (reason: SessionEndedEventV2['reason'], outcome: SessionEndedEventV2['outcome'], duration: SessionEndedEventV2['duration']): void => {
      expect(isSessionEndedEventV2({ ...ENDED, reason, outcome, duration })).toBe(true);
    },
  );

  it.each([
    ['timer-completed', 'canceled', { kind: 'timed', minutes: 25 }],
    ['timer-completed', 'completed', { kind: 'until-stopped' }],
    ['manual-completed', 'canceled', { kind: 'until-stopped' }],
    ['manual-completed', 'completed', { kind: 'timed', minutes: 25 }],
    ['manual-canceled', 'completed', { kind: 'timed', minutes: 25 }],
    ['manual-canceled', 'canceled', { kind: 'until-stopped' }],
    ['website-access-lost', 'completed', { kind: 'timed', minutes: 25 }],
    ['content-registration-failed', 'completed', { kind: 'timed', minutes: 25 }],
    ['alarm-failed', 'completed', { kind: 'timed', minutes: 25 }],
    ['tab-enforcement-failed', 'completed', { kind: 'timed', minutes: 25 }],
    ['invalid-active-state', 'completed', { kind: 'timed', minutes: 25 }],
    ['unknown-reason', 'canceled', { kind: 'timed', minutes: 25 }],
  ])(
    'rejects the invalid reason mapping %#',
    (reason: unknown, outcome: unknown, duration: unknown): void => {
      expect(isSessionEndedEventV2({ ...ENDED, reason, outcome, duration })).toBe(false);
    },
  );

  it('allows a missing scheduled occurrence only for a canceled invalid-active-state end', (): void => {
    const scheduledWithoutOccurrence: SessionEndedEventV2 = {
      ...ENDED,
      outcome: 'canceled',
      reason: 'invalid-active-state',
      duration: { kind: 'timed', minutes: 25 },
      source: 'schedule',
      scheduleOccurrence: null,
    };
    expect(isSessionEndedEventV2(scheduledWithoutOccurrence)).toBe(true);
    expect(
      isSessionEndedEventV2({ ...scheduledWithoutOccurrence, reason: 'manual-canceled' }),
    ).toBe(false);
    expect(isSessionEndedEventV2({ ...scheduledWithoutOccurrence, outcome: 'completed' })).toBe(
      false,
    );
    expect(
      isSessionEndedEventV2({
        ...scheduledWithoutOccurrence,
        duration: { kind: 'until-stopped' },
      }),
    ).toBe(false);
  });

  it('accepts scheduled events only with their exact occurrence', (): void => {
    expect(
      isSessionStartedEventV2({
        ...STARTED,
        source: 'schedule',
        scheduleOccurrence: OCCURRENCE,
      }),
    ).toBe(true);
    expect(
      isSessionEndedEventV2({
        ...ENDED,
        source: 'schedule',
        scheduleOccurrence: OCCURRENCE,
      }),
    ).toBe(true);
  });

  it('returns false for hostile event objects without throwing', (): void => {
    const revocable: { proxy: object; revoke: () => void } = Proxy.revocable<object>({}, {});
    revocable.revoke();
    const throwing: unknown = new Proxy<Record<string, unknown>>(
      {},
      {
        ownKeys: (): never => {
          throw new Error('ownKeys trap');
        },
      },
    );
    const nestedOccurrence: unknown = new Proxy<Record<string, unknown>>(
      {},
      {
        ownKeys: (): never => {
          throw new Error('nested ownKeys trap');
        },
      },
    );

    for (const value of [revocable.proxy, throwing]) {
      expect((): boolean => isSessionStartedEventV2(value)).not.toThrow();
      expect(isSessionStartedEventV2(value)).toBe(false);
      expect((): boolean => isSessionEndedEventV2(value)).not.toThrow();
      expect(isSessionEndedEventV2(value)).toBe(false);
    }
    expect((): boolean =>
      isSessionStartedEventV2({
        ...STARTED,
        source: 'schedule',
        scheduleOccurrence: nestedOccurrence,
      }),
    ).not.toThrow();
    expect(
      isSessionStartedEventV2({
        ...STARTED,
        source: 'schedule',
        scheduleOccurrence: nestedOccurrence,
      }),
    ).toBe(false);
  });

  it('rejects self-mutating root event fields', (): void => {
    const started: Record<string, unknown> = { ...STARTED };
    let sessionIdReads: number = 0;
    Object.defineProperty(started, 'sessionId', {
      enumerable: true,
      get: (): string => {
        sessionIdReads += 1;
        return sessionIdReads <= 2 ? STARTED.sessionId : 'not-a-uuid';
      },
    });

    const ended: Record<string, unknown> = {
      ...ENDED,
      outcome: 'canceled',
      duration: { kind: 'timed', minutes: 25 },
      source: 'schedule',
      scheduleOccurrence: null,
    };
    let reasonReads: number = 0;
    Object.defineProperty(ended, 'reason', {
      enumerable: true,
      get: (): string => {
        reasonReads += 1;
        return reasonReads === 1 ? 'website-access-lost' : 'invalid-active-state';
      },
    });

    expect(isSessionStartedEventV2(started)).toBe(false);
    expect(isSessionEndedEventV2(ended)).toBe(false);
  });

  it('rejects self-mutating nested event fields', (): void => {
    const duration: Record<string, unknown> = { minutes: 25 };
    let durationKindReads: number = 0;
    Object.defineProperty(duration, 'kind', {
      enumerable: true,
      get: (): string => {
        durationKindReads += 1;
        return durationKindReads === 1 ? 'timed' : 'until-stopped';
      },
    });
    const occurrence: Record<string, unknown> = { ...OCCURRENCE };
    let entryIdReads: number = 0;
    Object.defineProperty(occurrence, 'entryId', {
      enumerable: true,
      get: (): string => {
        entryIdReads += 1;
        return entryIdReads <= 2 ? OCCURRENCE.entryId : 'other';
      },
    });

    expect(isSessionStartedEventV2({ ...STARTED, duration })).toBe(false);
    expect(
      isSessionEndedEventV2({
        ...ENDED,
        source: 'schedule',
        scheduleOccurrence: occurrence,
      }),
    ).toBe(false);
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  isEventRecord,
  isLegacyEventRecord,
  isSessionEndedEventV2,
  isSessionEventRecordV2,
  isSessionStartedEventV2,
} from '../../../src/shared/runtime-validation';
import type { LegacyEventRecord, SessionEndedEventV2 } from '../../../src/shared/types';
import { ENDED, OCCURRENCE, SESSION_ID, STARTED } from './v2-runtime-fixtures';

const LEGACY_START: LegacyEventRecord = {
  t: 'sessionStarted',
  at: 1,
  source: 'manual',
  mode: 'blacklist',
  strictness: 'hard',
  durationMin: 25,
  intention: 'Ship the release',
  sessionId: SESSION_ID,
};
const LEGACY_IDENTITY: LegacyEventRecord = {
  t: 'sessionIdentityAssigned',
  at: 4,
  startedAt: 1,
  sessionId: SESSION_ID,
};
const LEGACY_EARNED: LegacyEventRecord = {
  t: 'budgetEarned',
  at: 9,
  ms: 5_000,
  sessionId: SESSION_ID,
};

const LEGACY_VARIANTS: readonly LegacyEventRecord[] = [
  LEGACY_START,
  { t: 'sessionCompleted', at: 2, focusedMs: 1_000, sessionId: SESSION_ID },
  { t: 'sessionCanceled', at: 3, focusedMs: 2_000, sessionId: SESSION_ID },
  LEGACY_IDENTITY,
  { t: 'phase', at: 5, from: 'focus', to: 'break', sessionId: SESSION_ID },
  {
    t: 'attempt',
    at: 6,
    url: 'https://example.com/feed',
    host: 'example.com',
    tabId: 7,
    kind: 'navigation',
    sessionId: SESSION_ID,
  },
  { t: 'gateOpened', at: 7, gate: 'pause', sessionId: SESSION_ID },
  { t: 'gateResisted', at: 8, gate: 'cancel', sessionId: SESSION_ID },
  LEGACY_EARNED,
  { t: 'pauseTaken', at: 10, ms: 6_000, sessionId: SESSION_ID },
  { t: 'unlockTaken', at: 11, host: 'example.com', ms: 7_000, sessionId: SESSION_ID },
];

describe('v2 event validation', (): void => {
  it('accepts exact start and manual-completion events', (): void => {
    expect(isSessionStartedEventV2(STARTED)).toBe(true);
    expect(isSessionEndedEventV2(ENDED)).toBe(true);
  });

  it('accepts a Friction until-stopped start event', (): void => {
    expect(
      isSessionStartedEventV2({
        ...STARTED,
        strictness: 'friction',
        duration: { kind: 'until-stopped' },
      }),
    ).toBe(true);
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

  it('rejects a start duration Proxy whose reads disagree with its data descriptors', (): void => {
    const duration: unknown = new Proxy<Record<string, unknown>>(
      { kind: 'until-stopped' },
      {
        get: (
          target: Record<string, unknown>,
          property: PropertyKey,
          receiver: unknown,
        ): unknown => (property === 'kind' ? 'timed' : Reflect.get(target, property, receiver)),
      },
    );

    expect(isSessionStartedEventV2({ ...STARTED, duration })).toBe(false);
  });

  it('rejects an end duration Proxy whose reads disagree with its data descriptors', (): void => {
    const duration: unknown = new Proxy<Record<string, unknown>>(
      { kind: 'timed', minutes: 25 },
      {
        get: (
          target: Record<string, unknown>,
          property: PropertyKey,
          receiver: unknown,
        ): unknown =>
          property === 'kind' ? 'until-stopped' : Reflect.get(target, property, receiver),
      },
    );

    expect(isSessionEndedEventV2({ ...ENDED, duration })).toBe(false);
  });
});

describe('v2 event record union validation', (): void => {
  it.each(LEGACY_VARIANTS)('accepts the legacy variant %#', (event: LegacyEventRecord): void => {
    expect(isSessionEventRecordV2(event)).toBe(true);
  });

  it('accepts both version 2 events', (): void => {
    expect(isSessionEventRecordV2(STARTED)).toBe(true);
    expect(isSessionEventRecordV2(ENDED)).toBe(true);
  });

  it('rejects a legacy start carrying version 2 without an event ID', (): void => {
    expect(isSessionEventRecordV2({ ...LEGACY_START, version: 2 })).toBe(false);
    expect(isSessionEventRecordV2({ ...LEGACY_EARNED, version: 2 })).toBe(false);
  });

  it.each([null, undefined, 42, '{}', { t: 'unknown', at: 1 }])(
    'rejects the malformed union candidate %#',
    (value: unknown): void => {
      expect(isSessionEventRecordV2(value)).toBe(false);
    },
  );

  it.each(LEGACY_VARIANTS)(
    'accepts the legacy variant %# through both entry points',
    (event: LegacyEventRecord): void => {
      // `isEventRecord` delegates to `isLegacyEventRecord`, so comparing the two would pass
      // whatever either did. Both are pinned to the expected verdict instead.
      expect(isLegacyEventRecord(event)).toBe(true);
      expect(isEventRecord(event)).toBe(true);
    },
  );

  it.each([
    { ...LEGACY_START, durationMin: -1 },
    { ...LEGACY_IDENTITY, sessionId: ' ' },
    { ...LEGACY_EARNED, at: Number.NaN },
    { t: 'unknown', at: 1 },
    null,
  ])('agrees with the legacy guard on the rejected value %#', (value: unknown): void => {
    expect(isLegacyEventRecord(value)).toBe(isEventRecord(value));
    expect(isLegacyEventRecord(value)).toBe(false);
  });

  it('rejects both version 2 events from the legacy guard', (): void => {
    expect(isLegacyEventRecord(STARTED)).toBe(false);
    expect(isLegacyEventRecord(ENDED)).toBe(false);
  });

  it('never references the legacy entry point from the union guard', (): void => {
    // Resolved from this module rather than the runner's working directory, and ended at the next
    // top-level declaration rather than the first closing brace, so a nested block inside the guard
    // cannot shorten the scanned region and turn a real reference into a pass.
    const source: string = readFileSync(
      fileURLToPath(new URL('../../../src/shared/runtime-validation.ts', import.meta.url)),
      'utf8',
    );
    const start: number = source.indexOf('export function isSessionEventRecordV2');
    expect(start).toBeGreaterThan(-1);
    const nextDeclaration: number = source
      .slice(start + 1)
      .search(/\n(?:export |function |const )/u);
    expect(nextDeclaration).toBeGreaterThan(-1);
    const guard: string = source.slice(start, start + 1 + nextDeclaration);

    expect(guard).toContain('isLegacyEventRecord');
    expect(guard).not.toMatch(/\bisEventRecord\b/u);
  });
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, emptySnapshot } from '../../../src/shared/constants';
import {
  isEventRecord,
  isSessionSnapshot,
  parseEventExportResponse,
} from '../../../src/shared/runtime-validation';
import type { EventRecord, SessionConfig, SessionSnapshot } from '../../../src/shared/types';

const NOW: number = 1_700_000_000_000;
const INDEFINITE_CONFIG: SessionConfig = {
  mode: 'blacklist',
  strictness: 'friction',
  durationMin: null,
  cycling: null,
  intention: 'write the report',
  source: 'manual',
  scheduleEntryId: null,
};

function indefiniteSnapshot(update: Record<string, unknown> = {}): unknown {
  return {
    ...emptySnapshot(NOW),
    phase: 'focus',
    config: INDEFINITE_CONFIG,
    startedAt: NOW - 10_000,
    phaseStartedAt: NOW - 10_000,
    phaseEndsAt: null,
    sessionEndsAt: null,
    ...update,
  };
}

describe('indefinite session snapshot validation', (): void => {
  it.each(['blacklist', 'whitelist'])(
    'accepts null focus deadlines for a manual friction %s session',
    (mode: string): void => {
      expect(
        isSessionSnapshot(indefiniteSnapshot({ config: { ...INDEFINITE_CONFIG, mode } })),
      ).toBe(true);
    },
  );

  it('accepts a finite paid pause deadline with no session deadline', (): void => {
    expect(
      isSessionSnapshot(indefiniteSnapshot({ phase: 'paused', phaseEndsAt: NOW + 10_000 })),
    ).toBe(true);
  });

  it.each([
    ['hard strictness', { strictness: 'hard' }],
    ['cycling', { cycling: DEFAULT_SETTINGS.defaultCycling }],
    ['scheduled source', { source: 'schedule', scheduleEntryId: 'workday' }],
    ['manual source with a schedule identity', { scheduleEntryId: 'workday' }],
    ['numeric infinity', { durationMin: Number.POSITIVE_INFINITY }],
    ['NaN duration', { durationMin: Number.NaN }],
  ])('rejects indefinite %s', (_label: string, configUpdate: Record<string, unknown>): void => {
    expect(
      isSessionSnapshot(indefiniteSnapshot({ config: { ...INDEFINITE_CONFIG, ...configUpdate } })),
    ).toBe(false);
  });

  it.each([
    ['finite session deadline', { sessionEndsAt: NOW + 20_000 }],
    ['finite focus deadline', { phaseEndsAt: NOW + 10_000 }],
    ['break phase', { phase: 'break', phaseEndsAt: NOW + 10_000 }],
    ['pause without a deadline', { phase: 'paused' }],
    ['pause deadline before its start', { phase: 'paused', phaseEndsAt: NOW - 20_000 }],
    ['pause with numeric infinity', { phase: 'paused', phaseEndsAt: Number.POSITIVE_INFINITY }],
    ['phase start before the session', { phaseStartedAt: NOW - 20_000 }],
  ])('rejects an indefinite %s', (_label: string, update: Record<string, unknown>): void => {
    expect(isSessionSnapshot(indefiniteSnapshot(update))).toBe(false);
  });

  it.each([
    [null, NOW + 20_000],
    [NOW + 10_000, null],
    [null, null],
  ])(
    'rejects null deadlines for a timed session (%s, %s)',
    (phaseEndsAt: number | null, sessionEndsAt: number | null): void => {
      const snapshot: unknown = indefiniteSnapshot({
        config: { ...INDEFINITE_CONFIG, durationMin: 25 },
        phaseEndsAt,
        sessionEndsAt,
      });
      expect(isSessionSnapshot(snapshot)).toBe(false);
    },
  );

  it('preserves an indefinite snapshot through JSON storage', (): void => {
    const restored: unknown = JSON.parse(JSON.stringify(indefiniteSnapshot()));

    expect(isSessionSnapshot(restored)).toBe(true);
    expect((restored as SessionSnapshot).config?.durationMin).toBeNull();
    expect((restored as SessionSnapshot).phaseEndsAt).toBeNull();
    expect((restored as SessionSnapshot).sessionEndsAt).toBeNull();
  });
});

describe('indefinite session event validation', (): void => {
  const started: EventRecord = {
    t: 'sessionStarted',
    at: NOW,
    source: 'manual',
    mode: 'blacklist',
    strictness: 'friction',
    durationMin: null,
    intention: 'write the report',
  };

  it('accepts and exports an indefinite session start with a null duration', (): void => {
    expect(isEventRecord(started)).toBe(true);
    expect(parseEventExportResponse({ json: JSON.stringify([started]) })).toEqual([started]);
  });

  it.each([Number.POSITIVE_INFINITY, Number.NaN, -1, 0, 'infinity', undefined])(
    'rejects an invalid session event duration %s',
    (durationMin: unknown): void => {
      expect(isEventRecord({ ...started, durationMin })).toBe(false);
    },
  );

  it.each([{ strictness: 'hard' }, { source: 'schedule' }])(
    'rejects an indefinite session event with incompatible settings %s',
    (update: Record<string, unknown>): void => {
      expect(isEventRecord({ ...started, ...update })).toBe(false);
    },
  );
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../src/shared/constants';
import { isScheduleEntryV2, parseStoredSettingsV2 } from '../../../src/shared/runtime-validation';
import type { SettingsV2 } from '../../../src/shared/types';
import { sparseArray, WINDOW_ENTRY } from './v2-runtime-fixtures';

type EntryExtraCase = readonly [
  label: string,
  shape: 'v1' | 'v2',
  key: PropertyKey,
  enumerable: boolean,
];

const ENTRY_EXTRA_CASES: EntryExtraCase[] = [
  ['v1 non-enumerable string extra', 'v1', 'extra', false],
  ['v1 Symbol extra', 'v1', Symbol('extra'), true],
  ['v2 non-enumerable string extra', 'v2', 'extra', false],
  ['v2 Symbol extra', 'v2', Symbol('extra'), true],
];

describe('v2 schedule validation and v1 Settings compatibility', (): void => {
  it('accepts exact v2 window and forced indefinite entries', (): void => {
    expect(isScheduleEntryV2(WINDOW_ENTRY)).toBe(true);
    expect(
      isScheduleEntryV2({
        ...WINDOW_ENTRY,
        duration: { kind: 'until-stopped' },
        strictness: 'flexible',
        cycling: null,
      }),
    ).toBe(true);
  });

  it.each([
    { ...WINDOW_ENTRY, duration: { kind: 'until-stopped' }, strictness: 'hard' },
    {
      ...WINDOW_ENTRY,
      duration: { kind: 'until-stopped' },
      strictness: 'flexible',
      cycling: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 },
    },
    { ...WINDOW_ENTRY, duration: { kind: 'window', minutes: 25 } },
    { ...WINDOW_ENTRY, durationMin: 25 },
    { ...WINDOW_ENTRY, extra: true },
  ])('rejects invalid v2 schedule entry %#', (value: unknown): void => {
    expect(isScheduleEntryV2(value)).toBe(false);
  });

  it('normalizes only exact v1 schedule entries to window duration', (): void => {
    const legacyEntry: Record<string, unknown> = structuredClone(WINDOW_ENTRY) as unknown as Record<
      string,
      unknown
    >;
    delete legacyEntry.duration;
    const stored: Record<string, unknown> = { ...DEFAULT_SETTINGS, schedule: [legacyEntry] };
    const parsed: SettingsV2 | null = parseStoredSettingsV2(stored);

    expect(parsed?.schedule[0]?.duration).toEqual({ kind: 'window' });
    expect(
      parseStoredSettingsV2({
        ...stored,
        schedule: [{ ...legacyEntry, durationMin: 25 }],
      }),
    ).toBeNull();
  });

  it('rejects sparse and overlapping schedules after normalization', (): void => {
    expect(parseStoredSettingsV2({ ...DEFAULT_SETTINGS, schedule: sparseArray(1) })).toBeNull();
    expect(
      parseStoredSettingsV2({
        ...DEFAULT_SETTINGS,
        schedule: [WINDOW_ENTRY, { ...WINDOW_ENTRY, id: 'overlap', start: '10:00', end: '12:00' }],
      }),
    ).toBeNull();
  });

  it('parses a stable entry snapshot before a stateful getter changes', (): void => {
    const entry: Record<string, unknown> = structuredClone(WINDOW_ENTRY) as unknown as Record<
      string,
      unknown
    >;
    let reads: number = 0;
    Object.defineProperty(entry, 'mode', {
      configurable: true,
      enumerable: true,
      get: (): string => {
        reads += 1;
        return reads === 1 ? 'blacklist' : 'invalid';
      },
    });

    const parsed: SettingsV2 | null = parseStoredSettingsV2({
      ...DEFAULT_SETTINGS,
      schedule: [entry],
    });

    expect(parsed?.schedule[0]?.mode).toBe('blacklist');
    expect(isScheduleEntryV2(parsed?.schedule[0])).toBe(true);
    expect(entry.mode).toBe('invalid');
  });

  it.each(ENTRY_EXTRA_CASES)(
    'rejects %s before cloning',
    (_label: string, shape: 'v1' | 'v2', key: PropertyKey, enumerable: boolean): void => {
      const entry: Record<PropertyKey, unknown> = structuredClone(
        WINDOW_ENTRY,
      ) as unknown as Record<PropertyKey, unknown>;
      if (shape === 'v1') delete entry.duration;
      Object.defineProperty(entry, key, { enumerable, value: true });

      expect(parseStoredSettingsV2({ ...DEFAULT_SETTINGS, schedule: [entry] })).toBeNull();
    },
  );

  it.each([
    { key: 'extra', enumerable: false },
    { key: Symbol('extra'), enumerable: true },
  ])('rejects an extra Settings root key %# before cloning', ({ key, enumerable }): void => {
    const stored: Record<PropertyKey, unknown> = structuredClone(
      DEFAULT_SETTINGS,
    ) as unknown as Record<PropertyKey, unknown>;
    Object.defineProperty(stored, key, { enumerable, value: true });

    expect(parseStoredSettingsV2(stored)).toBeNull();
  });

  it('returns null instead of throwing when root or entry cloning invokes a throwing getter', (): void => {
    const throwingRoot: Record<string, unknown> = structuredClone(
      DEFAULT_SETTINGS,
    ) as unknown as Record<string, unknown>;
    Object.defineProperty(throwingRoot, 'schedule', {
      enumerable: true,
      get: (): never => {
        throw new Error('root getter');
      },
    });
    const throwingEntry: Record<string, unknown> = structuredClone(
      WINDOW_ENTRY,
    ) as unknown as Record<string, unknown>;
    Object.defineProperty(throwingEntry, 'mode', {
      enumerable: true,
      get: (): never => {
        throw new Error('entry getter');
      },
    });
    let rootResult: SettingsV2 | null | undefined;
    let entryResult: SettingsV2 | null | undefined;

    expect((): void => {
      rootResult = parseStoredSettingsV2(throwingRoot);
    }).not.toThrow();
    expect((): void => {
      entryResult = parseStoredSettingsV2({ ...DEFAULT_SETTINGS, schedule: [throwingEntry] });
    }).not.toThrow();
    expect(rootResult).toBeNull();
    expect(entryResult).toBeNull();
  });
});

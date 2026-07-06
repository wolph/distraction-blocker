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
  it('accepts exact v2 window entries and Flexible or Friction indefinite entries', (): void => {
    expect(isScheduleEntryV2(WINDOW_ENTRY)).toBe(true);
    expect(
      isScheduleEntryV2({
        ...WINDOW_ENTRY,
        duration: { kind: 'until-stopped' },
        strictness: 'flexible',
        cycling: null,
      }),
    ).toBe(true);
    expect(
      isScheduleEntryV2({
        ...WINDOW_ENTRY,
        duration: { kind: 'until-stopped' },
        strictness: 'friction',
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

  it('rejects a stateful entry getter without invoking it', (): void => {
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

    expect(parseStoredSettingsV2({ ...DEFAULT_SETTINGS, schedule: [entry] })).toBeNull();
    expect(reads).toBe(0);
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

  it('does not reclassify a v2 entry when cloning drops its hidden duration', (): void => {
    const entry: Record<string, unknown> = structuredClone(WINDOW_ENTRY) as unknown as Record<
      string,
      unknown
    >;
    Object.defineProperty(entry, 'duration', {
      configurable: true,
      enumerable: false,
      value: entry.duration,
      writable: true,
    });

    expect(parseStoredSettingsV2({ ...DEFAULT_SETTINGS, schedule: [entry] })).toBeNull();
  });

  it('rejects a v1 entry when cloning drops a hidden required field', (): void => {
    const entry: Record<string, unknown> = structuredClone(WINDOW_ENTRY) as unknown as Record<
      string,
      unknown
    >;
    delete entry.duration;
    Object.defineProperty(entry, 'enabled', {
      configurable: true,
      enumerable: false,
      value: entry.enabled,
      writable: true,
    });

    expect(parseStoredSettingsV2({ ...DEFAULT_SETTINGS, schedule: [entry] })).toBeNull();
  });

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

  it('rejects transparent proxies at the Settings root and schedule array boundary', (): void => {
    const rootProxy: unknown = new Proxy(structuredClone(DEFAULT_SETTINGS), {});
    const scheduleProxy: unknown[] = new Proxy<unknown[]>([], {});

    expect(parseStoredSettingsV2(rootProxy)).toBeNull();
    expect(
      parseStoredSettingsV2({ ...structuredClone(DEFAULT_SETTINGS), schedule: scheduleProxy }),
    ).toBeNull();
  });

  it.each(['theme', 'schedule'] as const)(
    'rejects a non-enumerable required Settings field: %s',
    (field: 'theme' | 'schedule'): void => {
      const stored: Record<string, unknown> = structuredClone(
        DEFAULT_SETTINGS,
      ) as unknown as Record<string, unknown>;
      Object.defineProperty(stored, field, {
        configurable: true,
        enumerable: false,
        value: stored[field],
        writable: true,
      });

      expect(parseStoredSettingsV2(stored)).toBeNull();
    },
  );

  it('rejects Settings and schedule-array accessors without invoking them', (): void => {
    let rootReads: number = 0;
    const rootAccessor: Record<string, unknown> = structuredClone(
      DEFAULT_SETTINGS,
    ) as unknown as Record<string, unknown>;
    Object.defineProperty(rootAccessor, 'theme', {
      configurable: true,
      enumerable: true,
      get: (): string => {
        rootReads += 1;
        return 'auto';
      },
    });

    let arrayReads: number = 0;
    const accessorSchedule: unknown[] = [WINDOW_ENTRY];
    Object.defineProperty(accessorSchedule, 0, {
      configurable: true,
      enumerable: true,
      get: (): typeof WINDOW_ENTRY => {
        arrayReads += 1;
        return WINDOW_ENTRY;
      },
    });

    expect(parseStoredSettingsV2(rootAccessor)).toBeNull();
    expect(
      parseStoredSettingsV2({
        ...structuredClone(DEFAULT_SETTINGS),
        schedule: accessorSchedule,
      }),
    ).toBeNull();
    expect(rootReads).toBe(0);
    expect(arrayReads).toBe(0);
  });
});

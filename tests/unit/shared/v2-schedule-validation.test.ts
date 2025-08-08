import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../src/shared/constants';
import { isScheduleEntryV2, parseStoredSettingsV2 } from '../../../src/shared/runtime-validation';
import type { SettingsV2 } from '../../../src/shared/types';
import { sparseArray, WINDOW_ENTRY } from './v2-runtime-fixtures';

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
});

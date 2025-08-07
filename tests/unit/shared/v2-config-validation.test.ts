import { describe, expect, it } from 'vitest';
import {
  isCanonicalSessionRuleSnapshot,
  isScheduleDuration,
  isScheduleOccurrenceRef,
  isSessionConfigV2,
  isSessionDuration,
} from '../../../src/shared/runtime-validation';
import {
  MANUAL_INDEFINITE_CONFIG,
  MANUAL_TIMED_CONFIG,
  OCCURRENCE,
  SCHEDULED_INDEFINITE_CONFIG,
} from './v2-runtime-fixtures';

describe('v2 duration and occurrence validation', (): void => {
  it.each([
    [{ kind: 'timed', minutes: 25 }, true],
    [{ kind: 'timed', minutes: 0.1 }, true],
    [{ kind: 'until-stopped' }, true],
    [{ kind: 'window' }, false],
    [{ kind: 'timed', minutes: 0 }, false],
    [{ kind: 'timed', minutes: Number.NaN }, false],
    [{ kind: 'timed', minutes: Number.POSITIVE_INFINITY }, false],
    [{ kind: 'timed', minutes: 25, durationMin: 25 }, false],
    [{ kind: 'until-stopped', minutes: 25 }, false],
    [{ kind: 'until-stopped', extra: true }, false],
  ])('validates exact session duration %#', (value: unknown, accepted: boolean): void => {
    expect(isSessionDuration(value)).toBe(accepted);
  });

  it.each([
    [{ kind: 'window' }, true],
    [{ kind: 'until-stopped' }, true],
    [{ kind: 'timed', minutes: 25 }, false],
    [{ kind: 'window', minutes: 25 }, false],
  ])('validates exact schedule duration %#', (value: unknown, accepted: boolean): void => {
    expect(isScheduleDuration(value)).toBe(accepted);
  });

  it('requires a real local date and a token derived from both fields', (): void => {
    expect(isScheduleOccurrenceRef(OCCURRENCE)).toBe(true);
    expect(isScheduleOccurrenceRef({ ...OCCURRENCE, token: 'other@2026-09-02' })).toBe(false);
    expect(isScheduleOccurrenceRef({ ...OCCURRENCE, localStartDate: '2026-02-30' })).toBe(false);
    expect(isScheduleOccurrenceRef({ ...OCCURRENCE, localStartDate: '2026-9-2' })).toBe(false);
    expect(isScheduleOccurrenceRef({ ...OCCURRENCE, extra: true })).toBe(false);
  });
});

describe('v2 configuration validation', (): void => {
  it.each([
    MANUAL_TIMED_CONFIG,
    MANUAL_INDEFINITE_CONFIG,
    SCHEDULED_INDEFINITE_CONFIG,
    {
      ...MANUAL_TIMED_CONFIG,
      source: 'schedule',
      scheduleOccurrence: OCCURRENCE,
      duration: { kind: 'timed', minutes: 0.25 },
    },
  ])('accepts canonical config %#', (value: unknown): void => {
    expect(isSessionConfigV2(value)).toBe(true);
  });

  it.each([
    { ...MANUAL_INDEFINITE_CONFIG, strictness: 'friction' },
    { ...MANUAL_INDEFINITE_CONFIG, strictness: 'hard' },
    {
      ...MANUAL_INDEFINITE_CONFIG,
      cycling: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 },
    },
    { ...MANUAL_TIMED_CONFIG, scheduleOccurrence: OCCURRENCE },
    { ...SCHEDULED_INDEFINITE_CONFIG, scheduleOccurrence: null },
    { ...MANUAL_TIMED_CONFIG, durationMin: 25 },
    { ...MANUAL_TIMED_CONFIG, duration: { kind: 'timed', minutes: Number.NaN } },
    { ...MANUAL_TIMED_CONFIG, extra: true },
  ])('rejects invalid cross-field config %#', (value: unknown): void => {
    expect(isSessionConfigV2(value)).toBe(false);
  });

  it('accepts only already-canonical rules at persisted and public boundaries', (): void => {
    const rawNormalizableRules: unknown = {
      ...MANUAL_TIMED_CONFIG.rules,
      sessionAllowlist: [{ kind: 'host', pattern: 'HTTPS://Docs.Python.org/guide/' }],
    };
    expect(isCanonicalSessionRuleSnapshot(MANUAL_TIMED_CONFIG.rules)).toBe(true);
    expect(isCanonicalSessionRuleSnapshot(rawNormalizableRules)).toBe(false);
    expect(isSessionConfigV2({ ...MANUAL_TIMED_CONFIG, rules: rawNormalizableRules })).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  isCanonicalSessionRuleSnapshot,
  isCycleConfig,
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
    expect(isSessionConfigV2(structuredClone(value))).toBe(true);
  });

  it('preserves fractional scheduled durations across structured cloning', (): void => {
    const config: unknown = {
      ...MANUAL_TIMED_CONFIG,
      source: 'schedule',
      scheduleOccurrence: OCCURRENCE,
      duration: { kind: 'timed', minutes: 0.25 },
    };

    expect(isSessionConfigV2(config)).toBe(true);
    expect(isSessionConfigV2(structuredClone(config))).toBe(true);
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

  it('rejects non-enumerable expected fields that structured cloning would discard', (): void => {
    const duration: Record<string, unknown> = { kind: 'timed', minutes: 25 };
    Object.defineProperty(duration, 'minutes', { value: 25, enumerable: false });

    const cycling: Record<string, unknown> = {
      focusMin: 25,
      shortBreakMin: 5,
      longBreakMin: 15,
      longEvery: 4,
    };
    Object.defineProperty(cycling, 'longEvery', { value: 4, enumerable: false });

    const rules: object = structuredClone(MANUAL_TIMED_CONFIG.rules);
    Object.defineProperty(rules, 'baselineRevision', {
      value: MANUAL_TIMED_CONFIG.rules.baselineRevision,
      enumerable: false,
    });

    const config: object = structuredClone(MANUAL_TIMED_CONFIG);
    Object.defineProperty(config, 'intention', {
      value: MANUAL_TIMED_CONFIG.intention,
      enumerable: false,
    });

    expect(isSessionDuration(duration)).toBe(false);
    expect(isSessionDuration(structuredClone(duration))).toBe(false);
    expect(isCycleConfig(cycling)).toBe(false);
    expect(isCycleConfig(structuredClone(cycling))).toBe(false);
    expect(isCanonicalSessionRuleSnapshot(rules)).toBe(false);
    expect(isCanonicalSessionRuleSnapshot(structuredClone(rules))).toBe(false);
    expect(isSessionConfigV2(config)).toBe(false);
    expect(isSessionConfigV2(structuredClone(config))).toBe(false);
  });

  it('rejects rule arrays with extra string own keys', (): void => {
    const rules: typeof MANUAL_TIMED_CONFIG.rules = structuredClone(MANUAL_TIMED_CONFIG.rules);
    Object.defineProperty(rules.sessionAllowlist, 'extra', { value: true });

    expect(isCanonicalSessionRuleSnapshot(rules)).toBe(false);
  });

  it('rejects rule arrays with symbol own keys', (): void => {
    const rules: typeof MANUAL_TIMED_CONFIG.rules = structuredClone(MANUAL_TIMED_CONFIG.rules);
    Object.defineProperty(rules.sessionAllowlist, Symbol('extra'), { value: true });

    expect(isCanonicalSessionRuleSnapshot(rules)).toBe(false);
  });

  it('does not trust overridden rule-array iteration methods', (): void => {
    const rules: typeof MANUAL_TIMED_CONFIG.rules = structuredClone(MANUAL_TIMED_CONFIG.rules);
    Object.defineProperty(rules.sessionAllowlist, 'every', {
      value: (): boolean => true,
    });

    expect(isCanonicalSessionRuleSnapshot(rules)).toBe(false);
  });

  it('rejects throwing rule-array iteration getters without throwing', (): void => {
    const rules: typeof MANUAL_TIMED_CONFIG.rules = structuredClone(MANUAL_TIMED_CONFIG.rules);
    Object.defineProperty(rules.sessionAllowlist, Symbol.iterator, {
      get: (): never => {
        throw new Error('hostile iterator');
      },
    });

    expect((): boolean => isCanonicalSessionRuleSnapshot(rules)).not.toThrow();
    expect(isCanonicalSessionRuleSnapshot(rules)).toBe(false);
  });
});

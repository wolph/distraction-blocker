import { describe, expect, it } from 'vitest';
import {
  isCanonicalSessionRuleSnapshot,
  isScheduleDuration,
  isScheduleEntryV2,
  isScheduleOccurrenceRef,
  isSessionConfigV2,
  isSessionDuration,
  isSessionEndedEventV2,
  isSessionStartedEventV2,
  parseStoredSettingsV2,
} from '../../../src/shared/runtime-validation';
import type { SettingsV2 } from '../../../src/shared/types';

describe('v2 validator hostile inputs', (): void => {
  it('returns rejection values for revoked and throwing proxies', (): void => {
    const revocable: { proxy: object; revoke: () => void } = Proxy.revocable<object>({}, {});
    revocable.revoke();
    const throwing: unknown = new Proxy<Record<string, unknown>>(
      {},
      {
        get: (): never => {
          throw new Error('get trap');
        },
        ownKeys: (): never => {
          throw new Error('ownKeys trap');
        },
      },
    );
    const validators: ReadonlyArray<(value: unknown) => boolean> = [
      isCanonicalSessionRuleSnapshot,
      isSessionDuration,
      isScheduleDuration,
      isScheduleOccurrenceRef,
      isSessionConfigV2,
      isScheduleEntryV2,
      isSessionStartedEventV2,
      isSessionEndedEventV2,
    ];

    for (const hostile of [revocable.proxy, throwing]) {
      for (const validate of validators) {
        expect((): boolean => validate(hostile)).not.toThrow();
        expect(validate(hostile)).toBe(false);
      }
      expect((): SettingsV2 | null => parseStoredSettingsV2(hostile)).not.toThrow();
      expect(parseStoredSettingsV2(hostile)).toBeNull();
    }
  });

  it('rejects symbol keys and throwing nested getters', (): void => {
    expect(isSessionDuration({ kind: 'until-stopped', [Symbol('extra')]: true })).toBe(false);
    const duration: Record<string, unknown> = { kind: 'timed' };
    Object.defineProperty(duration, 'minutes', {
      enumerable: true,
      get: (): never => {
        throw new Error('nested getter');
      },
    });
    expect((): boolean => isSessionDuration(duration)).not.toThrow();
    expect(isSessionDuration(duration)).toBe(false);
  });
});

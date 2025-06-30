import { describe, expect, it } from 'vitest';
import { cancelPhrase } from '../../../src/shared/constants';

describe('cancelPhrase', (): void => {
  it('trims a real goal and keeps the required cancel prefix', (): void => {
    expect(cancelPhrase(' write the report ')).toBe(
      'I am ending this session before: write the report',
    );
    expect(cancelPhrase('write the report')).not.toContain('I choose distraction over');
  });

  it('uses a grammatical fallback when the intention is empty', (): void => {
    expect(cancelPhrase('  ')).toBe('I am ending this focus session early');
  });
});

import { describe, expect, it } from 'vitest';
import { assertTask7DevInventoryParity } from '../../../scripts/task7-dev-evidence';

const validRecord = {
  assertions: { exactCopy: ['A moment to decide'], forceEndControlCount: 0 },
  buildSource: 'dev' as const,
  bytes: 123,
  colorScheme: 'light' as const,
  diagnostics: { consoleMessages: [], pageErrors: [], requestFailures: [] },
  file: 'task7-dev-gate-auto-light-375-typed-gate-full.png',
  image: { height: 667, width: 375 },
  scope: 'full' as const,
  sha256: 'a'.repeat(64),
  state: 'typed-gate',
  surface: 'gate',
  theme: 'auto' as const,
  themeCase: 'auto-light',
  viewport: { height: 667, width: 375 },
};

describe('Task 7 development evidence inventory', () => {
  it('requires exact file parity with complete per-file metadata', (): void => {
    expect((): void =>
      assertTask7DevInventoryParity([validRecord.file], [validRecord]),
    ).not.toThrow();
    expect((): void =>
      assertTask7DevInventoryParity([validRecord.file], [validRecord, validRecord]),
    ).toThrow(/duplicate/i);
    expect((): void =>
      assertTask7DevInventoryParity([validRecord.file, 'missing.png'], [validRecord]),
    ).toThrow(/missing/i);
    expect((): void => assertTask7DevInventoryParity([], [validRecord])).toThrow(/unexpected/i);
    expect((): void =>
      assertTask7DevInventoryParity(
        [validRecord.file],
        [{ ...validRecord, assertions: { exactCopy: [] } }],
      ),
    ).toThrow(/metadata|assertion|exact copy/i);
    expect((): void =>
      assertTask7DevInventoryParity(
        [validRecord.file],
        [
          {
            ...validRecord,
            diagnostics: {
              ...validRecord.diagnostics,
              consoleMessages: ['changed diagnostic'],
            },
          },
        ],
      ),
    ).toThrow(/metadata|diagnostic/i);
  });
});

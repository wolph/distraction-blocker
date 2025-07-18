import { describe, expect, it } from 'vitest';
import {
  assertTask7DevInventoryParity,
  task7ViteStartupState,
} from '../../../scripts/task7-dev-evidence';

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
  it('does not accept an unrelated listener as the owned Vite server', (): void => {
    expect(task7ViteStartupState({ exitCode: null, output: '', responseReady: true })).toBe(
      'starting',
    );
    expect(
      task7ViteStartupState({
        exitCode: null,
        output: 'VITE v7.3.6 ready in 411 ms\nCRXJS: Load dist as unpacked extension',
        responseReady: true,
      }),
    ).toBe('ready');
    expect(
      task7ViteStartupState({
        exitCode: 1,
        output: 'Port 4177 is already in use',
        responseReady: true,
      }),
    ).toBe('failed');
  });

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

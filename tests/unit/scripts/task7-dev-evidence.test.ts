import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  assertTask7DevInventoryParity,
  stopTask7Vite,
  type Task7StoppableProcess,
  task7ViteStartupState,
} from '../../../scripts/task7-dev-evidence';

const validRecord = {
  assertions: {
    exactCopy: ['A moment to decide'],
    forceEndControlCount: 0,
    resolvedTheme: {
      backgroundColor: 'rgb(247, 250, 248)',
      color: 'rgb(22, 33, 26)',
      colorScheme: 'light',
    },
  },
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
  class FakeViteProcess extends EventEmitter implements Task7StoppableProcess {
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    readonly signals: NodeJS.Signals[] = [];

    constructor(private readonly exitOn: NodeJS.Signals | null) {
      super();
    }

    kill(signal: NodeJS.Signals): boolean {
      this.signals.push(signal);
      if (signal === this.exitOn) {
        this.exitCode = 0;
        queueMicrotask((): boolean => this.emit('exit', 0, signal));
      }
      return true;
    }
  }

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
        [{ ...validRecord, assertions: { ...validRecord.assertions, exactCopy: [] } }],
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
    expect((): void =>
      assertTask7DevInventoryParity(
        [validRecord.file],
        [
          {
            ...validRecord,
            assertions: { exactCopy: ['copy'] } as typeof validRecord.assertions,
          },
        ],
      ),
    ).toThrow(/metadata|assertion|theme/i);
  });

  it('awaits graceful Vite exit and escalates only after a bounded timeout', async (): Promise<void> => {
    const alreadyStoppedBySignal: FakeViteProcess = new FakeViteProcess(null);
    alreadyStoppedBySignal.signalCode = 'SIGTERM';
    await expect(stopTask7Vite(alreadyStoppedBySignal, 5)).resolves.toBeUndefined();
    expect(alreadyStoppedBySignal.signals).toEqual([]);

    const graceful: FakeViteProcess = new FakeViteProcess('SIGTERM');
    await expect(stopTask7Vite(graceful, 5)).resolves.toBeUndefined();
    expect(graceful.signals).toEqual(['SIGTERM']);

    const escalated: FakeViteProcess = new FakeViteProcess('SIGKILL');
    await expect(stopTask7Vite(escalated, 5)).resolves.toBeUndefined();
    expect(escalated.signals).toEqual(['SIGTERM', 'SIGKILL']);

    const stuck: FakeViteProcess = new FakeViteProcess(null);
    await expect(stopTask7Vite(stuck, 5)).rejects.toThrow(/did not exit/i);
    expect(stuck.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

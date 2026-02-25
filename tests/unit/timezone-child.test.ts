import { describe, expect, it } from 'vitest';
import { isTimezoneChild, runTimezoneChild } from './timezone-child';

describe('timezone child harness', (): void => {
  it('reports child status, signal, stdout, and stderr on failure', (): void => {
    expect((): string =>
      runTimezoneChild('UTC', [
        '--input-type=module',
        '--eval',
        "process.stdout.write('captured-out'); process.stderr.write('captured-err'); process.exit(7);",
      ]),
    ).toThrow(/status=7, signal=none[\s\S]*stdout: captured-out[\s\S]*stderr: captured-err/);
  });

  it('runs the child in the requested zone', (): void => {
    expect(
      runTimezoneChild('Europe/Amsterdam', [
        '--input-type=module',
        '--eval',
        'process.stdout.write(Intl.DateTimeFormat().resolvedOptions().timeZone);',
      ]),
    ).toBe('Europe/Amsterdam');
  });

  it('reads the child flag from the environment', (): void => {
    expect(isTimezoneChild('FOCUS_LOCK_UNSET_CHILD_FLAG')).toBe(false);
  });
});

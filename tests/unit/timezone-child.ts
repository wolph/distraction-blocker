import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Local-time behaviour can only be tested in a chosen zone, and `TZ` is read once per process while
 * Vitest shares one process across files. A suite that needs a zone therefore re-runs itself: the
 * parent spawns a child with `TZ` set and a flag naming the suite, and the child runs the same file
 * with only the zone-specific blocks enabled. Three suites did this with three copies of the
 * machinery below.
 */

const CHILD_TIMEOUT_MS: number = 30_000;

interface ChildProcessFailure {
  status?: number | null;
  signal?: string | null;
  stdout?: string | Uint8Array;
  stderr?: string | Uint8Array;
}

function capturedOutput(value: unknown): string {
  const output: string =
    typeof value === 'string'
      ? value
      : value instanceof Uint8Array
        ? Buffer.from(value).toString('utf8')
        : '';
  return output.trim() || '<empty>';
}

/** True inside the spawned child of the suite that owns `flag`, false in the parent run. */
export function isTimezoneChild(flag: string): boolean {
  return process.env[flag] === '1';
}

/**
 * Runs node with the given arguments in `timezone` and returns its stdout. A non-zero exit raises
 * an error carrying the child's status, signal, stdout and stderr, because the parent otherwise
 * reports only that the spawn failed.
 */
export function runTimezoneChild(
  timezone: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): string {
  try {
    return execFileSync(process.execPath, args, {
      encoding: 'utf8',
      env: { TZ: timezone, ...extraEnv },
      stdio: 'pipe',
      timeout: CHILD_TIMEOUT_MS,
    });
  } catch (error: unknown) {
    const failure: ChildProcessFailure = error as ChildProcessFailure;
    throw new Error(
      [
        `timezone child failed: status=${failure.status ?? 'none'}, signal=${failure.signal ?? 'none'}`,
        `stdout: ${capturedOutput(failure.stdout)}`,
        `stderr: ${capturedOutput(failure.stderr)}`,
      ].join('\n'),
      { cause: error },
    );
  }
}

/** Re-runs the suite at `suiteUrl` in `timezone` with `flag` set, so its child blocks execute. */
export function runSuiteInTimezone(timezone: string, flag: string, suiteUrl: string): string {
  const vitestPath: string = fileURLToPath(
    new URL('../../node_modules/vitest/vitest.mjs', import.meta.url),
  );
  return runTimezoneChild(timezone, [vitestPath, 'run', fileURLToPath(suiteUrl)], { [flag]: '1' });
}

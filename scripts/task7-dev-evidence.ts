export interface Task7StoppableProcess {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

function task7ProcessStopped(process: Task7StoppableProcess): boolean {
  return process.exitCode !== null || process.signalCode !== null;
}

export interface Task7DevEvidenceRecord {
  assertions: {
    exactCopy: readonly string[];
    resolvedTheme: {
      backgroundColor: string;
      color: string;
      colorScheme: string;
    };
    visibleResponsiveCopies?: number;
  };
  buildSource: 'dev';
  bytes: number;
  colorScheme: 'dark' | 'light';
  diagnostics: {
    consoleMessages: readonly string[];
    pageErrors: readonly string[];
    requestFailures: readonly string[];
  };
  file: string;
  image: { height: number; width: number };
  scope: 'focused' | 'full';
  sha256: string;
  state: string;
  surface: string;
  theme: 'auto' | 'dark' | 'light';
  themeCase: string;
  viewport: { height: number; width: number };
}

async function signalAndAwaitExit(
  process: Task7StoppableProcess,
  signal: NodeJS.Signals,
  timeoutMs: number,
): Promise<boolean> {
  if (task7ProcessStopped(process)) return true;
  return await new Promise<boolean>((resolve: (exited: boolean) => void): void => {
    let settled: boolean = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off('exit', onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const timer: NodeJS.Timeout = setTimeout((): void => finish(false), timeoutMs);
    process.on('exit', onExit);
    if (task7ProcessStopped(process)) {
      finish(true);
      return;
    }
    if (!process.kill(signal)) finish(task7ProcessStopped(process));
  });
}

export async function stopTask7Vite(
  process: Task7StoppableProcess,
  timeoutMs: number = 2_000,
): Promise<void> {
  if (await signalAndAwaitExit(process, 'SIGTERM', timeoutMs)) return;
  if (await signalAndAwaitExit(process, 'SIGKILL', timeoutMs)) return;
  throw new Error('Task 7 Vite server did not exit after SIGTERM and SIGKILL');
}

export function task7ViteStartupState(input: {
  exitCode: number | null;
  output: string;
  responseReady: boolean;
}): 'failed' | 'ready' | 'starting' {
  if (input.exitCode !== null) return 'failed';
  const ownedReadyOutput: boolean = /VITE v\S+\s+ready in \d+ ms/.test(input.output);
  return ownedReadyOutput && input.responseReady ? 'ready' : 'starting';
}

export function assertTask7DevInventoryParity(
  expectedFiles: readonly string[],
  inventory: readonly Task7DevEvidenceRecord[],
): void {
  const observed: Set<string> = new Set<string>();
  for (const record of inventory) {
    if (observed.has(record.file)) {
      throw new Error(`Duplicate Task 7 dev evidence entry: ${record.file}`);
    }
    observed.add(record.file);
    if (
      record.buildSource !== 'dev' ||
      record.assertions.exactCopy.length === 0 ||
      record.assertions.resolvedTheme?.backgroundColor === undefined ||
      record.assertions.resolvedTheme.backgroundColor === '' ||
      record.assertions.resolvedTheme.color === '' ||
      record.assertions.resolvedTheme.colorScheme === '' ||
      record.diagnostics.consoleMessages.length !== 0 ||
      record.diagnostics.pageErrors.length !== 0 ||
      record.diagnostics.requestFailures.length !== 0 ||
      record.bytes <= 0 ||
      !/^[0-9a-f]{64}$/.test(record.sha256) ||
      record.image.width <= 0 ||
      record.image.height <= 0 ||
      record.viewport.width <= 0 ||
      record.viewport.height <= 0 ||
      record.state === '' ||
      record.surface === '' ||
      record.themeCase === ''
    ) {
      throw new Error(`Task 7 dev evidence metadata/assertions are incomplete: ${record.file}`);
    }
  }
  const expected: Set<string> = new Set(expectedFiles);
  const missing: string[] = [...expected].filter((file: string): boolean => !observed.has(file));
  const unexpected: string[] = [...observed].filter((file: string): boolean => !expected.has(file));
  if (missing.length === 0 && unexpected.length === 0) return;
  throw new Error(
    `Task 7 dev inventory parity failed. Missing: ${missing.join(', ') || 'none'}. Unexpected: ${unexpected.join(', ') || 'none'}.`,
  );
}

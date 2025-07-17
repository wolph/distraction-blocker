export interface Task7DevEvidenceRecord {
  assertions: {
    exactCopy: readonly string[];
    forceEndControlCount?: number;
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

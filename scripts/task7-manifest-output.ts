import { readFile, writeFile } from 'node:fs/promises';

export type Task7ManifestMode = 'check' | 'write';

interface FinalizeTask7ManifestInput {
  build(generatedAt: string): unknown;
  manifestPath: string;
  mode: Task7ManifestMode;
  now?: () => Date;
}

export function parseTask7ManifestMode(args: readonly string[]): Task7ManifestMode {
  if (args.length === 0) return 'write';
  if (args.length === 1 && args[0] === '--check') return 'check';
  throw new Error(`Unexpected Task 7 manifest argument: ${args.join(' ') || '(empty)'}`);
}

function storedGeneratedAt(payload: string): string {
  const value: unknown = JSON.parse(payload);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('generatedAt' in value) ||
    typeof value.generatedAt !== 'string' ||
    value.generatedAt === ''
  ) {
    throw new Error('Existing Task 7 manifest has no generatedAt timestamp');
  }
  return value.generatedAt;
}

function serializeManifest(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function finalizeTask7Manifest(
  input: FinalizeTask7ManifestInput,
): Promise<'checked' | 'written'> {
  if (input.mode === 'check') {
    const currentPayload: string = await readFile(input.manifestPath, 'utf8');
    const expectedPayload: string = serializeManifest(
      input.build(storedGeneratedAt(currentPayload)),
    );
    if (currentPayload !== expectedPayload) {
      throw new Error('Task 7 evidence manifest does not match generated content');
    }
    return 'checked';
  }
  const generatedAt: string = (input.now ?? ((): Date => new Date()))().toISOString();
  await writeFile(input.manifestPath, serializeManifest(input.build(generatedAt)), 'utf8');
  return 'written';
}

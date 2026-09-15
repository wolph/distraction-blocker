import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WEBSITE_ORIGINS } from '../../src/shared/permissions';

const REPOSITORY_DIST: string = path.resolve(import.meta.dirname, '../../dist');

export function resolveExtensionDist(explicitOverride?: string): string {
  return explicitOverride ?? process.env.FOCUS_LOCK_E2E_DIST ?? REPOSITORY_DIST;
}

/** A keyless unpacked extension keeps its identity only while its directory stays the same. */
export async function createIsolatedExtensionDist(
  outputPath: string,
  explicitBase?: string,
): Promise<string> {
  const baseDist: string = path.resolve(resolveExtensionDist(explicitBase));
  const output: string = path.resolve(outputPath);
  const relative: string = path.relative(baseDist, output);
  if (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  ) {
    throw new Error('the isolated extension directory must be outside the source build');
  }
  await mkdir(path.dirname(output), { recursive: true });
  // Dereference: a base directory that is itself a symbolic link would otherwise be copied as a
  // link, and the manifest write below would land in the real build every later scenario loads.
  await cp(baseDist, output, {
    recursive: true,
    dereference: true,
    force: false,
    errorOnExist: true,
  });
  return output;
}

/** The caller closes the browser before this operation and closes the grant launch before returning. */
export async function withPermissionGrantManifest<T>(
  isolatedDist: string,
  grant: (directory: string) => Promise<T>,
): Promise<T> {
  const manifestPath: string = path.join(isolatedDist, 'manifest.json');
  const original: Buffer = await readFile(manifestPath);
  const value: unknown = JSON.parse(original.toString('utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('the extension manifest must be an object');
  }
  const manifest: Record<string, unknown> = { ...value, host_permissions: [...WEBSITE_ORIGINS] };
  try {
    await writeFile(manifestPath, JSON.stringify(manifest));
    return await grant(isolatedDist);
  } finally {
    await writeFile(manifestPath, original);
  }
}

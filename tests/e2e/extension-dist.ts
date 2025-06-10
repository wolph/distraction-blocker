import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WEBSITE_ORIGINS } from '../../src/shared/permissions';

interface ExtensionManifest {
  host_permissions?: string[];
}

const REPOSITORY_DIST: string = path.resolve(import.meta.dirname, '../../dist');

export function resolveExtensionDist(explicitOverride?: string): string {
  return explicitOverride ?? process.env.FOCUS_LOCK_E2E_DIST ?? REPOSITORY_DIST;
}

export async function createPermissionGrantDist(
  outputPath: string,
  explicitBase?: string,
): Promise<string> {
  const baseDist: string = resolveExtensionDist(explicitBase);
  await cp(baseDist, outputPath, { recursive: true });
  const manifestPath: string = path.join(outputPath, 'manifest.json');
  const manifest: ExtensionManifest = JSON.parse(
    await readFile(manifestPath, 'utf8'),
  ) as ExtensionManifest;
  manifest.host_permissions = [...WEBSITE_ORIGINS];
  await writeFile(manifestPath, JSON.stringify(manifest));
  return outputPath;
}

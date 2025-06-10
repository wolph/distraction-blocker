import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WEBSITE_ORIGINS } from '../../../src/shared/permissions';
import { createPermissionGrantDist, resolveExtensionDist } from '../../e2e/extension-dist';

let temporaryDirectory: string | null = null;
const originalEnvironmentDist: string | undefined = process.env.FOCUS_LOCK_E2E_DIST;

afterEach(async (): Promise<void> => {
  if (originalEnvironmentDist === undefined) delete process.env.FOCUS_LOCK_E2E_DIST;
  else process.env.FOCUS_LOCK_E2E_DIST = originalEnvironmentDist;
  if (temporaryDirectory !== null) await rm(temporaryDirectory, { recursive: true });
  temporaryDirectory = null;
});

describe('extension distribution resolution', (): void => {
  it('uses explicit override before environment and environment before repository dist', (): void => {
    process.env.FOCUS_LOCK_E2E_DIST = '/tmp/environment-dist';

    expect(resolveExtensionDist('/tmp/explicit-dist')).toBe('/tmp/explicit-dist');
    expect(resolveExtensionDist()).toBe('/tmp/environment-dist');
  });

  it('creates the permission-grant fixture from environment dist without repository dist access', async (): Promise<void> => {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'focus-lock-extension-dist-'));
    const environmentDist: string = path.join(temporaryDirectory, 'environment-dist');
    const grantDist: string = path.join(temporaryDirectory, 'grant-dist');
    await writeFile(
      path.join(temporaryDirectory, 'placeholder'),
      'parent exists before environment distribution is created',
    );
    await mkdir(environmentDist, { recursive: true });
    await writeFile(
      path.join(environmentDist, 'manifest.json'),
      JSON.stringify({ manifest_version: 3, name: 'Focus Lock test', version: '0.0.0' }),
    );
    await writeFile(path.join(environmentDist, 'environment-marker.txt'), 'selected');
    process.env.FOCUS_LOCK_E2E_DIST = environmentDist;

    await createPermissionGrantDist(grantDist);

    expect(await readFile(path.join(grantDist, 'environment-marker.txt'), 'utf8')).toBe('selected');
    const manifest: { host_permissions?: string[] } = JSON.parse(
      await readFile(path.join(grantDist, 'manifest.json'), 'utf8'),
    ) as { host_permissions?: string[] };
    expect(manifest.host_permissions).toEqual([...WEBSITE_ORIGINS]);
  });
});

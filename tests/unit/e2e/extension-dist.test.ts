import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WEBSITE_ORIGINS } from '../../../src/shared/permissions';
import {
  createIsolatedExtensionDist,
  resolveExtensionDist,
  withPermissionGrantManifest,
} from '../../e2e/extension-dist';

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

  it('copies the selected keyless build exactly into an isolated fixture directory', async (): Promise<void> => {
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

    await createIsolatedExtensionDist(grantDist);

    expect(await readFile(path.join(grantDist, 'environment-marker.txt'), 'utf8')).toBe('selected');
    const manifest: { host_permissions?: string[] } = JSON.parse(
      await readFile(path.join(grantDist, 'manifest.json'), 'utf8'),
    ) as { host_permissions?: string[] };
    expect(manifest.host_permissions).toBeUndefined();
    expect(await readFile(path.join(grantDist, 'manifest.json'), 'utf8')).toBe(
      await readFile(path.join(environmentDist, 'manifest.json'), 'utf8'),
    );
  });

  it.each([false, true])(
    'keeps one keyless path and restores exact manifest bytes after the grant callback (failure=%s)',
    async (fail: boolean): Promise<void> => {
      temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'focus-lock-extension-dist-'));
      const source: string = path.join(temporaryDirectory, 'source');
      const copied: string = path.join(temporaryDirectory, 'copied');
      await mkdir(source);
      const original: string =
        '{\n  "manifest_version": 3, "name": "Keyless test", "version": "1.0",\n  "optional_host_permissions": ["http://*/*", "https://*/*"]\n}\n';
      await writeFile(path.join(source, 'manifest.json'), original);
      await writeFile(path.join(source, 'background.js'), 'test bytes');
      const fixturePath: string = await createIsolatedExtensionDist(copied, source);
      expect(fixturePath).toBe(copied);
      expect(await readFile(path.join(copied, 'manifest.json'), 'utf8')).toBe(original);
      const grant: Promise<string> = withPermissionGrantManifest(
        fixturePath,
        async (grantPath: string): Promise<string> => {
          expect(grantPath).toBe(fixturePath);
          const manifest: Record<string, unknown> = JSON.parse(
            await readFile(path.join(grantPath, 'manifest.json'), 'utf8'),
          ) as Record<string, unknown>;
          expect(Object.hasOwn(manifest, 'key')).toBe(false);
          expect(manifest.host_permissions).toEqual([...WEBSITE_ORIGINS]);
          expect(await readFile(path.join(source, 'manifest.json'), 'utf8')).toBe(original);
          if (fail) throw new Error('grant failed');
          return 'granted';
        },
      );
      if (fail) await expect(grant).rejects.toThrow('grant failed');
      else await expect(grant).resolves.toBe('granted');
      expect(await readFile(path.join(fixturePath, 'manifest.json'), 'utf8')).toBe(original);
      expect(await readFile(path.join(fixturePath, 'background.js'), 'utf8')).toBe('test bytes');
      expect(await readFile(path.join(source, 'manifest.json'), 'utf8')).toBe(original);
    },
  );
});

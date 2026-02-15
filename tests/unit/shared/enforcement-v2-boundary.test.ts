import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('shared enforcement v2 source boundary', (): void => {
  it('does not import background authority into shared enforcement files', (): void => {
    const sharedDirectory: string = resolve('src/shared');
    const filenames: string[] = readdirSync(sharedDirectory).filter((filename: string): boolean =>
      filename.startsWith('enforcement-v2'),
    );

    expect(filenames).toContain('enforcement-v2.ts');
    let filename: string;
    for (filename of filenames) {
      const source: string = readFileSync(resolve(sharedDirectory, filename), 'utf8');
      expect(source).not.toMatch(/from\s+['"]\.\.\/background(?:\/|['"])/u);
      expect(source).not.toMatch(/from\s+['"][^'"]*src\/background(?:\/|['"])/u);
    }
  });
});

/**
 * The legacy session names the migration path still needs. Every other module reads v2 shapes,
 * so a new reference outside this list means v1 leaked back into live code.
 *
 * `RuntimeState` and `saveRuntime` are deliberately absent: they keep their v1 spelling until
 * the rename Task 2 defers lands, and `src/background/policy-storage.ts` reads `RuntimeState`
 * as migration input, which the plan's allowlist does not name. Add both names and that file
 * here in the same change that renames them.
 */
const LEGACY_SESSION_NAMES: readonly string[] = [
  'NormalizedSessionStateV1',
  'NormalizedSessionConfigV1',
  'LegacyRuntimeStateV1',
  'saveLegacyRuntime',
];

const LEGACY_ALLOWED_FILES: ReadonlySet<string> = new Set<string>([
  'background/legacy-runtime-v1.ts',
  'background/main.ts',
  'background/runtime-boot-v2.ts',
  'background/runtime-migration-v2.ts',
  'background/stores.ts',
  'core/session.ts',
  'shared/types.ts',
]);

/** Every TypeScript source under `src/`, as paths relative to `src/`. */
function sourceFiles(directory: string, prefix: string = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative: string = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...sourceFiles(resolve(directory, entry.name), relative));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      found.push(relative);
    }
  }
  return found;
}

describe('legacy session name boundary', (): void => {
  it('confines every legacy session name to the migration path', (): void => {
    const root: string = resolve('src');
    const files: string[] = sourceFiles(root);

    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain('background/stores.ts');

    const leaked: string[] = [];
    for (const file of files) {
      if (LEGACY_ALLOWED_FILES.has(file)) continue;
      const source: string = readFileSync(resolve(root, file), 'utf8');
      for (const name of LEGACY_SESSION_NAMES) {
        if (source.includes(name)) leaked.push(`${file}: ${name}`);
      }
    }

    expect(leaked).toEqual([]);
  });

  it('names only files that exist, so a deleted module cannot hide a leak', (): void => {
    const files: ReadonlySet<string> = new Set<string>(sourceFiles(resolve('src')));

    for (const allowed of LEGACY_ALLOWED_FILES) {
      expect(files).toContain(allowed);
    }
  });
});

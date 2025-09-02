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

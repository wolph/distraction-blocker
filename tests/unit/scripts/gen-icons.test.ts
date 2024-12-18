import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const fixtures: string[] = [];
const SCRIPT_PATH: string = resolve('scripts/gen-icons.mjs');

function fixture(): string {
  const path: string = mkdtempSync(join(tmpdir(), 'focus-lock-icons-'));
  fixtures.push(path);
  return path;
}

function generate(cwd: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [SCRIPT_PATH], { cwd, encoding: 'utf8' });
}

afterEach((): void => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('icon generation', () => {
  it('restores stale static icons before build can consume them', (): void => {
    const path: string = fixture();
    const iconDirectory: string = join(path, 'assets', 'icons');
    mkdirSync(iconDirectory, { recursive: true });
    cpSync('assets/icons/padlock.svg', join(iconDirectory, 'padlock.svg'));
    expect(generate(path).status).toBe(0);
    const iconPath: string = join(iconDirectory, 'idle-16.png');
    const expected: Buffer = readFileSync(iconPath);
    writeFileSync(iconPath, Buffer.from('stale'));
    expect(generate(path).status).toBe(0);
    expect(readFileSync(iconPath)).toEqual(expected);
  });

  it('exits nonzero when the canonical source is absent', (): void => {
    expect(generate(fixture()).status).not.toBe(0);
  });
});

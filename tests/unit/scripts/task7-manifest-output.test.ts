import { mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  finalizeTask7Manifest,
  parseTask7ManifestMode,
} from '../../../scripts/task7-manifest-output';

async function manifestFixture(value: string): Promise<{
  manifestPath: string;
  mtimeMs: number;
  payload: string;
}> {
  const directory: string = await mkdtemp(path.join(os.tmpdir(), 'task7-manifest-output-'));
  const manifestPath: string = path.join(directory, 'evidence-manifest.json');
  const payload: string = `${JSON.stringify(
    { generatedAt: '2026-09-01T12:00:00.000Z', schemaVersion: 2, value },
    null,
    2,
  )}\n`;
  await writeFile(manifestPath, payload, 'utf8');
  const fixedTime: Date = new Date('2026-09-01T12:30:00.000Z');
  await utimes(manifestPath, fixedTime, fixedTime);
  return { manifestPath, mtimeMs: (await stat(manifestPath)).mtimeMs, payload };
}

describe('Task 7 manifest output', () => {
  it('accepts only normal generation and --check', (): void => {
    expect(parseTask7ManifestMode([])).toBe('write');
    expect(parseTask7ManifestMode(['--check'])).toBe('check');
    expect((): void => {
      parseTask7ManifestMode(['--write']);
    }).toThrow(/argument/i);
    expect((): void => {
      parseTask7ManifestMode(['--check', '--write']);
    }).toThrow(/argument/i);
  });

  it('checks with the stored generatedAt without changing bytes or mtime', async (): Promise<void> => {
    const fixture = await manifestFixture('same');
    let observedGeneratedAt: string = '';

    await expect(
      finalizeTask7Manifest({
        build: (generatedAt: string): unknown => {
          observedGeneratedAt = generatedAt;
          return { generatedAt, schemaVersion: 2, value: 'same' };
        },
        manifestPath: fixture.manifestPath,
        mode: 'check',
      }),
    ).resolves.toBe('checked');

    expect(observedGeneratedAt).toBe('2026-09-01T12:00:00.000Z');
    expect(await readFile(fixture.manifestPath, 'utf8')).toBe(fixture.payload);
    expect((await stat(fixture.manifestPath)).mtimeMs).toBe(fixture.mtimeMs);
  });

  it('rejects stale content without changing bytes or mtime', async (): Promise<void> => {
    const fixture = await manifestFixture('stale');

    await expect(
      finalizeTask7Manifest({
        build: (generatedAt: string): unknown => ({
          generatedAt,
          schemaVersion: 2,
          value: 'current',
        }),
        manifestPath: fixture.manifestPath,
        mode: 'check',
      }),
    ).rejects.toThrow(/does not match/i);

    expect(await readFile(fixture.manifestPath, 'utf8')).toBe(fixture.payload);
    expect((await stat(fixture.manifestPath)).mtimeMs).toBe(fixture.mtimeMs);
  });

  it('regenerates in normal mode with the current timestamp', async (): Promise<void> => {
    const fixture = await manifestFixture('stale');

    await expect(
      finalizeTask7Manifest({
        build: (generatedAt: string): unknown => ({
          generatedAt,
          schemaVersion: 2,
          value: 'current',
        }),
        manifestPath: fixture.manifestPath,
        mode: 'write',
        now: (): Date => new Date('2026-09-01T13:00:00.000Z'),
      }),
    ).resolves.toBe('written');

    expect(JSON.parse(await readFile(fixture.manifestPath, 'utf8'))).toEqual({
      generatedAt: '2026-09-01T13:00:00.000Z',
      schemaVersion: 2,
      value: 'current',
    });
  });
});

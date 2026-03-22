import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyIndefiniteEvidenceDirectory } from '../../../scripts/verify-indefinite-evidence';
import {
  assertIndefiniteEvidenceCoverage,
  definitionFor,
  evidenceFileName,
  expectedIndefiniteArtifactCount,
  INDEFINITE_THEME_CASES,
  INDEFINITE_VISUAL_STATES,
  type IndefiniteEvidenceManifest,
  type IndefiniteEvidenceRecord,
  type IndefiniteRuntimeApiInterceptionDefinition,
  indefiniteInterceptionsFromObservations,
  parseEvidenceFileName,
  widthsForState,
} from '../../../tests/e2e/indefinite-visual-manifest';

const PNG_SIGNATURE: Buffer = Buffer.from('89504e470d0a1a0a', 'hex');
const COMMIT: string = '0123456789abcdef0123456789abcdef01234567';

const created: string[] = [];

async function evidenceDirectory(): Promise<string> {
  const directory: string = await mkdtemp(path.join(tmpdir(), 'indefinite-evidence-'));
  created.push(directory);
  return directory;
}

/** One PNG the verifier will accept, with content unique to its name. */
function pngFor(name: string): Buffer {
  return Buffer.concat([PNG_SIGNATURE, Buffer.from(name, 'utf8')]);
}

function recordsForCompleteRun(): IndefiniteEvidenceRecord[] {
  const records: IndefiniteEvidenceRecord[] = [];
  for (const state of INDEFINITE_VISUAL_STATES) {
    for (const theme of INDEFINITE_THEME_CASES) {
      for (const width of widthsForState(state)) {
        for (const scope of ['full', 'focused'] as const) {
          const name: string = evidenceFileName(state, theme.id, width, scope);
          const contents: Buffer = pngFor(name);
          records.push({
            path: name,
            state,
            themeId: theme.id,
            width,
            scope,
            bytes: contents.byteLength,
            sha256: createHash('sha256').update(contents).digest('hex'),
          });
        }
      }
    }
  }
  return records;
}

function manifestFor(
  records: readonly IndefiniteEvidenceRecord[],
  overrides: Partial<IndefiniteEvidenceManifest> = {},
): IndefiniteEvidenceManifest {
  return {
    artifactCount: records.length,
    artifacts: [...records],
    chromeVersion: '140.0.7300.0',
    determinism: [],
    maskedRegions: [],
    replayedCommands: [],
    runtimeApiInterceptions: [],
    sourceCommit: COMMIT,
    stateCount: INDEFINITE_VISUAL_STATES.length,
    states: [...INDEFINITE_VISUAL_STATES],
    storageSeeds: [],
    themes: INDEFINITE_THEME_CASES.map((theme: { id: string }): string => theme.id),
    unexpectedDiagnostics: [],
    viewportWidths: [340, 375, 768, 1280],
    worktreeClean: true,
    ...overrides,
  };
}

/** Writes a complete evidence directory, then applies the caller's damage to it. */
async function seedDirectory(
  manifest: IndefiniteEvidenceManifest,
  options: { omit?: string; corrupt?: string; extra?: string } = {},
): Promise<string> {
  const directory: string = await evidenceDirectory();
  for (const record of manifest.artifacts) {
    if (record.path === options.omit) continue;
    const contents: Buffer =
      record.path === options.corrupt ? Buffer.from('not a png') : pngFor(record.path);
    await writeFile(path.join(directory, record.path), contents);
  }
  if (options.extra !== undefined) {
    await writeFile(path.join(directory, options.extra), pngFor(options.extra));
  }
  await writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return directory;
}

afterEach(async (): Promise<void> => {
  await Promise.all(
    created
      .splice(0)
      .map(
        async (directory: string): Promise<void> =>
          await rm(directory, { recursive: true, force: true }),
      ),
  );
});

describe('indefinite evidence coverage', (): void => {
  it('accepts a run that captured every cell of the matrix', (): void => {
    expect((): void => {
      assertIndefiniteEvidenceCoverage(recordsForCompleteRun());
    }).not.toThrow();
  });

  it('counts the matrix the same way the capture does', (): void => {
    expect(recordsForCompleteRun()).toHaveLength(expectedIndefiniteArtifactCount());
  });

  it('captures every popup state at the popup width and nothing else', (): void => {
    expect(widthsForState('popup-active-indefinite-focus')).toEqual([340]);
    expect(widthsForState('overlay-active-timed')).toEqual([375, 768, 1280]);
    expect(widthsForState('stats-until-stopped-rows')).toEqual([375, 768, 1280]);
  });

  it('refuses a run with a state missing one theme', (): void => {
    const records: IndefiniteEvidenceRecord[] = recordsForCompleteRun().filter(
      (record: IndefiniteEvidenceRecord): boolean =>
        !(record.state === 'popup-forced-focus' && record.themeId === 'dark-light-media'),
    );

    expect((): void => {
      assertIndefiniteEvidenceCoverage(records);
    }).toThrow('popup-forced-focus-dark-light-media-340-full.png is missing');
  });

  it('refuses a run with a focused crop missing', (): void => {
    const records: IndefiniteEvidenceRecord[] = recordsForCompleteRun().filter(
      (record: IndefiniteEvidenceRecord): boolean =>
        !(record.state === 'overlay-stopped' && record.scope === 'focused' && record.width === 768),
    );

    expect((): void => {
      assertIndefiniteEvidenceCoverage(records);
    }).toThrow('overlay-stopped-auto-light-768-focused.png is missing');
  });
});

describe('the matrix the capture and the verifier both read', (): void => {
  it('reads a file name back to the cell that owns it', (): void => {
    const name: string = evidenceFileName('popup-long-copy', 'auto-dark', 340, 'focused');

    expect(parseEvidenceFileName(name)).toEqual({
      state: 'popup-long-copy',
      themeId: 'auto-dark',
      width: 340,
      scope: 'focused',
    });
  });

  it('refuses a file name that names no cell', (): void => {
    expect((): unknown => parseEvidenceFileName('popup-long-copy-auto-dark-999-full.png')).toThrow(
      'does not name a cell',
    );
    expect((): unknown =>
      parseEvidenceFileName(evidenceFileName('overlay-stopped', 'auto-dark', 340, 'full')),
    ).toThrow('does not name a cell');
  });

  it('refuses a state the matrix does not declare', (): void => {
    expect((): unknown => definitionFor('popup-nonexistent' as never)).toThrow(
      'is not a declared visual state',
    );
  });

  it('refuses a cell captured twice', (): void => {
    const records: IndefiniteEvidenceRecord[] = recordsForCompleteRun();
    const duplicated: IndefiniteEvidenceRecord | undefined = records[0];
    if (duplicated === undefined) throw new Error('the fixture produced no records');

    expect((): void => {
      assertIndefiniteEvidenceCoverage([...records, duplicated]);
    }).toThrow('was captured 2 times');
  });

  it('refuses an image outside the matrix', (): void => {
    const records: IndefiniteEvidenceRecord[] = recordsForCompleteRun();
    const stray: IndefiniteEvidenceRecord = {
      ...(records[0] as IndefiniteEvidenceRecord),
      width: 999,
    };

    expect((): void => {
      assertIndefiniteEvidenceCoverage([...records, stray]);
    }).toThrow('is unexpected');
  });

  it('counts what the run observed against what it declared', (): void => {
    const declared: IndefiniteRuntimeApiInterceptionDefinition[] = [
      {
        behavior: 'fixed-snapshot',
        expectedCount: 2,
        passthrough: 'all-other-calls',
        purpose: 'the snapshot the popup cannot outrun',
        requestType: 'getSnapshot',
        scope: 'chrome.runtime.sendMessage',
        state: 'popup-long-copy',
      },
    ];

    expect(
      indefiniteInterceptionsFromObservations(declared, [
        { state: 'popup-long-copy', requestType: 'getSnapshot' },
        { state: 'popup-long-copy', requestType: 'getSetupState' },
        { state: 'popup-forced-focus', requestType: 'getSnapshot' },
      ]),
    ).toEqual([{ ...declared[0], observedCount: 1 }]);
  });
});

describe('verifyIndefiniteEvidenceDirectory', (): void => {
  it('accepts a complete run whose files are the ones it recorded', async (): Promise<void> => {
    const manifest: IndefiniteEvidenceManifest = manifestFor(recordsForCompleteRun());
    const directory: string = await seedDirectory(manifest);

    await expect(
      verifyIndefiniteEvidenceDirectory({ evidenceDirectory: directory, sourceCommit: COMMIT }),
    ).resolves.toMatchObject({ artifactCount: manifest.artifactCount, worktreeClean: true });
  });

  it('refuses a manifest recorded against another commit', async (): Promise<void> => {
    const directory: string = await seedDirectory(manifestFor(recordsForCompleteRun()));

    await expect(
      verifyIndefiniteEvidenceDirectory({
        evidenceDirectory: directory,
        sourceCommit: 'fedcba9876543210fedcba9876543210fedcba98',
      }),
    ).rejects.toThrow('was captured at commit');
  });

  it('refuses a run captured from a dirty worktree', async (): Promise<void> => {
    const directory: string = await seedDirectory(
      manifestFor(recordsForCompleteRun(), { worktreeClean: false }),
    );

    await expect(
      verifyIndefiniteEvidenceDirectory({ evidenceDirectory: directory, sourceCommit: COMMIT }),
    ).rejects.toThrow('worktree');
  });

  it('refuses a run that reported a browser diagnostic', async (): Promise<void> => {
    const directory: string = await seedDirectory(
      manifestFor(recordsForCompleteRun(), {
        unexpectedDiagnostics: ['pageerror: overlay failed to mount'],
      }),
    );

    await expect(
      verifyIndefiniteEvidenceDirectory({ evidenceDirectory: directory, sourceCommit: COMMIT }),
    ).rejects.toThrow('unexpected browser diagnostics');
  });

  it('refuses an image whose bytes are not the ones the manifest hashed', async (): Promise<void> => {
    const manifest: IndefiniteEvidenceManifest = manifestFor(recordsForCompleteRun());
    const corrupt: string = evidenceFileName('overlay-active-indefinite', 'auto-dark', 375, 'full');
    const directory: string = await seedDirectory(manifest, { corrupt });

    await expect(
      verifyIndefiniteEvidenceDirectory({ evidenceDirectory: directory, sourceCommit: COMMIT }),
    ).rejects.toThrow(corrupt);
  });

  it('refuses a directory holding an image the manifest never recorded', async (): Promise<void> => {
    const manifest: IndefiniteEvidenceManifest = manifestFor(recordsForCompleteRun());
    const directory: string = await seedDirectory(manifest, {
      extra: 'popup-forced-hover-auto-light-341-full.png',
    });

    await expect(
      verifyIndefiniteEvidenceDirectory({ evidenceDirectory: directory, sourceCommit: COMMIT }),
    ).rejects.toThrow('popup-forced-hover-auto-light-341-full.png');
  });

  it('refuses a manifest missing a cell of the matrix', async (): Promise<void> => {
    const complete: IndefiniteEvidenceRecord[] = recordsForCompleteRun();
    const dropped: IndefiniteEvidenceRecord | undefined = complete.at(-1);
    if (dropped === undefined) throw new Error('the fixture produced no records');
    const manifest: IndefiniteEvidenceManifest = manifestFor(
      complete.filter((record: IndefiniteEvidenceRecord): boolean => record !== dropped),
    );
    const directory: string = await seedDirectory(manifest);

    await expect(
      verifyIndefiniteEvidenceDirectory({ evidenceDirectory: directory, sourceCommit: COMMIT }),
    ).rejects.toThrow('coverage is incomplete');
  });

  it('refuses a manifest that declares no replayed commands', async (): Promise<void> => {
    const manifest: IndefiniteEvidenceManifest = manifestFor(recordsForCompleteRun());
    const stripped: Record<string, unknown> = { ...manifest };
    Reflect.deleteProperty(stripped, 'replayedCommands');
    const directory: string = await seedDirectory(
      stripped as unknown as IndefiniteEvidenceManifest,
    );

    await expect(
      verifyIndefiniteEvidenceDirectory({ evidenceDirectory: directory, sourceCommit: COMMIT }),
    ).rejects.toThrow('declares no replayedCommands');
  });

  it('refuses an interception that did not reach its expected count', async (): Promise<void> => {
    const directory: string = await seedDirectory(
      manifestFor(recordsForCompleteRun(), {
        runtimeApiInterceptions: [
          {
            scope: 'chrome.runtime.sendMessage',
            state: 'popup-starting-immediate',
            requestType: 'getSnapshot',
            behavior: 'fixed-snapshot',
            passthrough: 'all-other-calls',
            purpose: 'the starting lifecycle the worker never broadcasts',
            expectedCount: 8,
            observedCount: 7,
          },
        ],
      }),
    );

    await expect(
      verifyIndefiniteEvidenceDirectory({ evidenceDirectory: directory, sourceCommit: COMMIT }),
    ).rejects.toThrow('popup-starting-immediate');
  });
});

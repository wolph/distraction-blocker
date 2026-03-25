/**
 * Verifies an indefinite-session evidence directory.
 *
 * What this proves is narrow and worth stating: the images on disk are exactly the ones this run
 * captured, the run captured every cell of the matrix, and it captured them from a clean worktree
 * at a named commit with no browser diagnostics. It does not prove the images look right. There is
 * no pixel baseline anywhere in this repository, so the appearance gate is a person opening them,
 * which is the same bargain the stats, onboarding, and task7 evidence make.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  assertIndefiniteEvidenceCoverage,
  assertInterceptionCount,
  type IndefiniteEvidenceManifest,
  type IndefiniteEvidenceRecord,
  type IndefiniteRuntimeApiInterception,
} from '../tests/e2e/indefinite-visual-manifest';

const PNG_SIGNATURE: Buffer = Buffer.from('89504e470d0a1a0a', 'hex');
const MANIFEST_NAME: string = 'manifest.json';

export interface VerifyIndefiniteEvidenceInput {
  evidenceDirectory: string;
  /** The commit the evidence must name. Defaults to this worktree's `git rev-parse HEAD`. */
  sourceCommit?: string;
}

/**
 * Reads the manifest, then holds it against the directory it describes. Every failure names the
 * file or the cell it is about, because the caller is a person deciding whether to publish.
 */
export async function verifyIndefiniteEvidenceDirectory(
  input: VerifyIndefiniteEvidenceInput,
): Promise<IndefiniteEvidenceManifest> {
  const directory: string = path.resolve(input.evidenceDirectory);
  const manifest: IndefiniteEvidenceManifest = parseManifest(
    JSON.parse(await readFile(path.join(directory, MANIFEST_NAME), 'utf8')) as unknown,
  );
  const expectedCommit: string = input.sourceCommit ?? currentCommit();
  if (manifest.sourceCommit !== expectedCommit) {
    throw new Error(
      `the evidence was captured at commit ${manifest.sourceCommit}, not ${expectedCommit}`,
    );
  }
  if (!manifest.worktreeClean) {
    throw new Error('the evidence was captured from a dirty worktree');
  }
  if (manifest.unexpectedDiagnostics.length > 0) {
    throw new Error(
      `the run reported unexpected browser diagnostics: ${manifest.unexpectedDiagnostics.join(', ')}`,
    );
  }
  for (const interception of manifest.runtimeApiInterceptions) {
    assertInterceptionCount(interception);
  }
  assertIndefiniteEvidenceCoverage(manifest.artifacts);
  await assertDiskParity(directory, manifest.artifacts);
  if (manifest.artifactCount !== manifest.artifacts.length) {
    throw new Error(
      `the manifest counts ${String(manifest.artifactCount)} artifacts and lists ${String(manifest.artifacts.length)}`,
    );
  }
  return manifest;
}

/** Every recorded image is on disk, is a PNG, and hashes to what the manifest says it does. */
async function assertDiskParity(
  directory: string,
  artifacts: readonly IndefiniteEvidenceRecord[],
): Promise<void> {
  const onDisk: Set<string> = new Set<string>(
    (await readdir(directory)).filter((name: string): boolean => name.endsWith('.png')),
  );
  for (const artifact of artifacts) {
    if (!onDisk.delete(artifact.path)) {
      throw new Error(`${artifact.path} is recorded in the manifest and missing from disk`);
    }
    const contents: Buffer = await readFile(path.join(directory, artifact.path));
    if (!contents.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
      throw new Error(`${artifact.path} does not contain PNG image data`);
    }
    const sha256: string = createHash('sha256').update(contents).digest('hex');
    if (sha256 !== artifact.sha256) {
      throw new Error(`${artifact.path} hashes to ${sha256}, not the recorded ${artifact.sha256}`);
    }
    if (contents.byteLength !== artifact.bytes) {
      throw new Error(
        `${artifact.path} is ${String(contents.byteLength)} bytes, not the recorded ${String(artifact.bytes)}`,
      );
    }
  }
  const unrecorded: string[] = [...onDisk].sort();
  if (unrecorded.length > 0) {
    throw new Error(
      `the directory holds images the manifest never recorded: ${unrecorded.join(', ')}`,
    );
  }
}

function currentCommit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A stored manifest is untrusted input: every field the verifier reads is checked before use. */
function parseManifest(value: unknown): IndefiniteEvidenceManifest {
  if (!isRecord(value)) throw new Error('the evidence manifest is not an object');
  const artifacts: unknown = value.artifacts;
  if (!Array.isArray(artifacts)) throw new Error('the evidence manifest lists no artifacts');
  const records: IndefiniteEvidenceRecord[] = artifacts.map(parseRecord);
  const interceptions: unknown = value.runtimeApiInterceptions;
  if (!Array.isArray(interceptions)) {
    throw new Error('the evidence manifest lists no runtime interceptions');
  }
  const diagnostics: unknown = value.unexpectedDiagnostics;
  if (
    !Array.isArray(diagnostics) ||
    diagnostics.some((entry: unknown): boolean => typeof entry !== 'string')
  ) {
    throw new Error('the evidence manifest lists no diagnostics');
  }
  if (typeof value.sourceCommit !== 'string' || typeof value.worktreeClean !== 'boolean') {
    throw new Error('the evidence manifest names no source commit or worktree state');
  }
  if (typeof value.artifactCount !== 'number') {
    throw new Error('the evidence manifest counts no artifacts');
  }
  for (const field of ['maskedRegions', 'replayedCommands', 'storageSeeds'] as const) {
    if (!Array.isArray(value[field])) {
      throw new Error(`the evidence manifest declares no ${field}`);
    }
  }
  return {
    ...(value as unknown as IndefiniteEvidenceManifest),
    artifacts: records,
    runtimeApiInterceptions: interceptions as IndefiniteRuntimeApiInterception[],
    unexpectedDiagnostics: diagnostics as string[],
  };
}

function parseRecord(value: unknown): IndefiniteEvidenceRecord {
  if (!isRecord(value)) throw new Error('an artifact entry is not an object');
  if (
    typeof value.path !== 'string' ||
    typeof value.sha256 !== 'string' ||
    typeof value.bytes !== 'number' ||
    typeof value.state !== 'string' ||
    typeof value.themeId !== 'string' ||
    typeof value.width !== 'number' ||
    (value.scope !== 'full' && value.scope !== 'focused')
  ) {
    throw new Error(`an artifact entry is incomplete: ${JSON.stringify(value)}`);
  }
  return value as unknown as IndefiniteEvidenceRecord;
}

/** The command-line entry point: one directory argument, and a summary on success. */
async function main(): Promise<void> {
  const directory: string | undefined = process.argv[2];
  if (directory === undefined) {
    throw new Error('usage: node scripts/verify-indefinite-evidence.ts <evidence-directory>');
  }
  const manifest: IndefiniteEvidenceManifest = await verifyIndefiniteEvidenceDirectory({
    evidenceDirectory: directory,
  });
  process.stdout.write(
    `verified ${String(manifest.artifactCount)} artifacts across ${String(manifest.stateCount)} states at ${manifest.sourceCommit}\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  await main();
}

import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface StatsEvidenceTreeEntry {
  bytes: number;
  file: string;
  sha256: string;
}

export interface StatsEvidenceTreeHash {
  entries: StatsEvidenceTreeEntry[];
  manifest: string;
  sha256: string;
}

async function collectStatsEvidenceFiles(
  root: string,
  relativeDirectory: string,
): Promise<string[]> {
  const absoluteDirectory: string = path.join(root, relativeDirectory);
  const directoryMetadata: Stats = await lstat(absoluteDirectory);
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    throw new Error(`Stats evidence directory is not a regular directory: ${relativeDirectory}.`);
  }
  const names: string[] = (await readdir(absoluteDirectory)).sort();
  const files: string[] = [];
  for (const name of names) {
    const relativePath: string = relativeDirectory === '' ? name : `${relativeDirectory}/${name}`;
    const absolutePath: string = path.join(root, ...relativePath.split('/'));
    const metadata: Stats = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Stats evidence tree contains a symbolic link: ${relativePath}.`);
    }
    if (metadata.isDirectory()) {
      files.push(...(await collectStatsEvidenceFiles(root, relativePath)));
    } else if (metadata.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`Stats evidence tree contains a non-file entry: ${relativePath}.`);
    }
  }
  return files;
}

async function statsEvidenceTreeEntry(
  root: string,
  relativePath: string,
): Promise<StatsEvidenceTreeEntry> {
  const payload: Buffer = await readFile(path.join(root, ...relativePath.split('/')));
  return {
    bytes: payload.byteLength,
    file: relativePath,
    sha256: createHash('sha256').update(payload).digest('hex'),
  };
}

export function serializeStatsEvidenceTree(entries: readonly StatsEvidenceTreeEntry[]): string {
  const lines: string[] = [...entries]
    .sort((left: StatsEvidenceTreeEntry, right: StatsEvidenceTreeEntry): number => {
      if (left.file < right.file) return -1;
      if (left.file > right.file) return 1;
      return 0;
    })
    .map((entry: StatsEvidenceTreeEntry): string =>
      JSON.stringify({ bytes: entry.bytes, file: entry.file, sha256: entry.sha256 }),
    );
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

export async function hashStatsEvidenceTree(directory: string): Promise<StatsEvidenceTreeHash> {
  const root: string = path.resolve(directory);
  const relativePaths: string[] = await collectStatsEvidenceFiles(root, '');
  const entries: StatsEvidenceTreeEntry[] = await Promise.all(
    relativePaths.map(
      async (relativePath: string): Promise<StatsEvidenceTreeEntry> =>
        await statsEvidenceTreeEntry(root, relativePath),
    ),
  );
  const manifest: string = serializeStatsEvidenceTree(entries);
  return {
    entries,
    manifest,
    sha256: createHash('sha256').update(manifest, 'utf8').digest('hex'),
  };
}

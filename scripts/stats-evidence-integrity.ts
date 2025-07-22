import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';

export interface StatsEvidenceFileMetadata {
  bytes: number;
  file: string;
  image: { height: number; width: number };
  sha256: string;
}

export function statsPngDimensions(payload: Uint8Array): { height: number; width: number } {
  try {
    const decoded: PNG = PNG.sync.read(Buffer.from(payload), { checkCRC: true });
    if (decoded.height < 1 || decoded.width < 1) throw new Error('empty dimensions');
    return { height: decoded.height, width: decoded.width };
  } catch (error: unknown) {
    throw new Error('Invalid Stats evidence PNG data, dimensions, or CRC.', { cause: error });
  }
}

export async function assertStatsEvidenceDiskParity(
  evidenceDir: string,
  inventory: readonly StatsEvidenceFileMetadata[],
  additionalFiles: readonly string[] = [],
): Promise<void> {
  const expectedFiles: string[] = inventory.map(
    (record: StatsEvidenceFileMetadata): string => record.file,
  );
  const actualFiles: string[] = (await readdir(evidenceDir)).sort();
  const sortedExpected: string[] = [...expectedFiles, ...additionalFiles].sort();
  if (new Set(expectedFiles).size !== expectedFiles.length) {
    throw new Error('Stats evidence directory inventory contains duplicate filenames.');
  }
  if (JSON.stringify(actualFiles) !== JSON.stringify(sortedExpected)) {
    throw new Error('Stats evidence directory parity failed due to missing or unexpected files.');
  }
  for (const record of inventory) {
    const payload: Buffer = await readFile(path.join(evidenceDir, record.file));
    const dimensions: { height: number; width: number } = statsPngDimensions(payload);
    const digest: string = createHash('sha256').update(payload).digest('hex');
    if (
      payload.byteLength !== record.bytes ||
      digest !== record.sha256 ||
      dimensions.height !== record.image.height ||
      dimensions.width !== record.image.width
    ) {
      throw new Error(`Stats evidence file metadata differs for ${record.file}.`);
    }
  }
}

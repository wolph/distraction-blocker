import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface StatsEvidenceFileMetadata {
  bytes: number;
  file: string;
  image: { height: number; width: number };
  sha256: string;
}

export function statsPngDimensions(payload: Uint8Array): { height: number; width: number } {
  const signature: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    payload.byteLength < 24 ||
    signature.some((byte: number, index: number): boolean => payload[index] !== byte)
  ) {
    throw new Error('Invalid Stats evidence PNG signature.');
  }
  const view: DataView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const dimensions: { height: number; width: number } = {
    height: view.getUint32(20),
    width: view.getUint32(16),
  };
  if (dimensions.height < 1 || dimensions.width < 1) {
    throw new Error('Invalid Stats evidence PNG dimensions.');
  }
  return dimensions;
}

export async function assertStatsEvidenceDiskParity(
  evidenceDir: string,
  inventory: readonly StatsEvidenceFileMetadata[],
): Promise<void> {
  const expectedFiles: string[] = inventory.map(
    (record: StatsEvidenceFileMetadata): string => record.file,
  );
  const actualFiles: string[] = (await readdir(evidenceDir)).sort();
  const sortedExpected: string[] = [...expectedFiles].sort();
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

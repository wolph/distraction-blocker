export interface ArchiveMember {
  name: string;
  size: number;
  type:
    | 'file'
    | 'directory'
    | 'symlink'
    | 'hardlink'
    | 'fifo'
    | 'block-device'
    | 'character-device'
    | 'socket'
    | 'special';
}

export interface ArtifactManifest {
  artifactCount: number;
  artifacts: { bytes: number; path: string; sha256: string }[];
}

export const ARCHIVE_LIMITS: Readonly<{
  maxArchiveBytes: number;
  maxMembers: number;
  maxFileBytes: number;
  maxTotalExpandedBytes: number;
}>;

export function parseArchiveListing(listing: string): ArchiveMember[];
export function listArchiveMembers(archivePath: string): ArchiveMember[];
export function validateArchiveMembers(
  members: readonly ArchiveMember[],
  manifest: ArtifactManifest,
  manifestBytes: number,
  archiveBytes: number,
): void;
export function sha256(filePath: string): Promise<string>;
export function validateArtifactSet(
  directory: string,
  manifestPath: string,
): Promise<ArtifactManifest & Record<string, unknown>>;
export function validateArchive(
  evidenceRoot: string,
  archiveName: string,
  manifestName: string,
  expectedCount: number,
): Promise<ArtifactManifest & Record<string, unknown>>;

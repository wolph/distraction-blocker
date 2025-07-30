import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { PNG } from 'pngjs';

export const PRIVACY_URL: string = 'https://wolph.github.io/distraction-blocker/privacy/';
export const SCREENSHOTS: string[] = [
  'store/assets/screenshots/01-start-session.png',
  'store/assets/screenshots/02-blocked-page.png',
  'store/assets/screenshots/03-onboarding.png',
  'store/assets/screenshots/04-stats.png',
  'store/assets/screenshots/05-privacy-data.png',
];
export const PERMISSIONS: string[] = [
  'storage',
  'alarms',
  'tabs',
  'webNavigation',
  'offscreen',
  'notifications',
  'scripting',
];
export const OPTIONAL_HOST_PERMISSIONS: string[] = ['http://*/*', 'https://*/*'];

export interface SubmissionManifest {
  schemaVersion: number;
  version: string;
  shortDescription: string;
  privacyPolicyUrl: string;
  permissions: string[];
  optionalHostPermissions: string[];
  screenshots: string[];
  smallPromo: string;
  marquee?: string;
  icon128: string;
  transportAllowlist: Array<{
    file: string;
    identifier: string;
    justification: string;
  }>;
}

export interface ArchiveEntryFixture {
  name: string;
  contents?: Buffer | string;
  mode?: number;
  compress?: boolean;
  generalPurposeBitFlag?: number;
  lastModFileTime?: number;
  lastModFileDate?: number;
  localExtra?: Buffer;
  centralExtra?: Buffer;
  fileComment?: Buffer | string;
  declaredCrc32?: number;
  declaredUncompressedSize?: number;
}

export function write(path: string, contents: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

export function writeJson(path: string, value: unknown): void {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writePng(path: string, width: number, height: number): void {
  const png: PNG = new PNG({ width, height });
  png.data.fill(255);
  write(path, PNG.sync.write(png));
}

export function validManifest(): Record<string, unknown> {
  return {
    manifest_version: 3,
    name: 'Focus Lock',
    version: '0.1.0',
    description: 'Focus sessions that lock distracting sites, with earned pauses.',
    key: 'public-extension-identity',
    icons: { '128': 'assets/icons/idle-128.png' },
    action: { default_popup: 'src/popup/popup.html' },
    background: { service_worker: 'service-worker-loader.js', type: 'module' },
    permissions: [...PERMISSIONS],
    optional_host_permissions: [...OPTIONAL_HOST_PERMISSIONS],
    web_accessible_resources: [
      {
        matches: [...OPTIONAL_HOST_PERMISSIONS],
        resources: ['src/content/index.iife.js'],
        use_dynamic_url: false,
      },
    ],
  };
}

export function validSubmissionManifest(): SubmissionManifest {
  return {
    schemaVersion: 1,
    version: '0.1.0',
    shortDescription: 'Focus sessions that lock distracting sites, with earned pauses.',
    privacyPolicyUrl: PRIVACY_URL,
    permissions: [...PERMISSIONS],
    optionalHostPermissions: [...OPTIONAL_HOST_PERMISSIONS],
    screenshots: [...SCREENSHOTS],
    smallPromo: 'store/assets/small-promo-440x280.png',
    marquee: 'store/assets/marquee-1400x560.png',
    icon128: 'assets/icons/idle-128.png',
    transportAllowlist: [],
  };
}

export function createFixture(root: string): void {
  writeJson(join(root, 'dist', 'manifest.json'), validManifest());
  write(join(root, 'dist', 'service-worker-loader.js'), "import './assets/background.js';\n");
  write(
    join(root, 'dist', 'assets', 'background.js'),
    'chrome.runtime.onInstalled.addListener(() => {});\n',
  );
  write(
    join(root, 'dist', 'src', 'popup', 'popup.html'),
    '<!doctype html><html><body><script type="module" src="/assets/popup.js"></script></body></html>\n',
  );
  write(
    join(root, 'dist', 'assets', 'popup.js'),
    "const documentationUrl = 'https://example.com/help';\n",
  );
  write(
    join(root, 'dist', 'src', 'content', 'index.iife.js'),
    "chrome.runtime.sendMessage({ type: 'blocked' });\n",
  );
  writePng(join(root, 'dist', 'assets', 'icons', 'idle-128.png'), 128, 128);
  write(
    join(root, 'src', 'background', 'index.ts'),
    'chrome.runtime.onInstalled.addListener((): void => {});\n',
  );
  writeJson(join(root, 'store', 'submission-manifest.json'), validSubmissionManifest());
  for (const screenshot of SCREENSHOTS) writePng(join(root, screenshot), 1280, 800);
  writePng(join(root, 'store', 'assets', 'small-promo-440x280.png'), 440, 280);
  writePng(join(root, 'store', 'assets', 'marquee-1400x560.png'), 1400, 560);
  writePng(join(root, 'assets', 'icons', 'idle-128.png'), 128, 128);
}

export function readSubmissionManifest(root: string): SubmissionManifest {
  return JSON.parse(
    readFileSync(join(root, 'store', 'submission-manifest.json'), 'utf8'),
  ) as SubmissionManifest;
}

export function distArchiveEntries(root: string): ArchiveEntryFixture[] {
  const paths: string[] = [
    'assets/background.js',
    'assets/icons/idle-128.png',
    'assets/popup.js',
    'manifest.json',
    'service-worker-loader.js',
    'src/content/index.iife.js',
    'src/popup/popup.html',
  ];
  return paths.map(
    (path: string): ArchiveEntryFixture => ({
      name: path,
      contents: readFileSync(join(root, 'dist', path)),
    }),
  );
}

function crc32(buffer: Buffer): number {
  let crc: number = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit: number = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function fixedDosDate(): number {
  return ((2000 - 1980) << 9) | (1 << 5) | 1;
}

export function archiveBuffer(entries: ArchiveEntryFixture[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset: number = 0;

  for (const entry of entries) {
    const name: Buffer = Buffer.from(entry.name, 'utf8');
    const uncompressed: Buffer = Buffer.isBuffer(entry.contents)
      ? entry.contents
      : Buffer.from(entry.contents ?? '');
    const shouldCompress: boolean = entry.compress ?? true;
    const compressed: Buffer = shouldCompress
      ? deflateRawSync(uncompressed, { level: 9 })
      : uncompressed;
    const compressionMethod: number = shouldCompress ? 8 : 0;
    const checksum: number = entry.declaredCrc32 ?? crc32(uncompressed);
    const mode: number = entry.mode ?? 0o100644;
    const declaredUncompressedSize: number = entry.declaredUncompressedSize ?? uncompressed.length;
    const generalPurposeBitFlag: number = entry.generalPurposeBitFlag ?? 0x0800;
    const lastModFileTime: number = entry.lastModFileTime ?? 0;
    const lastModFileDate: number = entry.lastModFileDate ?? fixedDosDate();
    const localExtra: Buffer = entry.localExtra ?? Buffer.alloc(0);
    const centralExtra: Buffer = entry.centralExtra ?? Buffer.alloc(0);
    const fileComment: Buffer = Buffer.isBuffer(entry.fileComment)
      ? entry.fileComment
      : Buffer.from(entry.fileComment ?? '', 'utf8');

    const localHeader: Buffer = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(generalPurposeBitFlag, 6);
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt16LE(lastModFileTime, 10);
    localHeader.writeUInt16LE(lastModFileDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(declaredUncompressedSize, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(localExtra.length, 28);
    localParts.push(localHeader, name, localExtra, compressed);

    const centralHeader: Buffer = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(generalPurposeBitFlag, 8);
    centralHeader.writeUInt16LE(compressionMethod, 10);
    centralHeader.writeUInt16LE(lastModFileTime, 12);
    centralHeader.writeUInt16LE(lastModFileDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(declaredUncompressedSize, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(centralExtra.length, 30);
    centralHeader.writeUInt16LE(fileComment.length, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((mode << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name, centralExtra, fileComment);

    localOffset += localHeader.length + name.length + localExtra.length + compressed.length;
  }

  const centralDirectory: Buffer = Buffer.concat(centralParts);
  const end: Buffer = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function writeArchive(root: string, entries: ArchiveEntryFixture[]): string {
  const zipPath: string = join(root, 'release', 'focus-lock-0.1.0.zip');
  write(zipPath, archiveBuffer(entries));
  return zipPath;
}

export function writePackageManifest(root: string, zipPath: string): void {
  const zip: Buffer = readFileSync(zipPath);
  writeJson(join(root, 'release', 'package-manifest.json'), {
    version: '0.1.0',
    zipPath: 'release/focus-lock-0.1.0.zip',
    sha256: createHash('sha256').update(zip).digest('hex'),
  });
}

export function runValidator(
  scriptPath: string,
  cwd: string,
  args: string[] = [],
  environment: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

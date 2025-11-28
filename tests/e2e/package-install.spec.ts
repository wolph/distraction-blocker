import type { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { CONTENT_SCRIPT_ID } from '../../src/shared/permissions';
import type { SetupState } from '../../src/shared/types';
import {
  assertNoUnexpectedBrowserDiagnostics,
  type BrowserDiagnostics,
} from './browser-diagnostics';
import { resolveExtensionDist } from './extension-dist';
import {
  expect,
  type FreshInstallLaunch,
  sendExtensionRequest,
  startTestSession,
  test,
} from './fixtures';
import {
  ARCHIVE_LIMITS,
  type ArchiveEntry,
  type ArchiveTotals,
  DEFLATE_COMPRESSION_METHOD,
  extractPackageArchive,
  type PackageManifest,
  REGULAR_FILE_EXTERNAL_ATTRIBUTES,
  readPackageArchive,
  readPackageManifest,
  UTF8_FILE_NAME_FLAG,
  validateArchiveEntry,
} from './package-install-archive';

test.setTimeout(120_000);

const REPOSITORY_ROOT: string = path.resolve(import.meta.dirname, '../..');
const REPOSITORY_DIST: string = path.join(REPOSITORY_ROOT, 'dist');

function expectedRegistrations(): Record<string, unknown>[] {
  return [
    {
      id: CONTENT_SCRIPT_ID,
      matches: ['http://*/*', 'https://*/*'],
      persistAcrossSessions: true,
      runAt: 'document_start',
    },
  ];
}

interface RuntimeIdentity {
  id: string;
  name: string;
  version: string;
}

let extractedDirectory: string | null = null;
let extractedFileNames: readonly string[] = [];
let extractedManifestText: string | null = null;
let packageManifest: PackageManifest | null = null;
let originalDistOverride: string | undefined;
let distOverrideApplied: boolean = false;

function requireExtractedDirectory(): string {
  if (extractedDirectory === null) throw new Error('the packaged ZIP was not extracted');
  return extractedDirectory;
}

function requireExtractedManifestText(): string {
  if (extractedManifestText === null) throw new Error('the packaged manifest was not extracted');
  return extractedManifestText;
}

function requirePackageManifest(): PackageManifest {
  if (packageManifest === null) throw new Error('the package manifest was not read');
  return packageManifest;
}

function expectNoDiagnostics(diagnostics: BrowserDiagnostics): void {
  expect((): void => assertNoUnexpectedBrowserDiagnostics(diagnostics)).not.toThrow();
}

function baselineEntry(overrides: Partial<ArchiveEntry> = {}): ArchiveEntry {
  return {
    compressedSize: 100,
    compressionMethod: DEFLATE_COMPRESSION_METHOD,
    crc32: 0,
    externalFileAttributes: REGULAR_FILE_EXTERNAL_ATTRIBUTES,
    fileName: 'manifest.json',
    generalPurposeBitFlag: UTF8_FILE_NAME_FLAG,
    localHeaderOffset: 0,
    uncompressedSize: 1_000,
    ...overrides,
  };
}

function expectRejectedEntry(overrides: Partial<ArchiveEntry>, reason: RegExp): void {
  const totals: ArchiveTotals = { entryCount: 0, uncompressedBytes: 0 };
  expect((): void =>
    validateArchiveEntry(baselineEntry(overrides), new Set<string>(), totals),
  ).toThrow(reason);
}

async function currentSetup(launch: FreshInstallLaunch): Promise<SetupState> {
  return await sendExtensionRequest(launch.extPage, { type: 'getSetupState' });
}

async function runtimeIdentity(launch: FreshInstallLaunch): Promise<RuntimeIdentity> {
  return await launch.worker.evaluate((): RuntimeIdentity => {
    const manifest: chrome.runtime.Manifest = chrome.runtime.getManifest();
    return { id: chrome.runtime.id, name: manifest.name, version: manifest.version };
  });
}

async function servedManifestText(launch: FreshInstallLaunch): Promise<string> {
  return await launch.worker.evaluate(async (): Promise<string> => {
    const response: Response = await fetch(chrome.runtime.getURL('manifest.json'));
    if (!response.ok) throw new Error(`manifest.json is unreadable: ${response.status}`);
    return await response.text();
  });
}

async function expectBlockedPage(launch: FreshInstallLaunch, url: string): Promise<void> {
  const page: Page = await launch.context.newPage();
  await page.goto(url, { waitUntil: 'commit' });
  await expect(page.locator('focus-lock-overlay')).toBeAttached();
  await expect(page).toHaveTitle('Locked - Focus Lock');
  await expect(page.locator('#marker')).toHaveCount(0);
}

test.beforeAll(async (): Promise<void> => {
  const manifest: PackageManifest = await readPackageManifest(REPOSITORY_ROOT);
  const archive: Buffer = await readPackageArchive(REPOSITORY_ROOT, manifest);
  const directory: string = await mkdtemp(path.join(tmpdir(), 'focus-lock-package-install-'));
  extractedDirectory = directory;
  extractedFileNames = await extractPackageArchive(archive, directory);
  extractedManifestText = await readFile(path.join(directory, 'manifest.json'), 'utf8');
  packageManifest = manifest;
  originalDistOverride = process.env.FOCUS_LOCK_E2E_DIST;
  process.env.FOCUS_LOCK_E2E_DIST = directory;
  distOverrideApplied = true;
});

test.afterAll(async (): Promise<void> => {
  if (distOverrideApplied) {
    if (originalDistOverride === undefined) delete process.env.FOCUS_LOCK_E2E_DIST;
    else process.env.FOCUS_LOCK_E2E_DIST = originalDistOverride;
    distOverrideApplied = false;
  }
  const directory: string | null = extractedDirectory;
  extractedDirectory = null;
  packageManifest = null;
  extractedManifestText = null;
  extractedFileNames = [];
  if (directory !== null) await rm(directory, { force: true, recursive: true });
});

test('the release ZIP extracts under archive safety rules and is the only loaded build', (): void => {
  const directory: string = requireExtractedDirectory();
  expect(extractedFileNames).toContain('manifest.json');
  expect(extractedFileNames.length).toBeGreaterThan(1);
  expect(
    extractedFileNames.filter(
      (name: string): boolean => name.startsWith('/') || name.includes('..'),
    ),
  ).toEqual([]);
  expect(resolveExtensionDist()).toBe(directory);
  expect(resolveExtensionDist()).not.toBe(REPOSITORY_DIST);

  const totals: ArchiveTotals = { entryCount: 0, uncompressedBytes: 0 };
  const seen: Set<string> = new Set<string>();
  expect((): void => validateArchiveEntry(baselineEntry(), seen, totals)).not.toThrow();
  expect((): void => validateArchiveEntry(baselineEntry(), seen, totals)).toThrow(/Duplicate/);

  expectRejectedEntry({ fileName: '../escape.json' }, /unsafe path component/);
  expectRejectedEntry({ fileName: '/etc/passwd' }, /absolute path/);
  expectRejectedEntry({ fileName: 'c:/escape.json' }, /absolute drive path/);
  expectRejectedEntry({ fileName: 'src/' }, /directory entries are forbidden/);
  expectRejectedEntry({ externalFileAttributes: (0o120777 << 16) >>> 0 }, /symbolic link/);
  expectRejectedEntry({ uncompressedSize: ARCHIVE_LIMITS.maxEntryBytes + 1 }, /member limit/);
  expectRejectedEntry({ compressedSize: 1, uncompressedSize: 1_000_000 }, /compression ratio/);
  expectRejectedEntry(
    { generalPurposeBitFlag: UTF8_FILE_NAME_FLAG | 0x0001 },
    /general-purpose flags/,
  );
  expectRejectedEntry({ compressionMethod: 0 }, /generator compression method/);
});

test('the packaged artifact installs, onboards, blocks, and survives a browser restart', async ({
  freshInstallExtension,
  siteUrl,
}) => {
  const url: string = siteUrl('/plain.html');
  const diagnostics: BrowserDiagnostics = freshInstallExtension.diagnostics;
  let launch: FreshInstallLaunch = await freshInstallExtension.launch();

  expect(resolveExtensionDist()).toBe(requireExtractedDirectory());
  const identity: RuntimeIdentity = await runtimeIdentity(launch);
  expect(identity.id).toBe(launch.extensionId);
  expect(identity.name).toBe('Focus Lock');
  expect(identity.version).toBe(requirePackageManifest().version);
  expect(await servedManifestText(launch)).toBe(requireExtractedManifestText());

  expect(await freshInstallExtension.hasWebsiteAccess()).toBe(false);
  expect(await freshInstallExtension.dynamicRegistrations()).toEqual([]);
  expect(await currentSetup(launch)).toMatchObject({
    blockingRegistration: 'unavailable',
    completed: false,
    storageMode: null,
    websiteAccess: 'denied',
  });
  await expect(launch.onboardingPage).toHaveURL(freshInstallExtension.onboardingUrl());
  await expect(
    launch.onboardingPage.getByRole('heading', { name: 'Choose your starting block list' }),
  ).toBeVisible();
  expectNoDiagnostics(diagnostics);

  launch = await freshInstallExtension.grantWebsiteAccess();
  expect(await freshInstallExtension.hasWebsiteAccess()).toBe(true);
  expect(await freshInstallExtension.dynamicRegistrations()).toMatchObject(expectedRegistrations());
  expect(await freshInstallExtension.completeSetup('sync')).toMatchObject({
    blockingRegistration: 'ready',
    completed: true,
    storageMode: 'sync',
    websiteAccess: 'granted',
  });

  await startTestSession(launch.extPage, {
    duration: { kind: 'timed', minutes: 2 },
    intention: 'verify the packaged artifact',
  });
  await expectBlockedPage(launch, url);
  const setupBeforeRestart: SetupState = await currentSetup(launch);
  expectNoDiagnostics(diagnostics);

  launch = await freshInstallExtension.relaunch();
  expect(await runtimeIdentity(launch)).toEqual(identity);
  expect(await currentSetup(launch)).toEqual(setupBeforeRestart);
  expect(await freshInstallExtension.hasWebsiteAccess()).toBe(true);
  expect(await freshInstallExtension.dynamicRegistrations()).toMatchObject(expectedRegistrations());
  await expect(launch.extPage.locator('.phase-label')).toHaveText('focusing');
  await expect(launch.extPage.locator('.clock')).toHaveText(/\d+:[0-5]\d/);
  await expectBlockedPage(launch, url);
  expectNoDiagnostics(diagnostics);
});

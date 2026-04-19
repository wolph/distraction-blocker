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
  admitArchiveEntry,
  DEFLATE_COMPRESSION_METHOD,
  extractPackageArchive,
  type PackageManifest,
  REGULAR_FILE_EXTERNAL_ATTRIBUTES,
  readPackageArchive,
  readPackageManifest,
  UTF8_FILE_NAME_FLAG,
} from './package-install-archive';

test.setTimeout(120_000);

const REPOSITORY_ROOT: string = path.resolve(import.meta.dirname, '../..');

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

/** Every concrete file path the packaged manifest names. Globbed resources are skipped. */
function declaredManifestFiles(manifestText: string): string[] {
  const manifest: Record<string, unknown> = JSON.parse(manifestText) as Record<string, unknown>;
  const found: string[] = [];
  const take: (value: unknown) => void = (value: unknown): void => {
    if (typeof value === 'string' && value !== '' && !value.includes('*')) found.push(value);
  };
  const record: (value: unknown) => Record<string, unknown> | null = (
    value: unknown,
  ): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;

  take(record(manifest.background)?.service_worker);
  take(record(manifest.action)?.default_popup);
  take(manifest.options_page);
  take(record(manifest.options_ui)?.page);
  for (const icon of Object.values(record(manifest.icons) ?? {})) take(icon);
  for (const script of Array.isArray(manifest.content_scripts) ? manifest.content_scripts : []) {
    const entry: Record<string, unknown> | null = record(script);
    for (const file of Array.isArray(entry?.js) ? entry.js : []) take(file);
    for (const file of Array.isArray(entry?.css) ? entry.css : []) take(file);
  }
  const resources: unknown[] = Array.isArray(manifest.web_accessible_resources)
    ? manifest.web_accessible_resources
    : [];
  for (const group of resources) {
    const entry: Record<string, unknown> | null = record(group);
    for (const file of Array.isArray(entry?.resources) ? entry.resources : []) take(file);
  }
  // A manifest this helper cannot read would make the inventory check vacuous, so it says so.
  if (found.length < 3) throw new Error('the packaged manifest declares no readable file paths');
  return found;
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
    admitArchiveEntry(baselineEntry(overrides), new Set<string>(), totals),
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

/**
 * Every packaged file must be byte-identical to the `dist/` this run actually has.
 *
 * The manifest and the archive are already checked against each other, and that proves only that
 * they came from the same moment rather than that the moment is this one. `store:validate` makes
 * this comparison against the live `dist/` when the archive is built, and nothing made it again
 * here, so a build landing between packaging and installing left this spec installing a stale
 * artifact and reporting success. On a shared branch that window is real: any build by anyone
 * rewrites `dist/`, and the release gate runs two other steps inside it.
 */
async function assertArchiveMatchesCurrentDist(
  directory: string,
  fileNames: readonly string[],
): Promise<void> {
  const distDirectory: string = path.join(REPOSITORY_ROOT, 'dist');
  const missing: string[] = [];
  const differing: string[] = [];
  for (const name of fileNames) {
    let built: Buffer;
    try {
      built = await readFile(path.join(distDirectory, name));
    } catch {
      missing.push(name);
      continue;
    }
    const packaged: Buffer = await readFile(path.join(directory, name));
    if (!packaged.equals(built)) differing.push(name);
  }
  if (missing.length === 0 && differing.length === 0) return;
  throw new Error(
    [
      'The packaged archive no longer matches dist/, so this spec would install an artifact that',
      'is not this build. Something rebuilt dist/ after the package was created. Re-run',
      '`npm run store:package` and try again.',
      missing.length === 0 ? '' : ` Absent from dist/: ${missing.sort().join(', ')}.`,
      differing.length === 0 ? '' : ` Differing bytes: ${differing.sort().join(', ')}.`,
    ]
      .join(' ')
      .trim(),
  );
}

test.beforeAll(async (): Promise<void> => {
  const manifest: PackageManifest = await readPackageManifest(REPOSITORY_ROOT);
  const archive: Buffer = await readPackageArchive(REPOSITORY_ROOT, manifest);
  const directory: string = await mkdtemp(path.join(tmpdir(), 'focus-lock-package-install-'));
  extractedDirectory = directory;
  extractedFileNames = await extractPackageArchive(archive, directory);
  await assertArchiveMatchesCurrentDist(directory, extractedFileNames);
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
  // The inventory is checked against what the packaged manifest itself declares, so a
  // truncated package fails here instead of at whatever loads the missing file. Naming the
  // paths in this file would only pin them to today's build layout.
  expect(extractedFileNames).toContain('manifest.json');
  for (const declared of declaredManifestFiles(requireExtractedManifestText())) {
    expect(extractedFileNames).toContain(declared);
  }
  expect(resolveExtensionDist()).toBe(directory);

  const totals: ArchiveTotals = { entryCount: 0, uncompressedBytes: 0 };
  const seen: Set<string> = new Set<string>();
  expect((): void => admitArchiveEntry(baselineEntry(), seen, totals)).not.toThrow();
  expect((): void => admitArchiveEntry(baselineEntry(), seen, totals)).toThrow(/Duplicate/);

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
  assertNoUnexpectedBrowserDiagnostics(diagnostics);

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
  assertNoUnexpectedBrowserDiagnostics(diagnostics);

  launch = await freshInstallExtension.relaunch();
  expect(await runtimeIdentity(launch)).toEqual(identity);
  expect(await currentSetup(launch)).toEqual(setupBeforeRestart);
  expect(await freshInstallExtension.hasWebsiteAccess()).toBe(true);
  expect(await freshInstallExtension.dynamicRegistrations()).toMatchObject(expectedRegistrations());
  await expect(launch.extPage.locator('.clock-stack__value').first()).toHaveText(/\d+:[0-5]\d/);
  await expect(launch.extPage.locator('.clock-stack__label').first()).not.toBeEmpty();
  await expectBlockedPage(launch, url);
  assertNoUnexpectedBrowserDiagnostics(diagnostics);
});

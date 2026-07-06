import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ThemeMode } from '../../src/shared/types';

export interface Task7ThemeCase {
  colorScheme: 'dark' | 'light';
  id: 'auto-dark' | 'auto-light' | 'dark-light-media' | 'light-dark-media';
  theme: ThemeMode;
}

export interface Task7ResolvedTheme {
  backgroundColor: string;
  color: string;
  colorScheme: string;
}

export type Task7ThemeSurface =
  | 'gate'
  | 'options'
  | 'overlay'
  | 'popup'
  | 'privacy'
  | 'stats'
  | 'stopped-overlay';

interface Task7CurrentSurfaceRecord {
  file: string;
  scope: 'focused' | 'full';
  state: string;
  surface: string;
  themeCase: Task7ThemeCase['id'];
  viewport: { height: number; width: number };
}

const TASK7_CURRENT_SURFACE_STATES: Readonly<Record<string, readonly string[]>> = {
  gate: ['typed-gate', 'untyped-gate'],
  stats: ['current-language'],
  'stopped-overlay': ['stopped-document'],
};

const TASK7_PAGE_VIEWPORTS: readonly { height: number; width: number }[] = [
  { height: 667, width: 375 },
  { height: 800, width: 768 },
  { height: 800, width: 1280 },
];

const TASK7_THEME_IDS: readonly Task7ThemeCase['id'][] = [
  'auto-light',
  'auto-dark',
  'light-dark-media',
  'dark-light-media',
];

export function assertTask7CurrentSurfaceCoverage(
  inventory: readonly Task7CurrentSurfaceRecord[],
): void {
  const observed: Set<string> = new Set(
    inventory.map(
      (record: Task7CurrentSurfaceRecord): string =>
        `${record.surface}/${record.state}/${record.themeCase}/${String(record.viewport.width)}/${record.scope}`,
    ),
  );
  const required: string[] = [];
  for (const [surface, states] of Object.entries(TASK7_CURRENT_SURFACE_STATES)) {
    for (const state of states) {
      for (const themeCase of TASK7_THEME_IDS) {
        for (const viewport of TASK7_PAGE_VIEWPORTS) {
          for (const scope of ['full', 'focused'] as const) {
            required.push(`${surface}/${state}/${themeCase}/${String(viewport.width)}/${scope}`);
          }
        }
      }
    }
  }
  const missing: string[] = required.filter((key: string): boolean => !observed.has(key));
  if (missing.length > 0) {
    throw new Error(`Missing Task 7 current surface evidence: ${missing.join(', ')}`);
  }
}

export interface Task7BuildProvenance {
  applicationSourceTreeSha256: string;
  distTreeSha256: string;
  gitCommit: string;
  manifestSha256: string;
  schemaVersion: 1;
}

function task7Record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseTask7BuildProvenance(value: unknown): Task7BuildProvenance {
  if (
    !task7Record(value) ||
    value.schemaVersion !== 1 ||
    typeof value.gitCommit !== 'string' ||
    !/^[0-9a-f]{40,64}$/.test(value.gitCommit) ||
    typeof value.applicationSourceTreeSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.applicationSourceTreeSha256) ||
    typeof value.distTreeSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.distTreeSha256) ||
    typeof value.manifestSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.manifestSha256)
  ) {
    throw new Error('Task 7 build provenance record is missing or invalid.');
  }
  return {
    applicationSourceTreeSha256: value.applicationSourceTreeSha256,
    distTreeSha256: value.distTreeSha256,
    gitCommit: value.gitCommit,
    manifestSha256: value.manifestSha256,
    schemaVersion: 1,
  };
}

export const TASK7_PROVENANCE_FILE: string = '.focus-lock-evidence-provenance.json';
const TASK7_APPLICATION_PATHS: readonly string[] = [
  'assets',
  'manifest.config.ts',
  'scripts/gen-icons.mjs',
  'src',
  'vite.config.ts',
];
const execFileAsync = promisify(execFile);

const EXPECTED_THEME: Readonly<
  Record<Task7ThemeSurface, Record<'dark' | 'light', Task7ResolvedTheme>>
> = {
  gate: {
    dark: {
      backgroundColor: 'rgb(18, 26, 21)',
      color: 'rgb(231, 239, 233)',
      colorScheme: 'dark',
    },
    light: {
      backgroundColor: 'rgb(247, 250, 248)',
      color: 'rgb(22, 33, 26)',
      colorScheme: 'light',
    },
  },
  options: {
    dark: {
      backgroundColor: 'rgb(22, 26, 24)',
      color: 'rgb(232, 236, 233)',
      colorScheme: 'dark',
    },
    light: {
      backgroundColor: 'rgb(250, 250, 248)',
      color: 'rgb(28, 35, 33)',
      colorScheme: 'light',
    },
  },
  overlay: {
    dark: {
      backgroundColor: 'rgba(15, 23, 42, 0.97)',
      color: '#f8fafc',
      colorScheme: 'dark',
    },
    light: {
      backgroundColor: 'rgba(248, 250, 252, 0.98)',
      color: '#0f172a',
      colorScheme: 'light',
    },
  },
  popup: {
    dark: {
      backgroundColor: 'rgb(18, 26, 21)',
      color: 'rgb(231, 239, 233)',
      colorScheme: 'dark',
    },
    light: {
      backgroundColor: 'rgb(247, 250, 248)',
      color: 'rgb(22, 33, 26)',
      colorScheme: 'light',
    },
  },
  privacy: {
    dark: {
      backgroundColor: 'rgb(22, 26, 24)',
      color: 'rgb(232, 236, 233)',
      colorScheme: 'dark',
    },
    light: {
      backgroundColor: 'rgb(250, 250, 248)',
      color: 'rgb(28, 35, 33)',
      colorScheme: 'light',
    },
  },
  stats: {
    dark: {
      backgroundColor: 'rgb(13, 13, 13)',
      color: 'rgb(255, 255, 255)',
      colorScheme: 'dark',
    },
    light: {
      backgroundColor: 'rgb(249, 249, 247)',
      color: 'rgb(11, 11, 11)',
      colorScheme: 'light',
    },
  },
  'stopped-overlay': {
    dark: {
      backgroundColor: 'rgba(15, 23, 42, 0.97)',
      color: '#f8fafc',
      colorScheme: 'dark',
    },
    light: {
      backgroundColor: 'rgba(248, 250, 252, 0.98)',
      color: '#0f172a',
      colorScheme: 'light',
    },
  },
};

function expectedResolvedMode(themeCase: Task7ThemeCase): 'dark' | 'light' {
  if (themeCase.theme === 'auto') return themeCase.colorScheme;
  return themeCase.theme;
}

export function assertTask7ResolvedTheme(
  actual: Task7ResolvedTheme,
  themeCase: Task7ThemeCase,
  surface: Task7ThemeSurface,
): void {
  const expected: Task7ResolvedTheme = EXPECTED_THEME[surface][expectedResolvedMode(themeCase)];
  for (const property of ['backgroundColor', 'color', 'colorScheme'] as const) {
    const matches: boolean =
      property === 'colorScheme'
        ? actual[property].split(/\s+/).includes(expected[property])
        : actual[property] === expected[property];
    if (matches) continue;
    const label: string = property.replace(
      /[A-Z]/g,
      (letter: string): string => `-${letter.toLowerCase()}`,
    );
    throw new Error(
      `${themeCase.id} ${surface} ${label} expected ${expected[property]}, received ${actual[property]}`,
    );
  }
}

export function assertTask7SingleResponsiveCopy(visibleCopies: number): void {
  if (visibleCopies !== 1) {
    throw new Error(
      `Task 7 Stats requires exactly one visible responsive DOM copy, received ${String(visibleCopies)}.`,
    );
  }
}

async function task7TreeFiles(root: string, directory: string = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath: string = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await task7TreeFiles(root, absolutePath)));
      continue;
    }
    if (!entry.isFile() || entry.name === TASK7_PROVENANCE_FILE) continue;
    files.push(path.relative(root, absolutePath).split(path.sep).join('/'));
  }
  return files.sort((left: string, right: string): number => left.localeCompare(right));
}

async function sha256Task7File(filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');
}

async function currentTask7ApplicationSource(repositoryRoot: string): Promise<{
  applicationSourceTreeSha256: string;
  gitCommit: string;
}> {
  const gitArguments: string[] = ['-C', repositoryRoot];
  const { stdout: commitOutput } = await execFileAsync('git', [
    ...gitArguments,
    'log',
    '-1',
    '--format=%H',
    '--',
    ...TASK7_APPLICATION_PATHS,
  ]);
  const { stdout: statusOutput } = await execFileAsync('git', [
    ...gitArguments,
    'status',
    '--porcelain',
    '--',
    ...TASK7_APPLICATION_PATHS,
  ]);
  if (statusOutput.trim() !== '') {
    throw new Error(`Task 7 application source is not committed:\n${statusOutput.trim()}`);
  }
  const { stdout: filesOutput } = await execFileAsync('git', [
    ...gitArguments,
    'ls-files',
    '-z',
    '--',
    ...TASK7_APPLICATION_PATHS,
  ]);
  const files: string[] = filesOutput
    .split('\0')
    .filter((file: string): boolean => file !== '')
    .sort((left: string, right: string): number => left.localeCompare(right));
  const hash = createHash('sha256');
  for (const relativePath of files) {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(await readFile(path.join(repositoryRoot, relativePath)));
    hash.update('\0');
  }
  return {
    applicationSourceTreeSha256: hash.digest('hex'),
    gitCommit: commitOutput.trim(),
  };
}

export async function createTask7BuildProvenance(
  repositoryRoot: string,
  extensionDist: string,
): Promise<Task7BuildProvenance> {
  await assertTask7IsolatedDist(repositoryRoot, extensionDist);
  const source = await currentTask7ApplicationSource(repositoryRoot);
  return {
    ...source,
    distTreeSha256: await hashTask7Tree(extensionDist),
    manifestSha256: await sha256Task7File(path.join(extensionDist, 'manifest.json')),
    schemaVersion: 1,
  };
}

export async function readTask7BuildProvenance(
  repositoryRoot: string,
  extensionDist: string,
): Promise<{
  currentApplicationSourceTreeSha256: string;
  currentGitCommit: string;
  observed: Task7BuildProvenance;
}> {
  await assertTask7IsolatedDist(repositoryRoot, extensionDist);
  const source = await currentTask7ApplicationSource(repositoryRoot);
  const recorded: Task7BuildProvenance = parseTask7BuildProvenance(
    JSON.parse(await readFile(path.join(extensionDist, TASK7_PROVENANCE_FILE), 'utf8')),
  );
  const observed: Task7BuildProvenance = {
    ...recorded,
    distTreeSha256: await hashTask7Tree(extensionDist),
    manifestSha256: await sha256Task7File(path.join(extensionDist, 'manifest.json')),
  };
  if (
    recorded.distTreeSha256 !== observed.distTreeSha256 ||
    recorded.manifestSha256 !== observed.manifestSha256
  ) {
    throw new Error('Task 7 isolated extension dist does not match its provenance record.');
  }
  return {
    currentApplicationSourceTreeSha256: source.applicationSourceTreeSha256,
    currentGitCommit: source.gitCommit,
    observed,
  };
}

async function assertTask7IsolatedDist(
  repositoryRoot: string,
  extensionDist: string,
): Promise<void> {
  const explicitRealPath: string = await realpath(extensionDist);
  let repositoryDistRealPath: string = path.resolve(repositoryRoot, 'dist');
  try {
    repositoryDistRealPath = await realpath(repositoryDistRealPath);
  } catch {
    // A missing repository dist cannot alias the existing explicit build.
  }
  if (explicitRealPath === repositoryDistRealPath) {
    throw new Error('Task 7 persistent evidence requires an isolated extension dist.');
  }
}

export async function hashTask7Tree(root: string): Promise<string> {
  const hash = createHash('sha256');
  for (const relativePath of await task7TreeFiles(root)) {
    const payload: Buffer = await readFile(path.join(root, relativePath));
    hash.update(relativePath);
    hash.update('\0');
    hash.update(payload);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function assertTask7BuildProvenance(input: {
  after: Task7BuildProvenance;
  before: Task7BuildProvenance;
  currentApplicationSourceTreeSha256: string;
  currentGitCommit: string;
  explicitDist: string;
  repositoryDist: string;
}): void {
  if (path.resolve(input.explicitDist) === path.resolve(input.repositoryDist)) {
    throw new Error('Task 7 persistent evidence requires an isolated extension dist.');
  }
  if (input.before.gitCommit !== input.currentGitCommit) {
    throw new Error('Task 7 build commit does not match the current application-source commit.');
  }
  if (input.before.applicationSourceTreeSha256 !== input.currentApplicationSourceTreeSha256) {
    throw new Error('Task 7 build application source does not match the current repository state.');
  }
  if (
    input.after.applicationSourceTreeSha256 !== input.before.applicationSourceTreeSha256 ||
    input.after.distTreeSha256 !== input.before.distTreeSha256 ||
    input.after.gitCommit !== input.before.gitCommit ||
    input.after.manifestSha256 !== input.before.manifestSha256 ||
    input.after.schemaVersion !== input.before.schemaVersion
  ) {
    throw new Error('Task 7 extension dist changed during evidence capture.');
  }
}

export function assertTask7ProductionInventoryParity(
  diskFiles: readonly string[],
  inventory: readonly { file: string }[],
): void {
  const seen: Set<string> = new Set<string>();
  for (const record of inventory) {
    if (seen.has(record.file)) {
      throw new Error(`Duplicate Task 7 production inventory entry: ${record.file}`);
    }
    seen.add(record.file);
  }
  const disk: Set<string> = new Set(diskFiles);
  const missing: string[] = [...disk].filter((file: string): boolean => !seen.has(file)).sort();
  const unexpected: string[] = [...seen].filter((file: string): boolean => !disk.has(file)).sort();
  if (missing.length === 0 && unexpected.length === 0) return;
  throw new Error(
    `Task 7 production inventory parity failed. Missing: ${missing.join(', ') || 'none'}. Unexpected: ${unexpected.join(', ') || 'none'}.`,
  );
}

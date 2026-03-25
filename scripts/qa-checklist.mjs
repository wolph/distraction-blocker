/**
 * Derives the QA checklist's machine-verified inventory from the suites themselves.
 *
 * The checklist used to carry typed counts. Four of them went stale, the newest by a factor of
 * more than two, and nothing failed: a typed number has no owner and no alarm. Everything this
 * script writes is asked of the runner or of the glob the runner is configured with, so a number
 * that drifts fails the contract test instead of misleading a reader.
 *
 *   node scripts/qa-checklist.mjs          rewrite the generated block in place
 *   node scripts/qa-checklist.mjs --check  fail if the block is not what the suites say
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECKLIST = path.join(root, 'docs/qa-checklist.md');
export const BEGIN = '<!-- BEGIN GENERATED: scripts/qa-checklist.mjs -->';
export const END = '<!-- END GENERATED -->';

/**
 * The unit suite is counted by files rather than by cases, and the glob is read from the Vitest
 * config rather than repeated here, so this counts what Vitest is actually configured to run. A
 * case count is deliberately absent: deriving one means collecting every test file, which is the
 * expensive half of a run, and a number that needs a run to verify is the kind that went stale.
 */
export async function unitTestFiles(repoRoot = root) {
  const config = readFileSync(path.join(repoRoot, 'vitest.config.ts'), 'utf8');
  const include = /include:\s*\[\s*'([^']+)'/.exec(config);
  if (include === null) throw new Error('vitest.config.ts declares no include pattern');
  const pattern = include[1];
  const files = [];
  for await (const entry of glob(pattern, { cwd: repoRoot })) files.push(entry);
  return { pattern, files: files.sort() };
}

/** The end-to-end scenarios, asked of Playwright rather than parsed out of the specs. */
export function e2eScenarios(repoRoot = root) {
  const raw = execFileSync('npx', ['playwright', 'test', '--list', '--reporter=json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const report = JSON.parse(raw);
  const byFile = new Map();
  const collect = (suites) => {
    for (const suite of suites) {
      for (const spec of suite.specs ?? []) {
        const file = spec.file ?? suite.file;
        if (!byFile.has(file)) byFile.set(file, []);
        byFile.get(file).push(spec.title);
      }
      collect(suite.suites ?? []);
    }
  };
  collect(report.suites ?? []);
  return [...byFile.entries()]
    .map(([file, titles]) => ({ file, titles: titles.sort() }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

export async function generatedBlock(repoRoot = root) {
  const unit = await unitTestFiles(repoRoot);
  const e2e = e2eScenarios(repoRoot);
  const total = e2e.reduce((sum, entry) => sum + entry.titles.length, 0);
  const lines = [
    BEGIN,
    '',
    'Derived by `node scripts/qa-checklist.mjs`, guarded by',
    '`tests/unit/docs/qa-checklist-contract.test.ts`. Nobody signs this section. Every number here',
    'is asked of the runner, or of the glob the runner is configured with, so a stale one fails a',
    'test rather than misleading a reader.',
    '',
    `Unit suite: **${unit.files.length} files** matching \`${unit.pattern}\`, the pattern`,
    '`vitest.config.ts` declares. The number of individual test cases is deliberately not recorded:',
    'deriving it means collecting every file, which is the expensive half of a run, and a number',
    'that needs a run to verify is exactly the kind that went stale here four times.',
    '',
    `End-to-end suite: **${total} scenarios in ${e2e.length} spec files**, as Playwright itself`,
    'lists them. Asking the runner rather than counting `test(` in the sources is not pedantry: a',
    'grep undercounts `test.skip`, which is listed and reported, and misses a spec file added',
    'since the grep was written. Both mistakes were present when this section was first drafted.',
    '',
  ];
  for (const entry of e2e) {
    lines.push(`### ${entry.file} (${entry.titles.length})`, '');
    for (const title of entry.titles) lines.push(`- ${title}`);
    lines.push('');
  }
  lines.push(END);
  return lines.join('\n');
}

function splice(document, block) {
  const start = document.indexOf(BEGIN);
  const finish = document.indexOf(END);
  if (start === -1 || finish === -1) throw new Error('the checklist has no generated block');
  return `${document.slice(0, start)}${block}${document.slice(finish + END.length)}`;
}

const isEntry =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntry) {
  const document = readFileSync(CHECKLIST, 'utf8');
  const block = await generatedBlock();
  const next = splice(document, block);
  if (process.argv.includes('--check')) {
    if (next !== document) {
      console.error('docs/qa-checklist.md does not match what the suites say. Run:');
      console.error('  node scripts/qa-checklist.mjs');
      process.exit(1);
    }
    console.log('QA checklist inventory matches the suites.');
  } else {
    writeFileSync(CHECKLIST, next, 'utf8');
    console.log('QA checklist inventory rewritten.');
  }
}

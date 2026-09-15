/**
 * The registration sweep in src/background/tabs.ts recognises Chrome's script-injection refusals
 * by message text, because Chrome exposes nothing else. A renamed message would silently turn a
 * harmless refusal into a reported one. This checks every recognised message, and the assumption
 * that host-permission denials name the URL, against Chromium's current source.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const CHROMIUM_RAW = 'https://raw.githubusercontent.com/chromium/chromium/main/';
const SOURCES = [
  'extensions/common/manifest_constants.h',
  'extensions/browser/scripting_utils.cc',
  'extensions/browser/script_executor.cc',
  'extensions/browser/api/execute_code_function.cc',
];

/** The fragments the sweep matches. Chromium builds some messages from format strings. */
const RECOGNISED_FRAGMENTS = [
  'The extensions gallery cannot be scripted',
  'Cannot access a chrome:// URL',
  'No tab with id',
  'The tab was closed',
  'is showing error page',
  'Cannot access contents of the page.',
];

/** The denial that must keep naming the URL, so the URL-less variant stays a distinct signal. */
const URL_NAMING_DENIAL =
  'Cannot access contents of url "*". Extension manifest must request permission to access this host.';

async function fetchSource(file) {
  const response = await fetch(`${CHROMIUM_RAW}${file}`);
  if (!response.ok) throw new Error(`fetching ${file} failed with HTTP ${String(response.status)}`);
  return await response.text();
}

async function localFragments() {
  const source = await readFile(path.resolve('src/background/tabs.ts'), 'utf8');
  return RECOGNISED_FRAGMENTS.filter((fragment) => !source.includes(fragment));
}

const missingLocally = await localFragments();
if (missingLocally.length > 0) {
  console.error(`tabs.ts no longer matches: ${missingLocally.join(', ')}. Update this script.`);
  process.exit(1);
}

const sources = await Promise.all(SOURCES.map(fetchSource));
const corpus = sources.join('\n');

/** C++ literals are split across lines and escape their quotes, so compare with both undone. */
const joined = corpus.replace(/"\s*\n\s*"/g, '').replaceAll('\\"', '"');
const missing = [...RECOGNISED_FRAGMENTS, URL_NAMING_DENIAL].filter(
  (fragment) => !joined.includes(fragment),
);
if (missing.length > 0) {
  console.error('Chromium no longer contains these messages verbatim:');
  for (const fragment of missing) console.error(`  ${fragment}`);
  console.error('Read the current Chromium messages and update isIgnorableInjectionFailure.');
  process.exit(1);
}
console.log(
  `All ${String(RECOGNISED_FRAGMENTS.length + 1)} Chrome injection messages still match Chromium main.`,
);

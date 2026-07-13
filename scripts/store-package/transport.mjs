import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { JSDOM } from 'jsdom';
import {
  inspectExecutableSource,
  inspectExtensionOriginFetch,
  isRemoteUrl,
} from './executable-analysis.mjs';
import {
  assert,
  assertString,
  objectKeysAre,
  validateRelativePath,
  walkRegularFiles,
} from './files.mjs';

const SOURCE_EXECUTABLE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const SHIPPED_EXECUTABLE_EXTENSIONS = new Set(['.cjs', '.htm', '.html', '.js', '.mjs']);
const SHIPPED_SCRIPT_EXTENSIONS = new Set(['.cjs', '.js', '.mjs']);
const MAX_EXTENSION_ORIGIN_FETCH_ENTRIES = 4;
const FAVICON_PATH_PREFIX = '/_favicon/';

export function validateTransportAllowlist(value) {
  assert(Array.isArray(value), 'transportAllowlist must be an array');
  assert(
    value.length === 0,
    'transportAllowlist must remain empty because product-data transport is forbidden',
  );
}

export function validateManifestExecutablePaths(manifest) {
  const paths = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    manifest.options_page,
    manifest.options_ui?.page,
    manifest.devtools_page,
    manifest.side_panel?.default_path,
    ...Object.values(manifest.chrome_url_overrides ?? {}),
    ...(manifest.sandbox?.pages ?? []),
    ...(manifest.content_scripts ?? []).flatMap((entry) => entry?.js ?? []),
  ];
  for (const path of paths) {
    assert(!isRemoteUrl(path), `Remote executable code URL is forbidden: ${path}`);
  }
}

function inspectHtml(source, filePath) {
  const observations = new Set();
  const document = new JSDOM(source).window.document;
  for (const script of document.querySelectorAll('script')) {
    assert(
      !isRemoteUrl(script.src),
      `Remote executable code URL is forbidden in ${filePath}: ${script.src}`,
    );
    if (!script.hasAttribute('src')) {
      for (const observation of inspectExecutableSource(script.textContent ?? '', filePath)) {
        observations.add(observation);
      }
    }
  }
  for (const link of document.querySelectorAll('link[rel="modulepreload"]')) {
    const href = link.getAttribute('href');
    assert(!isRemoteUrl(href), `Remote executable code URL is forbidden in ${filePath}: ${href}`);
  }
  return observations;
}

function scanExecutableFiles(rootDirectory, directory, extensions, pathPrefix) {
  if (!existsSync(join(rootDirectory, directory))) return new Set();
  const files = walkRegularFiles(rootDirectory, directory);
  const observations = new Set();
  for (const [relativePath, buffer] of files) {
    const extension = extname(relativePath).toLowerCase();
    if (!extensions.has(extension)) continue;
    const filePath = `${pathPrefix}/${relativePath}`;
    const source = buffer.toString('utf8');
    const found = ['.html', '.htm'].includes(extension)
      ? inspectHtml(source, filePath)
      : inspectExecutableSource(source, filePath);
    for (const observation of found) observations.add(observation);
  }
  return observations;
}

/**
 * The one transport the product may perform: a fetch of the extension's own
 * chrome-extension://<id>/_favicon/ URL, which Chrome answers from its local favicon cache. No
 * request reaches a website and no product data leaves the extension. The manifest names each
 * source file that may do this and why, and the policy checks the file rather than trusting the
 * entry.
 */
export function validateExtensionOriginFetch(value) {
  if (value === undefined) return [];
  assert(Array.isArray(value), 'extensionOriginFetch must be an array');
  assert(
    value.length <= MAX_EXTENSION_ORIGIN_FETCH_ENTRIES,
    `extensionOriginFetch must list at most ${MAX_EXTENSION_ORIGIN_FETCH_ENTRIES} files`,
  );
  const files = [];
  for (const entry of value) {
    objectKeysAre(entry, ['file', 'reason'], [], 'extensionOriginFetch entry');
    validateRelativePath(entry.file, 'extensionOriginFetch file');
    assertString(entry.reason, 'extensionOriginFetch reason');
    assert(
      entry.file.startsWith('src/') && SOURCE_EXECUTABLE_EXTENSIONS.has(extname(entry.file)),
      `extensionOriginFetch file must be an executable source file under src/: ${entry.file}`,
    );
    assert(!files.includes(entry.file), `extensionOriginFetch lists ${entry.file} twice`);
    files.push(entry.file);
  }
  return files;
}

function fetchObservation(filePath) {
  return `${filePath}:fetch`;
}

function assertExtensionOriginFetchSource(rootDirectory, filePath, observations) {
  const absolutePath = join(rootDirectory, filePath);
  assert(existsSync(absolutePath), `extensionOriginFetch file does not exist: ${filePath}`);
  const facts = inspectExtensionOriginFetch(readFileSync(absolutePath, 'utf8'), filePath);
  const foreign = [...observations].filter(
    (observation) =>
      observation.startsWith(`${filePath}:`) && observation !== fetchObservation(filePath),
  );
  assert(
    foreign.length === 0,
    `extensionOriginFetch file may only use fetch, found: ${foreign.join(', ')}`,
  );
  assert(
    facts.faviconUrlCalls > 0,
    `extensionOriginFetch file must build chrome.runtime.getURL('${FAVICON_PATH_PREFIX}'): ${filePath}`,
  );
  assert(
    facts.remoteLiterals.length === 0,
    `extensionOriginFetch file must not carry a remote URL: ${filePath}: ${facts.remoteLiterals.join(', ')}`,
  );
  assert(
    facts.globalFetchCalls > 0 && facts.globalFetchCalls === facts.safeGlobalFetchCalls,
    `extensionOriginFetch file must call fetch with credentials 'omit' and redirect 'error': ${filePath}`,
  );
  return facts.fetchCalls;
}

function assertShippedFetchStaysLocal(rootDirectory, observations, allowedFetchCalls) {
  const shippedFetchFiles = [...observations]
    .filter((observation) => observation.endsWith(':fetch'))
    .map((observation) => observation.slice(0, -':fetch'.length));
  if (shippedFetchFiles.length === 0) return;
  assert(
    allowedFetchCalls > 0,
    `Forbidden product-data transport identifier: ${fetchObservation(shippedFetchFiles[0])}`,
  );
  let shippedFetchCalls = 0;
  for (const filePath of shippedFetchFiles) {
    assert(
      SHIPPED_SCRIPT_EXTENSIONS.has(extname(filePath).toLowerCase()),
      `Forbidden product-data transport identifier: ${fetchObservation(filePath)}`,
    );
    const source = readFileSync(join(rootDirectory, filePath), 'utf8');
    const facts = inspectExtensionOriginFetch(source, filePath);
    // A bundle carries host patterns and the privacy URL as literals, so the remote-literal rule
    // belongs to the source file. The bundle must still build the favicon address and call the
    // global fetch only with the options that keep the request on the extension origin.
    assert(
      facts.faviconUrlCalls > 0 &&
        facts.globalFetchCalls > 0 &&
        facts.globalFetchCalls === facts.safeGlobalFetchCalls,
      `Shipped fetch is not the extension-origin favicon read: ${fetchObservation(filePath)}`,
    );
    shippedFetchCalls += facts.fetchCalls;
    observations.delete(fetchObservation(filePath));
  }
  assert(
    shippedFetchCalls === allowedFetchCalls,
    `Shipped code has ${shippedFetchCalls} fetch call sites, the exempted sources have ${allowedFetchCalls}`,
  );
}

export function validateTransportPolicy(rootDirectory, submission) {
  validateTransportAllowlist(submission.transportAllowlist);
  const exemptedFiles = validateExtensionOriginFetch(submission.extensionOriginFetch);
  const sourceObservations = scanExecutableFiles(
    rootDirectory,
    'src',
    SOURCE_EXECUTABLE_EXTENSIONS,
    'src',
  );
  let allowedFetchCalls = 0;
  for (const filePath of exemptedFiles) {
    allowedFetchCalls += assertExtensionOriginFetchSource(
      rootDirectory,
      filePath,
      sourceObservations,
    );
    sourceObservations.delete(fetchObservation(filePath));
  }
  for (const observation of sourceObservations) {
    assert(false, `Forbidden product-data transport identifier: ${observation}`);
  }
  const shippedObservations = scanExecutableFiles(
    rootDirectory,
    'dist',
    SHIPPED_EXECUTABLE_EXTENSIONS,
    'dist',
  );
  assertShippedFetchStaysLocal(rootDirectory, shippedObservations, allowedFetchCalls);
  for (const observation of shippedObservations) {
    assert(false, `Forbidden product-data transport identifier: ${observation}`);
  }
}

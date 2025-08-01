import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { JSDOM } from 'jsdom';
import { inspectExecutableSource, isRemoteUrl } from './executable-analysis.mjs';
import { assert, walkRegularFiles } from './files.mjs';

const SOURCE_EXECUTABLE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const SHIPPED_EXECUTABLE_EXTENSIONS = new Set(['.cjs', '.htm', '.html', '.js', '.mjs']);

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

export function validateTransportPolicy(rootDirectory, submission) {
  validateTransportAllowlist(submission.transportAllowlist);
  const observed = new Set([
    ...scanExecutableFiles(rootDirectory, 'src', SOURCE_EXECUTABLE_EXTENSIONS, 'src'),
    ...scanExecutableFiles(rootDirectory, 'dist', SHIPPED_EXECUTABLE_EXTENSIONS, 'dist'),
  ]);
  for (const observation of observed) {
    assert(false, `Forbidden product-data transport identifier: ${observation}`);
  }
}

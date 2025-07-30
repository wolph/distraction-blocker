import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { JSDOM } from 'jsdom';
import {
  assert,
  assertString,
  objectKeysAre,
  validateRelativePath,
  walkRegularFiles,
} from './files.mjs';

const TRANSPORT_IDENTIFIERS = new Set([
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'sendBeacon',
]);
const COMPUTED_TRANSPORT_RECEIVERS = new Set(['globalThis', 'window', 'self', 'navigator']);
const SOURCE_EXECUTABLE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const SHIPPED_EXECUTABLE_EXTENSIONS = new Set(['.cjs', '.htm', '.html', '.js', '.mjs']);

export function validateTransportAllowlist(value) {
  assert(Array.isArray(value), 'transportAllowlist must be an array');
  const seen = new Set();
  for (const entry of value) {
    objectKeysAre(entry, ['file', 'identifier', 'justification'], [], 'transportAllowlist entry');
    validateRelativePath(entry.file, 'transportAllowlist file');
    assert(
      entry.file.startsWith('src/') || entry.file.startsWith('dist/'),
      `transportAllowlist file must be in src or dist: ${entry.file}`,
    );
    assert(
      TRANSPORT_IDENTIFIERS.has(entry.identifier),
      `transportAllowlist identifier is invalid: ${entry.identifier}`,
    );
    assertString(entry.justification, 'transportAllowlist justification');
    const key = `${entry.file}:${entry.identifier}`;
    assert(!seen.has(key), `Duplicate transportAllowlist entry: ${key}`);
    seen.add(key);
  }
  return seen;
}

function remoteUrl(value) {
  return typeof value === 'string' && /^(?:(?:https?|wss?):)?\/\//iu.test(value);
}

function isEscaped(characters, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && characters[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
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
    assert(!remoteUrl(path), `Remote executable code URL is forbidden: ${path}`);
  }
}

function startQuotedRegion(context, index, state) {
  context.output[index] = ' ';
  context.stringStart = index;
  context.state = state;
}

function maskCodeCharacter(context, index) {
  const character = context.characters[index];
  const next = context.characters[index + 1];
  if (character === '/' && next === '/' && !isEscaped(context.characters, index)) {
    context.output[index] = ' ';
    context.output[index + 1] = ' ';
    context.state = 'line-comment';
    return index + 1;
  }
  if (character === '/' && next === '*' && !isEscaped(context.characters, index)) {
    context.output[index] = ' ';
    context.output[index + 1] = ' ';
    context.state = 'block-comment';
    return index + 1;
  }
  if (character === "'") startQuotedRegion(context, index, 'single-quote');
  else if (character === '"') startQuotedRegion(context, index, 'double-quote');
  else if (character === '`') {
    context.output[index] = ' ';
    context.templates.push({ start: index });
    context.state = 'template';
  } else if (context.interpolations.length > 0 && character === '{') {
    context.interpolations[context.interpolations.length - 1].depth += 1;
  } else if (context.interpolations.length > 0 && character === '}') {
    const interpolation = context.interpolations[context.interpolations.length - 1];
    if (interpolation.depth > 0) interpolation.depth -= 1;
    else {
      context.output[index] = ' ';
      context.interpolations.pop();
      context.state = 'template';
    }
  }
  return index;
}

function closeQuotedRegion(context, index) {
  if (context.retainRemoteUrls) {
    retainRemoteUrlMarker(context.output, context.characters, context.stringStart, index);
  } else {
    retainTransportPropertyMarker(context.output, context.characters, context.stringStart, index);
  }
  context.stringStart = -1;
  context.state = 'code';
}

function maskNonCodeCharacter(context, index) {
  const character = context.characters[index];
  const next = context.characters[index + 1];
  if (character !== '\n' && character !== '\r') context.output[index] = ' ';
  if (context.state === 'line-comment' && (character === '\n' || character === '\r')) {
    context.state = 'code';
  } else if (context.state === 'block-comment' && character === '*' && next === '/') {
    context.output[index + 1] = ' ';
    context.state = 'code';
    return index + 1;
  } else if (
    context.state === 'template' &&
    character === '$' &&
    next === '{' &&
    !isEscaped(context.characters, index)
  ) {
    context.output[index + 1] = ' ';
    context.interpolations.push({ depth: 0 });
    context.state = 'code';
    return index + 1;
  } else if (
    ((context.state === 'single-quote' && character === "'") ||
      (context.state === 'double-quote' && character === '"')) &&
    !isEscaped(context.characters, index)
  ) {
    closeQuotedRegion(context, index);
  } else if (
    context.state === 'template' &&
    character === '`' &&
    !isEscaped(context.characters, index)
  ) {
    const template = context.templates.pop();
    if (context.retainRemoteUrls) {
      retainRemoteUrlMarker(context.output, context.characters, template.start, index);
    }
    context.state = 'code';
  }
  return index;
}

function maskedJavaScript(source, retainRemoteUrls) {
  const context = {
    characters: [...source],
    output: [...source],
    state: 'code',
    stringStart: -1,
    templates: [],
    interpolations: [],
    retainRemoteUrls,
  };
  for (let index = 0; index < context.characters.length; index += 1) {
    index =
      context.state === 'code'
        ? maskCodeCharacter(context, index)
        : maskNonCodeCharacter(context, index);
  }
  return context.output.join('');
}

function retainRemoteUrlMarker(output, characters, start, end) {
  const contents = characters.slice(start + 1, end).join('');
  if (!/^(?:(?:https?|wss?):)?\/\//iu.test(contents)) return;
  const marker = 'REMOTE';
  for (let offset = 0; offset < marker.length; offset += 1) {
    output[start + offset] = marker[offset];
  }
}

function retainTransportPropertyMarker(output, characters, start, end) {
  const contents = characters.slice(start + 1, end).join('');
  if (!TRANSPORT_IDENTIFIERS.has(contents)) return;
  let previous = start - 1;
  while (previous >= 0 && /\s/u.test(characters[previous])) previous -= 1;
  if (characters[previous] !== '[') return;
  previous -= 1;
  while (previous >= 0 && /\s/u.test(characters[previous])) previous -= 1;
  const receiverEnd = previous + 1;
  while (previous >= 0 && /[$A-Z_a-z0-9]/u.test(characters[previous])) previous -= 1;
  const receiver = characters.slice(previous + 1, receiverEnd).join('');
  if (!COMPUTED_TRANSPORT_RECEIVERS.has(receiver)) return;
  for (let offset = 0; offset < contents.length; offset += 1) {
    output[start + offset] = contents[offset];
  }
}

function containsRemoteExecutableCode(source) {
  return /(?:\bimport\s*(?:\(\s*|[^;\n]*?\bfrom\s*)?|\bexport[^;\n]*?\bfrom\s*|\bimportScripts\s*\(|\bnew\s+(?:Shared)?Worker\s*\()\s*REMOTE\b/iu.test(
    maskedJavaScript(source, true),
  );
}

function inspectJavaScript(source, filePath) {
  assert(
    !containsRemoteExecutableCode(source),
    `Remote executable code URL is forbidden in ${filePath}`,
  );
  const executableText = maskedJavaScript(source, false);
  const observations = new Set();
  for (const identifier of TRANSPORT_IDENTIFIERS) {
    const pattern = new RegExp(`\\b${identifier}\\b`, 'u');
    if (pattern.test(executableText)) observations.add(`${filePath}:${identifier}`);
  }
  return observations;
}

function inspectHtml(source, filePath) {
  const observations = new Set();
  const document = new JSDOM(source).window.document;
  for (const script of document.querySelectorAll('script')) {
    assert(
      !remoteUrl(script.src),
      `Remote executable code URL is forbidden in ${filePath}: ${script.src}`,
    );
    if (!script.hasAttribute('src')) {
      for (const observation of inspectJavaScript(script.textContent ?? '', filePath)) {
        observations.add(observation);
      }
    }
  }
  for (const link of document.querySelectorAll('link[rel="modulepreload"]')) {
    const href = link.getAttribute('href');
    assert(!remoteUrl(href), `Remote executable code URL is forbidden in ${filePath}: ${href}`);
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
      : inspectJavaScript(source, filePath);
    for (const observation of found) observations.add(observation);
  }
  return observations;
}

export function validateTransportPolicy(rootDirectory, submission) {
  const allowed = validateTransportAllowlist(submission.transportAllowlist);
  const observed = new Set([
    ...scanExecutableFiles(rootDirectory, 'src', SOURCE_EXECUTABLE_EXTENSIONS, 'src'),
    ...scanExecutableFiles(rootDirectory, 'dist', SHIPPED_EXECUTABLE_EXTENSIONS, 'dist'),
  ]);
  for (const observation of observed) {
    assert(
      allowed.has(observation),
      `Unreviewed product-data transport identifier: ${observation}`,
    );
  }
  for (const entry of allowed) {
    assert(observed.has(entry), `Stale transportAllowlist entry was not observed: ${entry}`);
  }
}

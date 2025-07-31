import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parse } from '@babel/parser';
import { JSDOM } from 'jsdom';
import { assert, walkRegularFiles } from './files.mjs';

const TRANSPORT_IDENTIFIERS = new Set([
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'sendBeacon',
]);
const COMPUTED_TRANSPORT_RECEIVERS = new Set(['globalThis', 'window', 'self', 'navigator']);
const REMOTE_WORKER_CONSTRUCTORS = new Set(['Worker', 'SharedWorker']);
const SOURCE_EXECUTABLE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const SHIPPED_EXECUTABLE_EXTENSIONS = new Set(['.cjs', '.htm', '.html', '.js', '.mjs']);

export function validateTransportAllowlist(value) {
  assert(Array.isArray(value), 'transportAllowlist must be an array');
  assert(
    value.length === 0,
    'transportAllowlist must remain empty because product-data transport is forbidden',
  );
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
  retainTransportPropertyMarker(context.output, context.characters, context.stringStart, index);
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
    context.state = 'code';
  }
  return index;
}

function maskedJavaScript(source) {
  const context = {
    characters: [...source],
    output: [...source],
    state: 'code',
    stringStart: -1,
    interpolations: [],
  };
  for (let index = 0; index < context.characters.length; index += 1) {
    index =
      context.state === 'code'
        ? maskCodeCharacter(context, index)
        : maskNonCodeCharacter(context, index);
  }
  return context.output.join('');
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

function parserPlugins(filePath) {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.tsx') return ['typescript', 'jsx'];
  if (extension === '.ts') return ['typescript'];
  if (extension === '.jsx') return ['jsx'];
  return [];
}

function parseExecutableSource(source, filePath) {
  try {
    return parse(source, {
      sourceType: 'unambiguous',
      sourceFilename: filePath,
      plugins: parserPlugins(filePath),
    }).program;
  } catch (error) {
    throw new Error(
      `Could not inspect executable source ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function visitAst(node, visitor) {
  visitor(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child !== null && typeof child === 'object' && typeof child.type === 'string') {
          visitAst(child, visitor);
        }
      }
    } else if (value !== null && typeof value === 'object' && typeof value.type === 'string') {
      visitAst(value, visitor);
    }
  }
}

function unwrapExpression(node) {
  let current = node;
  while (
    ['TSAsExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'TSNonNullExpression'].includes(
      current?.type,
    )
  ) {
    current = current.expression;
  }
  return current;
}

function remoteReference(node, remoteConstants) {
  const expression = unwrapExpression(node);
  if (expression?.type === 'StringLiteral' && remoteUrl(expression.value)) return expression.value;
  if (expression?.type === 'TemplateLiteral') {
    const prefix = expression.quasis[0]?.value?.cooked ?? expression.quasis[0]?.value?.raw;
    if (remoteUrl(prefix)) return prefix;
  }
  if (expression?.type === 'Identifier' && remoteConstants.has(expression.name)) {
    return expression.name;
  }
  return null;
}

function collectRemoteConstants(program) {
  const initializers = new Map();
  visitAst(program, (node) => {
    if (node.type !== 'VariableDeclaration' || node.kind !== 'const') return;
    for (const declaration of node.declarations) {
      if (declaration.id?.type === 'Identifier' && declaration.init !== null) {
        initializers.set(declaration.id.name, declaration.init);
      }
    }
  });
  const remoteConstants = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, initializer] of initializers) {
      if (remoteConstants.has(name) || remoteReference(initializer, remoteConstants) === null)
        continue;
      remoteConstants.add(name);
      changed = true;
    }
  }
  return remoteConstants;
}

function remoteExecutableReference(node, remoteConstants) {
  if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type)) {
    return remoteReference(node.source, remoteConstants);
  }
  if (node.type === 'ImportExpression') return remoteReference(node.source, remoteConstants);
  if (
    node.type === 'CallExpression' &&
    (node.callee?.type === 'Import' ||
      (node.callee?.type === 'Identifier' && node.callee.name === 'importScripts'))
  ) {
    return remoteReference(node.arguments[0], remoteConstants);
  }
  if (
    node.type === 'NewExpression' &&
    node.callee?.type === 'Identifier' &&
    REMOTE_WORKER_CONSTRUCTORS.has(node.callee.name)
  ) {
    return remoteReference(node.arguments[0], remoteConstants);
  }
  return null;
}

function findRemoteExecutableReference(source, filePath) {
  const program = parseExecutableSource(source, filePath);
  const remoteConstants = collectRemoteConstants(program);
  let reference = null;
  visitAst(program, (node) => {
    if (reference === null) reference = remoteExecutableReference(node, remoteConstants);
  });
  return reference;
}

function inspectJavaScript(source, filePath) {
  const remoteReference = findRemoteExecutableReference(source, filePath);
  assert(
    remoteReference === null,
    `Remote executable code URL is forbidden in ${filePath}: ${remoteReference}`,
  );
  const executableText = maskedJavaScript(source);
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
  validateTransportAllowlist(submission.transportAllowlist);
  const observed = new Set([
    ...scanExecutableFiles(rootDirectory, 'src', SOURCE_EXECUTABLE_EXTENSIONS, 'src'),
    ...scanExecutableFiles(rootDirectory, 'dist', SHIPPED_EXECUTABLE_EXTENSIONS, 'dist'),
  ]);
  for (const observation of observed) {
    assert(false, `Forbidden product-data transport identifier: ${observation}`);
  }
}

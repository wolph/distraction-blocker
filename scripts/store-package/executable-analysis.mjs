import { extname } from 'node:path';
import { parse } from '@babel/parser';
import traversePackage from '@babel/traverse';

const traverse = traversePackage.default ?? traversePackage;
const TRANSPORT_IDENTIFIERS = new Set([
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'sendBeacon',
]);
const WORKER_CONSTRUCTORS = new Set(['Worker', 'SharedWorker']);
const IMPORT_SCRIPTS = new Set(['importScripts']);
const URL_CONSTRUCTOR = new Set(['URL']);
const EXPRESSION_WRAPPERS = new Set([
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
]);

export function isRemoteUrl(value) {
  return typeof value === 'string' && /^(?:(?:https?|wss?):)?\/\//iu.test(value);
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
    });
  } catch (error) {
    throw new Error(
      `Could not inspect executable source ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function unwrapPath(path) {
  let current = path;
  while (current?.node && EXPRESSION_WRAPPERS.has(current.node.type)) {
    current = current.get('expression');
  }
  return current;
}

function staticPropertyName(memberPath) {
  const propertyPath = memberPath.get('property');
  if (!memberPath.node.computed && propertyPath.isIdentifier()) return propertyPath.node.name;
  if (propertyPath.isStringLiteral()) return propertyPath.node.value;
  if (propertyPath.isTemplateLiteral() && propertyPath.node.expressions.length === 0) {
    return (
      propertyPath.node.quasis[0]?.value.cooked ?? propertyPath.node.quasis[0]?.value.raw ?? null
    );
  }
  return null;
}

function destructuredPropertyName(binding, localName) {
  const patternPath = binding.path.get('id');
  if (!patternPath.isObjectPattern()) return null;
  for (const propertyPath of patternPath.get('properties')) {
    if (!propertyPath.isObjectProperty()) continue;
    let valuePath = propertyPath.get('value');
    if (valuePath.isAssignmentPattern()) valuePath = valuePath.get('left');
    if (!valuePath.isIdentifier({ name: localName })) continue;
    const keyPath = propertyPath.get('key');
    if (!propertyPath.node.computed && keyPath.isIdentifier()) return keyPath.node.name;
    if (keyPath.isStringLiteral()) return keyPath.node.value;
    if (keyPath.isTemplateLiteral() && keyPath.node.expressions.length === 0) {
      return keyPath.node.quasis[0]?.value.cooked ?? keyPath.node.quasis[0]?.value.raw ?? null;
    }
    return null;
  }
  return null;
}

function callableName(path, names, seenBindings = new Set()) {
  const current = unwrapPath(path);
  if (!current?.node) return null;
  if (current.isIdentifier()) {
    const { name } = current.node;
    const binding = current.scope.getBinding(name);
    if (!binding) return names.has(name) ? name : null;
    if (seenBindings.has(binding) || !binding.constant || !binding.path.isVariableDeclarator()) {
      return null;
    }
    const destructuredName = destructuredPropertyName(binding, name);
    if (binding.path.get('id').isObjectPattern()) {
      return destructuredName !== null && names.has(destructuredName) ? destructuredName : null;
    }
    const initializer = binding.path.get('init');
    if (!initializer?.node) return null;
    const nextSeen = new Set(seenBindings);
    nextSeen.add(binding);
    return callableName(initializer, names, nextSeen);
  }
  if (current.isMemberExpression() || current.isOptionalMemberExpression()) {
    // A called or constructed static transport member is forbidden regardless of its receiver.
    // Reading the same member without invoking it remains harmless.
    const propertyName = staticPropertyName(current);
    return propertyName !== null && names.has(propertyName) ? propertyName : null;
  }
  return null;
}

function classifyString(value, detail) {
  if (isRemoteUrl(value)) return { kind: 'remote', detail };
  if (value.length === 0 || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) {
    return { kind: 'unknown', detail };
  }
  return { kind: 'local', detail };
}

function isImportMetaUrl(path) {
  const current = unwrapPath(path);
  if (!current?.isMemberExpression() || current.node.computed) return false;
  const objectPath = current.get('object');
  const propertyPath = current.get('property');
  return (
    objectPath.isMetaProperty() &&
    objectPath.node.meta.name === 'import' &&
    objectPath.node.property.name === 'meta' &&
    propertyPath.isIdentifier({ name: 'url' })
  );
}

function classifyUrlConstructor(path, seenBindings) {
  const calleePath = path.get('callee');
  if (callableName(calleePath, URL_CONSTRUCTOR) !== 'URL') {
    return { kind: 'unknown', detail: 'URL constructor' };
  }
  const argumentsPaths = path.get('arguments');
  const resource = classifyExecutableOperand(argumentsPaths[0], seenBindings);
  if (resource.kind !== 'local') return resource;
  const base = argumentsPaths[1];
  if (!base?.node) return { kind: 'unknown', detail: 'URL base' };
  if (isImportMetaUrl(base)) return { kind: 'local', detail: resource.detail };
  const baseClassification = classifyExecutableOperand(base, seenBindings);
  if (baseClassification.kind === 'remote') return baseClassification;
  return { kind: 'unknown', detail: 'URL base' };
}

function classifyExecutableOperand(path, seenBindings = new Set()) {
  const current = unwrapPath(path);
  if (!current?.node || current.isSpreadElement()) {
    return { kind: 'unknown', detail: 'missing or spread operand' };
  }
  if (current.isStringLiteral()) return classifyString(current.node.value, current.node.value);
  if (current.isTemplateLiteral()) {
    const prefix = current.node.quasis[0]?.value.cooked ?? current.node.quasis[0]?.value.raw ?? '';
    if (current.node.expressions.length === 0) return classifyString(prefix, prefix);
    return isRemoteUrl(prefix)
      ? { kind: 'remote', detail: prefix }
      : { kind: 'unknown', detail: 'interpolated template literal' };
  }
  if (current.isIdentifier()) {
    const { name } = current.node;
    const binding = current.scope.getBinding(name);
    if (
      binding?.kind !== 'const' ||
      !binding.constant ||
      seenBindings.has(binding) ||
      !binding.path.isVariableDeclarator()
    ) {
      return { kind: 'unknown', detail: name };
    }
    const initializer = binding.path.get('init');
    if (!initializer?.node) return { kind: 'unknown', detail: name };
    const nextSeen = new Set(seenBindings);
    nextSeen.add(binding);
    const classification = classifyExecutableOperand(initializer, nextSeen);
    return { ...classification, detail: name };
  }
  if (current.isNewExpression()) return classifyUrlConstructor(current, seenBindings);
  return { kind: 'unknown', detail: current.node.type };
}

function validateExecutableOperand(path, filePath, sink) {
  const classification = classifyExecutableOperand(path);
  if (classification.kind === 'local') return;
  if (classification.kind === 'remote') {
    throw new Error(
      `Remote executable code URL is forbidden in ${filePath} for ${sink}: ${classification.detail}`,
    );
  }
  throw new Error(
    `Unverifiable executable operand is forbidden in ${filePath} for ${sink}: ${classification.detail}`,
  );
}

function inspectCall(path, filePath, observations) {
  const calleePath = path.get('callee');
  if (calleePath.node?.type === 'Import') {
    validateExecutableOperand(path.get('arguments')[0], filePath, 'dynamic import');
    return;
  }
  const importScriptsName = callableName(calleePath, IMPORT_SCRIPTS);
  if (importScriptsName !== null) {
    const argumentPaths = path.get('arguments');
    if (argumentPaths.length === 0) {
      validateExecutableOperand(undefined, filePath, importScriptsName);
    }
    for (const argumentPath of argumentPaths) {
      validateExecutableOperand(argumentPath, filePath, importScriptsName);
    }
    return;
  }
  const transportName = callableName(calleePath, TRANSPORT_IDENTIFIERS);
  if (transportName !== null) observations.add(`${filePath}:${transportName}`);
}

function inspectConstructor(path, filePath, observations) {
  const calleePath = path.get('callee');
  const workerName = callableName(calleePath, WORKER_CONSTRUCTORS);
  if (workerName !== null) {
    validateExecutableOperand(path.get('arguments')[0], filePath, workerName);
    return;
  }
  const transportName = callableName(calleePath, TRANSPORT_IDENTIFIERS);
  if (transportName !== null) observations.add(`${filePath}:${transportName}`);
}

export function inspectExecutableSource(source, filePath) {
  const ast = parseExecutableSource(source, filePath);
  const observations = new Set();
  traverse(ast, {
    enter(path) {
      if (
        path.isImportDeclaration() ||
        path.isExportAllDeclaration() ||
        (path.isExportNamedDeclaration() && path.node.source !== null)
      ) {
        validateExecutableOperand(path.get('source'), filePath, 'static module import');
      } else if (path.node.type === 'ImportExpression') {
        validateExecutableOperand(path.get('source'), filePath, 'dynamic import');
      } else if (path.isCallExpression() || path.isOptionalCallExpression()) {
        inspectCall(path, filePath, observations);
      } else if (path.isNewExpression()) {
        inspectConstructor(path, filePath, observations);
      }
    },
  });
  return observations;
}

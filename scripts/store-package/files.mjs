import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function objectKeysAre(value, requiredKeys, optionalKeys, label) {
  assert(isObject(value), `${label} must be an object`);
  const keys = Object.keys(value);
  for (const key of requiredKeys) assert(keys.includes(key), `${label} is missing ${key}`);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const extras = keys.filter((key) => !allowed.has(key));
  assert(extras.length === 0, `${label} has extra keys: ${extras.join(', ')}`);
}

export function assertString(value, label) {
  assert(typeof value === 'string' && value.length > 0, `${label} must be a non-empty string`);
}

export function assertStringArray(value, label) {
  assert(Array.isArray(value), `${label} must be an array`);
  for (const entry of value) assertString(entry, `${label} entry`);
}

function isInside(path, directory) {
  return path === directory || path.startsWith(`${directory}${sep}`);
}

export function validateRelativePath(relativePath, label) {
  assertString(relativePath, label);
  assert(!isAbsolute(relativePath), `${label} must be a relative path: ${relativePath}`);
  assert(!relativePath.includes('\\'), `${label} must use forward slashes: ${relativePath}`);
  assert(!relativePath.includes('\0'), `${label} contains a null byte`);
  const components = relativePath.split('/');
  assert(
    components.every((component) => component !== '' && component !== '.' && component !== '..'),
    `${label} contains an unsafe path component: ${relativePath}`,
  );
}

function inspectRequiredPath(rootDirectory, relativePath, label) {
  validateRelativePath(relativePath, label);
  const rootRealPath = realpathSync(rootDirectory);
  const components = relativePath.split('/');
  let absolutePath = rootDirectory;
  for (const [index, component] of components.entries()) {
    absolutePath = join(absolutePath, component);
    assert(existsSync(absolutePath), `Missing required ${label}: ${relativePath}`);
    const stat = lstatSync(absolutePath);
    assert(!stat.isSymbolicLink(), `${label} must not be a symbolic link: ${relativePath}`);
    assert(
      isInside(realpathSync(absolutePath), rootRealPath),
      `${label} resolves outside the project root: ${relativePath}`,
    );
    if (index < components.length - 1) {
      assert(stat.isDirectory(), `${label} ancestor is not a directory: ${relativePath}`);
    }
  }
  return { absolutePath, stat: lstatSync(absolutePath) };
}

export function readRequiredFile(rootDirectory, relativePath, label = 'file') {
  const { absolutePath, stat } = inspectRequiredPath(rootDirectory, relativePath, label);
  assert(stat.isFile(), `${label} is not a regular file: ${relativePath}`);
  assert(stat.nlink === 1, `${label} must not be a hard link: ${relativePath}`);
  return readFileSync(absolutePath);
}

export function readJson(rootDirectory, relativePath, label) {
  const buffer = readRequiredFile(rootDirectory, relativePath, label);
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new Error(
      `Invalid ${label} JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function forbiddenDistPath(relativePath) {
  const lowerPath = relativePath.toLowerCase();
  const pathBase = basename(lowerPath);
  return (
    lowerPath.startsWith('store/assets/') ||
    lowerPath.split('/').some((component) => component.startsWith('.env')) ||
    ['.key', '.map', '.pem'].includes(extname(lowerPath)) ||
    /(^|\/)(__tests__|tests?)(\/|$)/u.test(lowerPath) ||
    /\.(spec|test)\.[^.]+$/u.test(pathBase)
  );
}

export function walkRegularFiles(rootDirectory, relativeDirectory, forbiddenCheck = null) {
  const directory = resolve(rootDirectory, relativeDirectory);
  const directoryStat = lstatSync(directory);
  assert(
    !directoryStat.isSymbolicLink(),
    `Directory must not be a symbolic link: ${relativeDirectory}`,
  );
  assert(
    directoryStat.isDirectory(),
    `Required directory is not a directory: ${relativeDirectory}`,
  );
  const rootRealPath = realpathSync(directory);
  const files = new Map();

  function visit(currentDirectory) {
    for (const entry of readdirSync(currentDirectory).sort()) {
      const entryPath = join(currentDirectory, entry);
      const relativePath = relative(directory, entryPath).split(sep).join('/');
      const stat = lstatSync(entryPath);
      assert(
        !stat.isSymbolicLink(),
        `Path must not be a symbolic link: ${relativeDirectory}/${relativePath}`,
      );
      assert(
        isInside(realpathSync(entryPath), rootRealPath),
        `Path resolves outside ${relativeDirectory}: ${relativePath}`,
      );
      if (stat.isDirectory()) {
        visit(entryPath);
        continue;
      }
      assert(stat.isFile(), `Path is not a regular file: ${relativeDirectory}/${relativePath}`);
      assert(
        stat.nlink === 1,
        `File must not be a hard link: ${relativeDirectory}/${relativePath}`,
      );
      assert(
        forbiddenCheck === null || !forbiddenCheck(relativePath),
        `Forbidden file in ${relativeDirectory}: ${relativePath}`,
      );
      files.set(relativePath, readFileSync(entryPath));
    }
  }

  visit(directory);
  return files;
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

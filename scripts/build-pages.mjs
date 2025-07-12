import { copyFileSync, lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const rootDirectory = realpathSync(resolve(process.cwd()));
const sourceDirectory = join(rootDirectory, 'docs', 'privacy');
const outputDirectory = join(rootDirectory, 'dist-pages');
const privacyOutputDirectory = join(outputDirectory, 'privacy');
const sourceFiles = ['index.html', 'style.css', '404.html'];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isInside(path, directory) {
  return path === directory || path.startsWith(`${directory}${sep}`);
}

function assertRealDirectoryComponents(relativeComponents) {
  let currentPath = rootDirectory;
  for (const component of relativeComponents) {
    currentPath = join(currentPath, component);
    const componentStat = lstatSync(currentPath);
    assert(
      !componentStat.isSymbolicLink(),
      `Privacy source path component must not be a symbolic link: ${currentPath}`,
    );
    assert(
      componentStat.isDirectory(),
      `Privacy source path component must be a directory: ${currentPath}`,
    );
    assert(
      isInside(realpathSync(currentPath), rootDirectory),
      `Privacy source path component resolves outside the project root: ${currentPath}`,
    );
  }
}

function assertRegularSource(filename, sourceRealPath) {
  const sourcePath = join(sourceDirectory, filename);
  const sourceStat = lstatSync(sourcePath);
  assert(!sourceStat.isSymbolicLink(), `Privacy source must not be a symbolic link: ${sourcePath}`);
  assert(sourceStat.isFile(), `Privacy source must be a regular file: ${sourcePath}`);
  assert(sourceStat.nlink === 1, `Privacy source must not be a hard link: ${sourcePath}`);
  assert(
    isInside(realpathSync(sourcePath), sourceRealPath),
    `Privacy source resolves outside docs/privacy: ${sourcePath}`,
  );
  assert(
    isInside(realpathSync(sourcePath), rootDirectory),
    `Privacy source resolves outside the project root: ${sourcePath}`,
  );
}

assertRealDirectoryComponents(['docs', 'privacy']);
const sourceRealPath = realpathSync(sourceDirectory);

for (const filename of sourceFiles) assertRegularSource(filename, sourceRealPath);

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(privacyOutputDirectory, { recursive: true });

for (const filename of sourceFiles) {
  copyFileSync(join(sourceDirectory, filename), join(privacyOutputDirectory, filename));
}

copyFileSync(join(sourceDirectory, '404.html'), join(outputDirectory, '404.html'));

const outputRealPath = realpathSync(outputDirectory);
for (const relativePath of [
  '404.html',
  'privacy/404.html',
  'privacy/index.html',
  'privacy/style.css',
]) {
  const outputPath = join(outputDirectory, relativePath);
  const outputStat = lstatSync(outputPath);
  assert(outputStat.isFile(), `Pages output must be a regular file: ${outputPath}`);
  assert(outputStat.nlink === 1, `Pages output must not be a hard link: ${outputPath}`);
  assert(
    isInside(realpathSync(outputPath), outputRealPath),
    `Pages output resolves outside dist-pages: ${outputPath}`,
  );
}

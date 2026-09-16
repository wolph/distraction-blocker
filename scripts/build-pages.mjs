import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const rootDirectory = realpathSync(resolve(process.cwd()));
const sourceDirectory = join(rootDirectory, 'docs', 'privacy');
const tourImageSourceDirectory = join(rootDirectory, 'docs', 'images', 'focus-lock', 'readme');
// The real-build unit test points this at an isolated temp directory with PAGES_OUTPUT_DIR, so a
// concurrently running e2e build (which also writes dist-pages) cannot empty this one out from
// under it. validate-pages.mjs honours the same override.
const outputDirectory = process.env.PAGES_OUTPUT_DIR
  ? resolve(process.env.PAGES_OUTPUT_DIR)
  : join(rootDirectory, 'dist-pages');
const privacyOutputDirectory = join(outputDirectory, 'privacy');
const tourImageOutputDirectory = join(outputDirectory, 'images');
const sourceFiles = ['index.html', 'style.css', '404.html'];
// The three README product-tour screenshots, copied from the one place the README itself reads
// them (docs/images/focus-lock/readme/) so the site never carries a second, driftable copy.
const tourImageFiles = ['focus-session.png', 'blocked-page.png', 'progress.png'];

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

function assertRegularSource(directory, filename, sourceRealPath) {
  const sourcePath = join(directory, filename);
  const sourceStat = lstatSync(sourcePath);
  assert(!sourceStat.isSymbolicLink(), `Source must not be a symbolic link: ${sourcePath}`);
  assert(sourceStat.isFile(), `Source must be a regular file: ${sourcePath}`);
  assert(sourceStat.nlink === 1, `Source must not be a hard link: ${sourcePath}`);
  assert(
    isInside(realpathSync(sourcePath), sourceRealPath),
    `Source resolves outside its directory: ${sourcePath}`,
  );
  assert(
    isInside(realpathSync(sourcePath), rootDirectory),
    `Source resolves outside the project root: ${sourcePath}`,
  );
}

function assertRegularOutput(outputPath, outputRealPath) {
  const outputStat = lstatSync(outputPath);
  assert(outputStat.isFile(), `Pages output must be a regular file: ${outputPath}`);
  assert(outputStat.nlink === 1, `Pages output must not be a hard link: ${outputPath}`);
  assert(
    isInside(realpathSync(outputPath), outputRealPath),
    `Pages output resolves outside dist-pages: ${outputPath}`,
  );
}

assertRealDirectoryComponents(['docs', 'privacy']);
const sourceRealPath = realpathSync(sourceDirectory);

for (const filename of sourceFiles) assertRegularSource(sourceDirectory, filename, sourceRealPath);

assertRealDirectoryComponents(['docs', 'images', 'focus-lock', 'readme']);
const tourImageSourceRealPath = realpathSync(tourImageSourceDirectory);

for (const filename of tourImageFiles)
  assertRegularSource(tourImageSourceDirectory, filename, tourImageSourceRealPath);

assert(
  existsSync(outputDirectory),
  `Run the Vite pages build before build-pages.mjs: ${outputDirectory} is missing`,
);
mkdirSync(privacyOutputDirectory, { recursive: true });
mkdirSync(tourImageOutputDirectory, { recursive: true });

for (const filename of sourceFiles) {
  copyFileSync(join(sourceDirectory, filename), join(privacyOutputDirectory, filename));
}

for (const filename of tourImageFiles) {
  copyFileSync(join(tourImageSourceDirectory, filename), join(tourImageOutputDirectory, filename));
}

copyFileSync(join(sourceDirectory, '404.html'), join(outputDirectory, '404.html'));

const outputRealPath = realpathSync(outputDirectory);
for (const relativePath of [
  '404.html',
  'privacy/404.html',
  'privacy/index.html',
  'privacy/style.css',
]) {
  assertRegularOutput(join(outputDirectory, relativePath), outputRealPath);
}
for (const filename of tourImageFiles) {
  assertRegularOutput(join(tourImageOutputDirectory, filename), outputRealPath);
}

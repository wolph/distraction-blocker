import { spawnSync } from 'node:child_process';
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const fixtures: string[] = [];
const BUILD_SCRIPT_PATH: string = resolve('scripts/build-pages.mjs');
const PAGE_URL_EXPRESSION: string = '$' + '{{ steps.deployment.outputs.page_url }}';
const SCRIPT_PATH: string = resolve('scripts/validate-pages.mjs');

const VALID_WORKFLOW: string = `name: Publish privacy policy

on:
  push:
    branches:
      - master
  workflow_dispatch:

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    permissions:
      contents: read
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version-file: package.json
          cache: npm
      - run: npm ci
      - run: npm run pages:validate
      - uses: actions/configure-pages@v6
      - uses: actions/upload-pages-artifact@v5
        with:
          path: dist-pages
  deploy:
    needs: build
    permissions:
      pages: write
      id-token: write
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    outputs:
      page_url: \${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - id: deployment
        uses: actions/deploy-pages@v5
`;

const VALID_PRIVACY_HTML: string = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="canonical" href="https://wolph.github.io/distraction-blocker/privacy/">
    <link rel="stylesheet" href="./style.css">
    <title>Focus Lock Privacy Policy</title>
  </head>
  <body>
    <a class="skip-link" href="#details">Skip to privacy details</a>
    <main id="details">
      <h1>Focus Lock Privacy</h1>
      <p>Policy text uses plain punctuation.</p>
      <a href="https://github.com/wolph/distraction-blocker">https://github.com/wolph/distraction-blocker</a>
    </main>
  </body>
</html>
`;

const VALID_NOT_FOUND_HTML: string = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="/distraction-blocker/privacy/style.css">
    <title>Focus Lock Privacy - Page not found</title>
  </head>
  <body>
    <main>
      <h1>Page not found</h1>
      <a href="/distraction-blocker/privacy/">Read the Focus Lock privacy policy</a>
    </main>
  </body>
</html>
`;

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function fixture(): string {
  const path: string = mkdtempSync(join(tmpdir(), 'focus-lock-pages-'));
  fixtures.push(path);
  write(join(path, '.github', 'workflows', 'pages.yml'), VALID_WORKFLOW);
  write(join(path, 'dist-pages', 'privacy', 'index.html'), VALID_PRIVACY_HTML);
  write(
    join(path, 'dist-pages', 'privacy', 'style.css'),
    '.skip-link { transform: translateY(-180%); }\n.skip-link:focus { transform: translateY(0); }\n',
  );
  write(join(path, 'dist-pages', 'privacy', '404.html'), VALID_NOT_FOUND_HTML);
  write(join(path, 'dist-pages', '404.html'), VALID_NOT_FOUND_HTML);
  return path;
}

function sourceFixture(): string {
  const path: string = mkdtempSync(join(tmpdir(), 'focus-lock-pages-source-'));
  fixtures.push(path);
  write(join(path, 'docs', 'privacy', 'index.html'), VALID_PRIVACY_HTML);
  write(
    join(path, 'docs', 'privacy', 'style.css'),
    '.skip-link { transform: translateY(-180%); }\n.skip-link:focus { transform: translateY(0); }\n',
  );
  write(join(path, 'docs', 'privacy', '404.html'), VALID_NOT_FOUND_HTML);
  return path;
}

function build(cwd: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [BUILD_SCRIPT_PATH], { cwd, encoding: 'utf8' });
}

function validate(cwd: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [SCRIPT_PATH], { cwd, encoding: 'utf8' });
}

function expectValidationFailure(path: string, message: RegExp): void {
  const result: ReturnType<typeof spawnSync> = validate(path);
  expect(result.status).not.toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toMatch(message);
}

function expectBuildFailure(path: string, message: RegExp): void {
  const result: ReturnType<typeof spawnSync> = build(path);
  expect(result.status).not.toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toMatch(message);
}

afterEach((): void => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('Pages validation', () => {
  it('accepts the release workflow and staged site', (): void => {
    const result: ReturnType<typeof spawnSync> = validate(fixture());
    expect(result.status, String(result.stderr)).toBe(0);
  });

  it('rejects invalid workflow YAML', (): void => {
    const path: string = fixture();
    write(join(path, '.github', 'workflows', 'pages.yml'), 'on: [push\n');
    expectValidationFailure(path, /workflow YAML/i);
  });

  it('rejects broad workflow permissions', (): void => {
    const path: string = fixture();
    const workflowPath: string = join(path, '.github', 'workflows', 'pages.yml');
    write(
      workflowPath,
      readFileSync(workflowPath, 'utf8').replace('contents: read', 'contents: write'),
    );
    expectValidationFailure(path, /permissions/i);
  });

  it('rejects an arbitrary command in the privileged deploy job', (): void => {
    const path: string = fixture();
    const workflowPath: string = join(path, '.github', 'workflows', 'pages.yml');
    write(
      workflowPath,
      readFileSync(workflowPath, 'utf8').replace(
        '    steps:\n      - id: deployment',
        '    steps:\n      - run: echo privileged\n      - id: deployment',
      ),
    );
    expectValidationFailure(path, /deploy step sequence/i);
  });

  it('rejects an extra action in the build job', (): void => {
    const path: string = fixture();
    const workflowPath: string = join(path, '.github', 'workflows', 'pages.yml');
    write(
      workflowPath,
      readFileSync(workflowPath, 'utf8').replace(
        '      - uses: actions/checkout@v7\n      - uses: actions/setup-node@v7',
        '      - uses: actions/checkout@v7\n      - uses: actions/cache@v4\n      - uses: actions/setup-node@v7',
      ),
    );
    expectValidationFailure(path, /build step sequence/i);
  });

  it('rejects a wrong build runner', (): void => {
    const path: string = fixture();
    const workflowPath: string = join(path, '.github', 'workflows', 'pages.yml');
    write(
      workflowPath,
      readFileSync(workflowPath, 'utf8').replace('runs-on: ubuntu-latest', 'runs-on: macos-latest'),
    );
    expectValidationFailure(path, /build runner/i);
  });

  it('rejects a deploy job that does not need build', (): void => {
    const path: string = fixture();
    const workflowPath: string = join(path, '.github', 'workflows', 'pages.yml');
    write(workflowPath, readFileSync(workflowPath, 'utf8').replace('needs: build', 'needs: audit'));
    expectValidationFailure(path, /deploy.*needs.*build/i);
  });

  it('rejects reordered build steps', (): void => {
    const path: string = fixture();
    const workflowPath: string = join(path, '.github', 'workflows', 'pages.yml');
    write(
      workflowPath,
      readFileSync(workflowPath, 'utf8').replace(
        '      - run: npm ci\n      - run: npm run pages:validate',
        '      - run: npm run pages:validate\n      - run: npm ci',
      ),
    );
    expectValidationFailure(path, /build step sequence/i);
  });

  it('rejects an extra workflow job', (): void => {
    const path: string = fixture();
    const workflowPath: string = join(path, '.github', 'workflows', 'pages.yml');
    write(
      workflowPath,
      `${readFileSync(workflowPath, 'utf8')}  audit:\n    runs-on: ubuntu-latest\n    steps: []\n`,
    );
    expectValidationFailure(path, /exactly build and deploy/i);
  });

  it('rejects a wrong deployment output', (): void => {
    const path: string = fixture();
    const workflowPath: string = join(path, '.github', 'workflows', 'pages.yml');
    write(
      workflowPath,
      readFileSync(workflowPath, 'utf8').replace(
        `page_url: ${PAGE_URL_EXPRESSION}`,
        `page_url: ${'$' + '{{ github.ref }}'}`,
      ),
    );
    expectValidationFailure(path, /deploy.*outputs/i);
  });

  it('rejects a flattened privacy directory', (): void => {
    const path: string = fixture();
    renameSync(
      join(path, 'dist-pages', 'privacy', 'index.html'),
      join(path, 'dist-pages', 'index.html'),
    );
    renameSync(
      join(path, 'dist-pages', 'privacy', 'style.css'),
      join(path, 'dist-pages', 'style.css'),
    );
    rmSync(join(path, 'dist-pages', 'privacy'), { recursive: true });
    expectValidationFailure(path, /dist-pages\/privacy\/index\.html/i);
  });

  it('rejects a missing root 404 page', (): void => {
    const path: string = fixture();
    rmSync(join(path, 'dist-pages', '404.html'));
    expectValidationFailure(path, /dist-pages\/404\.html/i);
  });

  it('rejects a missing privacy-scoped 404 page', (): void => {
    const path: string = fixture();
    rmSync(join(path, 'dist-pages', 'privacy', '404.html'));
    expectValidationFailure(path, /dist-pages\/privacy\/404\.html/i);
  });

  it('rejects the wrong upload path', (): void => {
    const path: string = fixture();
    const workflowPath: string = join(path, '.github', 'workflows', 'pages.yml');
    write(
      workflowPath,
      readFileSync(workflowPath, 'utf8').replace('path: dist-pages', 'path: docs'),
    );
    expectValidationFailure(path, /upload.*dist-pages/i);
  });

  it('rejects malformed staged HTML', (): void => {
    const path: string = fixture();
    const htmlPath: string = join(path, 'dist-pages', 'privacy', 'index.html');
    write(htmlPath, readFileSync(htmlPath, 'utf8').replace('<p>Policy', '<p><div>Policy'));
    expectValidationFailure(path, /HTML validation/i);
  });

  it('rejects a broken local link', (): void => {
    const path: string = fixture();
    const htmlPath: string = join(path, 'dist-pages', 'privacy', 'index.html');
    write(
      htmlPath,
      readFileSync(htmlPath, 'utf8').replace(
        '</main>',
        '<a href="./missing.html">Missing</a></main>',
      ),
    );
    expectValidationFailure(path, /broken same-site link/i);
  });

  it('rejects authored prose punctuation but ignores CSS punctuation', (): void => {
    const path: string = fixture();
    const htmlPath: string = join(path, 'dist-pages', 'privacy', 'index.html');
    write(
      htmlPath,
      readFileSync(htmlPath, 'utf8').replace('plain punctuation.', 'smart punctuation…'),
    );
    expectValidationFailure(path, /authored prose punctuation/i);
  });

  it('rejects an issue-only repository link', (): void => {
    const path: string = fixture();
    const htmlPath: string = join(path, 'dist-pages', 'privacy', 'index.html');
    write(
      htmlPath,
      readFileSync(htmlPath, 'utf8').replace(
        'https://github.com/wolph/distraction-blocker',
        'https://github.com/wolph/distraction-blocker/issues',
      ),
    );
    expectValidationFailure(path, /exact repository URL/i);
  });

  it('rejects the old privacy page title', (): void => {
    const path: string = fixture();
    const htmlPath: string = join(path, 'dist-pages', 'privacy', 'index.html');
    write(
      htmlPath,
      readFileSync(htmlPath, 'utf8').replace(
        '<title>Focus Lock Privacy Policy</title>',
        '<title>Focus Lock Privacy</title>',
      ),
    );
    expectValidationFailure(path, /exactly Focus Lock Privacy Policy/i);
  });

  it.each([
    ['script', '<script src="https://analytics.example/track.js"></script>'],
    ['iframe', '<iframe src="https://analytics.example/pixel"></iframe>'],
    ['image', '<img src="https://analytics.example/pixel.png" alt="">'],
    ['audio', '<audio src="https://analytics.example/pixel.mp3"></audio>'],
    ['video', '<video src="https://analytics.example/pixel.mp4"></video>'],
    ['object', '<object data="https://analytics.example/pixel"></object>'],
    ['embed', '<embed src="https://analytics.example/pixel">'],
    ['form', '<form action="https://analytics.example/collect"><button>Send</button></form>'],
  ])('rejects a request-producing %s element', (_name: string, element: string): void => {
    const path: string = fixture();
    const htmlPath: string = join(path, 'dist-pages', 'privacy', 'index.html');
    write(htmlPath, readFileSync(htmlPath, 'utf8').replace('</main>', `${element}</main>`));
    expectValidationFailure(path, /request-producing/i);
  });

  it('rejects an external stylesheet resource', (): void => {
    const path: string = fixture();
    const htmlPath: string = join(path, 'dist-pages', 'privacy', 'index.html');
    write(
      htmlPath,
      readFileSync(htmlPath, 'utf8').replace('./style.css', 'https://analytics.example/style.css'),
    );
    expectValidationFailure(path, /stylesheet resource/i);
  });

  it('rejects an unexpected preload resource', (): void => {
    const path: string = fixture();
    const htmlPath: string = join(path, 'dist-pages', 'privacy', 'index.html');
    write(
      htmlPath,
      readFileSync(htmlPath, 'utf8').replace(
        '</head>',
        '<link rel="preload" href="https://analytics.example/font.woff2"></head>',
      ),
    );
    expectValidationFailure(path, /unexpected link resource/i);
  });

  it('rejects network resources in the staged stylesheet', (): void => {
    const path: string = fixture();
    const stylesheetPath: string = join(path, 'dist-pages', 'privacy', 'style.css');
    write(
      stylesheetPath,
      `${readFileSync(stylesheetPath, 'utf8')}@import url("https://example.com");\n`,
    );
    expectValidationFailure(path, /stylesheet.*network resource/i);
  });

  it('builds only regular files in both 404 locations', (): void => {
    const path: string = sourceFixture();
    const result: ReturnType<typeof spawnSync> = build(path);
    expect(result.status, String(result.stderr)).toBe(0);
    const outputDirectory: string = join(path, 'dist-pages');
    const outputFiles: string[] = [
      join(outputDirectory, '404.html'),
      join(outputDirectory, 'privacy', '404.html'),
      join(outputDirectory, 'privacy', 'index.html'),
      join(outputDirectory, 'privacy', 'style.css'),
    ];
    expect(readdirSync(outputDirectory).sort()).toEqual(['404.html', 'privacy']);
    expect(readdirSync(join(outputDirectory, 'privacy')).sort()).toEqual([
      '404.html',
      'index.html',
      'style.css',
    ]);
    for (const outputPath of outputFiles) {
      expect(lstatSync(outputPath).isFile()).toBe(true);
      expect(lstatSync(outputPath).nlink).toBe(1);
    }
  });

  it('rejects an external source symlink', (): void => {
    const path: string = sourceFixture();
    const stylesheetPath: string = join(path, 'docs', 'privacy', 'style.css');
    const externalPath: string = join(path, 'external.css');
    write(externalPath, 'body {}\n');
    rmSync(stylesheetPath);
    symlinkSync(externalPath, stylesheetPath);
    expectBuildFailure(path, /symbolic link/i);
  });

  it('rejects an internal source symlink', (): void => {
    const path: string = sourceFixture();
    const stylesheetPath: string = join(path, 'docs', 'privacy', 'style.css');
    rmSync(stylesheetPath);
    symlinkSync('index.html', stylesheetPath);
    expectBuildFailure(path, /symbolic link/i);
  });

  it('rejects a source hard link', (): void => {
    const path: string = sourceFixture();
    const stylesheetPath: string = join(path, 'docs', 'privacy', 'style.css');
    rmSync(stylesheetPath);
    linkSync(join(path, 'docs', 'privacy', 'index.html'), stylesheetPath);
    expectBuildFailure(path, /hard link/i);
  });

  it('rejects a staged output symlink', (): void => {
    const path: string = fixture();
    const stylesheetPath: string = join(path, 'dist-pages', 'privacy', 'style.css');
    rmSync(stylesheetPath);
    symlinkSync('index.html', stylesheetPath);
    expectValidationFailure(path, /symbolic link/i);
  });

  it('rejects staged hard links', (): void => {
    const path: string = fixture();
    const privacyNotFoundPath: string = join(path, 'dist-pages', 'privacy', '404.html');
    rmSync(privacyNotFoundPath);
    linkSync(join(path, 'dist-pages', '404.html'), privacyNotFoundPath);
    expectValidationFailure(path, /hard link/i);
  });

  it('requires the exact package scripts', (): void => {
    const packageJson: { scripts: Record<string, string> } = JSON.parse(
      readFileSync('package.json', 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts['pages:build']).toBe('node scripts/build-pages.mjs');
    expect(packageJson.scripts['pages:validate']).toBe(
      "npm run pages:build && node scripts/validate-pages.mjs && html-validate 'dist-pages/**/*.html'",
    );
  });
});

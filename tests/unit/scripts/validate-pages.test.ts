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
import { afterEach, describe, expect, it, vi } from 'vitest';

const fixtures: string[] = [];
/**
 * Every test here builds a fixture on disk and spawns the script under test, which costs about a
 * second on an idle machine and five to ten seconds when the full suite runs this file alongside
 * everything else. The default budget is five seconds, so these tests passed alone and failed in
 * full runs. The budget is stated once for the file rather than per test, and it is thirty times
 * the measured idle cost, which is the contention headroom the release gate needs.
 */
vi.setConfig({ testTimeout: 30_000 });

const BUILD_SCRIPT_PATH: string = resolve('scripts/build-pages.mjs');
const GITHUB_REF_EXPRESSION: string = '$' + '{{ github.ref }}';
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

const VALID_SITE_HTML: string = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="icon" href="data:,">
    <link rel="canonical" href="https://wolph.github.io/distraction-blocker/">
    <link rel="stylesheet" href="/distraction-blocker/assets/main.css">
    <title>Focus Lock</title>
  </head>
  <body>
    <main id="main-content">
      <h1>Stay with the task you chose.</h1>
      <p>
        <a href="https://chromewebstore.google.com/detail/focus-lock/lfhgncahaaenflajfdolbkgiglppdgjm">Install</a>
        <a href="https://github.com/wolph/distraction-blocker#get-started">Source</a>
        <a href="/distraction-blocker/privacy/">Privacy policy</a>
      </p>
      <img src="/distraction-blocker/images/focus-session.png" width="10" height="10" alt="Demo">
    </main>
    <script type="module" src="/distraction-blocker/assets/main.js"></script>
  </body>
</html>
`;

const VALID_TAB_HTML: string = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="icon" href="data:,">
    <title>Demo tab</title>
  </head>
  <body>
    <main id="tab-content"></main>
    <script type="module" src="/distraction-blocker/assets/tab.js"></script>
  </body>
</html>
`;

const VALID_SITE_CSS: string = 'body { margin: 0; }\n';

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
  write(join(path, 'dist-pages', 'index.html'), VALID_SITE_HTML);
  write(join(path, 'dist-pages', 'tab.html'), VALID_TAB_HTML);
  write(join(path, 'dist-pages', 'assets', 'main.css'), VALID_SITE_CSS);
  write(join(path, 'dist-pages', 'assets', 'main.js'), '');
  write(join(path, 'dist-pages', 'assets', 'tab.js'), '');
  write(join(path, 'dist-pages', 'assets', 'enforcement-v2-validation.js'), '');
  write(join(path, 'dist-pages', 'images', 'focus-session.png'), 'stub');
  write(join(path, 'dist-pages', 'images', 'blocked-page.png'), 'stub');
  write(join(path, 'dist-pages', 'images', 'progress.png'), 'stub');
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
  // build-pages.mjs now assumes the Vite pages build already staged dist-pages.
  mkdirSync(join(path, 'dist-pages'), { recursive: true });
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

  it.each([
    ['defaults', 'defaults:\n  run:\n    shell: "./scripts/publish-pages.sh {0}"\n'],
    ['env', 'env:\n  RELEASE_CHANNEL: pages\n'],
    ['permissions', 'permissions: read-all\n'],
    ['run-name', `run-name: Publish from ${GITHUB_REF_EXPRESSION}\n`],
    ['timeout control', 'timeout-minutes: 5\n'],
  ])(
    'rejects the unapproved top-level %s workflow key',
    (_key: string, workflowKey: string): void => {
      const path: string = fixture();
      const workflowPath: string = join(path, '.github', 'workflows', 'pages.yml');
      write(
        workflowPath,
        readFileSync(workflowPath, 'utf8').replace(
          'name: Publish privacy policy\n',
          `name: Publish privacy policy\n${workflowKey}`,
        ),
      );
      expectValidationFailure(path, /top-level workflow keys/i);
    },
  );

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

  it.each([
    ['if', '    if: false\n'],
    ['env', '    env:\n      RELEASE_CHANNEL: pages\n'],
    ['container', '    container: node:22\n'],
    ['defaults', '    defaults:\n      run:\n        shell: bash\n'],
    ['continue-on-error', '    continue-on-error: true\n'],
    ['timeout-minutes', '    timeout-minutes: 5\n'],
    ['strategy', '    strategy:\n      matrix:\n        node: [22]\n'],
  ])('rejects the unapproved %s key in each workflow job', (_key: string, jobKey: string): void => {
    for (const jobName of ['build', 'deploy']) {
      const path: string = fixture();
      const workflowPath: string = join(path, '.github', 'workflows', 'pages.yml');
      const jobMarker: string = `  ${jobName}:\n`;
      write(
        workflowPath,
        readFileSync(workflowPath, 'utf8').replace(jobMarker, `${jobMarker}${jobKey}`),
      );
      expectValidationFailure(path, new RegExp(`${jobName} job keys`, 'i'));
    }
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

  it('rejects an external base URL with the approved relative stylesheet', (): void => {
    const path: string = fixture();
    const htmlPath: string = join(path, 'dist-pages', 'privacy', 'index.html');
    write(
      htmlPath,
      readFileSync(htmlPath, 'utf8').replace(
        '<link rel="stylesheet" href="./style.css">',
        '<base href="https://analytics.example/"><link rel="stylesheet" href="./style.css">',
      ),
    );
    expectValidationFailure(path, /base/i);
  });

  it('rejects an inline style element with an external URL', (): void => {
    const path: string = fixture();
    const htmlPath: string = join(path, 'dist-pages', 'privacy', 'index.html');
    write(
      htmlPath,
      readFileSync(htmlPath, 'utf8').replace(
        '</head>',
        '<style>body { background: url("https://analytics.example/pixel"); }</style></head>',
      ),
    );
    expectValidationFailure(path, /inline style/i);
  });

  it('rejects a style attribute with an external URL', (): void => {
    const path: string = fixture();
    const htmlPath: string = join(path, 'dist-pages', 'privacy', 'index.html');
    write(
      htmlPath,
      readFileSync(htmlPath, 'utf8').replace(
        '<main id="details">',
        '<main id="details" style="background: url(https://analytics.example/pixel)">',
      ),
    );
    expectValidationFailure(path, /style attribute/i);
  });

  it('rejects a body onload handler that calls fetch', (): void => {
    const path: string = fixture();
    const htmlPath: string = join(path, 'dist-pages', 'privacy', 'index.html');
    write(
      htmlPath,
      readFileSync(htmlPath, 'utf8').replace(
        '<body>',
        '<body onload="fetch(\'https://analytics.example/collect\')">',
      ),
    );
    expectValidationFailure(path, /event attribute/i);
  });

  it('rejects mixed-case event attributes', (): void => {
    const path: string = fixture();
    const htmlPath: string = join(path, 'dist-pages', 'privacy', 'index.html');
    write(
      htmlPath,
      readFileSync(htmlPath, 'utf8').replace(
        '<h1>Focus Lock Privacy</h1>',
        '<h1 oNcLiCk="alert(1)">Focus Lock Privacy</h1>',
      ),
    );
    expectValidationFailure(path, /event attribute/i);
  });

  it('rejects anchor ping tracking', (): void => {
    const path: string = fixture();
    const htmlPath: string = join(path, 'dist-pages', 'privacy', 'index.html');
    write(
      htmlPath,
      readFileSync(htmlPath, 'utf8').replace(
        '<a href="https://github.com/wolph/distraction-blocker">',
        '<a href="https://github.com/wolph/distraction-blocker" ping="https://analytics.example/collect">',
      ),
    );
    expectValidationFailure(path, /ping attribute/i);
  });

  it.each([
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,<script>alert(1)</script>'],
    ['vbscript', 'vbscript:msgbox(1)'],
  ])('rejects the %s executable URL scheme', (_scheme: string, href: string): void => {
    const path: string = fixture();
    const htmlPath: string = join(path, 'dist-pages', 'privacy', 'index.html');
    write(
      htmlPath,
      readFileSync(htmlPath, 'utf8').replace('</main>', `<a href="${href}">Unsafe link</a></main>`),
    );
    expectValidationFailure(path, /executable URL scheme/i);
  });

  it.each([
    ['background', '<div background="https://analytics.example/pixel">Background</div>'],
    ['cite', '<blockquote cite="https://analytics.example/collect">Quote</blockquote>'],
    ['formaction', '<button formaction="https://analytics.example/collect">Send</button>'],
    ['poster', '<div poster="https://analytics.example/pixel">Poster</div>'],
    ['SVG href', '<svg><use href="https://analytics.example/icon.svg#pixel"></use></svg>'],
    ['xlink href', '<svg><use xlink:href="https://analytics.example/icon.svg#pixel"></use></svg>'],
  ])('rejects the unapproved %s URL-bearing attribute', (_name: string, element: string): void => {
    const path: string = fixture();
    const htmlPath: string = join(path, 'dist-pages', 'privacy', 'index.html');
    write(htmlPath, readFileSync(htmlPath, 'utf8').replace('</main>', `${element}</main>`));
    expectValidationFailure(path, /URL-bearing attribute/i);
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

  it.each([
    ['image-set', 'body { background: image-set("https://analytics.example/pixel" 1x); }'],
    [
      '-webkit-image-set',
      'body { background: -webkit-image-set("https://analytics.example/pixel" 1x); }',
    ],
    [
      '@font-face quoted src',
      '@font-face { font-family: "Tracking Font"; src: "https://analytics.example/font.woff2"; }',
    ],
    [
      'uppercase with whitespace',
      'body { background: IMAGE-SET(  "https://analytics.example/pixel" 1x ); }',
    ],
    [
      'escaped function name',
      'body { background: im\\61 ge-set("https://analytics.example/pixel" 1x); }',
    ],
    [
      'protocol-relative image-set',
      'body { background: image-set("//analytics.example/pixel" 1x); }',
    ],
    ['unquoted URL', 'body { background: url(//analytics.example/pixel); }'],
    ['escaped URL function', 'body { background: u\\72l("https://analytics.example/pixel"); }'],
  ])('rejects the %s CSS resource construct', (_name: string, css: string): void => {
    const path: string = fixture();
    const stylesheetPath: string = join(path, 'dist-pages', 'privacy', 'style.css');
    write(stylesheetPath, `${readFileSync(stylesheetPath, 'utf8')}${css}\n`);
    expectValidationFailure(path, /stylesheet.*network resource/i);
  });

  it('allows request-like text in CSS strings and comments', (): void => {
    const path: string = fixture();
    const stylesheetPath: string = join(path, 'dist-pages', 'privacy', 'style.css');
    write(
      stylesheetPath,
      `${readFileSync(stylesheetPath, 'utf8')}.note::before { content: "url(https://example.test/pixel) image-set(//example.test/pixel)"; }\n/* @import url(https://example.test/style.css) */\n`,
    );
    const result: ReturnType<typeof spawnSync> = validate(path);
    expect(result.status, String(result.stderr)).toBe(0);
  });

  it('rejects a cross-site script src on a site page', (): void => {
    const path: string = fixture();
    const htmlPath: string = join(path, 'dist-pages', 'index.html');
    write(
      htmlPath,
      readFileSync(htmlPath, 'utf8').replace(
        '</body>',
        '<script type="module" src="https://analytics.example/track.js"></script></body>',
      ),
    );
    expectValidationFailure(path, /resource must be same-site/i);
  });

  it('rejects a cross-site img src on a site page', (): void => {
    const path: string = fixture();
    const htmlPath: string = join(path, 'dist-pages', 'index.html');
    write(
      htmlPath,
      readFileSync(htmlPath, 'utf8').replace(
        '</main>',
        '<img src="https://analytics.example/pixel.png" alt=""></main>',
      ),
    );
    expectValidationFailure(path, /resource must be same-site/i);
  });

  it('rejects a cross-site stylesheet href on a site page', (): void => {
    const path: string = fixture();
    const htmlPath: string = join(path, 'dist-pages', 'index.html');
    write(
      htmlPath,
      readFileSync(htmlPath, 'utf8').replace(
        '/distraction-blocker/assets/main.css',
        'https://analytics.example/main.css',
      ),
    );
    expectValidationFailure(path, /resource must be same-site/i);
  });

  it('rejects an inline script on a site page', (): void => {
    const path: string = fixture();
    const htmlPath: string = join(path, 'dist-pages', 'index.html');
    write(
      htmlPath,
      readFileSync(htmlPath, 'utf8').replace(
        '</body>',
        '<script type="module">alert(1)</script></body>',
      ),
    );
    expectValidationFailure(path, /inline scripts are forbidden/i);
  });

  it('rejects a style attribute on a site page', (): void => {
    const path: string = fixture();
    const htmlPath: string = join(path, 'dist-pages', 'index.html');
    write(
      htmlPath,
      readFileSync(htmlPath, 'utf8').replace(
        '<main id="main-content">',
        '<main id="main-content" style="color: red">',
      ),
    );
    expectValidationFailure(path, /style attribute/i);
  });

  it('rejects an iframe on a site page', (): void => {
    const path: string = fixture();
    const htmlPath: string = join(path, 'dist-pages', 'index.html');
    write(
      htmlPath,
      readFileSync(htmlPath, 'utf8').replace(
        '</main>',
        '<iframe src="/distraction-blocker/tab.html"></iframe></main>',
      ),
    );
    expectValidationFailure(path, /only scripts, stylesheets and images/i);
  });

  it('rejects an unlisted external anchor on a site page', (): void => {
    const path: string = fixture();
    const htmlPath: string = join(path, 'dist-pages', 'index.html');
    write(
      htmlPath,
      readFileSync(htmlPath, 'utf8').replace(
        '</main>',
        '<a href="https://example.com/unlisted">Unlisted</a></main>',
      ),
    );
    expectValidationFailure(
      path,
      /anchor url is outside the local and approved external contract/i,
    );
  });

  it('rejects an @import in the site stylesheet', (): void => {
    const path: string = fixture();
    const stylesheetPath: string = join(path, 'dist-pages', 'assets', 'main.css');
    write(
      stylesheetPath,
      `@import url("https://analytics.example/style.css");\n${readFileSync(stylesheetPath, 'utf8')}`,
    );
    expectValidationFailure(path, /site stylesheet must not use @import/i);
  });

  it('rejects a cross-origin url() in the site stylesheet', (): void => {
    const path: string = fixture();
    const stylesheetPath: string = join(path, 'dist-pages', 'assets', 'main.css');
    write(
      stylesheetPath,
      `${readFileSync(stylesheetPath, 'utf8')}.evil { background: url(https://analytics.example/pixel.png); }\n`,
    );
    expectValidationFailure(path, /site stylesheet must not load a cross-origin url/i);
  });

  it('rejects an unexpected staged file', (): void => {
    const path: string = fixture();
    write(join(path, 'dist-pages', 'extra.txt'), 'stub');
    expectValidationFailure(path, /staged site must contain only/i);
  });

  it('accepts the real built site', (): void => {
    const projectRoot: string = resolve('.');
    const viteBuildResult: ReturnType<typeof spawnSync> = spawnSync(
      process.execPath,
      [
        resolve('node_modules', 'vite', 'bin', 'vite.js'),
        'build',
        '--config',
        'vite.pages.config.ts',
      ],
      { cwd: projectRoot, encoding: 'utf8' },
    );
    expect(viteBuildResult.status, String(viteBuildResult.stderr)).toBe(0);
    const buildResult: ReturnType<typeof spawnSync> = build(projectRoot);
    expect(buildResult.status, String(buildResult.stderr)).toBe(0);
    const validationResult: ReturnType<typeof spawnSync> = validate(projectRoot);
    expect(validationResult.status, String(validationResult.stderr)).toBe(0);
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

  it('accepts real source and workflow ancestor directories', (): void => {
    const sourcePath: string = sourceFixture();
    const buildResult: ReturnType<typeof spawnSync> = build(sourcePath);
    expect(buildResult.status, String(buildResult.stderr)).toBe(0);

    const stagedPath: string = fixture();
    const validationResult: ReturnType<typeof spawnSync> = validate(stagedPath);
    expect(validationResult.status, String(validationResult.stderr)).toBe(0);
  });

  it('rejects an external docs ancestor symlink', (): void => {
    const path: string = mkdtempSync(join(tmpdir(), 'focus-lock-pages-source-root-'));
    fixtures.push(path);
    const externalPath: string = sourceFixture();
    symlinkSync(join(externalPath, 'docs'), join(path, 'docs'));
    expectBuildFailure(path, /symbolic link.*docs/i);
  });

  it('rejects an external docs privacy ancestor symlink', (): void => {
    const path: string = mkdtempSync(join(tmpdir(), 'focus-lock-pages-source-root-'));
    fixtures.push(path);
    mkdirSync(join(path, 'docs'));
    const externalPath: string = sourceFixture();
    symlinkSync(join(externalPath, 'docs', 'privacy'), join(path, 'docs', 'privacy'));
    expectBuildFailure(path, /symbolic link.*privacy/i);
  });

  it('rejects an external .github ancestor symlink', (): void => {
    const path: string = fixture();
    const externalPath: string = fixture();
    rmSync(join(path, '.github'), { recursive: true });
    symlinkSync(join(externalPath, '.github'), join(path, '.github'));
    expectValidationFailure(path, /symbolic link.*\.github/i);
  });

  it('rejects an external .github workflows ancestor symlink', (): void => {
    const path: string = fixture();
    const externalPath: string = fixture();
    rmSync(join(path, '.github', 'workflows'), { recursive: true });
    symlinkSync(join(externalPath, '.github', 'workflows'), join(path, '.github', 'workflows'));
    expectValidationFailure(path, /symbolic link.*workflows/i);
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
    expect(packageJson.scripts['pages:build']).toBe(
      'vite build --config vite.pages.config.ts && node scripts/build-pages.mjs',
    );
    expect(packageJson.scripts['pages:validate']).toBe(
      "npm run pages:build && node scripts/validate-pages.mjs && html-validate 'dist-pages/**/*.html'",
    );
  });
});

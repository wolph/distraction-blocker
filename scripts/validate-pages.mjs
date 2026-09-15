import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseCss, walk as walkCss } from 'css-tree';
import { HtmlValidate } from 'html-validate';
import { JSDOM } from 'jsdom';
import { parse } from 'yaml';

const SITE_ORIGIN = 'https://wolph.github.io';
const SITE_PREFIX = '/distraction-blocker/';
const PRIVACY_URL = `${SITE_ORIGIN}${SITE_PREFIX}privacy/`;
const REPOSITORY_URL = 'https://github.com/wolph/distraction-blocker';
const PAGE_URL_EXPRESSION = '$' + '{{ steps.deployment.outputs.page_url }}';
const PRIVACY_OUTPUT_FILES = [
  '404.html',
  'privacy/404.html',
  'privacy/index.html',
  'privacy/style.css',
];
const SITE_OUTPUT_FILES = [
  'assets/enforcement-v2-validation.js',
  'assets/main.css',
  'assets/main.js',
  'assets/tab.js',
  'images/blocked-page.png',
  'images/focus-session.png',
  'images/progress.png',
  'index.html',
  'tab.html',
];
const EXPECTED_OUTPUT_FILES = [...PRIVACY_OUTPUT_FILES, ...SITE_OUTPUT_FILES].sort();

/** The privacy policy must produce no request at all. The site may load its own files. */
function policyFor(relativeHtmlPath) {
  return relativeHtmlPath.startsWith('privacy/') || relativeHtmlPath === '404.html'
    ? 'no-requests'
    : 'same-site-only';
}
const EXPECTED_BUILD_STEPS = [
  { uses: 'actions/checkout@v7' },
  {
    uses: 'actions/setup-node@v7',
    with: { 'node-version-file': 'package.json', cache: 'npm' },
  },
  { run: 'npm ci' },
  { run: 'npm run pages:validate' },
  { uses: 'actions/configure-pages@v6' },
  { uses: 'actions/upload-pages-artifact@v5', with: { path: 'dist-pages' } },
];
const EXPECTED_DEPLOY_STEPS = [{ id: 'deployment', uses: 'actions/deploy-pages@v5' }];
const FORBIDDEN_PROSE_PUNCTUATION = /[“”„‟‘’‚‛—–−‑‒…;]/u;
const REQUEST_PRODUCING_SELECTOR =
  'script, iframe, img, audio, video, source, track, object, embed, form';
const URL_BEARING_ATTRIBUTES = new Set([
  'about',
  'action',
  'archive',
  'attributionsrc',
  'background',
  'cite',
  'classid',
  'code',
  'codebase',
  'data',
  'datasrc',
  'dynsrc',
  'formaction',
  'href',
  'imagesrcset',
  'itemid',
  'longdesc',
  'lowsrc',
  'manifest',
  'ping',
  'poster',
  'profile',
  'resource',
  'src',
  'srcdoc',
  'srcset',
  'usemap',
  'vocab',
  'xlink:href',
]);
const ALLOWED_EXTERNAL_ANCHOR_URLS = new Set([
  REPOSITORY_URL,
  `${REPOSITORY_URL}/issues`,
  'https://policies.google.com/privacy',
  'https://www.google.com/chrome/terms/',
  'https://developer.chrome.com/docs/webstore/program-policies/user-data-faq/',
]);
const SITE_INSTALL_URL =
  'https://chromewebstore.google.com/detail/focus-lock/lfhgncahaaenflajfdolbkgiglppdgjm';
const ALLOWED_CSS_AT_RULES = new Set(['media']);
const ALLOWED_CSS_FUNCTIONS = new Set([
  'calc',
  'clamp',
  'linear-gradient',
  'min',
  'minmax',
  'radial-gradient',
  'repeat',
  'rgba',
  'translateY',
  'var',
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isInside(path, directory) {
  return path === directory || path.startsWith(`${directory}${sep}`);
}

function stripUrlControlCharacters(value) {
  return [...value].filter((character) => character.codePointAt(0) > 0x20).join('');
}

function inspectRequiredPath(rootDirectory, relativePath) {
  const rootRealPath = realpathSync(rootDirectory);
  const pathComponents = relativePath.split('/');
  let absolutePath = rootDirectory;
  for (const [index, component] of pathComponents.entries()) {
    absolutePath = join(absolutePath, component);
    assert(existsSync(absolutePath), `Missing required file: ${relativePath}`);
    const componentStat = lstatSync(absolutePath);
    assert(
      !componentStat.isSymbolicLink(),
      `Required path component must not be a symbolic link: ${pathComponents.slice(0, index + 1).join('/')}`,
    );
    assert(
      isInside(realpathSync(absolutePath), rootRealPath),
      `Required path component resolves outside the project root: ${relativePath}`,
    );
    if (index < pathComponents.length - 1) {
      assert(
        componentStat.isDirectory(),
        `Required path component is not a directory: ${absolutePath}`,
      );
    }
  }
  return { absolutePath, fileStat: lstatSync(absolutePath) };
}

function readRequiredFile(rootDirectory, relativePath) {
  const { absolutePath, fileStat } = inspectRequiredPath(rootDirectory, relativePath);
  assert(fileStat.isFile(), `Required path is not a regular file: ${relativePath}`);
  assert(fileStat.nlink === 1, `Required file must not be a hard link: ${relativePath}`);
  return readFileSync(absolutePath, 'utf8');
}

function parseWorkflow(rootDirectory) {
  const workflowText = readRequiredFile(rootDirectory, '.github/workflows/pages.yml');
  try {
    return parse(workflowText);
  } catch (error) {
    throw new Error(
      `Invalid workflow YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function stepContract(steps) {
  assert(Array.isArray(steps), 'Workflow job must define steps');
  return steps.map((step) => {
    assert(step && typeof step === 'object', 'Workflow steps must be objects');
    const { name: _name, ...contract } = step;
    return contract;
  });
}

function validateJobKeys(job, expectedKeys, jobName) {
  assert(job && typeof job === 'object' && !Array.isArray(job), `${jobName} job must be an object`);
  assert(
    isDeepStrictEqual(Object.keys(job).sort(), [...expectedKeys].sort()),
    `${jobName} job keys must be exactly: ${expectedKeys.join(', ')}`,
  );
}

function validateWorkflow(rootDirectory) {
  const workflow = parseWorkflow(rootDirectory);
  assert(workflow && typeof workflow === 'object', 'Workflow YAML must contain an object');
  assert(
    isDeepStrictEqual(Object.keys(workflow).sort(), ['concurrency', 'jobs', 'name', 'on']),
    'Top-level workflow keys must be exactly: name, on, concurrency, jobs',
  );
  const triggers = workflow.on;
  assert(triggers && typeof triggers === 'object', 'Workflow triggers must be an object');
  assert(
    isDeepStrictEqual(Object.keys(triggers).sort(), ['push', 'workflow_dispatch']),
    'Workflow triggers must be exactly push and workflow_dispatch',
  );
  assert(
    isDeepStrictEqual(triggers.push, { branches: ['master'] }),
    'Push trigger must target only master',
  );
  assert(
    workflow.permissions === undefined,
    'Workflow-level permissions are forbidden. Scope permissions to each job',
  );
  assert(
    isDeepStrictEqual(workflow.concurrency, { group: 'pages', 'cancel-in-progress': false }),
    'Workflow concurrency must serialize Pages deployments without cancelling an active deployment',
  );
  assert(workflow.jobs && typeof workflow.jobs === 'object', 'Workflow must define jobs');
  assert(
    isDeepStrictEqual(Object.keys(workflow.jobs).sort(), ['build', 'deploy']),
    'Workflow jobs must be exactly build and deploy',
  );

  const { build, deploy } = workflow.jobs;
  validateJobKeys(build, ['runs-on', 'permissions', 'steps'], 'Build');
  assert(build?.['runs-on'] === 'ubuntu-latest', 'Build runner must be exactly ubuntu-latest');
  assert(
    isDeepStrictEqual(build.permissions, { contents: 'read' }),
    'Build permissions must be exactly contents: read',
  );
  assert(build.needs === undefined, 'Build job must not depend on another job');
  assert(build.environment === undefined, 'Build job must not use an environment');
  assert(build.outputs === undefined, 'Build job must not define outputs');
  const uploadStep = build.steps?.find((step) => step?.uses === 'actions/upload-pages-artifact@v5');
  assert(uploadStep?.with?.path === 'dist-pages', 'Pages upload path must be exactly dist-pages');
  assert(
    isDeepStrictEqual(stepContract(build.steps), EXPECTED_BUILD_STEPS),
    'Build step sequence must contain only the approved actions and commands in the required order',
  );

  validateJobKeys(
    deploy,
    ['needs', 'runs-on', 'permissions', 'environment', 'outputs', 'steps'],
    'Deploy',
  );
  assert(deploy?.['runs-on'] === 'ubuntu-latest', 'Deploy runner must be exactly ubuntu-latest');
  assert(deploy.needs === 'build', 'Deploy job needs must be exactly build');
  assert(
    isDeepStrictEqual(deploy.permissions, { pages: 'write', 'id-token': 'write' }),
    'Deploy permissions must be exactly pages: write and id-token: write',
  );
  assert(
    isDeepStrictEqual(deploy.environment, {
      name: 'github-pages',
      url: PAGE_URL_EXPRESSION,
    }),
    'Deploy environment must be github-pages with the standard page_url',
  );
  assert(
    isDeepStrictEqual(deploy.outputs, { page_url: PAGE_URL_EXPRESSION }),
    'Deploy outputs must expose the standard page_url',
  );
  assert(
    isDeepStrictEqual(stepContract(deploy.steps), EXPECTED_DEPLOY_STEPS),
    'Deploy step sequence must contain only actions/deploy-pages@v5',
  );
}

function inspectStagedTree(rootDirectory) {
  const outputDirectory = join(rootDirectory, 'dist-pages');
  assert(existsSync(outputDirectory), 'Missing required directory: dist-pages');
  const outputStat = lstatSync(outputDirectory);
  assert(!outputStat.isSymbolicLink(), 'Staged directory must not be a symbolic link: dist-pages');
  assert(outputStat.isDirectory(), 'Staged path must be a directory: dist-pages');
  const outputRealPath = realpathSync(outputDirectory);
  const files = [];

  function visit(directory) {
    for (const entry of readdirSync(directory)) {
      const entryPath = join(directory, entry);
      const relativePath = relative(outputDirectory, entryPath).split(sep).join('/');
      const entryStat = lstatSync(entryPath);
      assert(
        !entryStat.isSymbolicLink(),
        `Staged path must not be a symbolic link: dist-pages/${relativePath}`,
      );
      assert(
        isInside(realpathSync(entryPath), outputRealPath),
        `Staged path resolves outside dist-pages: dist-pages/${relativePath}`,
      );
      if (entryStat.isDirectory()) {
        visit(entryPath);
        continue;
      }
      assert(entryStat.isFile(), `Staged path is not a regular file: dist-pages/${relativePath}`);
      assert(
        entryStat.nlink === 1,
        `Staged file must not be a hard link: dist-pages/${relativePath}`,
      );
      files.push(relativePath);
    }
  }

  visit(outputDirectory);
  files.sort();
  const missingFiles = EXPECTED_OUTPUT_FILES.filter((file) => !files.includes(file));
  assert(
    missingFiles.length === 0,
    `Missing required file: ${missingFiles.map((file) => `dist-pages/${file}`).join(', ')}`,
  );
  assert(
    isDeepStrictEqual(files, EXPECTED_OUTPUT_FILES),
    `Staged site must contain only: ${EXPECTED_OUTPUT_FILES.map((file) => `dist-pages/${file}`).join(', ')}`,
  );
  return outputDirectory;
}

function htmlFiles(outputDirectory) {
  return EXPECTED_OUTPUT_FILES.filter((path) => path.endsWith('.html')).map((path) =>
    join(outputDirectory, path),
  );
}

function formatHtmlErrors(report, rootDirectory) {
  return report.results
    .flatMap((result) =>
      result.messages.map(
        (message) =>
          `${relative(rootDirectory, result.filePath)}:${message.line}:${message.column} ${message.message}`,
      ),
    )
    .join('\n');
}

async function validateHtml(rootDirectory, outputDirectory) {
  const validator = new HtmlValidate({
    extends: ['html-validate:recommended'],
    rules: {
      'doctype-style': 'off',
      'void-style': 'off',
    },
  });
  for (const htmlPath of htmlFiles(outputDirectory)) {
    const report = await validator.validateFile(htmlPath);
    assert(report.valid, `HTML validation failed:\n${formatHtmlErrors(report, rootDirectory)}`);
  }
}

function visibleText(document) {
  const copy = document.cloneNode(true);
  for (const element of copy.querySelectorAll('style, script, template, noscript'))
    element.remove();
  return copy.body?.textContent ?? '';
}

function urlToOutputPath(url, outputDirectory) {
  assert(
    url.pathname.startsWith(SITE_PREFIX),
    `Broken same-site link outside ${SITE_PREFIX}: ${url.href}`,
  );
  const relativePath = decodeURIComponent(url.pathname.slice(SITE_PREFIX.length));
  const normalizedPath =
    relativePath === '' || relativePath.endsWith('/') ? `${relativePath}index.html` : relativePath;
  const outputPath = resolve(outputDirectory, normalizedPath);
  assert(
    isInside(outputPath, outputDirectory),
    `Broken same-site link outside the staged site: ${url.href}`,
  );
  return outputPath;
}

function validateSameSiteLinks(document, htmlPath, outputDirectory) {
  const currentRelativePath = relative(outputDirectory, htmlPath).split(sep).join('/');
  const currentUrl = new URL(currentRelativePath, `${SITE_ORIGIN}${SITE_PREFIX}`);
  for (const element of document.querySelectorAll('[href], [src]')) {
    const href = element.getAttribute('href') ?? element.getAttribute('src');
    if (!href || /^(?:mailto|tel|data):/u.test(href)) continue;
    const targetUrl = new URL(href, currentUrl);
    if (targetUrl.origin !== SITE_ORIGIN) continue;
    const targetPath = urlToOutputPath(targetUrl, outputDirectory);
    assert(existsSync(targetPath), `Broken same-site link: ${href}`);
    const targetStat = lstatSync(targetPath);
    assert(!targetStat.isSymbolicLink(), `Broken same-site link targets a symbolic link: ${href}`);
    assert(targetStat.isFile() && targetStat.nlink === 1, `Broken same-site link: ${href}`);
    assert(
      isInside(realpathSync(targetPath), realpathSync(outputDirectory)),
      `Broken same-site link resolves outside the staged site: ${href}`,
    );
    if (targetUrl.hash && targetPath.endsWith('.html')) {
      const targetDocument =
        targetPath === htmlPath
          ? document
          : new JSDOM(readFileSync(targetPath, 'utf8'), { url: targetUrl.href }).window.document;
      const id = decodeURIComponent(targetUrl.hash.slice(1));
      assert(targetDocument.getElementById(id), `Broken same-site link fragment: ${href}`);
    }
  }
}

function assertNoInlineStyling(document, relativeHtmlPath) {
  assert(
    document.querySelector('base') === null,
    `HTML base elements are forbidden in dist-pages/${relativeHtmlPath}`,
  );
  assert(
    document.querySelector('style') === null,
    `Inline style elements are forbidden in dist-pages/${relativeHtmlPath}`,
  );
}

function isDataIconAttribute(element, attributeName, attributeValue) {
  return (
    element.localName === 'link' &&
    element.getAttribute('rel') === 'icon' &&
    attributeName === 'href' &&
    attributeValue === 'data:,'
  );
}

/** Runs `visit` for every URL-bearing attribute, after the checks common to both policies. */
function forEachUrlBearingAttribute(document, relativeHtmlPath, visit) {
  for (const element of document.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      const attributeName = attribute.name.toLowerCase();
      const attributeValue = attribute.value;
      assert(
        attributeName !== 'style',
        `Style attributes are forbidden in dist-pages/${relativeHtmlPath}`,
      );
      assert(
        !attributeName.startsWith('on'),
        `Event attributes are forbidden in dist-pages/${relativeHtmlPath}`,
      );
      assert(
        attributeName !== 'ping',
        `Ping attributes are forbidden in dist-pages/${relativeHtmlPath}`,
      );
      if (!URL_BEARING_ATTRIBUTES.has(attributeName)) continue;
      const compactValue = stripUrlControlCharacters(attributeValue);
      const isDataIcon = isDataIconAttribute(element, attributeName, attributeValue);
      assert(
        isDataIcon || !/^(?:data|javascript|vbscript):/iu.test(compactValue),
        `Executable URL scheme is forbidden in dist-pages/${relativeHtmlPath}`,
      );
      visit({ element, attribute, attributeName, attributeValue, compactValue, isDataIcon });
    }
  }
}

/** Collects `<link rel="stylesheet">` hrefs, checking the icon and (if allowed) canonical link. */
function collectStylesheetLinks(document, relativeHtmlPath, canonicalAllowed, expectedCanonical) {
  const stylesheets = [];
  for (const link of document.querySelectorAll('link[href]')) {
    const rel = link.getAttribute('rel');
    const href = link.getAttribute('href');
    if (rel === 'canonical') {
      assert(canonicalAllowed, `Unexpected link resource in dist-pages/${relativeHtmlPath}`);
      assert(
        href === expectedCanonical,
        `Unexpected canonical URL in dist-pages/${relativeHtmlPath}`,
      );
      continue;
    }
    if (rel === 'icon') {
      assert(href === 'data:,', `Unexpected link resource in dist-pages/${relativeHtmlPath}`);
      continue;
    }
    assert(rel === 'stylesheet', `Unexpected link resource in dist-pages/${relativeHtmlPath}`);
    stylesheets.push(href);
  }
  return stylesheets;
}

/** The privacy policy: no request-producing element, and anchors follow the local/approved list. */
function validateNoRequestResources(document, relativeHtmlPath) {
  assertNoInlineStyling(document, relativeHtmlPath);
  assert(
    document.querySelectorAll(REQUEST_PRODUCING_SELECTOR).length === 0,
    `Request-producing HTML elements are forbidden in dist-pages/${relativeHtmlPath}`,
  );
  forEachUrlBearingAttribute(
    document,
    relativeHtmlPath,
    ({ element, attribute, attributeName, attributeValue }) => {
      assert(
        attributeName === 'href' && ['a', 'link'].includes(element.localName),
        `Unapproved URL-bearing attribute ${attribute.name} in dist-pages/${relativeHtmlPath}`,
      );
      if (element.localName !== 'a') return;
      const isLocalHref =
        attributeValue.startsWith('#') ||
        attributeValue.startsWith('./') ||
        attributeValue.startsWith(SITE_PREFIX);
      assert(
        isLocalHref || ALLOWED_EXTERNAL_ANCHOR_URLS.has(attributeValue),
        `Anchor URL is outside the local and approved external contract: ${attributeValue}`,
      );
    },
  );
  const canonicalAllowed = relativeHtmlPath === 'privacy/index.html';
  const stylesheets = collectStylesheetLinks(
    document,
    relativeHtmlPath,
    canonicalAllowed,
    PRIVACY_URL,
  );
  const expectedStylesheet =
    relativeHtmlPath === 'privacy/index.html'
      ? './style.css'
      : '/distraction-blocker/privacy/style.css';
  assert(
    isDeepStrictEqual(stylesheets, [expectedStylesheet]),
    `Stylesheet resource must be exactly ${expectedStylesheet} in dist-pages/${relativeHtmlPath}`,
  );
}

function assertApprovedSameSiteAttribute(element, attribute, attributeName, relativeHtmlPath) {
  const approved =
    (attributeName === 'href' && ['a', 'link'].includes(element.localName)) ||
    (attributeName === 'src' && ['script', 'img'].includes(element.localName));
  assert(
    approved,
    `Unapproved URL-bearing attribute ${attribute.name} in dist-pages/${relativeHtmlPath}`,
  );
}

/** Anchors may point off-site only to the install page or the repository. Everything else that
 * loads a resource (a script src, an img src, a stylesheet href) must resolve same-site. */
function assertSameSiteAnchorOrResource(attributeInfo, relativeHtmlPath) {
  const { element, attributeName, attributeValue, compactValue, isDataIcon } = attributeInfo;
  const base = `${SITE_ORIGIN}${SITE_PREFIX}${relativeHtmlPath}`;
  if (attributeName === 'href' && element.localName === 'a') {
    const resolved = new URL(compactValue, base);
    const isApprovedExternal =
      attributeValue === SITE_INSTALL_URL || attributeValue.startsWith(REPOSITORY_URL);
    assert(
      resolved.origin === SITE_ORIGIN || isApprovedExternal,
      `Anchor URL is outside the local and approved external contract in dist-pages/${relativeHtmlPath}: ${attributeValue}`,
    );
    return;
  }
  if (isDataIcon) return;
  const resolved = new URL(compactValue, base);
  assert(
    resolved.origin === SITE_ORIGIN && resolved.pathname.startsWith(SITE_PREFIX),
    `Resource must be same-site in dist-pages/${relativeHtmlPath}: ${attributeValue}`,
  );
}

/** The site policy: only scripts, stylesheets and images load, same-site, plus approved anchors. */
function validateSameSiteResources(document, relativeHtmlPath) {
  assertNoInlineStyling(document, relativeHtmlPath);
  assert(
    document.querySelectorAll('iframe, object, embed, form, audio, video, source, track').length ===
      0,
    `Only scripts, stylesheets and images may load in dist-pages/${relativeHtmlPath}`,
  );
  for (const script of document.querySelectorAll('script')) {
    assert(
      script.textContent.trim() === '',
      `Inline scripts are forbidden in dist-pages/${relativeHtmlPath}`,
    );
    assert(
      script.getAttribute('type') === 'module',
      `Scripts must be modules in dist-pages/${relativeHtmlPath}`,
    );
  }
  forEachUrlBearingAttribute(document, relativeHtmlPath, (attributeInfo) => {
    assertApprovedSameSiteAttribute(
      attributeInfo.element,
      attributeInfo.attribute,
      attributeInfo.attributeName,
      relativeHtmlPath,
    );
    assertSameSiteAnchorOrResource(attributeInfo, relativeHtmlPath);
  });
  const canonicalAllowed = relativeHtmlPath === 'index.html';
  const stylesheets = collectStylesheetLinks(
    document,
    relativeHtmlPath,
    canonicalAllowed,
    `${SITE_ORIGIN}${SITE_PREFIX}`,
  );
  assert(
    stylesheets.length <= 1,
    `At most one stylesheet may load in dist-pages/${relativeHtmlPath}`,
  );
}

function validateResources(document, relativeHtmlPath) {
  const policy = policyFor(relativeHtmlPath);
  if (policy === 'no-requests') {
    validateNoRequestResources(document, relativeHtmlPath);
  } else {
    validateSameSiteResources(document, relativeHtmlPath);
  }
}

/** The site stylesheet may load its own assets but never a cross-origin url() or an @import. */
function validateSiteStylesheetContents(stylesheet, relativeCssPath) {
  let stylesheetAst;
  try {
    stylesheetAst = parseCss(stylesheet, { parseCustomProperty: true });
  } catch (error) {
    throw new Error(
      `Site stylesheet parsing failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  walkCss(stylesheetAst, (node) => {
    assert(
      node.type !== 'Atrule' || node.name !== 'import',
      `Site stylesheet must not use @import in dist-pages/${relativeCssPath}`,
    );
    if (node.type !== 'Url') return;
    const value = stripUrlControlCharacters(node.value);
    assert(
      !/^(?:https?:|\/\/)/iu.test(value),
      `Site stylesheet must not load a cross-origin url() in dist-pages/${relativeCssPath}: ${node.value}`,
    );
  });
}

function validatePrivacyMetadata(document, stylesheet) {
  assert(
    document.title === 'Focus Lock Privacy Policy',
    'Privacy page title must be exactly Focus Lock Privacy Policy',
  );
  assert(
    document.querySelector('meta[name="viewport"]')?.getAttribute('content') ===
      'width=device-width, initial-scale=1',
    'Privacy page must declare the standard responsive viewport',
  );
  assert(
    document.querySelector('link[rel="canonical"]')?.getAttribute('href') === PRIVACY_URL,
    `Privacy page canonical URL must be ${PRIVACY_URL}`,
  );
  assert(
    [...document.querySelectorAll('a[href]')].some(
      (link) => link.getAttribute('href') === REPOSITORY_URL,
    ),
    `Privacy page must link to the exact repository URL ${REPOSITORY_URL}`,
  );
  assert(
    /:focus(?:-visible)?\b/u.test(stylesheet),
    'Privacy stylesheet must provide visible focus styling',
  );
  let stylesheetAst;
  try {
    stylesheetAst = parseCss(stylesheet, { parseCustomProperty: true });
  } catch (error) {
    throw new Error(
      `Privacy stylesheet parsing failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  walkCss(stylesheetAst, (node) => {
    assert(
      node.type !== 'Url' && node.type !== 'Raw',
      'Privacy stylesheet must not contain network resource declarations or unparsed syntax',
    );
    if (node.type === 'Atrule') {
      assert(
        ALLOWED_CSS_AT_RULES.has(node.name),
        `Privacy stylesheet network resource policy forbids @${node.name}`,
      );
    }
    if (node.type === 'Function') {
      assert(
        ALLOWED_CSS_FUNCTIONS.has(node.name),
        `Privacy stylesheet network resource policy forbids ${node.name}()`,
      );
    }
  });
}

function validateStagedSite(rootDirectory) {
  const outputDirectory = inspectStagedTree(rootDirectory);
  const privacyHtml = readFileSync(join(outputDirectory, 'privacy', 'index.html'), 'utf8');
  const stylesheet = readFileSync(join(outputDirectory, 'privacy', 'style.css'), 'utf8');
  const siteStylesheet = readFileSync(join(outputDirectory, 'assets', 'main.css'), 'utf8');
  const privacyNotFoundHtml = readFileSync(join(outputDirectory, 'privacy', '404.html'), 'utf8');
  const rootNotFoundHtml = readFileSync(join(outputDirectory, '404.html'), 'utf8');
  assert(
    privacyNotFoundHtml === rootNotFoundHtml,
    'Root and privacy-scoped 404 pages must have identical content',
  );

  const privacyDocument = new JSDOM(privacyHtml, { url: PRIVACY_URL }).window.document;
  validatePrivacyMetadata(privacyDocument, stylesheet);
  validateSiteStylesheetContents(siteStylesheet, 'assets/main.css');
  for (const htmlPath of htmlFiles(outputDirectory)) {
    const html = readFileSync(htmlPath, 'utf8');
    const relativePath = relative(outputDirectory, htmlPath).split(sep).join('/');
    const url = new URL(relativePath, `${SITE_ORIGIN}${SITE_PREFIX}`).href;
    const document = new JSDOM(html, { url }).window.document;
    assert(
      !FORBIDDEN_PROSE_PUNCTUATION.test(visibleText(document)),
      `Authored prose punctuation is invalid in ${relative(rootDirectory, htmlPath)}`,
    );
    validateResources(document, relativePath);
    validateSameSiteLinks(document, htmlPath, outputDirectory);
  }
}

async function main() {
  const rootDirectory = realpathSync(resolve(process.cwd()));
  validateWorkflow(rootDirectory);
  validateStagedSite(rootDirectory);
  await validateHtml(rootDirectory, join(rootDirectory, 'dist-pages'));
  console.log('Pages artifact is valid.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

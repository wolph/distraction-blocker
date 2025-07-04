import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { HtmlValidate } from 'html-validate';
import { JSDOM } from 'jsdom';
import { parse } from 'yaml';

const SITE_ORIGIN = 'https://wolph.github.io';
const SITE_PREFIX = '/distraction-blocker/';
const PRIVACY_URL = `${SITE_ORIGIN}${SITE_PREFIX}privacy/`;
const REPOSITORY_URL = 'https://github.com/WoLpH/distraction-blocker';
const PAGE_URL_EXPRESSION = '$' + '{{ steps.deployment.outputs.page_url }}';
const REQUIRED_ACTIONS = [
  'actions/checkout@v7',
  'actions/setup-node@v7',
  'actions/configure-pages@v6',
  'actions/upload-pages-artifact@v5',
  'actions/deploy-pages@v5',
];
const FORBIDDEN_PROSE_PUNCTUATION = /[“”„‟‘’‚‛—–−‑‒…;]/u;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readRequiredFile(rootDirectory, relativePath) {
  const absolutePath = join(rootDirectory, relativePath);
  assert(existsSync(absolutePath), `Missing required file: ${relativePath}`);
  assert(statSync(absolutePath).isFile(), `Required path is not a file: ${relativePath}`);
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

function workflowSteps(workflow) {
  assert(workflow && typeof workflow === 'object', 'Workflow YAML must contain an object');
  assert(workflow.jobs && typeof workflow.jobs === 'object', 'Workflow must define jobs');
  const jobs = Object.values(workflow.jobs);
  assert(jobs.length === 1, 'Workflow must define exactly one deployment job');
  const job = jobs[0];
  assert(
    job && typeof job === 'object' && Array.isArray(job.steps),
    'Deployment job must define steps',
  );
  return { job, steps: job.steps };
}

function validateWorkflow(rootDirectory) {
  const workflow = parseWorkflow(rootDirectory);
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
    isDeepStrictEqual(workflow.permissions, {
      contents: 'read',
      pages: 'write',
      'id-token': 'write',
    }),
    'Workflow permissions must be exactly contents: read, pages: write, and id-token: write',
  );
  assert(
    isDeepStrictEqual(workflow.concurrency, { group: 'pages', 'cancel-in-progress': false }),
    'Workflow concurrency must serialize Pages deployments without cancelling an active deployment',
  );

  const { job, steps } = workflowSteps(workflow);
  assert(
    isDeepStrictEqual(job.environment, {
      name: 'github-pages',
      url: PAGE_URL_EXPRESSION,
    }),
    'Deployment job must use the github-pages environment and deployment page_url',
  );

  const actionNames = steps.map((step) => step.uses).filter(Boolean);
  for (const action of REQUIRED_ACTIONS) {
    assert(
      actionNames.filter((candidate) => candidate === action).length === 1,
      `Workflow must use ${action}`,
    );
  }

  const commands = steps.map((step) => step.run).filter(Boolean);
  for (const command of ['npm ci', 'npm run pages:build', 'npm run pages:validate']) {
    assert(commands.includes(command), `Workflow must run: ${command}`);
  }

  const uploadStep = steps.find((step) => step.uses === 'actions/upload-pages-artifact@v5');
  assert(uploadStep?.with?.path === 'dist-pages', 'Pages upload path must be exactly dist-pages');
  const deployStep = steps.find((step) => step.uses === 'actions/deploy-pages@v5');
  assert(
    deployStep?.id === 'deployment',
    'Pages deployment step must expose the standard page_url output',
  );
}

function htmlFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...htmlFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith('.html')) files.push(entryPath);
  }
  return files;
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
  const normalizedPath = relativePath.endsWith('/') ? `${relativePath}index.html` : relativePath;
  const outputPath = resolve(outputDirectory, normalizedPath);
  assert(
    outputPath === outputDirectory || outputPath.startsWith(`${outputDirectory}${sep}`),
    `Broken same-site link outside the staged site: ${url.href}`,
  );
  return outputPath;
}

function validateSameSiteLinks(document, htmlPath, outputDirectory) {
  const currentRelativePath = relative(outputDirectory, htmlPath).split(sep).join('/');
  const currentUrl = new URL(currentRelativePath, `${SITE_ORIGIN}${SITE_PREFIX}`);
  for (const element of document.querySelectorAll('[href]')) {
    const href = element.getAttribute('href');
    if (!href || /^(?:mailto|tel|data):/u.test(href)) continue;
    const targetUrl = new URL(href, currentUrl);
    if (targetUrl.origin !== SITE_ORIGIN) continue;
    const targetPath = urlToOutputPath(targetUrl, outputDirectory);
    assert(
      existsSync(targetPath) && statSync(targetPath).isFile(),
      `Broken same-site link: ${href}`,
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

function validatePrivacyMetadata(document, stylesheet) {
  assert(
    document.title === 'Focus Lock Privacy',
    'Privacy page title must be exactly Focus Lock Privacy',
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
    [...document.querySelectorAll('a[href]')].some((link) => {
      const href = link.getAttribute('href');
      return href === REPOSITORY_URL || href?.startsWith(`${REPOSITORY_URL}/`);
    }),
    `Privacy page must link to ${REPOSITORY_URL}`,
  );
  assert(
    /:focus(?:-visible)?\b/u.test(stylesheet),
    'Privacy stylesheet must provide visible focus styling',
  );
  assert(
    document.querySelectorAll('script, iframe').length === 0,
    'Privacy page must not include analytics',
  );
}

function validateStagedSite(rootDirectory) {
  const outputDirectory = join(rootDirectory, 'dist-pages');
  const privacyHtmlPath = join(outputDirectory, 'privacy', 'index.html');
  const notFoundPath = join(outputDirectory, '404.html');
  const privacyHtml = readRequiredFile(rootDirectory, 'dist-pages/privacy/index.html');
  const stylesheet = readRequiredFile(rootDirectory, 'dist-pages/privacy/style.css');
  readRequiredFile(rootDirectory, 'dist-pages/404.html');
  assert(
    !existsSync(join(outputDirectory, 'index.html')),
    'Privacy page must not be flattened to dist-pages/index.html',
  );

  const privacyDocument = new JSDOM(privacyHtml, { url: PRIVACY_URL }).window.document;
  validatePrivacyMetadata(privacyDocument, stylesheet);
  for (const htmlPath of [privacyHtmlPath, notFoundPath]) {
    const html = readFileSync(htmlPath, 'utf8');
    const url = htmlPath === privacyHtmlPath ? PRIVACY_URL : `${SITE_ORIGIN}${SITE_PREFIX}404.html`;
    const document = new JSDOM(html, { url }).window.document;
    assert(
      !FORBIDDEN_PROSE_PUNCTUATION.test(visibleText(document)),
      `Authored prose punctuation is invalid in ${relative(rootDirectory, htmlPath)}`,
    );
    validateSameSiteLinks(document, htmlPath, outputDirectory);
  }
}

async function main() {
  const rootDirectory = resolve(process.cwd());
  validateWorkflow(rootDirectory);
  validateStagedSite(rootDirectory);
  await validateHtml(rootDirectory, join(rootDirectory, 'dist-pages'));
  console.log('Pages artifact is valid.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

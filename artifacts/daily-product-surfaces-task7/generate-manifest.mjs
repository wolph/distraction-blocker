import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTask7ManifestDiagnosticsAudit } from '../../scripts/task7-manifest-diagnostics.ts';
import {
  finalizeTask7Manifest,
  parseTask7ManifestMode,
} from '../../scripts/task7-manifest-output.ts';
import { task7PngDimensions } from '../../scripts/task7-png.ts';
import { assertTask7ResolvedTheme } from '../../tests/e2e/task7-evidence.ts';

const directory = path.dirname(fileURLToPath(import.meta.url));
const manifestName = 'evidence-manifest.json';
const manifestMode = parseTask7ManifestMode(process.argv.slice(2));
const themeCases = {
  'auto-light': { colorScheme: 'light', theme: 'auto' },
  'auto-dark': { colorScheme: 'dark', theme: 'auto' },
  'light-dark-media': { colorScheme: 'dark', theme: 'light' },
  'dark-light-media': { colorScheme: 'light', theme: 'dark' },
};

function sha256(payload) {
  return createHash('sha256').update(payload).digest('hex');
}

function themeCaseFromName(name) {
  return Object.keys(themeCases).find((candidate) => name.includes(`-${candidate}-`)) ?? null;
}

function surfaceFromName(name) {
  if (name.includes('stopped-overlay')) return 'stopped-overlay';
  if (name.includes('stats')) return 'stats';
  if (name.includes('gate')) return 'gate';
  if (name.includes('popup')) return 'popup';
  if (name.includes('options')) return 'options';
  if (name.includes('privacy')) return 'privacy';
  if (name.includes('overlay')) return 'overlay';
  return 'unknown';
}

function viewportFromName(name, dimensions) {
  if (name === 'production-overlay-provenance-340-full.png') {
    return { height: dimensions.height, width: dimensions.width };
  }
  const themeCase = themeCaseFromName(name);
  const afterTheme = themeCase === null ? name : name.split(`-${themeCase}-`)[1];
  const declaredWidth = Number(afterTheme?.match(/^(340|375|768|1280)(?:-|\.)/)?.[1]);
  const width = Number.isFinite(declaredWidth) ? declaredWidth : dimensions.width;
  const height = width === 340 ? 760 : width === 375 ? 667 : 800;
  return { height, width };
}

function scopeFromName(name, dimensions, viewport) {
  if (name.endsWith('-full.png') || name.includes('-full-')) return 'full';
  if (
    name.endsWith('-focused.png') ||
    name.endsWith('-focus.png') ||
    name.includes('-categories.png') ||
    name.includes('-sticky-save') ||
    name.includes('-invalid-domain.png') ||
    name.includes('-flexible-hover.png') ||
    name.includes('-friction-focus.png')
  ) {
    return 'focused';
  }
  return dimensions.width === viewport.width ? 'full' : 'focused';
}

function stateFromName(name, themeCase) {
  let stem = name.slice(0, -4);
  const prefixes = [
    'task7-production-',
    'task7-dev-current-',
    'task7-dev-',
    'task7-options-overlap-fixed-',
    'production-',
  ];
  for (const prefix of prefixes) {
    if (stem.startsWith(prefix)) {
      stem = stem.slice(prefix.length);
      break;
    }
  }
  for (const surface of [
    'stopped-overlay-',
    'popup-',
    'options-',
    'privacy-',
    'overlay-',
    'stats-',
    'gate-',
  ]) {
    if (stem.startsWith(surface)) stem = stem.slice(surface.length);
  }
  if (themeCase !== null && stem.startsWith(`${themeCase}-`)) {
    stem = stem.slice(themeCase.length + 1);
  }
  stem = stem.replace(/^(340|375|768|1280)-/, '');
  return stem.replace(/-(full|focused)$/, '');
}

function buildSourceFromName(name) {
  return name.startsWith('task7-production-') || name.startsWith('production-')
    ? 'production'
    : 'dev';
}

async function loadReport(name) {
  return JSON.parse(await readFile(path.join(directory, name), 'utf8'));
}

function assertExactInventory(label, report, diskFiles) {
  const reportFiles = report.inventory.map((record) => record.file);
  const uniqueReportFiles = new Set(reportFiles);
  if (uniqueReportFiles.size !== reportFiles.length) {
    throw new Error(`${label} inventory contains duplicate file entries`);
  }
  const expected = [...diskFiles].sort();
  const actual = [...uniqueReportFiles].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const missing = expected.filter((file) => !uniqueReportFiles.has(file));
    const unexpected = actual.filter((file) => !diskFiles.has(file));
    throw new Error(
      `${label} inventory does not match disk: missing=${JSON.stringify(missing)}, unexpected=${JSON.stringify(unexpected)}`,
    );
  }
}

function assertProductionProvenance(report) {
  const before = report.provenance?.before;
  const after = report.provenance?.after;
  if (before === undefined || after === undefined) {
    throw new Error('Production report is missing before/after build provenance');
  }
  for (const [phase, provenance] of [
    ['before', before],
    ['after', after],
  ]) {
    if (provenance.schemaVersion !== 1) {
      throw new Error(`Production ${phase} provenance has an unsupported schema`);
    }
    if (!/^[0-9a-f]{40,64}$/.test(provenance.gitCommit ?? '')) {
      throw new Error(`Production ${phase} provenance has invalid gitCommit`);
    }
    for (const field of ['applicationSourceTreeSha256', 'distTreeSha256', 'manifestSha256']) {
      if (!/^[0-9a-f]{64}$/.test(provenance[field] ?? '')) {
        throw new Error(`Production ${phase} provenance has invalid ${field}`);
      }
    }
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error('Production build provenance changed during the evidence run');
  }
  return before;
}

const names = (await readdir(directory)).filter((name) => name !== manifestName).sort();
if (names.includes('task7-dev-options-missing-auto-light-375-full.png')) {
  throw new Error('Misnamed Task 7 Privacy capture is still present');
}

const files = [];
const screenshots = [];
for (const name of names) {
  const absolutePath = path.join(directory, name);
  const info = await stat(absolutePath);
  if (!info.isFile()) continue;
  const payload = await readFile(absolutePath);
  const fileRecord = { bytes: info.size, file: name, sha256: sha256(payload) };
  files.push(fileRecord);
  if (!name.endsWith('.png')) continue;
  const dimensions = task7PngDimensions(payload);
  const themeCase = themeCaseFromName(name);
  const viewport = viewportFromName(name, dimensions);
  screenshots.push({
    ...fileRecord,
    buildSource: buildSourceFromName(name),
    colorScheme: themeCase === null ? 'light' : themeCases[themeCase].colorScheme,
    image: dimensions,
    scope: scopeFromName(name, dimensions, viewport),
    state: stateFromName(name, themeCase),
    surface: surfaceFromName(name),
    theme: themeCase === null ? 'auto' : themeCases[themeCase].theme,
    themeCase: themeCase ?? 'auto-light',
    viewport,
  });
}

const productionReport = await loadReport('production-run-report.json');
const productionDiskFiles = new Set(
  names.filter((name) => name.startsWith('task7-production-') && name.endsWith('.png')),
);
assertExactInventory('Production', productionReport, productionDiskFiles);
if (productionReport.inventory.length !== 356) {
  throw new Error(
    `Expected 356 production matrix files, found ${productionReport.inventory.length}`,
  );
}
for (const record of productionReport.inventory) {
  const current = files.find((candidate) => candidate.file === record.file);
  if (current === undefined || current.sha256 !== record.sha256 || current.bytes !== record.bytes) {
    throw new Error(`Production checksum mismatch: ${record.file}`);
  }
}
const productionProvenance = assertProductionProvenance(productionReport);
const devCurrentReport = await loadReport('task7-dev-current-run-report.json');
const devCurrentDiskFiles = new Set(
  names.filter((name) => name.startsWith('task7-dev-current-') && name.endsWith('.png')),
);
assertExactInventory('Development current-surface', devCurrentReport, devCurrentDiskFiles);
if (devCurrentReport.inventory.length !== 320 || devCurrentReport.screenshotCount !== 320) {
  throw new Error(
    `Expected 320 reproducible development files, found ${devCurrentReport.inventory.length}`,
  );
}
for (const record of devCurrentReport.inventory) {
  const current = files.find((candidate) => candidate.file === record.file);
  if (current === undefined || current.sha256 !== record.sha256 || current.bytes !== record.bytes) {
    throw new Error(`Development checksum mismatch: ${record.file}`);
  }
  if (
    record.buildSource !== 'dev' ||
    !Array.isArray(record.assertions?.exactCopy) ||
    record.assertions.exactCopy.length === 0 ||
    typeof record.assertions?.resolvedTheme?.backgroundColor !== 'string' ||
    typeof record.assertions?.resolvedTheme?.color !== 'string' ||
    typeof record.assertions?.resolvedTheme?.colorScheme !== 'string' ||
    Object.values(record.diagnostics ?? {}).some(
      (messages) => !Array.isArray(messages) || messages.length !== 0,
    )
  ) {
    throw new Error(`Development metadata or diagnostics mismatch: ${record.file}`);
  }
  assertTask7ResolvedTheme(
    record.assertions.resolvedTheme,
    themeCases[record.themeCase],
    record.surface,
  );
  const index = screenshots.findIndex((candidate) => candidate.file === record.file);
  if (index === -1) throw new Error(`Development screenshot metadata is missing: ${record.file}`);
  screenshots[index] = record;
}

assertTask7ManifestDiagnosticsAudit(productionReport.diagnosticsAudit);
const productionDiagnosticsAudit = productionReport.diagnosticsAudit;

const reportNames = names.filter(
  (name) =>
    name.endsWith('-run-report.json') ||
    name.startsWith('task7-dev-options-run-') ||
    name.startsWith('task7-dev-privacy-run-'),
);
const runReports = [];
for (const name of reportNames) {
  const report = await loadReport(name);
  const diagnosticCounts = report.diagnosticCounts ?? report.diagnosticsAudit?.observedCounts ?? {};
  const classified = new Set(['intentionalWorkerStopMessages', 'shutdownWorkerMessages']);
  const nonzero = Object.entries(diagnosticCounts).filter(
    ([category, count]) => count !== 0 && !classified.has(category),
  );
  if (nonzero.length > 0)
    throw new Error(`Unexpected diagnostics in ${name}: ${JSON.stringify(nonzero)}`);
  runReports.push({
    buildSource: report.buildSource,
    diagnosticCounts,
    file: name,
    inventoryCount: report.inventoryCount ?? report.inventory?.length ?? 0,
    sha256: files.find((candidate) => candidate.file === name)?.sha256 ?? null,
    themeCase: report.themeCase ?? null,
    viewport: report.viewport ?? null,
  });
}

const optionReportNames = names.filter((name) => name.startsWith('task7-dev-options-run-'));
const devOptionSamples = [];
for (const name of optionReportNames) {
  const report = await loadReport(name);
  for (const state of report.geometry.states) {
    devOptionSamples.push({
      category: state.category,
      gap: state.gap,
      report: name,
      rowBottom: state.rowBottom,
      stateTop: state.stateTop,
      themeCase: report.themeCase,
      viewport: report.viewport,
    });
  }
}
if (devOptionSamples.length !== 0 || devOptionSamples.some((sample) => sample.gap < 0)) {
  throw new Error(`Invalid dev Options geometry samples: ${devOptionSamples.length}`);
}

const productionOptionSamples = productionReport.geometryAssertions.options.flatMap((entry) =>
  (entry.categoryStateGaps ?? []).map((gap) => ({
    gap,
    themeCase: entry.themeCase,
    viewport: entry.viewport,
  })),
);
if (
  productionOptionSamples.length !== 84 ||
  productionOptionSamples.some((sample) => sample.gap < 0)
) {
  throw new Error(`Invalid production Options geometry samples: ${productionOptionSamples.length}`);
}

const requiredCounts = {
  devHardClick: screenshots.filter(
    (entry) => entry.file.includes('-hard-click-') && entry.buildSource === 'dev',
  ).length,
  devOverlayProvenance: screenshots.filter((entry) =>
    entry.file.startsWith('task7-dev-current-overlay-'),
  ).length,
  devUnsupportedTab: screenshots.filter(
    (entry) => entry.file.includes('-unsupported-tab-') && entry.buildSource === 'dev',
  ).length,
  devStatsCurrent: screenshots.filter(
    (entry) =>
      entry.file.startsWith('task7-dev-current-stats-') && entry.state === 'current-language',
  ).length,
  devTypedGate: screenshots.filter(
    (entry) => entry.file.startsWith('task7-dev-current-gate-') && entry.state === 'typed-gate',
  ).length,
  devUntypedGate: screenshots.filter(
    (entry) => entry.file.startsWith('task7-dev-current-gate-') && entry.state === 'untyped-gate',
  ).length,
  devForceEndRemoved: screenshots.filter(
    (entry) => entry.buildSource === 'dev' && entry.state === 'force-end-removed',
  ).length,
  devStoppedOverlay: screenshots.filter(
    (entry) =>
      entry.file.startsWith('task7-dev-current-stopped-overlay-') &&
      entry.state === 'stopped-document',
  ).length,
  productionStatsCurrent: screenshots.filter(
    (entry) =>
      entry.file.startsWith('task7-production-stats-') && entry.state === 'current-language',
  ).length,
  productionTypedGate: screenshots.filter(
    (entry) => entry.file.startsWith('task7-production-gate-') && entry.state === 'typed-gate',
  ).length,
  productionUntypedGate: screenshots.filter(
    (entry) => entry.file.startsWith('task7-production-gate-') && entry.state === 'untyped-gate',
  ).length,
  productionForceEndRemoved: screenshots.filter(
    (entry) =>
      entry.file.startsWith('task7-production-gate-') && entry.state === 'force-end-removed',
  ).length,
  productionStoppedOverlay: screenshots.filter((entry) =>
    entry.file.startsWith('task7-production-stopped-overlay-'),
  ).length,
  productionMatrix: screenshots.filter((entry) => entry.file.startsWith('task7-production-'))
    .length,
};
if (
  requiredCounts.devHardClick !== 8 ||
  requiredCounts.devOverlayProvenance !== 24 ||
  requiredCounts.devUnsupportedTab !== 8 ||
  requiredCounts.devStatsCurrent !== 24 ||
  requiredCounts.devTypedGate !== 24 ||
  requiredCounts.devUntypedGate !== 24 ||
  requiredCounts.devForceEndRemoved !== 0 ||
  requiredCounts.devStoppedOverlay !== 24 ||
  requiredCounts.productionStatsCurrent !== 24 ||
  requiredCounts.productionTypedGate !== 24 ||
  requiredCounts.productionUntypedGate !== 24 ||
  requiredCounts.productionForceEndRemoved !== 0 ||
  requiredCounts.productionStoppedOverlay !== 24 ||
  requiredCounts.productionMatrix !== 356
) {
  throw new Error(`Required evidence count mismatch: ${JSON.stringify(requiredCounts)}`);
}

function buildManifest(generatedAt) {
  return {
    schemaVersion: 2,
    generatedAt,
    buildSources: {
      dev: { server: 'http://127.0.0.1:4177' },
      production: {
        ...productionProvenance,
        extensionId: productionReport.extensionId,
      },
    },
    counts: {
      filesExcludingManifest: files.length,
      screenshots: screenshots.length,
      supportFiles: files.length - screenshots.length,
      ...requiredCounts,
    },
    diagnostics: {
      production: productionDiagnosticsAudit,
      runs: runReports,
    },
    geometryAssertions: {
      devOptionsCategorySamples: devOptionSamples,
      devOptionsSummary: {
        count: devOptionSamples.length,
        source:
          'Per-file copy, viewport, diagnostics, and checksum assertions are in the development inventory. Intersection geometry is asserted by the runner and production report.',
      },
      productionOptionsCategorySamples: productionOptionSamples,
      productionOptionsSummary: {
        count: productionOptionSamples.length,
        maximumGap: Math.max(...productionOptionSamples.map((sample) => sample.gap)),
        minimumGap: Math.min(...productionOptionSamples.map((sample) => sample.gap)),
      },
      production: productionReport.geometryAssertions,
    },
    matrix: {
      developmentCurrent: {
        inventory: devCurrentReport.inventory,
        screenshotCount: devCurrentReport.screenshotCount,
        sourceHarnesses: devCurrentReport.sourceHarnesses,
      },
      production: productionReport.matrix,
      themeCases,
    },
    files,
    screenshots,
    manifestChecksumRule:
      'files excludes evidence-manifest.json so the manifest does not hash itself',
  };
}

const manifestPath = path.join(directory, manifestName);
const output = await finalizeTask7Manifest({
  build: buildManifest,
  manifestPath,
  mode: manifestMode,
});
const manifest = buildManifest('');
console.log(
  JSON.stringify({ manifest: manifestPath, mode: output, counts: manifest.counts }, null, 2),
);

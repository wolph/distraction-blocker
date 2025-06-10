import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface EvidenceArtifact {
  bytes: number;
  path: string;
  sha256: string;
}

export interface RuntimeApiInterception {
  behavior: 'hold-pending' | 'throw-once';
  expectedCount: number;
  observedCount: number;
  passthrough: 'all-other-calls';
  purpose: string;
  requestType: 'completeOnboarding' | 'getSetupState';
  scope: 'chrome.runtime.sendMessage';
  state: 'step-3-pending-completion' | 'load-error-retry';
}

export type RuntimeApiInterceptionDefinition = Omit<RuntimeApiInterception, 'observedCount'>;

export interface RuntimeApiInterceptionObservation {
  requestType: RuntimeApiInterception['requestType'];
  state: RuntimeApiInterception['state'];
}

export const PRODUCTION_RUNTIME_API_INTERCEPTIONS: readonly RuntimeApiInterceptionDefinition[] = [
  {
    scope: 'chrome.runtime.sendMessage',
    state: 'step-3-pending-completion',
    requestType: 'completeOnboarding',
    behavior: 'hold-pending',
    passthrough: 'all-other-calls',
    expectedCount: 12,
    purpose: 'Keep the completion request pending so the disabled pending UI can be captured.',
  },
  {
    scope: 'chrome.runtime.sendMessage',
    state: 'load-error-retry',
    requestType: 'getSetupState',
    behavior: 'throw-once',
    passthrough: 'all-other-calls',
    expectedCount: 12,
    purpose:
      'Fail the first setup-state load so the error and successful Retry UI can be captured.',
  },
];

export function runtimeApiInterceptionsFromObservations(
  observations: readonly RuntimeApiInterceptionObservation[],
): RuntimeApiInterception[] {
  return PRODUCTION_RUNTIME_API_INTERCEPTIONS.map(
    (definition: RuntimeApiInterceptionDefinition): RuntimeApiInterception => ({
      ...definition,
      observedCount: observations.filter(
        (observation: RuntimeApiInterceptionObservation): boolean =>
          observation.state === definition.state &&
          observation.requestType === definition.requestType,
      ).length,
    }),
  );
}

export interface VisualEvidenceManifest {
  artifactCount: number;
  artifacts: EvidenceArtifact[];
  chromeVersion: string;
  runtimeApiInterceptions: RuntimeApiInterception[];
  sourceCommit: string;
  stateCount: number;
  states: string[];
  themes: string[];
  viewportWidths: number[];
}

export interface WriteVisualEvidenceManifestOptions {
  chromeVersion: string;
  evidenceDir: string;
  sourceCommit: string;
  states: string[];
  themes: string[];
  viewportWidths: number[];
  runtimeApiInterceptions: RuntimeApiInterception[];
}

const PNG_SIGNATURE: Buffer = Buffer.from('89504e470d0a1a0a', 'hex');

export async function writeVisualEvidenceManifest(
  options: WriteVisualEvidenceManifestOptions,
): Promise<VisualEvidenceManifest> {
  const artifactNames: string[] = (await readdir(options.evidenceDir))
    .filter((name: string): boolean => name.endsWith('.png'))
    .sort((left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0));
  const artifacts: EvidenceArtifact[] = await Promise.all(
    artifactNames.map(async (name: string): Promise<EvidenceArtifact> => {
      const contents: Buffer = await readFile(path.join(options.evidenceDir, name));
      if (!contents.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
        throw new Error(`${name} does not contain PNG image data`);
      }
      return {
        path: name,
        bytes: contents.byteLength,
        sha256: createHash('sha256').update(contents).digest('hex'),
      };
    }),
  );
  for (const interception of options.runtimeApiInterceptions) {
    if (interception.observedCount !== interception.expectedCount) {
      throw new Error(
        `${interception.state} observed ${interception.observedCount} of ${interception.expectedCount} expected interceptions`,
      );
    }
  }
  const manifest: VisualEvidenceManifest = {
    artifactCount: artifacts.length,
    artifacts,
    chromeVersion: options.chromeVersion,
    runtimeApiInterceptions: options.runtimeApiInterceptions,
    sourceCommit: options.sourceCommit,
    stateCount: options.states.length,
    states: options.states,
    themes: options.themes,
    viewportWidths: options.viewportWidths,
  };
  await writeFile(
    path.join(options.evidenceDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

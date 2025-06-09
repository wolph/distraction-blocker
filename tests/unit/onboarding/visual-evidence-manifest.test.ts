import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PRODUCTION_RUNTIME_API_INTERCEPTIONS,
  type RuntimeApiInterception,
  writeVisualEvidenceManifest,
} from '../../e2e/onboarding-visual-manifest';

let temporaryDirectory: string | null = null;

afterEach(async (): Promise<void> => {
  if (temporaryDirectory !== null) await rm(temporaryDirectory, { recursive: true });
  temporaryDirectory = null;
});

describe('onboarding visual evidence manifest', (): void => {
  it('hashes every PNG and discloses each scoped runtime interception', async (): Promise<void> => {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'focus-lock-visual-manifest-'));
    const contents: Buffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    await writeFile(path.join(temporaryDirectory, 'example.png'), contents);
    const runtimeApiInterceptions: RuntimeApiInterception[] =
      PRODUCTION_RUNTIME_API_INTERCEPTIONS.map(
        (definition): RuntimeApiInterception => ({
          ...definition,
          observedCount: definition.expectedCount,
        }),
      );

    const manifest = await writeVisualEvidenceManifest({
      chromeVersion: '151.0.7922.34',
      evidenceDir: temporaryDirectory,
      sourceCommit: 'abc123',
      states: ['step-3-pending-completion', 'load-error-retry'],
      themes: ['auto-dark'],
      viewportWidths: [375],
      runtimeApiInterceptions,
    });

    expect(manifest.artifactCount).toBe(1);
    expect(manifest.artifacts).toEqual([
      {
        path: 'example.png',
        bytes: contents.byteLength,
        sha256: createHash('sha256').update(contents).digest('hex'),
      },
    ]);
    expect(manifest.runtimeApiInterceptions).toEqual(runtimeApiInterceptions);
    expect(manifest.runtimeApiInterceptions).toEqual([
      {
        scope: 'chrome.runtime.sendMessage',
        state: 'step-3-pending-completion',
        requestType: 'completeOnboarding',
        behavior: 'hold-pending',
        passthrough: 'all-other-calls',
        expectedCount: 12,
        observedCount: 12,
        purpose: 'Keep the completion request pending so the disabled pending UI can be captured.',
      },
      {
        scope: 'chrome.runtime.sendMessage',
        state: 'load-error-retry',
        requestType: 'getSetupState',
        behavior: 'throw-once',
        passthrough: 'all-other-calls',
        expectedCount: 12,
        observedCount: 12,
        purpose:
          'Fail the first setup-state load so the error and successful Retry UI can be captured.',
      },
    ]);
    expect(
      JSON.parse(await readFile(path.join(temporaryDirectory, 'manifest.json'), 'utf8')),
    ).toEqual(manifest);
  });

  it('rejects a file that has a PNG name without PNG image data', async (): Promise<void> => {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'focus-lock-visual-manifest-'));
    await writeFile(path.join(temporaryDirectory, 'renamed-text.png'), 'not a PNG');

    await expect(
      writeVisualEvidenceManifest({
        chromeVersion: '151.0.7922.34',
        evidenceDir: temporaryDirectory,
        sourceCommit: 'abc123',
        states: [],
        themes: [],
        viewportWidths: [],
        runtimeApiInterceptions: [],
      }),
    ).rejects.toThrow('renamed-text.png does not contain PNG image data');
  });
});

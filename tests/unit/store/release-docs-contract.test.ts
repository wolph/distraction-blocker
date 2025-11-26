import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import manifestDefinition from '../../../manifest.config';
import { DEFAULT_SETTINGS, EVENT_LOG_CAP } from '../../../src/shared/constants';
import {
  LOCAL_EVENTS,
  LOCAL_RUNTIME,
  LOCAL_RUNTIME_MIGRATION,
  LOCAL_RUNTIME_SCHEMA,
  SYNC_BANK,
  SYNC_LISTS,
  SYNC_SETTINGS,
  SYNC_STREAK,
} from '../../../src/shared/storage-keys';

interface ReleaseManifest {
  optional_host_permissions?: string[];
  permissions?: string[];
}

interface DocumentPaths {
  disclosures: string;
  listing: string;
  permissionJustifications: string;
  privacy: string;
  readme: string;
  reviewer: string;
}

const LISTING_OPENER: string =
  'Focus Lock blocks distracting websites during deliberate focus sessions. Choose what gets blocked, decide how difficult early exit should be, and earn bounded pauses without losing the state of pages you already had open.';

/** The worker-dependent limit the spec requires store-facing trust documentation to state. */
const WORKER_BOUNDARY: string =
  "Blocking is enforced by the extension's service worker. If Chrome has not woken the worker when a page starts loading, that page can load before the block applies. Focus Lock does not use declarativeNetRequest rules.";

const DOCUMENT_PATHS: DocumentPaths = {
  disclosures: 'store/privacy-disclosures.md',
  listing: 'store/listing.md',
  permissionJustifications: 'store/permission-justifications.md',
  privacy: 'docs/privacy/index.html',
  readme: 'README.md',
  reviewer: 'store/reviewer-instructions.md',
};

function readDocument(path: string): string {
  return readFileSync(path, 'utf8');
}

function normalizedDocument(path: string): string {
  return readDocument(path).replace(/\s+/g, ' ').trim();
}

async function releaseManifest(): Promise<ReleaseManifest> {
  const resolved: unknown = await manifestDefinition;
  if (typeof resolved === 'function') {
    return (await resolved({ command: 'build', mode: 'production' })) as ReleaseManifest;
  }
  return resolved as ReleaseManifest;
}

describe('Chrome Web Store release documentation contract', (): void => {
  it('maps every manifest permission to a shipped user-facing behavior', async (): Promise<void> => {
    const manifest: ReleaseManifest = await releaseManifest();
    const declared: string[] = [
      ...(manifest.permissions ?? []),
      ...(manifest.optional_host_permissions ?? []),
    ];
    const justificationSource: string = readDocument(DOCUMENT_PATHS.permissionJustifications);
    const justificationRows: string[] = justificationSource
      .split('\n')
      .filter((line: string): boolean => line.startsWith('| `'));
    const justifications: string = normalizedDocument(DOCUMENT_PATHS.permissionJustifications);

    expect(declared).not.toHaveLength(0);
    for (const permission of declared) {
      expect(
        justificationRows.some((row: string): boolean => row.includes(`\`${permission}\``)),
        permission,
      ).toBe(true);
    }
    expect(justifications).toContain('shipped user-facing behavior');
    expect(justifications).not.toContain('reviewer-visible behavior');
  });

  it('keeps retention values and local history deletion aligned with storage code', (): void => {
    const privacy: string = normalizedDocument(DOCUMENT_PATHS.privacy);
    const disclosures: string = normalizedDocument(DOCUMENT_PATHS.disclosures);
    const storageSource: string = readDocument('src/background/policy-storage.ts');
    const historyKeysStart: number = storageSource.indexOf('function localHistoryRemovalKeys(');
    const historyKeysEnd: number = storageSource.indexOf(
      'function withoutAggregateHistory(',
      historyKeysStart,
    );
    const historyKeysSource: string = storageSource.slice(historyKeysStart, historyKeysEnd);

    expect(EVENT_LOG_CAP).toBe(50_000);
    expect(DEFAULT_SETTINGS.retentionDays).toBe(90);
    for (const document of [privacy, disclosures]) {
      expect(document).toContain(EVENT_LOG_CAP.toLocaleString('en-US'));
      expect(document).toContain(`${DEFAULT_SETTINGS.retentionDays} days`);
    }
    expect(LOCAL_EVENTS).toBe('events');
    expect(LOCAL_RUNTIME).toBe('runtime');
    expect([SYNC_SETTINGS, SYNC_LISTS, SYNC_BANK, SYNC_STREAK]).toEqual([
      'settings',
      'lists',
      'bank',
      'streak',
    ]);
    expect(historyKeysSource).toContain('[LOCAL_EVENTS]');
    expect(historyKeysSource).not.toContain('LOCAL_RUNTIME');
    expect(disclosures).toContain('| Full URLs | Yes | No | No |');
    expect(disclosures).toContain('| Live session, gates, and temporary unlocks | Yes | No | No |');
    expect(disclosures).toContain(
      '| Settings and block or allow lists | Working copy | Yes | No |',
    );
    expect(disclosures).toContain('| Pause balance and streaks | Working copy | Yes | No |');
    expect(disclosures).toContain(
      '| Daily and monthly session totals and domain-level blocked-attempt counts | Working copy for this device | Yes | No |',
    );
  });

  it('qualifies local deletion anywhere release copy promises it', (): void => {
    const paths: string[] = [
      DOCUMENT_PATHS.privacy,
      DOCUMENT_PATHS.disclosures,
      DOCUMENT_PATHS.reviewer,
      DOCUMENT_PATHS.listing,
      DOCUMENT_PATHS.readme,
    ];

    for (const path of paths) {
      const document: string = normalizedDocument(path);
      expect(document, path).toContain('historical full URLs');
      expect(document, path).toContain('from the local event log');
      expect(document, path).toContain('does not clear the current live-session runtime');
      expect(document, path).toContain('URL and intention state');
      expect(document, path).toContain('remains until that live state ends');
    }
  });

  it('states the extension and developer Chrome Sync ownership boundary', (): void => {
    const paths: string[] = [
      DOCUMENT_PATHS.privacy,
      DOCUMENT_PATHS.disclosures,
      DOCUMENT_PATHS.listing,
      DOCUMENT_PATHS.readme,
    ];

    for (const path of paths) {
      const document: string = normalizedDocument(path);
      expect(document, path).toContain(
        "Focus Lock reads, writes, and deletes the disclosed Chrome Sync data through Chrome's extension APIs.",
      );
      expect(document, path).toContain('The developer does not receive or retain a separate copy.');
    }
    expect(normalizedDocument(DOCUMENT_PATHS.disclosures)).not.toContain(
      'Focus Lock does not receive or control Chrome Sync data.',
    );
  });

  it('keeps the exact listing opener', (): void => {
    expect(readDocument(DOCUMENT_PATHS.listing).split('\n', 1)[0]).toBe(LISTING_OPENER);
  });

  it('states the worker-dependent blocking boundary where users read it', (): void => {
    for (const path of [DOCUMENT_PATHS.listing, DOCUMENT_PATHS.privacy]) {
      expect(normalizedDocument(path), path).toContain(WORKER_BOUNDARY);
    }
  });

  it('describes what the tabs permission sends to the packaged blocking script', (): void => {
    const justifications: string = normalizedDocument(DOCUMENT_PATHS.permissionJustifications);

    expect(justifications).toContain(
      'sends frozen enforcement commands and epoch resets to the packaged blocking script',
    );
  });

  it('lists every local runtime key as local only', (): void => {
    const disclosures: string = normalizedDocument(DOCUMENT_PATHS.disclosures);

    expect([LOCAL_RUNTIME, LOCAL_RUNTIME_SCHEMA, LOCAL_RUNTIME_MIGRATION, LOCAL_EVENTS]).toEqual([
      'runtime',
      'runtimeSchema',
      'runtimeMigration',
      'events',
    ]);
    for (const key of [
      LOCAL_RUNTIME,
      LOCAL_RUNTIME_SCHEMA,
      LOCAL_RUNTIME_MIGRATION,
      LOCAL_EVENTS,
    ]) {
      expect(disclosures, key).toContain(`\`${key}\``);
    }
    expect(disclosures).toContain(
      'The local runtime keys `runtime`, `runtimeSchema`, `runtimeMigration`, and `events` are local only.',
    );
  });

  it('selects URL and user data categories without selecting website content', (): void => {
    const disclosures: string = readDocument(DOCUMENT_PATHS.disclosures);

    expect(disclosures).toMatch(/^- \[x\] Web history,/m);
    expect(disclosures).toMatch(/^- \[x\] User activity,/m);
    expect(disclosures).toMatch(/^- \[x\] User-provided content,/m);
    expect(disclosures).toMatch(/^- \[ \] Website content[,:]/m);
    expect(disclosures).not.toMatch(/^- \[x\] Website content[,:]/m);
    expect(disclosures).toContain('packaged blocking interface');
    expect(disclosures).toContain('does not inspect or collect page text');
  });
});

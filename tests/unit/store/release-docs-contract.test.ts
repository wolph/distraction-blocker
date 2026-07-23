import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import manifestDefinition from '../../../manifest.config';
import { DEFAULT_SETTINGS, EVENT_LOG_CAP } from '../../../src/shared/constants';
import {
  LOCAL_EVENTS,
  LOCAL_RUNTIME,
  LOCAL_V2_SESSION_AUTHORITY_KEYS,
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
  'Focus Lock blocks distracting websites during deliberate focus sessions. Choose what gets blocked, decide how difficult early exit should be, and earn bounded site access credit without losing the state of pages you already had open.';

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
    // The negative half was one-sided: `local.remove('runtime')` or a renamed constant makes the
    // privacy claim false and leaves this passing. Pin the whole removal set instead, so a key
    // added by any spelling has to show up here.
    expect(historyKeysSource).not.toContain('LOCAL_RUNTIME');
    expect(historyKeysSource).not.toContain('runtime');
    const removalKeys: string[] = [...historyKeysSource.matchAll(/\[([A-Z_]+)\]/g)].map(
      (match: RegExpMatchArray): string => match[1] ?? '',
    );
    expect(removalKeys).toEqual(['LOCAL_EVENTS']);
    expect(disclosures).toContain('| Full URLs | Yes | No | No |');
    expect(disclosures).toContain('| Live session, gates, and temporary unlocks | Yes | No | No |');
    expect(disclosures).toContain(
      '| Settings and block or allow lists | Working copy | Yes | No |',
    );
    expect(disclosures).toContain('| Site access credit and streaks | Working copy | Yes | No |');
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
      // The qualification has to name what is held and say what bounds it. Before the indefinite
      // session there was always a timer, so "remains until that live state ends" was a bound. It
      // is not one now, and copy that stops at the old phrasing has to fail here.
      expect(document, path).toContain('focus intention');
      expect(document, path).toContain('address of every website tab');
      expect(document, path).toContain('run until stopped');
      // The cleanup batch covers every enforceable target, and `classifyEnforcementTargetV2` calls
      // any top-frame http or https document enforceable whether or not it was blocked, so copy
      // must not shrink that set to the pages the session blocked. The closure runner empties the
      // command map in the write that removes its journal, so copy has to make that promise as
      // well, and the older wording that left the batch for the next session to replace is a
      // description of retention the code no longer has.
      expect(document, path).toContain('removes every one of them when it completes');
      expect(document, path).not.toContain('addresses of the pages');
      expect(document, path).not.toContain('the next session replaces them');
      // No shipped surface starts an all-scope clear: `Confirmation` in `options/PrivacyData.tsx`
      // admits only local history and synced policy, and the one `'all'` branch there retries a
      // clear that is already stuck. Copy must not offer deleting all data as the way out.
      expect(document, path).not.toContain('all Focus Lock data is deleted');
      expect(document, path).not.toContain('delete all Focus Lock data');
    }
  });

  // A qualification that ends by pointing at a section the document does not have is worse than no
  // pointer, because the reader is sent somewhere for the part that actually bounds the retention.
  // Substring checks cannot catch that, so resolve the cross-reference itself.
  it('resolves every Retention cross-reference in release copy', (): void => {
    const sections: Record<string, RegExp> = {
      [DOCUMENT_PATHS.privacy]: /id="retention"/,
      [DOCUMENT_PATHS.disclosures]: /^#{2,3} Retention/m,
      [DOCUMENT_PATHS.reviewer]: /^#{2,3} Retention/m,
      [DOCUMENT_PATHS.listing]: /^#{2,3} Retention/m,
      [DOCUMENT_PATHS.readme]: /^#{2,3} Retention/m,
    };

    for (const [path, heading] of Object.entries(sections)) {
      const pointer: boolean = /See Retention|Retention below/.test(normalizedDocument(path));
      if (!pointer) continue;
      // The heading has to be matched against the raw file: `normalizedDocument` collapses every
      // newline, so a line-anchored heading pattern can never match its output.
      expect(
        heading.test(readDocument(path)),
        `${path} points at a Retention section it does not have`,
      ).toBe(true);
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

  it('lists every local session authority key as local only', (): void => {
    // Derived from the exported key list rather than a copy of it. A key that joins the authority
    // set now fails here until the disclosure names it, which a hardcoded list of four could not
    // do: that is how `dataClearJournal` reached the archive unnamed.
    const disclosures: string = normalizedDocument(DOCUMENT_PATHS.disclosures);
    const sentence: RegExpExecArray | null = /The local runtime keys ([^.]+) are local only\./.exec(
      disclosures,
    );
    if (sentence === null) throw new Error('the disclosures no longer name the local runtime keys');

    const named: string[] = [...(sentence[1] ?? '').matchAll(/`([^`]+)`/g)]
      .map((match: RegExpMatchArray): string => match[1] ?? '')
      .sort();

    expect(named).toEqual([...LOCAL_V2_SESSION_AUTHORITY_KEYS].sort());
    for (const key of LOCAL_V2_SESSION_AUTHORITY_KEYS) {
      expect(disclosures, key).toContain(`\`${key}\``);
    }
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

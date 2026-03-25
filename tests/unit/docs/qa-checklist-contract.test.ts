import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BEGIN,
  type E2eSpecFile,
  END,
  e2eScenarios,
  generatedBlock,
  type UnitTestFiles,
  unitTestFiles,
} from '../../../scripts/qa-checklist.mjs';

const ROOT: string = path.resolve(__dirname, '../../..');
const CHECKLIST: string = path.join(ROOT, 'docs/qa-checklist.md');

function checklist(): string {
  return readFileSync(CHECKLIST, 'utf8');
}

/**
 * The guard the four stale counts needed and did not have. `release-docs-contract` derives the
 * local key list from the code and fails when the published documents disagree. This is the same
 * rule for the QA checklist, whose most recent typed sign-off covered 41 per cent of the tests
 * that existed by the time anyone checked.
 */
describe('QA checklist contract', (): void => {
  it('carries an inventory identical to what the suites say right now', async (): Promise<void> => {
    const document: string = checklist();
    const start: number = document.indexOf(BEGIN);
    const finish: number = document.indexOf(END);

    expect(start, 'the checklist has lost its generated block').toBeGreaterThan(-1);
    expect(finish).toBeGreaterThan(start);
    expect(document.slice(start, finish + END.length)).toBe(await generatedBlock(ROOT));
  }, 30_000);

  it('counts end-to-end scenarios the way the runner does, not the way a grep would', (): void => {
    // The grep this replaces was wrong twice over: `test.skip` is listed and reported but does not
    // match a `^test(` anchor, and a spec file added after the grep was written is invisible to it.
    const scenarios: E2eSpecFile[] = e2eScenarios(ROOT);
    const listed: number = scenarios.reduce(
      (sum: number, entry: E2eSpecFile): number => sum + entry.titles.length,
      0,
    );
    const sources: string = scenarios
      .map((entry: E2eSpecFile): string =>
        readFileSync(path.join(ROOT, 'tests/e2e', entry.file), 'utf8'),
      )
      .join('\n');
    const anchored: number = (sources.match(/^test\(/gm) ?? []).length;

    expect(listed).toBeGreaterThan(0);
    expect(listed).toBeGreaterThanOrEqual(anchored);
    expect(checklist()).toContain(`**${listed} scenarios in ${scenarios.length} spec files**`);
  }, 30_000);

  it('counts unit files through the pattern Vitest is configured with', async (): Promise<void> => {
    const unit: UnitTestFiles = await unitTestFiles(ROOT);
    const config: string = readFileSync(path.join(ROOT, 'vitest.config.ts'), 'utf8');

    expect(config).toContain(unit.pattern);
    expect(checklist()).toContain(`**${unit.files.length} files** matching \`${unit.pattern}\``);
  });

  it('keeps no typed count outside the generated block', (): void => {
    const document: string = checklist();
    const signed: string = document.slice(document.indexOf('## Signed judgements'));
    // A count in a signed section is a machine fact wearing a signature, which is what rotted.
    // Viewport widths and version numbers are not counts, so the pattern asks for a bare integer
    // followed by a countable noun.
    const counts: RegExpMatchArray | null = signed.match(
      /\b\d[\d,]*\s+(tests?|test files?|scenarios?|files?|screenshots?|captures?|records?)\b/i,
    );

    expect(counts, `a signed section states a count: ${counts?.[0] ?? ''}`).toBeNull();
  });

  it('admits the evidence that was not preserved instead of dropping it', (): void => {
    const document: string = checklist();

    expect(document).toContain('## Evidence that was not preserved');
    expect(document).toContain('.playwright-mcp/qa-final/');
    expect(document).toContain('test-results/');
    // Every surviving evidence pointer has to be tracked or digest-pinned, which is the rule the
    // losses established. A pointer into either dead location outside that section is a relapse.
    const above: string = document.slice(0, document.indexOf('## Evidence that was not preserved'));
    expect(above).not.toContain('.playwright-mcp/');
    expect(above).not.toContain('test-results/');
  });
});

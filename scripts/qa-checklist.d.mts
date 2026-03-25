/**
 * Declarations for the QA checklist generator, following the precedent set by
 * `docs/qa-artifacts/onboarding-task6/verify-lib.d.mts`: the tool stays plain JavaScript so it can
 * be run with bare `node`, and the contract test gets real types rather than an `any` import.
 */
export const BEGIN: string;
export const END: string;

export interface UnitTestFiles {
  pattern: string;
  files: string[];
}

export interface E2eSpecFile {
  file: string;
  titles: string[];
}

export function unitTestFiles(repoRoot?: string): Promise<UnitTestFiles>;
export function e2eScenarios(repoRoot?: string): E2eSpecFile[];
export function generatedBlock(repoRoot?: string): Promise<string>;

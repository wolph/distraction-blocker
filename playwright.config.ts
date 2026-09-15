import { defineConfig } from '@playwright/test';

/**
 * The store screenshot scenarios compare byte-exact PNGs captured on the release machine and refuse
 * any build other than the one they record. They belong to the release gate, where the captures are
 * refreshed, and cannot pass on a CI runner with different fonts and a newer build.
 */
const skipReleaseCaptures: boolean = process.env.FOCUS_LOCK_SKIP_RELEASE_CAPTURES === '1';

export default defineConfig({
  globalSetup: './tests/e2e/global-setup.ts',
  testDir: 'tests/e2e',
  testIgnore: skipReleaseCaptures ? ['**/store-screenshots.spec.ts'] : [],
  timeout: 60_000,
  workers: 1,
  use: { trace: 'retain-on-failure' },
});

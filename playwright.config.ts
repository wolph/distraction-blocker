import { defineConfig } from '@playwright/test';

export default defineConfig({
  globalSetup: './tests/e2e/global-setup.ts',
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,
  use: { trace: 'retain-on-failure' },
});

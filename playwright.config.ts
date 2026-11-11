import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: 'test-results/playwright',
  reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/playwright.json' }]],
  use: { ignoreHTTPSErrors: true, locale: 'en-US', timezoneId: 'UTC', trace: 'retain-on-failure', screenshot: 'only-on-failure', actionTimeout: 10000 },
  projects: [
    { name: 'iphone-webkit', use: { ...devices['iPhone 15'], browserName: 'webkit' } },
    { name: 'iphone-standalone', use: { ...devices['iPhone 15'], browserName: 'webkit' } },
    { name: 'desktop-webkit', use: { browserName: 'webkit', viewport: { width: 1440, height: 1000 } } },
    { name: 'desktop-chromium', use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 } } },
  ],
});

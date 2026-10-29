import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test',
  testMatch: 'browser.spec.js',
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: 'http://127.0.0.1:3199',
    browserName: process.env.BROWSER_ENGINE || 'chromium',
    headless: true,
    launchOptions: process.env.BROWSER_EXECUTABLE
      ? { executablePath: process.env.BROWSER_EXECUTABLE }
      : {},
  },
  webServer: {
    command: 'node test/browser-server.mjs',
    url: 'http://127.0.0.1:3199/health',
    reuseExistingServer: false,
    timeout: 30000,
  },
  reporter: 'list',
});

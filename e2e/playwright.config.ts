import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 10 * 60 * 1000,
  expect: { timeout: 30 * 1000 },
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost',
    headless: process.env.HEADED ? false : true,
    trace: 'on-first-retry'
  }
});

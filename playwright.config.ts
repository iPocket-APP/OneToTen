import { defineConfig } from '@playwright/test';

const external = process.env.FILE_ROOM_TEST_URL;
const baseURL = external ?? 'http://127.0.0.1:5173';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  use: { baseURL, locale: 'zh-CN', screenshot: 'only-on-failure' },
  webServer: external ? undefined : {
    command: 'npm exec -- vite --host 127.0.0.1 --mode test',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});


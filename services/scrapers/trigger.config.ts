import { defineConfig } from '@trigger.dev/sdk';
import { playwright } from '@trigger.dev/build/extensions/playwright';

export default defineConfig({
  project: 'proj_eigtroxsysxjbjgeyuql',
  runtime: 'node-22',
  logLevel: 'info',
  maxDuration: 3600,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      factor: 2,
      minTimeoutInMs: 10_000,
      maxTimeoutInMs: 120_000,
      randomize: true,
    },
  },
  build: {
    // Trinidad eGP scraper drives Chromium via Playwright (TT's portal
    // sits behind a JS challenge that defeats plain HTTP fetches). The
    // playwright() extension installs the browser + its system deps in
    // the deploy image. Default headless Chromium is what we use.
    extensions: [playwright()],
  },
  dirs: ['./src/trigger/scheduled'],
});

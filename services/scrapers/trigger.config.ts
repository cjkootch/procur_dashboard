import { defineConfig } from '@trigger.dev/sdk/v3';

export default defineConfig({
  project: 'proj_eigtroxsysxjbjgeyuql',
  runtime: 'node',
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
  // Only bundle cheerio-based scrapers (Jamaica + Guyana) for now.
  // Trinidad uses Playwright which needs a build extension that isn't in
  // this pinned trigger.dev version; we'll re-enable once the @trigger.dev
  // packages can be upgraded.
  dirs: ['./src/trigger/scheduled'],
});

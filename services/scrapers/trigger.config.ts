import { defineConfig } from '@trigger.dev/sdk/v3';

export default defineConfig({
  project: 'procur-scrapers',
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
  dirs: ['./src/trigger'],
});

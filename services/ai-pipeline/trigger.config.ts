import { defineConfig } from '@trigger.dev/sdk/v3';

export default defineConfig({
  project: 'proj_jfecvhrkzlltppanqzkv',
  runtime: 'node',
  logLevel: 'info',
  maxDuration: 900,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      factor: 2,
      minTimeoutInMs: 5_000,
      maxTimeoutInMs: 60_000,
      randomize: true,
    },
  },
  dirs: ['./src/trigger'],
});

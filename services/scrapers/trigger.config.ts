import { defineConfig } from '@trigger.dev/sdk';

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
  // Only bundle cheerio-based scrapers from `./scheduled`. Trinidad's
  // task file lives under src/trigger/ (outside the glob) because it
  // needs Playwright/Chromium and the @trigger.dev/build@4.4.4
  // playwright() extension currently fails the deploy build with a
  // hard-coded grep for chromium-headless-shell that doesn't match
  // playwright install --dry-run output. See scrape-trinidad.ts for
  // the re-enable plan.
  // Awards extractors (./src/trigger/awards) are env-gated individually
  // (JM_AWARDS_EXTRACTOR_ENABLED, TED_AWARDS_EXTRACTOR_ENABLED,
  // UNGM_AWARDS_EXTRACTOR_ENABLED). Including the dir bundles them;
  // without the env flag set, each task no-ops at run time.
  dirs: ['./src/trigger/scheduled', './src/trigger/awards'],
});

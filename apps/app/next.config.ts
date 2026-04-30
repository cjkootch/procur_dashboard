import { withSentryConfig } from '@sentry/nextjs';
import type { NextConfig } from 'next';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },
  experimental: {
    serverActions: {
      // Library file upload ingests PDFs up to 15 MB.
      bodySizeLimit: '16mb',
    },
  },
  // Sentry + OpenTelemetry emit critical-dependency warnings because their
  // tracer dynamically requires platform modules. Safe to ignore.
  webpack(config) {
    config.ignoreWarnings = [
      ...(config.ignoreWarnings ?? []),
      { module: /@opentelemetry\/instrumentation/ },
      { module: /require-in-the-middle/ },
    ];
    return config;
  },
};

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: "auto-tech-consulting-llc",

  project: "javascript-nextjs",

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Delete the source-map files from the Vercel build output after
  // uploading them to Sentry. They've already done their job (Sentry
  // resolves stack traces server-side via debug-id) — keeping them
  // in the deployed bundle just bloats cold-start payload and serves
  // them publicly. Silences the build-time warning the SDK emits
  // when this is unset.
  sourcemaps: {
    deleteSourcemapsAfterUpload: true,
  },

  // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  tunnelRoute: "/monitoring",

  // The wizard's generated config nested `automaticVercelMonitors` and
  // `treeshake.removeDebugLogging` under a `webpack` block — those are
  // v9+ options. We're on @sentry/nextjs ^8.x so they'd type-error.
  // Both are nice-to-have (we don't use Vercel Cron; trigger.dev runs
  // our jobs), so dropped.
});

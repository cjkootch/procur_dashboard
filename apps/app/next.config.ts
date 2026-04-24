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

export default nextConfig;

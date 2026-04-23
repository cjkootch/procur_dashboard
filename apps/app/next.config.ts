import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },
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

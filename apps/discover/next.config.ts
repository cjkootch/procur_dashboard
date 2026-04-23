import type { NextConfig } from 'next';
import { config as loadEnv } from 'dotenv';

// Next only auto-loads .env files from the app's working directory. In a
// monorepo, credentials live at the repo root so every app sees the same
// values. Load those first; local .env.local in-app (if any) then overrides.
loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },
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

import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // This app lives in a subdirectory of the kompass monorepo, which has its
  // own root pnpm-lock.yaml — pin the trace root here so Next.js doesn't try
  // to infer it (and warn) from the parent lockfile.
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;

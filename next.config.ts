import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  // No remote images and no runtime image cache writes (read-only rootfs in Docker).
  images: { unoptimized: true },
  // Native / CJS-only packages must not be bundled by the server compiler.
  serverExternalPackages: ['better-sqlite3', 'argon2', 'node-cron'],
};

export default nextConfig;

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  // No remote images and no runtime image cache writes (read-only rootfs in Docker).
  images: { unoptimized: true },
  // Native / CJS-only packages must not be bundled by the server compiler.
  // tesseract.js and pdfjs-dist join them for a different reason (MUST-2.2): the tesseract
  // worker is loaded BY FILE PATH from node_modules, so if Next bundles the library that
  // path stops existing and it silently falls back to its CDN defaults — the exact failure
  // the offline-install invariant forbids.
  serverExternalPackages: [
    'better-sqlite3',
    'argon2',
    'node-cron',
    'tesseract.js',
    'tesseract.js-core',
    'pdfjs-dist',
  ],
};

export default nextConfig;

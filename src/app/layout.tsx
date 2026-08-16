import type { Metadata } from 'next';
import { headers } from 'next/headers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Budget Tracker',
  description: 'Self-hosted household budget tracker',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the per-request nonce (set by src/middleware.ts) opts this route into
  // dynamic rendering, which the nonce-based CSP requires: a statically pre-rendered
  // page would ship scripts nonced at build time that could never match a fresh
  // per-request nonce in the response's Content-Security-Policy header.
  await headers();

  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

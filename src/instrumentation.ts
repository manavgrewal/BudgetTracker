/**
 * Next.js boot hook: runs once per server process, in every runtime Next builds
 * (Node.js and Edge). The Node-only work (opening the database, starting the
 * cron scheduler) lives in ./instrumentation-node so Next's Edge compiler pass
 * never has to resolve better-sqlite3/node-cron, neither of which has an
 * Edge-compatible build.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}

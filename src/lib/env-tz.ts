/**
 * Pure, isomorphic TZ resolution — deliberately split out of @/lib/env.
 *
 * @/lib/env's readEnv() resolves SECRET_KEY, which (since the zero-config key-file feature)
 * touches node:fs/node:path/node:crypto. src/lib/dates.ts is shared/isomorphic code reachable
 * from client components (via *-client.tsx), and importing ANYTHING from a module that
 * statically imports those node builtins fails the client webpack build outright — tree-shaking
 * happens after module resolution, so it does not matter that dates.ts only ever wanted `.tz`.
 * This tiny module has zero node builtin imports, so it is safe for both server and browser
 * bundles. @/lib/env re-exports DEFAULT_TZ and uses readTz() internally, so this stays the one
 * place the TZ-default rule is written.
 */
export const DEFAULT_TZ = 'America/Toronto';

export function readTz(source: Partial<NodeJS.ProcessEnv> = process.env): string {
  return source.TZ && source.TZ.length > 0 ? source.TZ : DEFAULT_TZ;
}

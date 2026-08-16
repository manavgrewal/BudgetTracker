/** Single source of "now" so tests can pass an explicit Date everywhere. */
export function nowIso(at: Date = new Date()): string {
  return at.toISOString();
}

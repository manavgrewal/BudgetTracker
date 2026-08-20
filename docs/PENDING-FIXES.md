# Pending fixes

Three defects the owner found on v1.4.0, investigated 2026-08-19. Nothing here is started.
Each entry records what was verified in the code, not a guess, so whoever picks it up does not
have to re-diagnose it.

## 1. CSV import rejects dates Excel rewrites, and the format list cannot be extended

**Reported:** a CSV that imports fine as a Unix file fails after being saved on Windows, where
`28 May 2026` becomes `26-May-26`. Suspected line endings.

**Verified cause: not line endings.** `src/lib/import/parse.ts:50` calls `Papa.parse` with no
`newline` option, so papaparse auto-detects LF and CRLF equally. Unix and Windows files parse
the same. The failure is the date format.

`src/lib/dates.ts:16` holds exactly seven formats, as a compiled TypeScript union
(`src/lib/dates.ts:8`):

    MM/DD/YYYY, DD/MM/YYYY, YYYY-MM-DD, YYYY/MM/DD, MM/DD/YY, DD-MMM-YYYY, MMM DD, YYYY

`26-May-26` is `DD-MMM-YY`, a two digit year. `DD-MMM-YYYY` requires four. There is no format
missing by accident and no way for an end user to add one: the list is code, and
`src/lib/import/mapping.ts:13` documents that a mapping's `dateFormat` must be one of them.

**Options, in the order recommended.**

- **A. Add the missing formats** (`DD-MMM-YY`, `D MMM YYYY`, `YYYY-MM-DD HH:mm`, and any others
  the owner's banks emit). Touches `DATE_FORMATS`, the union type, `parseDateString`, and its
  tests. **About 45 minutes.** Unblocks the file that fails today.
- **B. Auto-detect the format from the column** (RECOMMENDED). The preview step samples the
  first rows, tries every known format, and keeps the one that parses all of them; it asks the
  user only when two formats both fit and disagree (the real DD/MM versus MM/DD ambiguity).
  **About 2.5 to 3 hours.** Removes the question instead of answering it, and covers the next
  bank's format without another release.
- **C. User-defined formats in Settings**, with a token editor and stored patterns.
  **About 4 to 5 hours.** Not recommended: it adds surface and a real footgun, because a
  hand-entered DD/MM against an MM/DD file corrupts dates silently rather than failing. Option
  B covers the actual need.

**Files:** `src/lib/dates.ts`, `src/lib/import/parse.ts`, `src/lib/import/mapping.ts`,
`src/lib/import/preview.ts` (option B), `tests/lib/dates.test.ts`, `tests/lib/import/*`.

## 2. An import mapping cannot be deleted, by anyone

**Reported:** a mapping created for a test stays forever, including for an admin.

**Verified cause.** The `import_profiles` table (`src/db/schema.ts:48`) has a create path
(`createProfile`, `src/lib/import/presets.ts:153`) and an update path
(`updateProfileMapping`, `src/lib/import/presets.ts:173`) and **no delete path anywhere**: no
library function, no server action in
`src/app/(app)/settings/managers/actions.ts`, and no button. The only profile actions exposed
are `saveProfileMappingAction` (line 137) and the category and rule actions around it.

The guard needed already exists: the table carries `is_builtin`
(`src/db/schema.ts:53`), which marks the four bank presets that must not be deletable.

**Fix.** A `deleteProfile(id)` in `src/lib/import/presets.ts` that refuses when `is_builtin` is
true, an admin-only `deleteProfileAction` beside the existing profile action, a delete control
with a confirm step on the managers page, and tests covering the built-in refusal, the
successful delete, and the non-admin refusal. **About 1 hour.**

**Files:** `src/lib/import/presets.ts`, `src/app/(app)/settings/managers/actions.ts`, the
managers client component, `tests/lib/import/presets.test.ts`, `tests/app/managers-*.test.*`.

## 3. A new child category does not appear in the hierarchy until a hard refresh

**Reported:** adding Education under Kids leaves the Budgets hierarchy looking unchanged.

**Verified cause: the data layer is correct, the cache invalidation is incomplete.**
`budgetProgress` (`src/lib/budgets.ts:196-201`) builds top level rows and attaches each row
whose `parentId` matches, so Kids gaining its first child renders correctly on a fresh load.
`src/app/(app)/budgets/page.tsx:12` is `force-dynamic`, so nothing is cached server side.

The category mutations in `src/app/(app)/settings/managers/actions.ts` call
`revalidatePath('/settings/managers')`, and in two places `/transactions`, and **never**
`/budgets`, `/reports` or the dashboard. Next's client side router cache then keeps the
already-visited page for roughly 30 seconds, which is exactly the "it did not reset" window.

**Fix.** Add the missing `revalidatePath` calls to every category mutation (create at line 21,
rename at 38, archive at 51), and add a test asserting each category action revalidates every
route that renders categories, so a future page added to that set is not missed the same way.
**About 45 minutes.**

**Files:** `src/app/(app)/settings/managers/actions.ts`, `tests/app/managers-actions.test.ts`.

## Totals and suggested order

With option B for the CSV work: **about 4.5 to 5 hours.** With option A instead: **about 2.5
hours.**

Fastest relief first:

1. Item 1 option A, the missing date formats, so imports work today.
2. Item 2, mapping delete.
3. Item 3, the revalidation fix.
4. Item 1 option B, auto-detect, as a follow up.

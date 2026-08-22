import { DATE_FORMATS, parseDateString, type DateFormat } from '@/lib/dates';

export type DateFormatDetectionStatus = 'unique' | 'resolved' | 'ambiguous' | 'none';

export interface DateFormatDetection {
  /** Every known format that parsed every sampled non-empty value, in DATE_FORMATS order. */
  candidates: DateFormat[];
  status: DateFormatDetectionStatus;
  /** Set for 'unique' and 'resolved'. Null for 'ambiguous' (never guess) and 'none'. */
  detected: DateFormat | null;
}

/**
 * Cap on how many sampled values are actually checked. Detection cost is
 * O(formats x samples), so this bounds it even when a caller hands in every row of a
 * 10,000-row file; a few dozen values are already enough to prove or disprove a format.
 */
const SAMPLE_LIMIT = 25;

/**
 * Pure date-format sniffer for the import preview (PENDING-FIXES #1, option B). Given raw
 * strings sampled from a CSV's date column — BEFORE any dateFormat has been chosen — tries
 * every format in DATE_FORMATS and keeps the ones that parse every sampled non-empty value.
 *
 * Resolution rules:
 * - 0 survivors -> 'none'. Nothing fits; the caller reports that rather than throwing.
 * - 1 survivor -> 'unique'. No ambiguity possible, use it.
 * - 2+ survivors that produce the SAME iso date for every sample -> 'resolved'. This is
 *   harmless duplicate coverage, not a real ambiguity — e.g. 'YYYY-MM-DD' and 'YYYY/MM/DD'
 *   parse identically field-for-field in dates.ts, so they always agree wherever both
 *   match. Tie-break: the first candidate in DATE_FORMATS declaration order (see that
 *   array's docblock — the ISO/4-digit-year forms are listed first on purpose).
 * - 2+ survivors that disagree on at least one sample -> 'ambiguous'. This is the real
 *   DD/MM vs MM/DD problem. Never guess: the caller surfaces every candidate so the
 *   mapping UI can ask the user, and an explicitly chosen dateFormat is left untouched
 *   regardless of what this function reports.
 *
 * No clock access and no I/O — pure string matching over the given samples, so it is safe
 * to unit test directly and to call from buildPreview without affecting what dateFormat is
 * actually used to parse the file.
 */
export function detectDateFormat(rawSamples: readonly string[]): DateFormatDetection {
  const samples = rawSamples
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .slice(0, SAMPLE_LIMIT);

  if (samples.length === 0) return { candidates: [], status: 'none', detected: null };

  const candidates = DATE_FORMATS.filter((format) =>
    samples.every((sample) => parseDateString(sample, format) !== null),
  );

  if (candidates.length === 0) return { candidates: [], status: 'none', detected: null };
  if (candidates.length === 1) return { candidates, status: 'unique', detected: candidates[0] };

  const agreeOnEverySample = samples.every((sample) => {
    const parsed = candidates.map((format) => parseDateString(sample, format));
    return parsed.every((value) => value === parsed[0]);
  });

  if (!agreeOnEverySample) return { candidates, status: 'ambiguous', detected: null };
  return { candidates, status: 'resolved', detected: candidates[0] };
}

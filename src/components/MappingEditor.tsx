'use client';

import type { ImportMapping } from '@/lib/import/mapping';
import type { DateFormatDetection } from '@/lib/import/detect-date-format';
import { DATE_FORMATS } from '@/lib/dates';
import { Field, inputClass, labelClass, selectClass } from '@/components/ui/form';
import { Notice } from '@/components/ui/Notice';

/**
 * Which column of the bank's CSV holds what. Shared by the import preview and
 * the add-a-bank wizard, so it stays a bare grid with no card of its own —
 * each caller decides what it sits inside.
 */
export function MappingEditor({
  mapping,
  onChange,
  dateFormatDetection,
  busy,
}: {
  mapping: ImportMapping;
  onChange: (next: ImportMapping) => void;
  /**
   * What detectDateFormat() found by sampling the date column itself, independent of
   * whatever mapping.dateFormat currently says. Optional so a caller that has not been
   * updated yet still compiles, but every real caller (the preview screen and the
   * new-bank wizard) now passes it — otherwise a confident detector result never
   * reaches anyone, and an ambiguous one (day/month could be swapped) stays invisible.
   */
  dateFormatDetection?: DateFormatDetection | null;
  /**
   * Whether the caller already has a preview/save request in flight for this mapping.
   * Only gates the one-click "Use X" date-format button below — the button re-fetches
   * on click the same way every other field here re-fetches on change, so it needs the
   * same double-fire guard the caller's other buttons already have (release-review
   * finding C). Every other control in this form is a plain onChange and is left alone.
   * Optional and defaults to not-busy so a caller with nothing to gate (the new-bank
   * wizard, which only ever updates local state) can skip it.
   */
  busy?: boolean;
}) {
  const set = <K extends keyof ImportMapping>(key: K, value: ImportMapping[K]) => onChange({ ...mapping, [key]: value });
  const numberOrNull = (value: string) => (value.trim() === '' ? null : Number(value));

  let dateFormatNotice: React.ReactNode = null;
  if (dateFormatDetection?.status === 'ambiguous') {
    // The real DD/MM vs MM/DD case: two or more formats fit the sample but disagree on
    // what at least one date actually is. Never auto-pick here — say so loudly (role="alert"
    // plus the warning tone, not just a quiet hint) so a wrong pick is a choice, not an accident.
    dateFormatNotice = (
      <Notice
        tone="warning"
        role="alert"
        title="This date column is ambiguous — day and month could be swapped"
        className="sm:col-span-2 lg:col-span-3"
      >
        More than one format fits the sample rows ({dateFormatDetection.candidates.join(', ')}), and they do not
        all read the same date out of every row. Picking the wrong one will not fail — it will silently swap the
        day and the month. Check a real date from this file, then set the correct format above yourself.
      </Notice>
    );
  } else if (dateFormatDetection?.status === 'none') {
    // The sample fed to detection is every raw cell in the date column, INCLUDING error
    // rows (src/lib/import/preview.ts) — so a headerless preset (TD, Scotiabank) sampling
    // its own header text, or an opening-balance/footer line, reads as "no format matches"
    // even though the real transaction rows below it are fine. Name that likely cause
    // before the generic advice, rather than sending the user hunting the column number.
    dateFormatNotice = (
      <Notice tone="warning" title="Could not recognize this column's date format" className="sm:col-span-2 lg:col-span-3">
        None of the formats this app knows matched every sampled value. This often means a header row, an
        opening-balance line, or a footer note ended up in the sample instead of real transaction rows — if that
        looks likely, try ticking <strong>Has header</strong> above (or raising header rows) first. Otherwise,
        double check the date column number above, then set the format by hand.
      </Notice>
    );
  } else if (
    dateFormatDetection?.detected &&
    // mapping.dateFormat is a bare `string` (ImportMapping, src/lib/import/mapping.ts) since
    // it round-trips through zod/JSON, not the narrower DateFormat union `candidates` is
    // typed as — widen the array's type for the membership check rather than asserting the
    // value itself is a DateFormat, the same pattern dates.ts's isDateFormat() uses.
    !(dateFormatDetection.candidates as readonly string[]).includes(mapping.dateFormat)
  ) {
    // Guard: if the currently-selected format is itself one of the candidates that parsed
    // every sampled value, it already reads the sample identically to `detected` (that is
    // what "candidate" means), so offering a switch is at best noise and at worst — for
    // 'resolved', where two formats merely happen to agree on this sample, e.g. MM/DD/YYYY
    // and DD/MM/YYYY whenever every sampled day equals its month — a one-click way to swap
    // day and month for every row outside the sample. Only a mismatch against the full
    // candidate set is ever worth surfacing (release review finding A).
    const detected = dateFormatDetection.detected;
    // Further restrict the auto-apply BUTTON to 'unique': a lone candidate that parses
    // everything and isn't the current pick is unambiguously better. 'resolved' means
    // multiple *different* formats coincidentally agreed on this small sample — real
    // signal that the current pick is wrong, but not proof the tie-break winner
    // (candidates[0]) is the right replacement, so it's surfaced as text only, never as a
    // single click.
    const canAutoApply = dateFormatDetection.status === 'unique';
    dateFormatNotice = (
      <Notice tone="info" title={`Detected format: ${detected}`} className="sm:col-span-2 lg:col-span-3">
        <div className="flex flex-wrap items-center gap-3">
          {canAutoApply ? (
            <p>The format selected above is {mapping.dateFormat}, but every sampled date reads cleanly as {detected} instead.</p>
          ) : (
            <p>
              The format selected above is {mapping.dateFormat}, which does not fit every sampled date. {dateFormatDetection.candidates.length}{' '}
              other formats do ({dateFormatDetection.candidates.join(', ')}), and they happen to agree with each other on this sample —
              that agreement does not prove either is correct for a row this sample didn&rsquo;t cover. Check a real date from this file, then
              set the format by hand if one of them looks right.
            </p>
          )}
          {canAutoApply ? (
            <button
              type="button"
              onClick={() => set('dateFormat', detected)}
              disabled={busy}
              className="btn btn--secondary btn--sm"
            >
              Use {detected}
            </button>
          ) : null}
        </div>
      </Notice>
    );
  }

  return (
    <div className="grid gap-4 rounded-lg border border-line bg-surface-2/50 p-4 sm:grid-cols-2 lg:grid-cols-3">
      <label className="flex items-center gap-2 self-end pb-2">
        <input
          type="checkbox"
          checked={mapping.hasHeader}
          onChange={(e) => set('hasHeader', e.target.checked)}
          className="accent-accent"
        />
        <span className={labelClass}>Has header</span>
      </label>
      <Field label="Header rows">
        <input
          type="number"
          min={0}
          value={mapping.headerRows}
          onChange={(e) => set('headerRows', Number(e.target.value))}
          className={inputClass}
        />
      </Field>
      <Field label="Date column">
        <input
          type="number"
          min={0}
          value={mapping.dateCol}
          onChange={(e) => set('dateCol', Number(e.target.value))}
          className={inputClass}
        />
      </Field>
      <Field label="Date format">
        <select value={mapping.dateFormat} onChange={(e) => set('dateFormat', e.target.value)} className={selectClass}>
          {DATE_FORMATS.map((format) => (
            <option key={format} value={format}>
              {format}
            </option>
          ))}
        </select>
      </Field>
      {dateFormatNotice}
      <Field label="Description columns (comma separated)">
        <input
          value={mapping.descCols.join(',')}
          onChange={(e) => set('descCols', e.target.value.split(',').map((v) => Number(v.trim())).filter((v) => Number.isInteger(v)))}
          className={inputClass}
        />
      </Field>
      <Field label="Amount mode">
        <select
          value={mapping.amountMode}
          onChange={(e) => set('amountMode', e.target.value as ImportMapping['amountMode'])}
          className={selectClass}
        >
          <option value="signed">Single signed amount column</option>
          <option value="debit_credit">Separate debit / credit columns</option>
        </select>
      </Field>
      {mapping.amountMode === 'signed' ? (
        <>
          <Field label="Amount column">
            <input
              type="number"
              min={0}
              value={mapping.amountCol ?? ''}
              onChange={(e) => set('amountCol', numberOrNull(e.target.value))}
              className={inputClass}
            />
          </Field>
          <Field label="Sign convention">
            <select
              value={mapping.signConvention}
              onChange={(e) => set('signConvention', e.target.value as ImportMapping['signConvention'])}
              className={selectClass}
            >
              <option value="negative_is_spend">Negative = money out</option>
              <option value="positive_is_spend">Positive = money out (Amex style)</option>
            </select>
          </Field>
        </>
      ) : (
        <>
          <Field label="Debit column (money out)">
            <input
              type="number"
              min={0}
              value={mapping.debitCol ?? ''}
              onChange={(e) => set('debitCol', numberOrNull(e.target.value))}
              className={inputClass}
            />
          </Field>
          <Field label="Credit column (money in)">
            <input
              type="number"
              min={0}
              value={mapping.creditCol ?? ''}
              onChange={(e) => set('creditCol', numberOrNull(e.target.value))}
              className={inputClass}
            />
          </Field>
        </>
      )}
      <Field label="Encoding">
        <select
          value={mapping.encoding}
          onChange={(e) => set('encoding', e.target.value as ImportMapping['encoding'])}
          className={selectClass}
        >
          <option value="auto">Detect automatically</option>
          <option value="utf-8">UTF-8</option>
          <option value="windows-1252">windows-1252</option>
        </select>
      </Field>
    </div>
  );
}

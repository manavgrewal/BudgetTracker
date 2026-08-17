'use client';

import type { ImportMapping } from '@/lib/import/mapping';
import { DATE_FORMATS } from '@/lib/dates';
import { Field, inputClass, labelClass, selectClass } from '@/components/ui/form';

/**
 * Which column of the bank's CSV holds what. Shared by the import preview and
 * the add-a-bank wizard, so it stays a bare grid with no card of its own —
 * each caller decides what it sits inside.
 */
export function MappingEditor({
  mapping,
  onChange,
}: {
  mapping: ImportMapping;
  onChange: (next: ImportMapping) => void;
}) {
  const set = <K extends keyof ImportMapping>(key: K, value: ImportMapping[K]) => onChange({ ...mapping, [key]: value });
  const numberOrNull = (value: string) => (value.trim() === '' ? null : Number(value));

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

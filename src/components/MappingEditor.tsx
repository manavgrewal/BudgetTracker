'use client';

import type { ImportMapping } from '@/lib/import/mapping';
import { DATE_FORMATS } from '@/lib/dates';

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
    <div className="grid grid-cols-2 gap-3 rounded-md border border-slate-200 p-3 text-sm dark:border-slate-800 md:grid-cols-3">
      <label className="flex flex-col gap-1">
        Has header
        <input type="checkbox" checked={mapping.hasHeader} onChange={(e) => set('hasHeader', e.target.checked)} />
      </label>
      <label className="flex flex-col gap-1">
        Header rows
        <input type="number" min={0} value={mapping.headerRows} onChange={(e) => set('headerRows', Number(e.target.value))} className="rounded border px-2 py-1 dark:bg-slate-900" />
      </label>
      <label className="flex flex-col gap-1">
        Date column
        <input type="number" min={0} value={mapping.dateCol} onChange={(e) => set('dateCol', Number(e.target.value))} className="rounded border px-2 py-1 dark:bg-slate-900" />
      </label>
      <label className="flex flex-col gap-1">
        Date format
        <select value={mapping.dateFormat} onChange={(e) => set('dateFormat', e.target.value)} className="rounded border px-2 py-1 dark:bg-slate-900">
          {DATE_FORMATS.map((format) => (
            <option key={format} value={format}>
              {format}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        Description columns (comma separated)
        <input
          value={mapping.descCols.join(',')}
          onChange={(e) => set('descCols', e.target.value.split(',').map((v) => Number(v.trim())).filter((v) => Number.isInteger(v)))}
          className="rounded border px-2 py-1 dark:bg-slate-900"
        />
      </label>
      <label className="flex flex-col gap-1">
        Amount mode
        <select value={mapping.amountMode} onChange={(e) => set('amountMode', e.target.value as ImportMapping['amountMode'])} className="rounded border px-2 py-1 dark:bg-slate-900">
          <option value="signed">Single signed amount column</option>
          <option value="debit_credit">Separate debit / credit columns</option>
        </select>
      </label>
      {mapping.amountMode === 'signed' ? (
        <>
          <label className="flex flex-col gap-1">
            Amount column
            <input type="number" min={0} value={mapping.amountCol ?? ''} onChange={(e) => set('amountCol', numberOrNull(e.target.value))} className="rounded border px-2 py-1 dark:bg-slate-900" />
          </label>
          <label className="flex flex-col gap-1">
            Sign convention
            <select value={mapping.signConvention} onChange={(e) => set('signConvention', e.target.value as ImportMapping['signConvention'])} className="rounded border px-2 py-1 dark:bg-slate-900">
              <option value="negative_is_spend">Negative = money out</option>
              <option value="positive_is_spend">Positive = money out (Amex style)</option>
            </select>
          </label>
        </>
      ) : (
        <>
          <label className="flex flex-col gap-1">
            Debit column (money out)
            <input type="number" min={0} value={mapping.debitCol ?? ''} onChange={(e) => set('debitCol', numberOrNull(e.target.value))} className="rounded border px-2 py-1 dark:bg-slate-900" />
          </label>
          <label className="flex flex-col gap-1">
            Credit column (money in)
            <input type="number" min={0} value={mapping.creditCol ?? ''} onChange={(e) => set('creditCol', numberOrNull(e.target.value))} className="rounded border px-2 py-1 dark:bg-slate-900" />
          </label>
        </>
      )}
      <label className="flex flex-col gap-1">
        Encoding
        <select value={mapping.encoding} onChange={(e) => set('encoding', e.target.value as ImportMapping['encoding'])} className="rounded border px-2 py-1 dark:bg-slate-900">
          <option value="auto">Detect automatically</option>
          <option value="utf-8">UTF-8</option>
          <option value="windows-1252">windows-1252</option>
        </select>
      </label>
    </div>
  );
}

'use client';

import { useState } from 'react';
import { Field, inputClass, selectClass } from '@/components/ui/form';
import { RANGE_PRESETS, type RangePresetId } from '@/lib/date-range';

/**
 * The shared date-range control (MUST-12.1).
 *
 * MUST-12.2: it is a form control, not a router. It renders inside the page's existing
 * <form method="get">, performs no router.push, no fetch, no useEffect and no navigation of
 * its own. Pressing the form's existing submit button is what applies the range, exactly as
 * it does for the account, category and person selects beside it.
 *
 * MUST-12.8: it imports RANGE_PRESETS from @/lib/date-range, which is pure and client-safe. It
 * imports nothing from @/lib/predict/history, @/db or @/lib/env.
 */
export function DateRangePicker({
  value,
  from,
  to,
  today,
  allowAny = false,
  className = '',
}: {
  /** The server-resolved preset, or '' when there is no range (allowAny only). */
  value: RangePresetId | '';
  /** The server-resolved endpoints, prefilling the two inputs on the custom branch. */
  from: string;
  to: string;
  /** Server-resolved today, in the app's TZ. Bounds the custom inputs' max (MUST-12.6). */
  today: string;
  /** Renders an extra "Any dates" option whose value is ''. Transactions only (spec D1). */
  allowAny?: boolean;
  className?: string;
}) {
  // MUST-12.5: one piece of state, and nothing else.
  const [preset, setPreset] = useState<RangePresetId | ''>(value);
  const custom = preset === 'custom';

  return (
    <>
      <Field label="Dates" className={className}>
        <select
          name="range"
          value={preset}
          onChange={(event) => setPreset(event.target.value as RangePresetId | '')}
          className={selectClass}
        >
          {allowAny ? <option value="">Any dates</option> : null}
          {RANGE_PRESETS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>
      {/*
        MUST-12.4: disabled AND visually hidden. A disabled input is not submitted, so a stale
        from or to cannot ride along beside a preset and produce a URL whose two halves
        disagree. This is belt and braces over the server-side precedence rule, and it is worth
        having both: one keeps the URL clean, the other keeps the server right.
      */}
      <Field label="From" className={custom ? '' : 'hidden'}>
        <input type="date" name="from" defaultValue={from} max={today} disabled={!custom} className={inputClass} />
      </Field>
      <Field label="To" className={custom ? '' : 'hidden'}>
        <input type="date" name="to" defaultValue={to} max={today} disabled={!custom} className={inputClass} />
      </Field>
    </>
  );
}

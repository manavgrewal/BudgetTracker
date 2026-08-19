import { addMonths, isIsoDate, monthEnd, monthOf, monthStart } from '@/lib/dates';

/**
 * The shared range resolver, PURE and client-safe (MUST-2.3). It imports from @/lib/dates and
 * nothing else, and it NEVER determines the current date: `today` is a required parameter.
 *
 * MUST-11.4 is the reason the URL carries a preset TOKEN rather than a resolved date pair. A
 * phone in another timezone, or a laptop whose clock is a day off, must not be able to produce
 * a different "This month" than the server would, because the same "This month" appears in a
 * budget_pace notification computed server-side.
 */

export type RangePresetId =
  | 'this_month'
  | 'last_month'
  | 'last_3_months'
  | 'last_6_months'
  | 'ytd'
  | 'last_year'
  | 'custom';

/** MUST-11.1: exactly seven, in this order. "Any dates" is a picker option, not a preset (D1). */
export const RANGE_PRESETS: readonly { id: RangePresetId; label: string }[] = [
  { id: 'this_month', label: 'This month' },
  { id: 'last_month', label: 'Last month' },
  { id: 'last_3_months', label: 'Last 3 months' },
  { id: 'last_6_months', label: 'Last 6 months' },
  { id: 'ytd', label: 'Year to date' },
  { id: 'last_year', label: 'Last year' },
  { id: 'custom', label: 'Custom' },
];

/**
 * The lower bound used when a URL carries a `to` and no `from` and there is no fallback preset
 * to borrow one from. It keeps a one-sided bookmark meaning "everything up to that date",
 * which is what it meant in v1.3.1 where the filter added only the one clause.
 */
export const RANGE_FLOOR_DATE = '1900-01-01';

/**
 * L-9: the symmetric upper bound, used when a URL carries a `from` and no `to` and there is no
 * fallback preset to borrow one from. It keeps a one-sided bookmark meaning "everything from
 * that date on", which is what it meant in v1.3.1. Filling this gap with the current month's
 * end instead (as the code did before this fix) silently hid anything dated after the current
 * month, which is not what a v1.3.1 `?from=...` bookmark meant.
 */
export const RANGE_CEILING_DATE = '2999-12-31';

export function isRangePresetId(value: string): value is RangePresetId {
  return RANGE_PRESETS.some((preset) => preset.id === value);
}

export interface ResolvedRange {
  preset: RangePresetId;
  from: string;
  to: string;
  /** 'Last 3 months', or for custom the two dates. */
  label: string;
}

function labelOf(preset: RangePresetId): string {
  return RANGE_PRESETS.find((entry) => entry.id === preset)?.label ?? preset;
}

/**
 * MUST-11.2. Note that last_3_months and last_6_months INCLUDE the current partial month:
 * three calendar months means this one and the two before it. That is a different window from
 * the predictive history window of spec section 4, which deliberately excludes the partial
 * month; the two are unrelated and the Reports baselines card says so.
 *
 * MUST-11.3 point 3: no clamping to today. There is no data after today anyway, and clamping
 * would make this_month and ytd produce a different `to` on every page load.
 */
function endpointsOf(preset: Exclude<RangePresetId, 'custom'>, today: string): { from: string; to: string } {
  const month = monthOf(today);
  switch (preset) {
    case 'this_month':
      return { from: monthStart(month), to: monthEnd(month) };
    case 'last_month': {
      const previous = addMonths(month, -1);
      return { from: monthStart(previous), to: monthEnd(previous) };
    }
    case 'last_3_months':
      return { from: monthStart(addMonths(month, -2)), to: monthEnd(month) };
    case 'last_6_months':
      return { from: monthStart(addMonths(month, -5)), to: monthEnd(month) };
    case 'ytd':
      return { from: `${today.slice(0, 4)}-01-01`, to: monthEnd(month) };
    case 'last_year': {
      const year = String(Number(today.slice(0, 4)) - 1).padStart(4, '0');
      return { from: `${year}-01-01`, to: `${year}-12-31` };
    }
  }
}

function presetRange(preset: Exclude<RangePresetId, 'custom'>, today: string): ResolvedRange {
  const { from, to } = endpointsOf(preset, today);
  return { preset, from, to, label: labelOf(preset) };
}

function customRange(from: string, to: string): ResolvedRange {
  // MUST-11.5: somebody who typed them backwards meant the range between them.
  const [low, high] = from <= to ? [from, to] : [to, from];
  return { preset: 'custom', from: low, to: high, label: `${low} to ${high}` };
}

/** MUST-11.9: total. Every combination of the four inputs gives a ResolvedRange or null, never a throw. */
export function resolveRange(input: {
  preset: string | null | undefined;
  from: string | null | undefined;
  to: string | null | undefined;
  today: string;
  fallback: RangePresetId | null;
}): ResolvedRange | null {
  const raw = typeof input.preset === 'string' ? input.preset : '';
  const from = typeof input.from === 'string' && isIsoDate(input.from) ? input.from : null;
  const to = typeof input.to === 'string' && isIsoDate(input.to) ? input.to : null;

  // Case 1: a recognised, non-custom preset wins and any from/to is ignored entirely.
  if (isRangePresetId(raw) && raw !== 'custom') return presetRange(raw, input.today);

  // Cases 2 and 3: custom, explicitly or inferred from a loose pair. Case 3 is what keeps
  // every existing bookmark and the old Export CSV link working byte for byte.
  if (raw === 'custom' || from !== null || to !== null) {
    if (from !== null && to !== null) return customRange(from, to);
    if (from === null && to === null) {
      return input.fallback === null || input.fallback === 'custom' ? null : presetRange(input.fallback, input.today);
    }
    const filler =
      input.fallback === null || input.fallback === 'custom'
        ? { from: RANGE_FLOOR_DATE, to: RANGE_CEILING_DATE }
        : endpointsOf(input.fallback, input.today);
    return customRange(from ?? filler.from, to ?? filler.to);
  }

  // Case 4.
  if (input.fallback === null || input.fallback === 'custom') return null;
  return presetRange(input.fallback, input.today);
}

/** MUST-11.8: the one place a range becomes query parameters, so no page hand-builds a link. */
export function rangeParams(range: ResolvedRange | null): Record<string, string> {
  if (range === null) return {};
  if (range.preset === 'custom') return { range: 'custom', from: range.from, to: range.to };
  return { range: range.preset };
}

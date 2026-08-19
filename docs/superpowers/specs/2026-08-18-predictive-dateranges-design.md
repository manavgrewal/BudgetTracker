# Predictive spending targets and date-range presets, Design Spec (v1.4.0)

**Date:** 2026-08-18
**Status:** approved design. Ships as **v1.4.0**.
**Base specs:** `docs/superpowers/specs/2026-08-15-budget-tracker-design.md` (the master spec; section references with no prefix are to it), `docs/superpowers/specs/2026-08-17-notifications-design.md` (*notify section n*) and `docs/superpowers/specs/2026-08-17-update-loans-design.md` (*v1.3.1 section n*).

Requirement labels (**MUST-n.m**) are binding and each one is written so that it is testable.

This release carries **two features that share nothing but a version number**:

1. **Predictive spending targets.** Per-category median, average and trend over a fixed history window, a suggested monthly budget with one-click apply into the existing `budgets` table, a mid-month pace projection, and six new notification events that plug into the existing registry.
2. **Date-range presets.** One shared preset picker and one shared range-resolution helper, adopted by Reports, Transactions and the CSV export route.

Nothing in any base spec is withdrawn.

**There is no AI, no LLM, no model file and no inference of any kind in this release.** Every number below is arithmetic over rows already in the household's SQLite database, in integer cents, computed in pure functions with unit tests.

---

## 1. Overview

### 1.1 What the household sees

The Budgets page already lists every category with a limit, net spend, remaining and a progress bar. It gains two things. Each category with enough history shows a suggested monthly amount with a button that writes it. Each category with a limit shows, from the seventh day of the month onward, where the month is heading if the rest of it looks like the part already spent.

The Reports page already takes a From and a To date. Those two bare inputs are replaced by a picker with seven choices, one of which is Custom and reveals the same two inputs. The Transactions page gets the same picker. Both pages keep working from the URL exactly as they do today.

Notifications gain six events. They are off or on per user per channel through the toggle matrix that already exists, and, like every event before them, they send nothing to anybody who has not configured a channel.

### 1.2 The zero-egress rule, restated for a fourth feature

**MUST-1.1** Predictive targets make **no outbound connection of any kind, ever**. There is no model to download, no service to call and no telemetry. `src/lib/predict/` contains zero `fetch(` call sites and zero string literal containing `://`, and `tests/ops/notify-egress.test.ts` is extended to assert both (section 16.1).

**MUST-1.2** Date-range presets make no outbound connection either. The resolution helper is pure string arithmetic over ISO dates.

**MUST-1.3** Neither feature reads or writes any file outside the SQLite database.

### 1.3 The no-migration claim

**MUST-1.4** This release adds **no table, no column and no migration**. Specifically:

- The six notification events are six appended entries in `NOTIFICATION_EVENTS`, six appended dedup-key builders, six appended `RenderInput` union members and six appended `renderEvent` cases. That is the extension point notify MUST-4.4 promised, exercised for the second time after `update_available`.
- Suggestions write through the **existing** `upsertBudget()` into the **existing** `budgets` table. A suggested budget and a typed budget are the same row.
- Predictive thresholds are **exported module constants**, not stored settings. Section 20 (D2) explains why, and what it would cost to change that later.
- Date-range state lives in the URL query string. Nothing about it is persisted.

`drizzle/` is untouched by this release. `src/db/schema.ts` is untouched by this release.

### 1.4 Goals

- A household that has been importing statements for six months can be told what a realistic budget for each category looks like, and set it with one press.
- A month that is heading over its limit says so on the twelfth, not on the thirty-first.
- A charge three times the size of what that merchant usually costs gets noticed.
- A subscription that went from $12.99 to $16.99 gets noticed.
- Picking "Last 3 months" takes one click on every page that filters by date, and means the same three months on every one of them.

### 1.5 Non-goals for v1.4.0

No forecasting past the end of the current month. No machine learning of any kind. No per-merchant budgets. No cashflow forecasting. No income prediction. No savings-rate targets. No confidence intervals or error bars. No goal-completion prediction. No what-if scenarios. No category auto-creation. No preset beyond the seven listed. No saved custom ranges. Every one of these is listed again in section 22.

---

## 2. Architecture delta

| Concern | Decision |
|---|---|
| New library dir | `src/lib/predict/` (**new**), layout in section 2.1 |
| New library file | `src/lib/date-range.ts` (**new**), the shared range resolver (section 11) |
| New component | `src/components/ui/DateRangePicker.tsx` (**new**), the shared picker (section 12) |
| New evaluators | `src/lib/notify/evaluate/pace.ts`, `anomalies.ts`, `monthly.ts` (all **new**) |
| New migration | **none** (MUST-1.4) |
| New table or column | **none** (MUST-1.4) |
| New page | **none.** Every surface extends an existing page |
| New route handler | **none.** The one new mutation is a server action |
| New runtime dependency | **none** |
| New notification events | six, all `audience: 'all'` (section 9) |
| New env var | **none** |
| New settings key | **none** (D2) |
| Scheduler | **no change.** Every new evaluator is called from the existing `runScheduledEvaluation()` |
| Docker, CSP, security headers | **no change** |

### 2.1 `src/lib/predict/` layout (all files new)

```
src/lib/predict/
  constants.ts   every threshold and window, in one place, PURE          (section 3.3)
  stats.ts       median / mean / rounding / trend, PURE                  (section 5)
  window.ts      historyMonths() and the day-of-month arithmetic, PURE   (section 4)
  suggest.ts     suggestBudget() over a series, PURE                     (section 6)
  pace.ts        projectMonthEnd() over two integers, PURE               (section 8)
  anomalies.ts   unusual / creep / duplicate detection over rows, PURE   (section 9)
  history.ts     the ONLY module here that touches the database          (section 4.3)
```

**MUST-2.1** Every file under `src/lib/predict/` **except `history.ts`** is **pure**: no `@/db` import, no `@/lib/env` import, no node builtin, no `new Date()`. They take plain arrays and integers and return plain objects. This is the same rule notify MUST-2.1 puts on `src/lib/notify/events.ts` and v1.3.1 MUST-2.1 puts on `src/lib/update/semver.ts`, and it exists for two reasons: `constants.ts` and `stats.ts` are imported by the Budgets client to format a suggestion label, so the Ruling P4 client-bundle constraint applies to them; and a pure function over an array of integers is testable without a database, which is what makes section 17's unit tests cheap enough to be exhaustive.

**MUST-2.2** `src/lib/predict/history.ts` is server-only and is never imported, directly or transitively, from a `*-client.tsx` file. Only `import type` is permitted there.

**MUST-2.3** `src/lib/date-range.ts` is **pure** and client-safe. It imports from `@/lib/dates` and nothing else. It never calls `new Date()`, never calls `todayIso()` and never reads `process.env`. Every function on it takes the current date as an explicit `today: string` parameter (MUST-11.4).

### 2.2 Files modified (exhaustive)

| File | Change | Feature |
|---|---|---|
| `src/lib/notify/events.ts` | six appended `NOTIFICATION_EVENTS` entries, six appended key builders (section 9) | predictive |
| `src/lib/notify/render.ts` | six appended `RenderInput` union members, six appended `case` blocks (section 9.9) | predictive |
| `src/lib/notify/evaluate/index.ts` | three call sites inside the existing daily-slot and tick blocks (section 10) | predictive |
| `src/app/(app)/budgets/page.tsx` | passes suggestions and projections into the client (section 14.1) | predictive |
| `src/app/(app)/budgets/budgets-client.tsx` | the suggestion button, the apply-all button, the projection cell (section 14.1) | predictive |
| `src/app/(app)/budgets/actions.ts` | two new server actions (section 7) | predictive |
| `src/app/(app)/reports/page.tsx` | preset resolution, the baselines card's data (sections 13.1, 14.2) | both |
| `src/app/(app)/reports/reports-client.tsx` | the picker replaces two date inputs; the baselines card; the export link (sections 13.1, 14.2) | both |
| `src/app/(app)/transactions/page.tsx` | preset resolution feeding `TransactionFilter` (section 13.2) | date ranges |
| `src/app/(app)/transactions/transactions-client.tsx` | the picker replaces two date inputs (section 13.2) | date ranges |
| `src/app/api/reports/export/route.ts` | resolves `range` the same way the page does (section 13.3) | date ranges |
| `src/components/icons.tsx` | `TrendUpIcon`, `TrendDownIcon`, `TrendFlatIcon` | predictive |
| `tests/lib/notify/events.test.ts` | the registry table assertion gains six rows | predictive |
| `tests/ops/notify-egress.test.ts` | `src/lib/predict/` added as a zero-egress tree (section 16.1) | predictive |
| `package.json` | `version` to `1.4.0` | both |
| `CHANGELOG.md`, `README.md` | section 18.3 | both |

The table is exhaustive for source, ops and documentation files. Test files are enumerated separately in section 17.

`src/db/schema.ts`, `drizzle/`, `src/lib/scheduler.ts`, `src/lib/budgets.ts`, `src/lib/reports.ts`, `src/lib/transactions.ts`, `src/lib/dates.ts`, `src/lib/notify/outbox.ts`, `src/lib/notify/config.ts` and `src/components/app-shell/nav.ts` are **not** changed by this release. Neither feature adds a route.

---

## 3. Shared vocabulary and the rounding rules

### 3.1 What "spend" means here

**MUST-3.1** Every number in this spec is **net spend in integer cents**, defined exactly as `src/lib/budgets.ts` already defines it and with no second definition anywhere:

- Transfers are excluded (`is_transfer = 0`).
- A refund nets against spend, through the existing `netSpentCents()` negation in `src/lib/money.ts`. A category can therefore have a negative month.
- Income categories are excluded entirely, matching `budgetProgress()`.
- The **rollup rule** applies: a parent category's spend is its own rows plus every child's rows, including an archived child's. This is the rule `buildRow()` in `budgets.ts` already applies, and section 4.3 restates it because the new history query cannot call `buildRow()`.
- **Household scope** counts every row regardless of `attributed_user_id`. **Personal scope** for user U counts only rows with `attributed_user_id = U`. Same as `categorySpend()`.

**MUST-3.2** No predictive number is ever computed from a different spend definition than the one the Budgets page is already showing. If a suggestion and a progress bar disagree, the suggestion is wrong.

### 3.2 Rounding

**MUST-3.3** `src/lib/predict/stats.ts` exports exactly one division primitive and everything else uses it:

```ts
/** Half away from zero. divRound(5, 2) === 3; divRound(-5, 2) === -3. */
export function divRound(numerator: number, denominator: number): number;
```

Implemented on absolute values so the sign is applied once at the end, because `Math.round(-2.5)` in JavaScript is `-2`, which would round a refund-heavy median toward zero and a spend-heavy one away from it, in the same function. Every average, every median of an even-length series and every pace projection goes through `divRound`. There is no other rounding call anywhere under `src/lib/predict/`.

**MUST-3.4** `ceilToDollar(cents)` rounds a **non-negative** cents value up to the next whole dollar: `Math.ceil(cents / 100) * 100`. It throws on a negative input rather than guessing. It is applied exactly once, as the last step of the suggestion (MUST-6.6), because nobody types a budget of $247.36.

**MUST-3.5** No intermediate value is ever converted to a floating dollar amount and back. Every multiply-then-divide is done as `divRound(a * b, c)` on integers, in that order, so a scaling factor never loses a cent to a float. The largest intermediate this release can produce is a month's cents times 31, which is far inside `Number.MAX_SAFE_INTEGER`.

### 3.3 `src/lib/predict/constants.ts`

**MUST-3.6** Every threshold in this spec is a named export of `constants.ts`. No magic number appears in `suggest.ts`, `pace.ts`, `anomalies.ts` or any evaluator. A test imports the module and asserts each value, so changing one is a visible, reviewed edit rather than a silent behaviour change.

```ts
// The history window (section 4)
export const HISTORY_MONTHS = 6;              // last 6 full calendar months
export const MIN_HISTORY_MONTHS = 3;          // fewer than this: no suggestion at all
export const SEASONAL_MIN_MONTHS = 15;        // 12 for the reference year, plus 3 more

// The suggestion (section 6)
export const TREND_MIN_ABS_CENTS = 2000;      // $20
export const TREND_MIN_PCT = 10;
export const TREND_DAMPING_DIVISOR = 2;       // apply half the observed move
export const SEASONAL_CLAMP_MIN_PCT = 50;     // ratio floor, 0.5x
export const SEASONAL_CLAMP_MAX_PCT = 200;    // ratio ceiling, 2.0x
export const SUGGESTION_FLOOR_CENTS = 500;    // $5, below which no suggestion is offered
export const SUGGESTION_CAP_MULTIPLE = 3;     // never more than 3x the median

// The pace projection (section 8)
export const PACE_MIN_DAY_OF_MONTH = 7;

// The pace notification (section 9.2)
export const PACE_OVERSHOOT_MIN_PCT = 110;    // projected must reach 110% of the limit

// Unusual transaction (section 9.3)
export const UNUSUAL_MULTIPLE = 3;
export const UNUSUAL_LOOKBACK_DAYS = 14;
export const UNUSUAL_BASELINE_DAYS = 365;
export const UNUSUAL_MIN_SAMPLES = 5;
export const UNUSUAL_MIN_ABS_CENTS = 5000;    // $50
export const UNUSUAL_MIN_HOUSEHOLD_HISTORY_DAYS = 60;
export const UNUSUAL_MAX_PER_EVALUATION = 5;

// Subscription creep (section 9.4)
export const CREEP_LOOKBACK_DAYS = 35;
export const CREEP_BASELINE_DAYS = 365;
export const CREEP_MIN_CHARGES = 4;           // 3 baseline charges plus the new one
export const CREEP_MONTHLY_GAP_MIN_DAYS = 25;
export const CREEP_MONTHLY_GAP_MAX_DAYS = 35;
export const CREEP_YEARLY_GAP_MIN_DAYS = 350;
export const CREEP_YEARLY_GAP_MAX_DAYS = 380;
export const CREEP_MIN_PCT = 5;
export const CREEP_MIN_ABS_CENTS = 100;       // $1
export const CREEP_MAX_PER_EVALUATION = 5;

// Duplicate charge (section 9.5)
export const DUPLICATE_WINDOW_DAYS = 3;
export const DUPLICATE_LOOKBACK_DAYS = 14;
export const DUPLICATE_MIN_ABS_CENTS = 1000;  // $10
export const DUPLICATE_MAX_PER_EVALUATION = 5;

// The two month-boundary reports (sections 9.6, 9.7)
export const MONTH_REPORT_DAY_MAX = 3;        // fires on day 1, 2 or 3 of the month
export const MONTH_REPORT_MAX_LINES = 8;
export const SUGGEST_REFRESH_MIN_DELTA_PCT = 10;
export const SUGGEST_REFRESH_MIN_DELTA_CENTS = 1000;  // $10
```

**MUST-3.7** Every lookback window that appears inside a dedup key is **far below** `OUTBOX_RETENTION_DAYS` (400, from `src/lib/notify/outbox.ts`). The largest is `UNUSUAL_LOOKBACK_DAYS = 14`. This is the pruning-safety argument notify MUST-3.12 requires, and section 9.10 states it in full. A test asserts the inequality directly against the imported constant rather than against a copied number.

---

## 4. The history window and the spend series

### 4.1 Which months are in the window

**MUST-4.1** The history window for a target month **T** is the **last 6 full calendar months ending immediately before T**: `addMonths(T, -6)` through `addMonths(T, -1)` inclusive. For T = `2026-08`, that is `2026-02`, `2026-03`, `2026-04`, `2026-05`, `2026-06`, `2026-07`.

**MUST-4.2** The current, partial month is **never** in the window. A month with eleven days in it is not a month, and including it would drag every median down at the start of every month and up at the end of it.

**MUST-4.3 (the clip, and why it matters more than anything else here).** The window is intersected with the months at or after the household's **first data month**, defined as `monthOf(min(transactions.date))` over all non-transfer rows. A household that started importing in June has months for June and July only, not four zeros and two real months. Without this clip, every median on a new install would be zero and every suggestion would be nonsense.

**MUST-4.4 (how a month with no spend counts).** Inside the clipped window, a month in which a category had **no transactions at all contributes the integer 0**, not a gap. It is a real observation: the household spent nothing on that category that month, and a median that skips those months would tell somebody who buys tires twice a year to budget for tires every month. A month **outside** the clipped window contributes nothing at all, because the household has no evidence either way about it.

**MUST-4.5** The window is therefore between 0 and 6 months long. `historyMonths()` returns the exact list of month keys, ascending, and every downstream function takes that list rather than recomputing it.

```ts
// src/lib/predict/window.ts, PURE
export function historyMonths(input: {
  targetMonth: string;      // 'YYYY-MM'
  firstDataMonth: string | null;   // null when the household has no transactions
}): string[];
```

### 4.2 The minimum-history guard

**MUST-4.6** With fewer than `MIN_HISTORY_MONTHS` (3) months in the clipped window, **no suggestion is produced for any category**, `suggestBudget()` returns `null`, and the UI shows the sentence in MUST-15.1 instead of a disabled button. Two months of data can produce a median, and that median means nothing.

**MUST-4.7** The guard is on the **window length**, not on the number of months in which that particular category had spend. A category with three zero months and three spending months has six observations and gets a suggestion. This follows directly from MUST-4.4 and is the reason the two rules are written next to each other.

### 4.3 `src/lib/predict/history.ts`, the one database module

**MUST-4.8** The series for every category over the whole window is read in **exactly one grouped query per (scope, user)**, not one query per month and not one `resolveBudget()` call per category per month:

```sql
select substr(t.date, 1, 7) as month, t.category_id, sum(t.amount_cents) as total
from transactions t
where t.date >= :windowStart and t.date <= :windowEnd
  and t.is_transfer = 0
  and t.category_id is not null
  [and t.attributed_user_id = :userId]      -- personal scope only
group by 1, 2
```

served by the existing `transactions_date_idx`. `windowStart` is `monthStart(first window month)` and `windowEnd` is `monthEnd(last window month)`.

**MUST-4.9** `netSpentCents()` is applied per (month, category) cell, and then the **rollup rule of MUST-3.1** is applied in TypeScript over `listCategories({ includeArchived: true })`: a parent's value for a month is its own cell plus every child's cell for that month, archived children included. Income categories are dropped before the rollup, exactly as `budgetProgress()` drops them, so an income child under a spend parent cannot silently change a parent's total in a way that disagrees with `budgetProgress()`. (Amended after the pre-flight ruling on F4: the earlier "after the rollup" wording contradicted both `budgetProgress()` and the test named in section 17.2.) The result is:

```ts
export interface CategorySeries {
  categoryId: number;
  categoryName: string;
  parentId: number | null;
  isArchived: boolean;
  /** One entry per month in historyMonths(), same order, zero-filled per MUST-4.4. */
  monthlyCents: number[];
}

export function categorySeries(input: {
  months: string[];
  scope: 'household' | 'personal';
  userId: number | null;
}): CategorySeries[];

export function firstDataMonth(): string | null;
```

**MUST-4.10** `categorySeries()` returns exactly the row set `budgetProgress()` reports, flattened: every non-archived top-level non-income category with one level of rollup (archived children included in the sum), every non-archived child as its own own-spend row, and archived top-level categories only when their own cells are non-zero. Rows the Budgets page does not draw get no series. Present rows with no spend carry an all-zero series, so the pure functions downstream never have to distinguish "absent" from "zero". (Amended after the pre-flight ruling on F4: the earlier "a row for every non-income category" wording would have produced suggestions for rows the budgets UI cannot apply them to.)

**MUST-4.11** Seasonality needs a longer read than the six-month window. `history.ts` exports a second function, `seasonalReference()`, which reads the 12 calendar months ending at `addMonths(targetMonth, -12)` inclusive using the same single grouped query shape and the same rollup rule. It is called **only** when `monthsBetween(firstDataMonth, targetMonth) >= SEASONAL_MIN_MONTHS`, so a household with under 15 months of history never pays for the second query.

---

## 5. Statistical definitions

Every function in this section lives in `src/lib/predict/stats.ts`, is pure, takes a `number[]` of integer cents, and is unit tested against hand-computed values.

### 5.1 Median

**MUST-5.1** `medianCents(values: number[]): number | null`.

- An empty array returns `null`.
- The array is copied and sorted ascending numerically. The input is never mutated.
- Odd length: the middle element, exactly.
- Even length: `divRound(lower + upper, 2)` over the two middle elements, so `[100, 201]` gives `151` and `[-100, -201]` gives `-151`.

**MUST-5.2** The median is the **primary** statistic for the suggestion, and the average is not, because one $2,400 vet bill in six months moves a mean by $400 a month and moves a median by nothing. Both are shown to the household (section 14.2); only the median drives the number the button writes.

### 5.2 Average

**MUST-5.3** `meanCents(values: number[]): number | null`. Empty returns `null`. Otherwise `divRound(sum, values.length)`. The sum is a plain integer accumulation, matching `sumCents()` in `src/lib/money.ts`.

### 5.3 Trend

**MUST-5.4** `trendOf(values: number[]): Trend` where

```ts
export type TrendDirection = 'rising' | 'falling' | 'flat' | 'unknown';
export interface Trend { direction: TrendDirection; deltaCents: number }
```

- With fewer than 6 values, the result is `{ direction: 'unknown', deltaCents: 0 }`. Three points split into two halves of one and two is not a trend.
- With 6 values in ascending month order: `recent = meanCents(values.slice(3))`, `prior = meanCents(values.slice(0, 3))`, `deltaCents = recent - prior`.
- The threshold is `Math.max(TREND_MIN_ABS_CENTS, divRound(Math.abs(prior) * TREND_MIN_PCT, 100))`, that is, the larger of $20 and 10 percent of the earlier half.
- `deltaCents >= threshold` gives `'rising'`, `deltaCents <= -threshold` gives `'falling'`, anything between gives `'flat'`.

**MUST-5.5** There is **no** linear regression, no exponential smoothing and no seasonal decomposition. Six points cannot support one, and a slope fitted to six household months would be presented with more authority than it has earned. The two-half comparison is the whole method and it is stated in the UI copy (MUST-14.5).

### 5.4 Seasonality

**MUST-5.6** Seasonality is a **single multiplicative factor for one calendar month**, and only that. It is applied only when all four of these hold:

1. `monthsBetween(firstDataMonth, targetMonth) >= SEASONAL_MIN_MONTHS` (15).
2. The month `A = addMonths(targetMonth, -12)` is at or after `firstDataMonth`.
3. The full 12 months ending at `A` inclusive are all at or after `firstDataMonth`.
4. The mean of those 12 months for this category is **strictly greater than zero**.

**MUST-5.7** The factor is the rational `ratioNum / ratioDen` where `ratioNum = spend(A)` and `ratioDen = meanCents(the 12 months ending at A)`. It is **clamped before it is used**, on the rational, never on a float:

- If `ratioNum * 100 < ratioDen * SEASONAL_CLAMP_MIN_PCT`, use `ratioNum = SEASONAL_CLAMP_MIN_PCT, ratioDen = 100` (0.5x).
- If `ratioNum * 100 > ratioDen * SEASONAL_CLAMP_MAX_PCT`, use `ratioNum = SEASONAL_CLAMP_MAX_PCT, ratioDen = 100` (2.0x).
- If `ratioNum < 0`, seasonality does not apply at all. A category that was net-refunded in that month last year says nothing useful about this one.

**MUST-5.8** When any condition in MUST-5.6 fails, the factor is **absent**, not 1.0, and the suggestion records `seasonalApplied: false` so the UI can say so honestly rather than implying a seasonal adjustment happened and came out neutral.

### 5.5 Spread, for the confidence label

**MUST-5.9** `spreadCents(values)` is `max - min` over the window. It feeds only the confidence label in MUST-6.8 and never the suggested amount.

---

## 6. The suggested budget

### 6.1 The function

```ts
// src/lib/predict/suggest.ts, PURE
export interface Suggestion {
  suggestedCents: number;
  medianCents: number;
  meanCents: number;
  trend: Trend;
  monthsUsed: number;
  seasonalApplied: boolean;
  confidence: 'low' | 'medium' | 'high';
}

export type NoSuggestionReason =
  | 'not-enough-history'   // window shorter than MIN_HISTORY_MONTHS
  | 'no-spend'             // median at or below zero
  | 'below-floor';         // computed value under SUGGESTION_FLOOR_CENTS

export function suggestBudget(input: {
  monthlyCents: number[];              // ascending, one per window month
  seasonal: { num: number; den: number } | null;
}): { suggestion: Suggestion } | { reason: NoSuggestionReason };
```

### 6.2 The algorithm, in order

**MUST-6.1** The steps run in exactly this order and each is separately testable.

1. **Guard.** `monthlyCents.length < MIN_HISTORY_MONTHS` gives `{ reason: 'not-enough-history' }`.
2. **Base.** `base = medianCents(monthlyCents)`. If `base <= 0`, give `{ reason: 'no-spend' }`. A category that nets to zero or to a refund over six months does not get a budget.
3. **Trend.** With `trend.direction` of `'rising'` or `'falling'`, `value = base + divRound(trend.deltaCents, TREND_DAMPING_DIVISOR)`. With `'flat'` or `'unknown'`, `value = base`.
4. **Seasonality.** With a non-null clamped factor, `value = divRound(value * num, den)`.
5. **Cap.** `value = Math.min(value, base * SUGGESTION_CAP_MULTIPLE)`.
6. **Round.** If `value <= 0` after steps 1 through 5, stop here and report below-floor; `ceilToDollar` throws on negatives by design (MUST-3.4) and a non-positive pre-round value can only mean the trend adjustment consumed the whole median. Otherwise `value = ceilToDollar(value)`. (Amended after Task 3 review: the earlier unconditional wording made a falling-trend series throw instead of reporting below-floor.)
7. **Floor.** `value < SUGGESTION_FLOOR_CENTS` gives `{ reason: 'below-floor' }`.

**MUST-6.2 (why the trend is halved).** Step 3 applies **half** the observed move, not all of it. Six months of one household's data is a small sample, and a budget that chases the last three months will overshoot on both sides. Halving is a damping choice, it is stated in `constants.ts` as `TREND_DAMPING_DIVISOR`, and it is the single number to change if the owner wants the suggestion more or less reactive.

**MUST-6.3 (why the cap comes before the rounding).** Steps 3 and 4 can each move the value, and a rising trend on a seasonally high month can compound. The cap at three times the median bounds what those two multipliers can do together, and it is applied to the **median**, not to the post-trend value, so it cannot itself be inflated by the thing it is bounding.

**MUST-6.4** Step 5's cap can only lower a value, and step 6 can only raise it by less than one dollar. The final number can therefore exceed `3 x median` by at most 99 cents, which is the correct trade against showing somebody a budget of $746.03.

**MUST-6.5** `suggestBudget` never returns a negative or zero amount. Steps 2 and 7 are the two guards that make that true, and a property test over generated series asserts it.

**MUST-6.6** The suggestion is computed for a **target month**, and the only target month this release ever uses is the **current month** for the Budgets page (section 14.1) and the **month being reported on** for the two month-boundary events (sections 9.6 and 9.7). There is no way to ask for a suggestion for a month further out, because there is no forecasting past month end (MUST-1.5).

### 6.3 Confidence

**MUST-6.7** `confidence` is derived from two things and nothing else:

- `monthsUsed` of 3 or 4 gives `'low'`, 5 gives `'medium'`, 6 gives `'high'`.
- Then, if `spreadCents > 2 * medianCents`, the level drops by one step (`'high'` to `'medium'`, `'medium'` to `'low'`, `'low'` stays `'low'`).

**MUST-6.8** Confidence is a **label the UI shows**, never a filter. A low-confidence suggestion is still offered, with its label visible, because the household is better placed than the arithmetic to know whether last spring was typical.

---

## 7. Applying a suggestion

### 7.1 Household and personal budgets, both

**MUST-7.1** The `budgets` table carries a `scope` of `'household'` or `'personal'` with a nullable `user_id`, and both are first class here. Suggestions are computed **per scope**:

- **Household**: `categorySeries({ scope: 'household', userId: null })`, which counts every transaction regardless of attribution.
- **Personal, for user U**: `categorySeries({ scope: 'personal', userId: U })`, which counts only rows attributed to U.

The two produce different numbers for the same category and neither is derived from the other.

**MUST-7.2 (the attribution caveat, stated rather than discovered).** `attributed_user_id` is NULL on most imported rows until somebody sets it. In a household that has never attributed anything, every personal series is all zeros, every personal median is zero, and MUST-6.1 step 2 returns `'no-spend'` for every category. That is correct behaviour and the personal sections simply show no suggestions. MUST-15.2 gives the copy that explains it, so the absence reads as an explanation rather than a bug.

### 7.2 The two server actions

**MUST-7.3** `src/app/(app)/budgets/actions.ts` gains two actions. Both begin with the same three lines every existing action in that file begins with: `isSameOrigin(await headers())`, `await requireUser()`, and the zod parses.

```ts
export async function applySuggestionAction(prev: BudgetActionState, formData: FormData): Promise<BudgetActionState>;
export async function applyAllSuggestionsAction(prev: BudgetActionState, formData: FormData): Promise<BudgetActionState>;
```

**MUST-7.4 (the amount is never a form field).** `applySuggestionAction` takes `scope`, `userId`, `month` and `categoryId`, and **no amount**. It recomputes the suggestion server-side from the same inputs the page used and writes that. A crafted request therefore cannot write an arbitrary number through a path labelled "suggestion", and, more importantly, the button's label can never disagree with what the button did: there is one computation, on the server, at the moment of the write.

**MUST-7.5** If the recomputed suggestion is `null` for any reason (the history moved, the category was archived and re-scoped, a transaction was deleted between the render and the press), the action writes **nothing** and returns `{ error: 'That suggestion is no longer available. Reload the page.' }`. It never falls back to a stale number.

**MUST-7.6 (permissions, identical to the existing rule).** Members may apply to **household** budgets and to their **own** personal budgets. Admins may apply to anyone's. This is `setLimitAction`'s rule verbatim, in the same shape:

```ts
const userId = scope === 'personal' ? (rawUserId === '' ? user.id : Number(rawUserId)) : null;
if (scope === 'personal' && userId !== user.id && user.role !== 'admin') {
  return { error: 'You can only edit your own personal budgets.' };
}
```

**MUST-7.7 (the write is the existing write).** Both actions call `upsertBudget({ scope, userId, categoryId, month, amountCents })` from `src/lib/budgets.ts` and nothing else. That means the existing effective-month semantics apply unchanged: applying a suggestion while viewing month M upserts a row at `effective_month = M` and never mutates an earlier row, exactly as typing a limit does. A suggested budget and a typed budget are indistinguishable in the database, and that is deliberate: there is no "this was a suggestion" flag to store, no column to add, and no second code path for clearing one.

**MUST-7.8 (apply-all never overwrites)**. `applyAllSuggestionsAction` takes `scope`, `userId` and `month`, and applies every available suggestion **only to categories whose resolved limit for that month is currently `null`**. A category with a limit somebody typed is skipped, always, with no confirmation dialog and no override flag. The success message names both numbers: `Set 7 budgets from suggestions. Skipped 4 categories that already had a limit.`

**MUST-7.9** Both actions call `revalidatePath('/budgets')` on success, matching the existing two actions in the file.

**MUST-7.10** Neither action is rate limited, matching every existing budget action. `applyAllSuggestionsAction` performs at most one `categorySeries()` read plus one `upsertBudget()` per category, which is bounded by the household's category count and is well inside what the existing `copyPreviousMonthAction` already does.

---

## 8. The pace projection

### 8.1 The formula

**MUST-8.1** `projectMonthEnd()` is pure and takes three integers:

```ts
// src/lib/predict/pace.ts, PURE
export function projectMonthEnd(input: {
  spentCents: number;      // net spend for the month so far
  dayOfMonth: number;      // 1..31, the day in the app's TZ
  daysInMonth: number;     // 28..31
}): number | null;
```

Returning `divRound(spentCents * daysInMonth, dayOfMonth)`.

**MUST-8.2** `dayOfMonth` comes from `Number(today.slice(8, 10))` where `today = todayIso(now, tz)`, and `daysInMonth` comes from `Number(monthEnd(month).slice(8, 10))`. Both use only the exported surface of `src/lib/dates.ts`; neither constructs a `Date` and neither reimplements a leap-year rule. February is 29 days in 2028 because `monthEnd` already says so.

**MUST-8.3 (today counts as elapsed).** The divisor is the day number itself, not `dayOfMonth - 1`. A transaction dated today is already in `spentCents`, so on the 10th the household has ten days of spending, not nine. Off by one here is a 10 percent error on the 10th.

**MUST-8.4 (the early-month guard).** `dayOfMonth < PACE_MIN_DAY_OF_MONTH` (7) returns `null`, and a `null` projection is never displayed and never notified. Three days of spending multiplied by ten is a rumour.

**MUST-8.5** `spentCents <= 0` returns `0`. A category that is net-refunded so far this month is not projected into a negative month-end, and it can never trigger an overshoot.

**MUST-8.6** There is **no** day-of-week weighting, no weekend adjustment and no "known upcoming recurring charge" term. A household that pays rent on the 1st will see a high projection on the 7th and a truthful one by the 20th, and the UI copy says the projection assumes the rest of the month looks like the part already spent (MUST-14.4). An explanation is cheaper and more honest than a model.

### 8.2 Where the month-to-date number comes from

**MUST-8.7** `spentCents` for the projection is `budgetProgress(currentMonth, scope, userId)`'s `spentCents` for that row, the number already on screen. It is not re-queried and not recomputed. This is the same discipline notify MUST-6.16 puts on the budget events: the projection can never disagree with the progress bar beside it.

---

## 9. The six notification events

### 9.1 The registry entries

**MUST-9.1** `src/lib/notify/events.ts` gains exactly six appended entries. Nothing else in that file's existing content changes.

| `id` | `label` | `audience` | `trigger` | `defaultEnabled` |
|---|---|---|---|---|
| `budget_pace` | On pace to go over budget | `all` | `daily_slot` | `true` |
| `unusual_transaction` | An unusually large charge | `all` | `tick` | `true` |
| `subscription_creep` | A recurring charge went up | `all` | `daily_slot` | `true` |
| `duplicate_charge` | A possible duplicate charge | `all` | `tick` | `true` |
| `predicted_vs_actual` | Last month, predicted against actual | `all` | `daily_slot` | `false` |
| `suggested_budget_refresh` | New month, new suggested budgets | `all` | `daily_slot` | `false` |

**MUST-9.2** The default split follows notify MUST-4.1 exactly: on for "something is wrong or is about to be", off for the two informational month-boundary reports a person should opt into. As with every default, it has no effect until the user has an enabled channel (notify MUST-4.2).

**MUST-9.3** All six are `audience: 'all'`. None of them requires admin rights to act on: a member can move their own budget, look at their own transaction, or cancel their own subscription.

**MUST-9.4** Every `id` above is **permanent** once shipped, per notify MUST-4.5. `notification_prefs` keys on the string.

**MUST-9.5** The `trigger` field is metadata that records when the event is evaluated. It is asserted by the existing table in `tests/lib/notify/events.test.ts`, which gains six rows, and it drives no behaviour. The actual cadence is the call site in section 10.

### 9.2 `budget_pace`

**MUST-9.6 (trigger condition).** Evaluated on the user's **daily slot**, for the **current month only**, over the same two scopes `evaluateBudgets()` walks: household rows to every user with the event enabled, personal rows only to that user. A row fires when **all** of these hold:

1. `dayOfMonth >= PACE_MIN_DAY_OF_MONTH` (7).
2. `row.limitCents !== null` and `row.limitCents > 0`. A zero limit is `budget_exceeded`'s business, not a projection's.
3. `row.spentCents <= row.limitCents`. A budget already blown is `budget_exceeded`'s message, and sending both would be telling somebody their roof might leak while they stand in the rain.
4. `projected !== null` and `projected * 100 >= row.limitCents * PACE_OVERSHOOT_MIN_PCT`. A projected 3 percent overshoot on the 7th is noise; 10 percent is a number worth acting on.

**MUST-9.7 (dedup key).** `pace:<h|p>:<categoryId>:<month>`, using the same `scopeLetter()` helper the two existing budget keys use.

```ts
export function budgetPaceKey(scope: BudgetScopeKey, categoryId: number, month: string): string {
  return `pace:${scopeLetter(scope)}:${categoryId}:${month}`;
}
```

**MUST-9.8 (cadence).** At most **one message per scope, per category, per month, ever**. It fires on the first day at or after the 7th on which the projection crosses the threshold, and never again that month, whether the projection later gets worse, gets better, or crosses back and forth. Re-alerting on a moving projection is how a useful alert becomes an ignored one.

**MUST-9.9 (pruning safety).** The key contains the month and the evaluator only ever visits the current month, so a row pruned by the 400-day sweep belongs to a month that is never evaluated again. This is the identical argument the existing `budget:...` keys rest on.

**Message.** Subject `On pace to go over: Groceries (August 2026)`. Body: `Your Groceries budget for August 2026 is $600.00. You have spent $410.00 in 12 days. At that rate the month ends near $1,059.00, about $459.00 over.` The scope word is `scopeWord()`, the existing helper, so household and personal read as `Household` and `Your` exactly as the other budget messages do.

### 9.3 `unusual_transaction`

**MUST-9.10 (trigger condition).** A transaction fires when **all** of these hold:

1. The household's data spans at least `UNUSUAL_MIN_HOUSEHOLD_HISTORY_DAYS` (60) days, measured from `min(transactions.date)` to today. A first import has no baseline to be unusual against.
2. The row is non-transfer, has `amount_cents < 0` (a spend, not a refund or a deposit), and its `date` is within the last `UNUSUAL_LOOKBACK_DAYS` (14) days.
3. `Math.abs(amountCents) >= UNUSUAL_MIN_ABS_CENTS` ($50). A $1 coffee that became $4 is a triple and is not news.
4. A baseline exists. The **merchant baseline** is `medianCents` of `Math.abs(amount_cents)` over the other non-transfer spend rows with the same `normalized_merchant` in the last `UNUSUAL_BASELINE_DAYS` (365) days, requiring at least `UNUSUAL_MIN_SAMPLES` (5) of them. When the merchant has fewer than 5, the **category baseline** is used instead: the same median over rows in the same `category_id` and the same window, with the same minimum of 5. When neither qualifies, the row does not fire.
5. `Math.abs(amountCents) >= UNUSUAL_MULTIPLE * baseline` (3x).

**MUST-9.11** The baseline **excludes the row being tested**. Including it pulls the median toward the outlier and makes a large charge partly responsible for deciding it is not large.

**MUST-9.12 (dedup key).** `unusual:<transactionId>`. One message per transaction, ever.

**MUST-9.13 (cadence and the volume cap).** Evaluated on **every tick**, fingerprint-guarded per section 10.2, so an afternoon import is reported in minutes. At most `UNUSUAL_MAX_PER_EVALUATION` (5) events are enqueued per user per evaluation, taken **oldest transaction first**, so a large import cannot produce forty messages in one pass. The remainder are simply not enqueued and, because the fingerprint will not have changed, are not retried; this is a deliberate cap on noise, not a queue, and MUST-19.6 records that decision.

**MUST-9.14 (pruning safety).** 14 days is far below the 400-day retention (MUST-3.7). A transaction whose outbox row is pruned is 386 days outside the evaluation window and can never be re-examined.

**Message.** Subject `Unusual charge: CANADIAN TIRE $412.88`. Body names the date, the account, the amount, the usual amount, and which baseline was used: `This is about 3.4 times the $121.00 you usually spend at CANADIAN TIRE.` or `...the $121.00 that Home & Garden charges usually run.` The merchant string passes through the existing `truncateText(name, NAME_MAX)`, per notify MUST-10.3.

### 9.4 `subscription_creep`

**MUST-9.15 (what counts as recurring).** A `normalized_merchant` is recurring when, over the last `CREEP_BASELINE_DAYS` (365) days, it has at least `CREEP_MIN_CHARGES` (4) non-transfer spend rows, and the **median gap in days between consecutive charges** falls in either the monthly band (`CREEP_MONTHLY_GAP_MIN_DAYS` 25 to `CREEP_MONTHLY_GAP_MAX_DAYS` 35) or the yearly band (350 to 380). Those are the two real cases; weekly and quarterly subscriptions are out of scope for this release and named in section 22.

**MUST-9.16 (trigger condition).** For a recurring merchant, the **most recent** charge fires when:

1. Its date is within the last `CREEP_LOOKBACK_DAYS` (35) days.
2. `newAmount > baseline`, where `baseline` is `medianCents` of `Math.abs(amount_cents)` over the **preceding** charges from that merchant in the window (at least 3 of them, by MUST-9.15).
3. `(newAmount - baseline) * 100 >= baseline * CREEP_MIN_PCT` (5 percent) **and** `newAmount - baseline >= CREEP_MIN_ABS_CENTS` ($1). Both, so neither a large cheap subscription nor a tiny expensive one slips through on a technicality.

**MUST-9.17 (dedup key).** `creep:<transactionId>` where the id is the **increased charge**. One message per price change, ever. The next month's charge at the new price does not fire again, because by then the median of the preceding charges has moved and condition 3 fails; if the price rises a second time, that is a different transaction id and a legitimately new message.

**MUST-9.18 (cadence).** The user's **daily slot**. A price increase is not urgent enough to warrant a per-tick scan, and 35 days of lookback means a container that was off for a week loses nothing. At most `CREEP_MAX_PER_EVALUATION` (5) per user per evaluation.

**MUST-9.19 (pruning safety).** 35 days is far below 400.

**Message.** Subject `Price went up: NETFLIX`. Body: `NETFLIX charged $20.99 on 2026-08-14. The last 3 charges were $16.49. That is $4.50 more, about 27 percent.`

### 9.5 `duplicate_charge`

**MUST-9.20 (trigger condition).** A pair of transactions fires when:

1. Both are non-transfer spends (`amount_cents < 0`), with the **same `normalized_merchant`** and the **exact same `amount_cents`**.
2. Their dates are within `DUPLICATE_WINDOW_DAYS` (3) days of each other, measured with `daysBetweenIso`.
3. The **later** of the two is dated within the last `DUPLICATE_LOOKBACK_DAYS` (14) days.
4. `Math.abs(amount_cents) >= DUPLICATE_MIN_ABS_CENTS` ($10). Two identical $4 transit fares in one day are two transit fares.

**MUST-9.21 (what this is not).** The importer's `transactions_dedup_uq` index already collapses byte-identical repeats from the same file, and SimpleFIN's `external_id` index does the same for the provider path. Everything that reaches this evaluator therefore survived both, which means it is either a genuine second charge or a bank reporting the same charge twice with different raw text. The message says exactly that rather than asserting a duplicate, and the event is named `possible` in its blurb for the same reason.

**MUST-9.22 (dedup key).** `dupe:<lowerId>:<higherId>` with the two transaction ids sorted ascending, so the same pair produces the same key regardless of which row the scan reaches first.

**MUST-9.23 (pairing rule).** Each later transaction is paired with the **single nearest earlier** matching transaction, never with all of them. Three identical charges on three consecutive days produce two events (2 with 1, 3 with 2), not three.

**MUST-9.24 (cadence).** Every **tick**, sharing section 10.2's fingerprint with `unusual_transaction` because both read the same 14-day slice. At most `DUPLICATE_MAX_PER_EVALUATION` (5) per user per evaluation.

**MUST-9.25 (pruning safety).** 14 days, far below 400.

**Message.** Subject `Possible duplicate: BELL CANADA $89.50`. Body: `BELL CANADA charged $89.50 on 2026-08-12 and again on 2026-08-13. It may be a real second charge, or the bank may have reported one charge twice.`

### 9.6 `predicted_vs_actual`

**MUST-9.26 (trigger condition).** Evaluated on the user's **daily slot**. It fires when `dayOfMonth <= MONTH_REPORT_DAY_MAX` (3), and reports on `M = addMonths(currentMonth, -1)`, the month that just ended. It does not fire when the previous month has no category with either a resolved limit or a computable suggestion.

**MUST-9.27 (what "predicted" means, since nothing is stored).** There is no stored prediction, because there is no new table (MUST-1.4). "Predicted" is therefore **recomputed at report time**: the suggestion the app would have produced for month M, from the six full calendar months ending at `addMonths(M, -1)`. That is reproducible from data already in the database, it is the same function the Budgets page calls, and it is stated in the message itself so nobody reads it as a recorded forecast. Section 20 (D3) records this as a deviation from the obvious reading of the feature name.

**MUST-9.28 (dedup key).** `predvs:<M>` where M is the reported month.

**MUST-9.29 (cadence and pruning safety).** Once per month, ever. The three-day window exists so that a container switched off on the 1st still delivers on the 2nd or 3rd, on top of the daily slot's own 12-hour catch-up. The key advances monthly and the evaluator only ever visits the immediately previous month, so a pruned row belongs to a month that is never revisited. This is the same argument `weeklyDigestKey` rests on.

**MUST-9.30** The body carries at most `MONTH_REPORT_MAX_LINES` (8) categories, chosen by the largest absolute difference between actual and predicted, plus one household total line. It is rendered with the existing `padded()` two-column helper in `render.ts`, so it reads as a table in plain text exactly as the weekly digest does.

**Message.** Subject `July 2026: what we expected against what happened`. Body lines of the shape `Groceries        $620.00 expected, $713.40 actual, $93.40 difference`, then `Across every category with a suggestion, July 2026 came in $210.00 over what the last six months pointed at.`

### 9.7 `suggested_budget_refresh`

**MUST-9.31 (trigger condition).** Evaluated on the user's **daily slot**, when `dayOfMonth <= MONTH_REPORT_DAY_MAX` (3), for the **current** month T. It fires only when at least one category's suggestion for T differs from the limit currently resolved for T by at least `SUGGEST_REFRESH_MIN_DELTA_PCT` (10 percent) **and** at least `SUGGEST_REFRESH_MIN_DELTA_CENTS` ($10). A category with no resolved limit counts as a difference when it has a suggestion at all.

**MUST-9.32 (dedup key).** `suggest:<T>`. Once per month, ever.

**MUST-9.33** The message **never applies anything**. It names up to `MONTH_REPORT_MAX_LINES` (8) categories and tells the reader the Budgets page has the buttons. Applying a budget is a decision a person makes, and a notification that quietly rewrote the household's budgets on the 1st of every month would be the single worst thing in this release.

**MUST-9.34 (pruning safety).** Monthly key, current month only, same argument as MUST-9.29.

**Message.** Subject `New month: 5 suggested budgets changed`. Body lines of the shape `Groceries        $780.00 suggested, $600.00 set`, then `Open Budgets to apply any of these. Nothing has been changed.`

### 9.8 Scope handling, for the four category-shaped events

**MUST-9.35** `budget_pace`, `predicted_vs_actual` and `suggested_budget_refresh` are all scope-aware and follow `evaluateBudgets()`'s pattern exactly: household rows are evaluated once and delivered to **every** user with the event enabled; personal rows are evaluated per user and delivered **only to that user**. The dedup keys of `budget_pace` carry the scope letter for exactly this reason. `predicted_vs_actual` and `suggested_budget_refresh` render **both** scopes into one message per user (a household section and a "yours" section), which is why their keys carry only the month: one message per user per month covering everything they can see.

**MUST-9.36** `unusual_transaction`, `subscription_creep` and `duplicate_charge` are **household-wide**: the same transaction is reported to every user with the event enabled, with no attribution filter. A large charge is a household fact, and filtering it by `attributed_user_id` would hide exactly the charges nobody has claimed yet.

### 9.9 Rendering

**MUST-9.37** `src/lib/notify/render.ts` gains six `RenderInput` union members and six `case` blocks. It stays pure, it stays the one renderer for both channels, and no body carries a URL (notify MUST-10.4). Every merchant name, category name and account name passes through `truncateText(value, NAME_MAX)`.

**MUST-9.38** `renderEvent`'s switch keeps its no-`default` shape. The declared return type means a union member with no matching case is a TS2366 compile error, which is what guarantees the union member and the case land in the same change.

**MUST-9.39** Every amount in every body is formatted by the existing `money()` wrapper over `formatCents(cents, { currency: true })`. No new number formatting is introduced.

### 9.10 The no-migration proof, discharged

**MUST-9.40** Adding these six events touches exactly three source files: `src/lib/notify/events.ts` (six entries, six key builders), `src/lib/notify/render.ts` (six union members, six cases) and the three new evaluator modules that call `enqueue()`. It touches **no** migration, **no** `src/db/schema.ts` line, and **no** settings UI component, because the toggle matrix is generated from the registry (notify MUST-11.3). `tests/db/notification-schema.test.ts`'s existing "accepts an event_id that is not in the registry" assertion already covers the storage half; section 17.5 adds the assertion that the rendered matrix gains six rows with no component edit.

**MUST-9.41** Every one of the six dedup keys is inserted through the existing `enqueue()`, which is `INSERT ... ON CONFLICT DO NOTHING` against `notification_outbox_dedup_uq`. Idempotency is therefore structural: re-running any evaluator with the same inputs inserts nothing and returns zero. No evaluator keeps its own record of what it has sent.

---

## 10. Evaluation cadence and the fingerprint guards

### 10.1 Where the three evaluators are called

**MUST-10.1** `src/lib/notify/evaluate/index.ts` changes in exactly three places, and `runScheduledEvaluation`'s existing structure, its per-user try/catch blocks and its slot-skip logging are otherwise untouched:

```ts
      const daily = dailySlot(now, settings.dailyHour, tz);
      if (daily.fires) {
        evaluateComingDue({ userId: user.id, now, tz });
        evaluateStaleImport({ userId: user.id, now, tz });
        evaluateBudgetPace({ userId: user.id, now, tz });        // new
        evaluateSubscriptionCreep({ userId: user.id, now, tz }); // new
        evaluateMonthBoundary({ userId: user.id, now, tz });     // new, both month events
      } else {
```

and, beside the existing `evaluateBudgets` call at the end:

```ts
  try {
    evaluateBudgets({ now, tz });
  } catch (error) { ... }

  try {
    evaluateAnomalies({ now, tz });   // new: unusual_transaction + duplicate_charge
  } catch (error) {
    console.error('[notify] anomaly evaluation failed', error);
  }
```

**MUST-10.2** `src/lib/scheduler.ts` is **not** changed. `runNotifyTick`'s dormancy bail (`if (!hasAnyEnabledTarget() && countPendingOutbox() === 0) return;`) is the first statement after the single-flight guard and remains so, which means a household with no notification channel runs **none** of this. `tests/lib/scheduler.test.ts`'s existing dormancy assertion is unamended.

**MUST-10.3** Each new evaluator is wrapped so one throwing user cannot stop the rest of the household from being told anything, matching the existing pattern. Each logs one line on failure and returns.

### 10.2 The tick fingerprint

**MUST-10.4** `evaluateAnomalies` runs on **every** tick, so it needs the same guard `evaluateBudgets` uses. The fingerprint is one query over the derived 17-day slice both anomaly detectors read (`DUPLICATE_LOOKBACK_DAYS` + `DUPLICATE_WINDOW_DAYS`), wider than `unusual_transaction`'s own 14-day window so that a duplicate pair whose later half sits on the 14-day boundary still has its earlier half inside the slice:

```ts
select count(*) as n,
       coalesce(max(id), 0) as maxId,
       coalesce(max(updated_at), '') as maxUpdated
from transactions
where date >= :sliceStart
```

served by `transactions_date_idx`, concatenated with the participant list (`userId:enabled` pairs, sorted by user id) exactly as `budget.ts` does. An unchanged fingerprint returns immediately. (Amended after the Task 8 review: the earlier wording named a plain 14-day slice; the shipped slice is 17 days, a strict superset of the 14-day window that is therefore also safe as the fingerprint's basis, sanctioned by the Task 8 implementation brief.)

**MUST-10.5** `max(updated_at)` is in the fingerprint so that **re-categorising** an existing transaction, which changes neither the count nor the max id, still triggers a re-evaluation. That matters here because the `unusual_transaction` category baseline (MUST-9.10 condition 4) depends on `category_id`.

**MUST-10.6** The fingerprint is recorded **after** every participant has been processed without throwing, following the fix already applied in `budget.ts`: recording it first would let one participant's transient error burn the fingerprint for the whole household. A retried evaluation with the same fingerprint costs nothing, because `enqueue()` is idempotent.

**MUST-10.7** `resetAnomalyFingerprintForTests()` is exported alongside the existing `resetBudgetFingerprintForTests()` and is called from the shared test reset helper.

**MUST-10.8** The daily-slot evaluators need **no** fingerprint. They run at most once per user per day by construction: a per-user record of the last daily slot date actually processed (mirroring `digestAlreadySent`'s existence check for the weekly digest) skips `evaluateBudgetPace`, `evaluateSubscriptionCreep` and `evaluateMonthBoundary` entirely once that slot has already run, and their dedup keys make a second run within the catch-up window a no-op regardless. (Amended in the final fix wave: the code as shipped in v1.0/v1.1 relied on the dedup keys alone, with no record of a slot already processed, so an unchanged tick inside the 12-hour catch-up window still recomputed all three roughly 144 times a day. The per-slot record above is what makes "at most once per user per day" true rather than aspirational.)

### 10.3 Cost

**MUST-10.9** On a tick where the anomaly fingerprint is unchanged and the user's daily slot has already been processed for its slot date, the total added cost of this release is **one indexed count query**. On a tick where the fingerprint has changed, it is one 17-day row read, plus per candidate a merchant baseline query, plus, at most once per distinct category represented among the candidates, a memoised category baseline query. On the one tick per user per day where a new daily slot is first processed, it additionally runs `evaluateBudgetPace`, `evaluateSubscriptionCreep` and `evaluateMonthBoundary` once each; MUST-10.8's per-slot record is what keeps that to once a day rather than once per five-minute tick. There is no per-tick suggestion computation anywhere: suggestions are computed on the Budgets page render, in the two daily-slot month events, and nowhere else. (Amended after the Task 8 review: the earlier wording named a 14-day row read and a single unconditional baseline aggregate per candidate; the shipped slice is 17 days for the reason given at MUST-10.4, and `findUnusual()` now shares one category baseline query across every candidate in the same category instead of repeating it.) (Amended in the final fix wave: the earlier wording described only the anomaly fingerprint's cost and left out the three daily-slot evaluators, which the shipped v1.0/v1.1 code re-ran on every tick inside the 12-hour catch-up window regardless of that fingerprint. MUST-10.8's per-slot record closes that gap, and this line now states the true steady-state cost.)

**MUST-10.10** A household with **no user** having any anomaly event enabled skips the fingerprint query entirely, via the same `computeParticipants()`-shaped early return `evaluateBudgets` uses. Zero enabled participants means zero queries.

---

## 11. Date-range presets: the resolution helper

### 11.1 `src/lib/date-range.ts`

**MUST-11.1** The seven presets, their ids, and their labels, in this order, as one exported array that both the picker and every server caller read:

| `id` | Label |
|---|---|
| `this_month` | This month |
| `last_month` | Last month |
| `last_3_months` | Last 3 months |
| `last_6_months` | Last 6 months |
| `ytd` | Year to date |
| `last_year` | Last year |
| `custom` | Custom |

```ts
export type RangePresetId =
  | 'this_month' | 'last_month' | 'last_3_months'
  | 'last_6_months' | 'ytd' | 'last_year' | 'custom';

export const RANGE_PRESETS: readonly { id: RangePresetId; label: string }[];

export function isRangePresetId(value: string): value is RangePresetId;

export interface ResolvedRange {
  preset: RangePresetId;
  from: string;   // ISO date
  to: string;     // ISO date
  label: string;  // 'Last 3 months' or, for custom, '2026-01-01 to 2026-03-31'
}

export function resolveRange(input: {
  preset: string | null | undefined;
  from: string | null | undefined;
  to: string | null | undefined;
  today: string;                          // ISO, resolved by the CALLER (MUST-11.4)
  fallback: RangePresetId | null;
}): ResolvedRange | null;

export function rangeParams(range: ResolvedRange | null): Record<string, string>;
```

### 11.2 Exact definitions

**MUST-11.2** With `M = monthOf(today)` and `Y = today.slice(0, 4)`, each preset resolves to exactly:

| `id` | `from` | `to` |
|---|---|---|
| `this_month` | `monthStart(M)` | `monthEnd(M)` |
| `last_month` | `monthStart(addMonths(M, -1))` | `monthEnd(addMonths(M, -1))` |
| `last_3_months` | `monthStart(addMonths(M, -2))` | `monthEnd(M)` |
| `last_6_months` | `monthStart(addMonths(M, -5))` | `monthEnd(M)` |
| `ytd` | `${Y}-01-01` | `monthEnd(M)` |
| `last_year` | `${Y - 1}-01-01` | `${Y - 1}-12-31` |
| `custom` | the given `from` | the given `to` |

**MUST-11.3 (three things this table settles, deliberately).**

1. `last_3_months` and `last_6_months` **include the current, partial month**. Three calendar months means this one and the two before it. This is stated in the picker's own option text nowhere and in the docs everywhere, because "Last 3 months" is what people say and any other reading needs a longer label. Note that this is a different window from the predictive history window of section 4, which deliberately excludes the partial month; the two are unrelated and section 14.3 makes the Reports page say so.
2. Every `to` is a **month end**, not `today`. The range therefore does not change meaning between the morning and the evening of the same day, and a manually entered transaction dated later this month is inside "This month" rather than invisible.
3. `resolveRange` performs **no clamping to today**. There is no data after today anyway, and clamping would make `this_month` and `ytd` produce a different `to` on every page load.

**MUST-11.4 (the timezone rule, and it is the important one).** `resolveRange` **never** determines the current date. It takes `today` as a required parameter. Every server caller passes `todayIso(new Date(), readEnv().tz)`, the app's one existing way of resolving "today" in the configured `TZ`. The client component **never** calls `resolveRange` and never computes a date from the browser clock.

This is the entire reason the URL carries a preset token rather than a resolved pair of dates. A phone in another timezone, or a laptop whose clock is a day off, must not be able to produce a different "This month" than the server would, because the same "This month" appears in a `budget_pace` notification computed server-side, and a page that disagrees with a notification is a page nobody trusts again.

**MUST-11.5 (custom validation).** For `custom`:

- Both `from` and `to` must satisfy the existing `isIsoDate()`. An invalid one is discarded.
- If both are discarded, the result is the `fallback` preset (or `null` when the fallback is `null`).
- If exactly one survives, the other is filled from the same preset resolution the fallback would give, and the result stays `custom`.
- If `from > to` after validation, the two are **swapped** rather than rejected. Somebody who typed them backwards meant the range between them.

**MUST-11.6 (precedence, so a stale pair can never contradict a label).**

1. `preset` present and recognised and **not** `custom`: the preset wins and any `from` or `to` in the URL is **ignored entirely**.
2. `preset === 'custom'`: `from` and `to` are read, per MUST-11.5.
3. `preset` absent or unrecognised, but `from` or `to` present: treated as `custom`. This is what keeps every existing bookmark, and the existing Export CSV link, working byte for byte.
4. Nothing present: the `fallback`, or `null` when the fallback is `null`.

**MUST-11.7 (`fallback: null` means no range at all).** `resolveRange` returns `null`, and the caller applies no date filter. This is what Transactions needs, since it has never had a default date filter and adding one would hide the older rows people open that page to find. Section 20 (D1) records the consequence for the picker.

**MUST-11.8** `rangeParams()` is the one place a range is turned back into query parameters, so no page hand-builds a link. It returns `{}` for `null`, `{ range: id }` for a non-custom preset, and `{ range: 'custom', from, to }` for a custom one. The Export CSV link and any future link is built from it.

**MUST-11.9** `resolveRange` is **total**: every combination of the four inputs produces either a `ResolvedRange` or `null`, and it never throws. A property test over generated garbage inputs asserts it.

---

## 12. The picker component

### 12.1 The contract

**MUST-12.1** `src/components/ui/DateRangePicker.tsx` is a client component with exactly this surface:

```tsx
'use client';

export function DateRangePicker(props: {
  /** The server-resolved preset, or '' when there is no range (allowAny only). */
  value: RangePresetId | '';
  /** The server-resolved endpoints. Prefill the two date inputs on the custom branch. */
  from: string;
  to: string;
  /** Server-resolved today, in the app's TZ. Bounds the custom inputs' `max`. */
  today: string;
  /** Renders an extra "Any dates" option whose value is ''. Transactions only. */
  allowAny?: boolean;
  className?: string;
}): React.ReactElement;
```

**MUST-12.2 (it is a form control, not a router).** The component renders **inside the page's existing `<form method="get">`**. It performs no `router.push`, no `fetch`, no `useEffect` and no navigation of its own. Pressing the form's existing submit button is what applies the range, exactly as it does for the account, category and person selects beside it. This keeps every page a plain server-rendered GET and keeps the back button meaningful.

**MUST-12.3 (the field names).** One `<select name="range">`, and two `<input type="date">` named `from` and `to`. Those are the same two names the two pages use today, which is why MUST-11.6 case 3 keeps old links working with no redirect.

**MUST-12.4 (disabled, not hidden).** When the selected preset is anything other than `custom`, the two date inputs are rendered with `disabled` and are visually hidden. A disabled input is **not submitted**, so a stale `from` or `to` cannot ride along beside a preset and produce a URL whose two halves disagree. This is belt and braces over MUST-11.6 case 1, and it is worth having both: one keeps the URL clean, the other keeps the server right even if the URL is not.

**MUST-12.5 (the only state).** One `useState<RangePresetId | ''>` holding the current selection, initialised from `props.value`. Nothing else. The component derives everything it renders from that and its props.

**MUST-12.6 (custom bounds).** Both date inputs carry `max={today}`, using the **server-resolved** today passed in as a prop. The Transactions page already passes `today={todayIso()}` into its client for the manual-entry form, so this is the established shape and not a new one.

**MUST-12.7 (accessibility).** The select is labelled by the existing `<Field label="Dates">` wrapper, and the two date inputs keep their own `From` and `To` `<Field>` labels so a screen reader announces which is which. The component uses `selectClass` and `inputClass` from `src/components/ui/form.tsx` and introduces no new styling constants.

**MUST-12.8** The component imports `RANGE_PRESETS` and `RangePresetId` from `@/lib/date-range`, which is pure and client-safe by MUST-2.3. It imports nothing from `@/lib/predict/history`, `@/db` or `@/lib/env`.

---

## 13. Which pages adopt it, and which do not

### 13.1 Reports

**MUST-13.1** `src/app/(app)/reports/page.tsx` replaces its inline `from`/`to` parsing with:

```ts
const today = todayIso(new Date(), readEnv().tz);
const range = resolveRange({
  preset: one('range'), from: one('from'), to: one('to'),
  today, fallback: 'last_6_months',
})!;   // non-null: the fallback is non-null
```

**MUST-13.2 (byte-identical default).** The current default is `monthStart(addMonths(currentMonth(), -5))` through `monthEnd(currentMonth())`, which is exactly what `last_6_months` resolves to. The page's behaviour with an empty query string is therefore unchanged, and a test asserts the two expressions agree.

**MUST-13.3** `ReportsClient` receives `range: ResolvedRange` in place of the two loose strings, renders `<DateRangePicker>` with `allowAny` **unset** (Reports has always had a range and always will), and builds the export link from `rangeParams(range)` rather than from string concatenation.

**MUST-13.4** The `PageHeader` eyebrow becomes `range.label`, so it reads `Last 6 months` rather than `2026-03-01 → 2026-08-31`. For a custom range the label is the two dates, so nothing is lost.

### 13.2 Transactions

**MUST-13.5** `src/app/(app)/transactions/page.tsx` resolves the range with `fallback: null` and feeds `TransactionFilter`:

```ts
const range = resolveRange({ preset: one('range'), from: one('from'), to: one('to'), today, fallback: null });
// ...
from: range?.from ?? null,
to: range?.to ?? null,
```

**MUST-13.6 (unchanged default).** With no query parameters, `range` is `null`, `filter.from` and `filter.to` are `null`, and `buildWhere` adds no date clause. That is exactly today's behaviour, and it is preserved on purpose: Transactions is the page people open to find a charge from March.

**MUST-13.7** `TransactionsClient` renders `<DateRangePicker allowAny>` in place of its two bare date inputs, in the same position in the same filter form, and the form's existing `Filter` button still applies it.

**MUST-13.8** The page passes the already-resolved `range` down so the picker's `value`, `from` and `to` reflect what the server used. Today the two inputs render with **no** `defaultValue` at all, so a filtered page forgets its own dates on reload. Fixing that is a consequence of adopting the shared component, not a separate change.

### 13.3 The CSV export route

**MUST-13.9** `src/app/api/reports/export/route.ts` resolves `range` with the **same helper and the same `fallback: null`** as the Transactions page, so a link carrying `range=last_3_months` exports the same three months the page is showing. Without this the picker would silently produce a CSV over a different window than the screen.

**MUST-13.10** The route keeps `fallback: null` rather than Reports' `last_6_months`, because it serves both pages' links and the caller's parameters are always explicit. `rangeParams()` on the Reports client guarantees they are.

### 13.4 The pages that deliberately do not adopt it

**MUST-13.11** Each of these is a decision, recorded so a reader does not assume it was an oversight:

| Page | Why not |
|---|---|
| `/budgets` | Its selector is a **month**, not a range, because a budget row is defined per `effective_month`. A range picker there would imply budgets can span a range, which they cannot. |
| `/dashboard` | Fixed to the current month and a rolling 12-month trend by design (section 7 of the master spec). Making it range-filtered is a different feature. |
| `/goals` | Its date inputs are **data entry** (a goal's target date), not a filter. |
| `/warranties` and `/warranties/[id]` | Same: purchase and expiry dates are data entry. Its list filter is by expiry bucket, not by an arbitrary range. |
| `/review` | Has no date filter today and gains none. The review queue is defined by categorisation state, not by date. |
| `/import` | Has no date filter. Import history is a list of imports, not of transactions. |

---

## 14. Predictive UI surfaces

### 14.1 The Budgets page

**MUST-14.1** `src/app/(app)/budgets/page.tsx` computes, server-side, for the viewed month:

- `suggestions: Map<categoryId, Suggestion | { reason }>` per scope, from `categorySeries()` plus `suggestBudget()`.
- `projections: Map<categoryId, number | null>` per scope, from `projectMonthEnd()` over the `spentCents` already in the `BudgetRow` (MUST-8.7).

Both are computed **only when the viewed month is the current month**. For a past or future month, both are empty maps and the two columns render nothing. A pace projection for July, viewed in August, is not a projection.

**MUST-14.2** The client is thin. `budgets-client.tsx` receives the two maps as props and renders them. It performs **no** arithmetic beyond `formatCents`, which it already imports. It does not compute a median, a trend, a projection or a percentage.

**MUST-14.3 (the suggestion control).** Each editable row with a `Suggestion` gains, beside the existing amount input and Save button, one small button reading `Use $780`. It submits `applySuggestionAction` with `scope`, `userId`, `month` and `categoryId`, and no amount (MUST-7.4). Its `title` carries the reasoning: `Median of the last 6 full months, adjusted for a rising trend. Confidence: medium.`

**MUST-14.4 (the projection cell).** The row's progress-bar cell gains a second line, `On pace for $1,059`, shown only when the projection is non-null. When the projection exceeds the limit it takes the same warning colour the existing `BudgetProgressBar` already uses for an over-budget bar, so the page has one visual language for "this is going badly" rather than two. The cell's `title` reads `Assumes the rest of the month looks like the 12 days so far.`

**MUST-14.5 (the section control).** Each section header (household, and each person's) gains an `Apply all suggestions` button beside the existing `Copy previous month` button, wired to `applyAllSuggestionsAction`. Its hint reads `Only fills in categories with no limit set. Nothing you have typed is changed.`

**MUST-14.6** Both new buttons obey the same `editable` predicate the amount input already obeys, so a member looking at another member's personal section sees neither. The server enforces it independently (MUST-7.6); the client hiding it is courtesy, not security.

### 14.2 The Reports page: category baselines

**MUST-14.7** Reports gains one card, `Category baselines`, above the existing month-over-month card. Per category, one row: median, average, a trend arrow with the delta, and the suggested amount. It uses `TableWrap` and `Money` and introduces no new chart.

**MUST-14.8 (it deliberately ignores the range picker).** The card's window is **the last 6 full calendar months**, always, whatever the picker says. Its `CardHeader` description says exactly that: `Median and average over the last 6 full calendar months. This card does not follow the date filter above: a median needs equal-length months, and an arbitrary range does not have them.` Section 20 (D4) records the deviation. Without the sentence, a card that ignores the control directly above it is a bug report waiting to happen.

**MUST-14.9** The trend arrow uses the three new icons and carries a text label beside it (`Rising`, `Falling`, `Flat`, or nothing for `unknown`), so the information is not carried by shape and colour alone.

### 14.3 Copy that is required, not optional

**MUST-14.10** The following sentences ship as written, because each one is the difference between a number that is trusted and a number that is guessed at:

- Budgets, under the section heading, when the history window is shorter than 3 months: `Suggestions appear once there are three full calendar months of history.`
- Budgets, on the projection cell's title: `Assumes the rest of the month looks like the N days so far.`
- Reports baselines card description: the sentence in MUST-14.8, in full.
- `suggested_budget_refresh` body: `Nothing has been changed.`
- `duplicate_charge` body: `It may be a real second charge, or the bank may have reported one charge twice.`

---

## 15. Error and empty states

**MUST-15.1 (not enough history).** With fewer than 3 months in the clipped window, the Budgets page shows **no** suggestion buttons anywhere and one sentence under each section heading (MUST-14.10). It does **not** render disabled buttons. A disabled control invites a person to work out what would enable it.

**MUST-15.2 (no personal attribution).** When a person's personal series is entirely zero **and** the household series is not, that person's section shows: `No transactions are attributed to you yet, so there is nothing to base a personal suggestion on.` This is the state MUST-7.2 describes and it is by far the most likely empty state on a real install.

**MUST-15.3 (early in the month).** Before day 7, the projection line is simply absent. The column header carries a `title` of `Appears from the 7th of the month.` and no row shows a placeholder.

**MUST-15.4 (a category with no suggestion).** A row whose reason is `'no-spend'` or `'below-floor'` shows nothing at all in the suggestion slot. There is no `n/a`, no dash and no tooltip. A category the household does not spend on does not need a line explaining that.

**MUST-15.5 (the baselines card with nothing to show).** The existing `EmptyState` component with `title="Not enough history yet"` and the body `Baselines appear after three full calendar months.`

**MUST-15.6 (a stale suggestion).** MUST-7.5's error state, shown through the existing single-banner mechanism in `budgets-client.tsx`. The banner already shows only the most recent submission, so this does not add a second one.

**MUST-15.7 (an evaluator that throws).** Caught by the per-user or per-evaluator try/catch of MUST-10.3, logged as one line, and the rest of the evaluation continues. No notification failure can break a tick, and no tick failure can break the scheduler. This is notify MUST-6.19's rule and this release does not weaken it.

**MUST-15.8 (an empty range).** A date range with no transactions in it renders the **existing** `EmptyState` on each Reports card, unchanged by this release. The Transactions page's existing empty text (`Widen the date range or clear the search`) is likewise unchanged and remains accurate with a preset selected.

---

## 16. Egress and performance

### 16.1 The egress invariant

**MUST-16.1** `tests/ops/notify-egress.test.ts` gains `src/lib/predict/` as a third scanned tree, in the same table-driven shape it already uses for `src/lib/notify/` and `src/lib/update/`, with an expectation of **zero** `fetch(` call sites and **zero** URL string literals. `src/lib/date-range.ts` and `src/components/ui/DateRangePicker.tsx` are added to the same assertion.

**MUST-16.2** The app's complete egress destination list is **unchanged** by this release: `api.telegram.org`, the configured SMTP relay, `api.github.com`, the SimpleFIN access URL, and the Watchtower endpoint on the compose network. Nothing is added and nothing is removed.

### 16.2 Query budget

**MUST-16.3** The Budgets page render adds, over what it does today:

- one `firstDataMonth()` query;
- one `categorySeries()` query for the household scope;
- one `categorySeries()` query per active person for their personal scope;
- at most one `seasonalReference()` query per scope, and only on installs with 15 or more months of history.

That is `2 + 2P` queries for a household of P people, each a single grouped aggregate served by `transactions_date_idx`. It replaces nothing, so it is a net addition, and it is the largest single cost in this release.

**MUST-16.4** The pace projection adds **zero** queries: it reuses `budgetProgress()`'s `spentCents` (MUST-8.7).

**MUST-16.5** The Reports baselines card reuses the household `categorySeries()` result and adds one query, not one per category.

**MUST-16.6** No suggestion, series or projection is cached, memoised or stored. Every one is recomputed on demand from the transactions table. There is no cache to invalidate, which is the whole reason there is no new table.

---

## 17. Testing

Vitest, colocated under `tests/` mirroring the source layout. Every requirement above is written to be testable; the list below is the minimum, not the ceiling.

**MUST-17.1 (the network gate).** No test in this release performs network I/O of any kind, and none needs a stub, because no code path in either feature can reach the network.

### 17.1 Predictive, pure units: `tests/lib/predict/`

- **`stats.test.ts`**: `divRound` on `(5,2)`, `(-5,2)`, `(5,-2)`, `(-5,-2)`, `(4,2)`, `(0,7)`, asserting half-away-from-zero in all four sign quadrants. `medianCents` on empty, one, two, three and six elements, on an all-zero series, on a series with negatives, and asserting the input array is not mutated. `meanCents` likewise. `ceilToDollar` on `0`, `1`, `99`, `100`, `101`, and asserting it throws on `-1`. `trendOf` returning `'unknown'` under six values, and each of `'rising'`, `'falling'`, `'flat'` at, just under, and just over the threshold, including a case where the 10 percent rule binds and one where the $20 floor binds.
- **`window.test.ts`**: `historyMonths` for a target of `2026-08` with `firstDataMonth` of `null`, `2025-01` (full 6), `2026-05` (clipped to 3), `2026-07` (clipped to 1), and `2026-09` (in the future, giving an empty list). A year boundary case: target `2026-01` gives `2025-07` through `2025-12`.
- **`suggest.test.ts`**: each of the three `NoSuggestionReason` values reached by its own fixture. Steps 3, 4, 5, 6 and 7 each isolated by a fixture that exercises only that step. A property test over 500 generated series asserting the result is always `null` or a positive multiple of 100 cents, and always at most `3 * median + 99`. The cap actually binding, with a rising trend and a 2.0x seasonal factor on the same category. Confidence at each of `monthsUsed` 3, 4, 5, 6, and the spread downgrade applying at each level including `'low'` staying `'low'`.
- **`pace.test.ts`**: the formula on day 7 of a 31-day month, day 15 of a 28-day month, day 31 of a 31-day month (projection equals spend exactly), day 6 (null), zero spend, and negative spend (zero). A test asserting `daysInMonth` derived from `monthEnd('2028-02')` is 29.
- **`anomalies.test.ts`**: for each of the three detectors, a positive case, a case failing on each individual condition, the minimum-sample fallback from merchant to category baseline and then to nothing, the exclusion of the tested row from its own baseline (MUST-9.11), the duplicate pairing rule over three identical charges (MUST-9.23), the key ordering of a pair regardless of scan order, and the recurrence bands accepting 28 and 365 day gaps while rejecting 7 and 90 day ones.
- **`constants.test.ts`**: every exported constant's value pinned, plus the assertion that `UNUSUAL_LOOKBACK_DAYS`, `CREEP_LOOKBACK_DAYS` and `DUPLICATE_LOOKBACK_DAYS` are each strictly less than the imported `OUTBOX_RETENTION_DAYS` (MUST-3.7).

### 17.2 Predictive, database: `tests/lib/predict/history.test.ts`

- The rollup rule matching `budgetProgress()` on the same fixture, including an archived child rolling into its parent.
- Zero-filling: a category with spend in months 1 and 4 of a six-month window produces `[x, 0, 0, y, 0, 0]`.
- Household and personal scopes producing different series on the same fixture, and personal being all zeros when nothing is attributed.
- Income categories excluded, and an income child not altering a spend parent's total.
- `firstDataMonth()` ignoring transfers.
- A single query per call, asserted by counting prepared-statement executions.

### 17.3 The evaluators: `tests/lib/notify/evaluate/`

- **`pace.test.ts`**: fires once and only once for a scope/category/month across ten consecutive daily evaluations. Does not fire before day 7. Does not fire when already over the limit. Does not fire at a 105 percent projection and does fire at 110. Household rows reaching every enabled user, personal rows reaching only their owner.
- **`anomalies.test.ts`**: the fingerprint short-circuiting a second evaluation with no data change; a re-categorisation changing the fingerprint; the per-evaluation cap holding at 5 with 12 candidates; nothing firing at all on a household with under 60 days of history; the fingerprint recorded only after a clean pass (MUST-10.6).
- **`monthly.test.ts`**: both month events firing on day 1, 2 and 3 and not on day 4; each firing exactly once per month across all three days; `predicted_vs_actual` recomputing its prediction from the window ending two months back (MUST-9.27); `suggested_budget_refresh` not firing when every delta is under both thresholds, and firing when one clears both.
- **`dedup.test.ts`** (the existing file, extended): every one of the six new keys inserted twice inserts one row.

### 17.4 Budget application: `tests/app/budget-suggestions.test.ts`

- `applySuggestionAction` writing the recomputed amount and ignoring any `amount` field a crafted request adds.
- The same action refusing a member's write to another member's personal scope, and allowing an admin's.
- MUST-7.5's stale path: the suggestion becoming unavailable between render and submit returns the error and writes nothing.
- `applyAllSuggestionsAction` skipping every category with an existing limit, and its message reporting both counts.
- Both actions rejected on a cross-origin request.
- Applying at month M writing `effective_month = M` and leaving an earlier row untouched.

### 17.5 The registry-extension proof

**MUST-17.2** `tests/lib/notify/events.test.ts` gains the six rows and asserts, as it already does, that every id is unique and every audience and trigger is a valid union member. A test renders the notifications settings matrix for a member and for an admin and asserts it contains six new rows **with no edit to `notifications-client.tsx`**, discharging notify MUST-4.4 for the second time.

### 17.6 Date ranges: `tests/lib/date-range.test.ts`

- All seven presets resolved against `today = '2026-08-18'`, each asserting both endpoints exactly.
- The same seven against `2026-01-05` (year boundary), `2026-12-31`, and `2028-02-29` (leap day).
- MUST-11.6's four precedence cases, including a `range=last_month&from=2020-01-01` URL resolving to last month with the stray `from` ignored.
- MUST-11.5's four custom cases, including the swap.
- `fallback: null` with an empty input returning `null`.
- A property test over generated garbage (`range=';drop table'`, unicode, 5000 characters, arrays) asserting `resolveRange` never throws and always returns `null` or a valid pair.
- `rangeParams` round-tripping every preset back through `resolveRange` to the same result.
- **The timezone test that matters**: `resolveRange` called with the same inputs but two different `today` values gives two different answers, and a grep assertion that `src/lib/date-range.ts` contains no `new Date`, no `Date.now`, no `todayIso` and no `process.env`.

### 17.7 The picker: `tests/components/DateRangePicker.test.tsx`

- Renders seven options without `allowAny`, eight with it.
- Selecting `custom` reveals two enabled date inputs; selecting anything else renders them `disabled`.
- A `disabled` input is not present in the submitted `FormData` (MUST-12.4), asserted by constructing `FormData` from the form element.
- Both date inputs carry `max` equal to the `today` prop.

### 17.8 Page integration: `tests/app/`

- Reports with an empty query string producing the identical `from` and `to` it produces today (MUST-13.2).
- Transactions with an empty query string applying no date clause (MUST-13.6).
- An existing-style bookmark, `/transactions?from=2026-01-01&to=2026-03-31`, resolving to a custom range and returning the same rows it does today.
- `/api/reports/export?range=last_3_months` producing a CSV over the same rows the page shows for that preset.

### 17.9 Regression guards

- `tests/lib/scheduler.test.ts` unamended, its dormancy assertion still passing (MUST-10.2).
- A grep invariant asserting no file under `src/lib/predict/` except `history.ts` imports `@/db`, `@/lib/env` or a node builtin (MUST-2.1).
- A grep invariant asserting no `*-client.tsx` imports `@/lib/predict/history`.
- `tests/lib/budgets.test.ts` unamended: `upsertBudget`, `resolveBudget` and `budgetProgress` are not changed by this release.

---

## 18. Acceptance criteria

### 18.1 Automated, all must pass before release

- **AC1** `npm test` green, including every test in section 17.
- **AC2** `npm run typecheck` clean under `strict`.
- **AC3** `tests/ops/notify-egress.test.ts` passes with its MUST-16.1 amendment: `src/lib/predict/`, `src/lib/date-range.ts` and `src/components/ui/DateRangePicker.tsx` contain zero `fetch(` sites and zero URL literals.
- **AC4** `git diff` for this release touches **no** file under `drizzle/` and **no** line of `src/db/schema.ts`. Asserted as a test that reads both paths' git status against the release tag.
- **AC5** Every one of the six new dedup keys, enqueued twice with identical inputs, produces exactly one outbox row per enabled channel.
- **AC6** A property test over 500 generated series: `suggestBudget` never returns a negative amount, never returns a non-multiple of 100 cents, and never exceeds `3 x median + 99`.
- **AC7** `resolveRange` never throws over 1,000 generated garbage inputs, and `src/lib/date-range.ts` contains no clock access of any kind (MUST-11.4's grep).
- **AC8** With no user having any of the six events enabled, twelve simulated ticks and three simulated daily slots perform **zero** predictive queries beyond the participant check.
- **AC9** Reports and Transactions with an empty query string produce byte-identical filters to v1.3.1.
- **AC10** No file under `src/lib/predict/` other than `history.ts` imports `@/db`, `@/lib/env` or a node builtin.

### 18.2 Manual, documented QA checklist, run once per release

- **A1** Fresh install, no transactions. Budgets shows no suggestion buttons and the three-months sentence. Nothing errors.
- **A2** Import two months of history. Still no suggestions, still the sentence. Import a third full month. Suggestions appear, labelled low confidence.
- **A3** With six months of history, apply one suggestion. The limit lands on the row, the progress bar redraws against it, and the Budgets month picker shows the same number the following month through the existing effective-month rule.
- **A4** Press `Apply all suggestions` on a section where three categories already have limits. Exactly the unlimited ones change, and the message names both counts.
- **A5** As a member, confirm no suggestion or apply-all button appears in another member's personal section, and that a crafted POST to `applySuggestionAction` for that scope is refused.
- **A6** On the 12th of a month, confirm the projection line appears and reads plausibly against the month-to-date figure. On the 3rd, confirm it is absent.
- **A7** With Telegram configured and `budget_pace` on, drive a category past its 110 percent projection. The message arrives once. Force a second evaluation the same day and the following day: nothing further arrives.
- **A8** Enter a transaction three times the usual size for a known merchant. The unusual-charge message arrives within one tick. Re-run the tick: nothing further.
- **A9** Enter two identical charges for the same merchant one day apart. The duplicate message arrives once, and its wording says it may be a real second charge.
- **A10** Raise a monthly subscription's amount by $4 and import it. The creep message arrives on the next daily slot, once.
- **A11** On the 1st of a month with both month events enabled, confirm both arrive, that the predicted-vs-actual body says the prediction was recomputed, and that the refresh body says nothing has been changed. Confirm neither arrives again on the 2nd or 3rd.
- **A12** Turn every one of the six events off in the toggle matrix. Confirm the matrix rendered all six without any UI having been rebuilt for them, and that no further messages arrive.
- **A13** Reports: select each of the seven presets in turn and confirm the eyebrow label, the numbers, and that the URL carries `range=` and not a date pair. Select Custom and confirm the two inputs appear prefilled.
- **A14** Open an old bookmark of the shape `/reports?from=2026-01-01&to=2026-03-31`. It renders exactly as it did in v1.3.1, with the picker showing Custom.
- **A15** With a preset selected on Reports, press Export CSV. The file covers the same range the page shows.
- **A16** Transactions with no filters shows every transaction, as it does today. Select "Last month", filter, and confirm the picker still shows "Last month" after the reload.
- **A17** Set the container's `TZ` to `Pacific/Auckland` while the browser stays on Toronto time, near midnight. Confirm "This month" on the page matches the month the server is in, not the browser.
- **A18** Restore a v1.3.1 backup. The app boots, no migration runs, suggestions compute from the restored history, and no notification floods on the first tick.

---

## 19. Decisions taken on the owner's behalf

Each is a single constant or a one-paragraph change if the owner wants it different.

1. **The history window is the last 6 full calendar months and excludes the current one** (MUST-4.1, MUST-4.2). Six is enough for a median to mean something and short enough to follow a household whose life changed.
2. **The window is clipped to the household's first data month** (MUST-4.3). This is the single most consequential line in the statistical half.
3. **A month with no spend counts as zero inside the window** (MUST-4.4), so twice-yearly costs are averaged down rather than treated as monthly.
4. **Three months is the minimum** (MUST-4.6), and below it there are no buttons rather than disabled ones.
5. **The median drives the suggestion, not the average** (MUST-5.2). Both are shown.
6. **Trend is a two-half mean comparison, not a regression** (MUST-5.4, MUST-5.5), and only **half** the observed move is applied (MUST-6.2).
7. **Seasonality is one clamped factor from the same calendar month a year earlier**, needing 15 months of history, and is absent rather than 1.0 when unavailable (MUST-5.6 to MUST-5.8).
8. **Suggestions are capped at three times the median and rounded up to the dollar** (MUST-6.1 steps 5 and 6).
9. **A category with a non-positive median gets no suggestion** (MUST-6.1 step 2), and nothing under $5 is suggested at all.
10. **Confidence is a label, never a filter** (MUST-6.8).
11. **Applying a suggestion recomputes it server-side and takes no amount from the form** (MUST-7.4).
12. **Apply-all never overwrites a limit somebody typed** (MUST-7.8), with no override.
13. **A suggested budget is an ordinary budget row** (MUST-7.7). No flag, no column, no second code path.
14. **The projection starts on the 7th** (MUST-8.4) and assumes the rest of the month resembles the part already spent, which the UI says out loud (MUST-14.4).
15. **`budget_pace` fires once per category per month and never again** (MUST-9.8), and stands down entirely once `budget_exceeded` owns the situation (MUST-9.6 condition 3).
16. **Anomaly detection needs 60 days of household history before it says anything** (MUST-9.10 condition 1), so a first import is silent.
17. **Five events per evaluation is the cap for each anomaly detector** (MUST-9.13), and the overflow is dropped rather than queued.
18. **A charge must clear both a 3x multiple and a $50 floor** (MUST-9.10) to be unusual.
19. **Recurrence means a median gap of 25 to 35 days or 350 to 380 days** (MUST-9.15). Weekly and quarterly are out of scope.
20. **The duplicate detector reports pairs, nearest earlier only** (MUST-9.23), and says "possible" because the importer's dedup already caught the certain cases.
21. **"Predicted" in the month-end report is recomputed, not recalled** (MUST-9.27), because there is no table to recall it from and inventing one for a monthly email is the wrong trade.
22. **The refresh notice never applies anything** (MUST-9.33).
23. **Both month events fire on day 1, 2 or 3** (MUST-9.26), so a container off on the 1st still delivers.
24. **The two tick-cadence detectors share one fingerprint** (MUST-10.4) because they read the same slice.
25. **The scheduler is not touched** (MUST-10.2). Notify's dormancy bail stands exactly as written.
26. **No new settings key and no new per-user knob** (D2). Every threshold is a named constant with a pinning test.
27. **The URL carries a preset token, not a resolved date pair** (MUST-11.4), which is what makes the timezone correct.
28. **`last_3_months` and `last_6_months` include the current partial month** (MUST-11.3), and every `to` is a month end.
29. **A recognised preset makes any `from`/`to` in the URL irrelevant** (MUST-11.6), and the picker also disables those inputs so they are never submitted (MUST-12.4).
30. **Old `from`/`to` links resolve as Custom** (MUST-11.6 case 3), so nothing anybody bookmarked breaks.
31. **Transactions keeps having no default date filter** (MUST-13.6), through the picker's "Any dates" option (D1).
32. **The picker is a form control, not a router** (MUST-12.2). One `useState` and no effects.
33. **The Reports baselines card ignores the range picker and says so** (MUST-14.8).
34. **Nothing is cached** (MUST-16.6), which is why there is no table and nothing to invalidate.

---

## 20. Deviations

Four things in this release do not do the obvious thing. Each is recorded here rather than left for a reader to find.

**D1. "Any dates" is an eighth option in the picker, and it is not one of the seven approved presets.**
The approved list is seven presets. Transactions has never had a default date filter, and giving it one would mean the page people open to find a charge from March opens showing only August. The alternatives were to default Transactions to `this_month` (which changes behaviour people rely on), to render the picker with no selection (which is an invalid control state), or to add an option representing the absence of a range. The third is what ships: `allowAny` renders an extra option whose value is the empty string, `resolveRange` returns `null` for it, and no date clause is applied. Reports does not pass `allowAny` and therefore never shows it. This is an addition to the picker, not to the preset list: `RANGE_PRESETS` still has exactly seven entries and "Any dates" is not one of them.

**D2. Predictive thresholds are module constants, not stored settings, and there is no way for a household to change them.**
The brief allows predictive settings to ride existing extensible mechanisms. Two mechanisms exist and neither fits well. `notification_user_settings` is a fixed-column table with SQL range CHECKs, so a per-user threshold there is a migration, which MUST-1.4 rules out. The `settings` key/value table has no migration cost but is **household-wide**, so a per-user "what counts as unusual for me" is not expressible there either. Rather than ship a household-wide knob nobody asked for and then be unable to make it per-user without the migration, this release ships **no** setting at all: every threshold is an exported constant in `src/lib/predict/constants.ts` with a test pinning its value. Promoting one to a household-wide `predict.` key later is a small change following the `update.` precedent exactly; promoting one to per-user is the migration this release declined to spend.

**D3. "Predicted versus actual" compares against a prediction that was never recorded.**
The event's name implies a stored forecast. There is none, because storing one needs a table and MUST-1.4 rules that out. "Predicted" is therefore recomputed at report time as the suggestion the app **would have** produced for that month, from the six full calendar months ending the month before it (MUST-9.27). This is deterministic and reproducible from data already in the database, and it is what the message says it is. The one behavioural consequence: if transactions in the six-month reference window are edited or re-categorised after the fact, a re-sent report would compare against a slightly different prediction. Since the dedup key is per month and the report is sent once, ever, that case cannot arise in practice, but it is the honest reason this is a deviation rather than an implementation detail.

**D4. The Reports baselines card does not follow the range picker sitting directly above it.**
A median needs equal-length observation buckets. Over an arbitrary range of, say, 47 days, "the median month" has no meaning, and computing one over partial months would produce a number that looks authoritative and is not. The card is therefore pinned to the last 6 full calendar months, and its description says so in the words of MUST-14.8. The alternative, hiding the card whenever the range is not a whole number of months, was rejected: a card that disappears is harder to understand than a card that explains itself.

**Everything else rides an existing mechanism as required.** No migration. No new table. No new column. The six events are six registry entries, six key builders, six render cases and three evaluators, verified against `src/lib/notify/events.ts`, `render.ts`, `outbox.ts` and `config.ts` before this spec was written.

---

## 21. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | The tick-cadence anomaly detectors run their queries every five minutes forever | MUST-10.4's fingerprint, the same shape `budget.ts` already proved, plus MUST-10.10's zero-participant early return. AC8 asserts zero queries with the events off. Without the fingerprint this is three queries per tick, 864 a day, over a growing table |
| R2 | A household's first import of a year of history produces dozens of anomaly alerts at once | The 60-day household-history floor (MUST-9.10) does **not** hold this back: it measures `min(transactions.date)` to today, and a 12-month import clears 60 days the instant it lands. What actually bounds it is the per-evaluation caps acting together: `UNUSUAL_MAX_PER_EVALUATION`, `CREEP_MAX_PER_EVALUATION` and `DUPLICATE_MAX_PER_EVALUATION`, each 5. A test drives a realistic 12-month import into a fresh install, with default-on events enabled and a channel configured, and runs the first tick and the first daily slot together: the actual result is **13 messages** (5 unusual, capped from 8 qualifying candidates; 5 creep, capped from 8; 3 duplicate, under its own cap of 5), comfortably inside the roughly 10-to-15 range these three caps produce, not the dozens an unguarded household would see and not the zero this row previously claimed |
| R3 | The range picker resolves "this month" from the browser clock and the page silently disagrees with a notification computed server-side | MUST-11.4 makes `resolveRange` take `today` as a parameter and forbids any clock access in the module; the URL carries a token, never a resolved pair; AC7's grep asserts no `new Date`, `Date.now`, `todayIso` or `process.env` in the file; A17 tests it against a real timezone split |
| R4 | `Apply all suggestions` overwrites limits the household spent an evening setting | MUST-7.8 skips every category with a resolved limit, with no override flag and no confirmation dialog to click through by accident. The success message names the skipped count so the behaviour is visible on the first press. A4 is the manual run |
| R5 | A dedup key carrying a transaction id regenerates after the 400-day outbox sweep and re-alerts on a year-old charge | Every lookback is 35 days or less against a 400-day retention, and MUST-3.7 makes that an asserted inequality against the imported `OUTBOX_RETENTION_DAYS` rather than a remembered one. Widening any window past 400 fails the build |
| R6 | A suggestion is computed from a different definition of spend than the progress bar beside it | MUST-3.1 and MUST-3.2 pin one definition; MUST-4.9 reimplements only the rollup, in one place, and `tests/lib/predict/history.test.ts` asserts it against `budgetProgress()` on the same fixture. MUST-8.7 has the projection reuse the bar's own number rather than recompute it |
| R7 | A seasonal factor or a trend adjustment produces an absurd suggestion | The trend is halved (MUST-6.2), the seasonal ratio is clamped to 0.5x..2.0x on the rational before use (MUST-5.7), and the whole thing is capped at three times the median (MUST-6.1 step 5). AC6's property test over 500 series asserts the bound holds |
| R8 | Suggestions on a fresh install are all zero because the window is padded with months the household did not exist for | MUST-4.3's clip, tested directly in `window.test.ts`, plus MUST-4.6's three-month minimum. A1 and A2 are the manual runs |
| R9 | `budget_pace` and `budget_exceeded` both fire and the household is told the same thing twice | MUST-9.6 condition 3 stands `budget_pace` down the moment spend passes the limit. The two are mutually exclusive by construction, not by ordering |
| R10 | A person edits a budget between the page render and the suggestion press, and the button writes a number derived from stale data | MUST-7.4 recomputes server-side at the moment of the write, so the button carries no amount at all. MUST-7.5 refuses rather than falling back |
| R11 | A stale `from`/`to` pair in a URL contradicts the preset beside it and the page shows one thing while the export shows another | Two independent guards: MUST-11.6 case 1 ignores the pair server-side, and MUST-12.4 disables the inputs so they are never submitted. MUST-13.9 routes the export through the identical helper |
| R12 | Adopting the shared picker silently changes what Reports or Transactions shows by default | MUST-13.2 and MUST-13.6 pin both defaults to their v1.3.1 behaviour, AC9 asserts byte-identical filters, and A14 opens an old bookmark by hand |
| R13 | Six new events prove nothing about notify MUST-4.4 because the implementer edits the settings UI anyway | MUST-9.40 enumerates the three files that may change and section 17.5 asserts the matrix gains six rows with no component edit. The claim is discharged by a test |
| R14 | The Budgets page render gets slow on a household with many categories and years of history | MUST-16.3 bounds it at `2 + 2P` grouped aggregates over an indexed date range, none of them per-category, and MUST-4.11 skips the seasonal read entirely below 15 months. The suggestion arithmetic itself is over at most six integers per category |

---

## 22. Out of scope, explicitly deferred

**Predictive:** any forecast beyond the end of the current month; machine learning, regression models, exponential smoothing and seasonal decomposition of any kind; confidence intervals and error bars; per-merchant budgets; income prediction; cashflow forecasting; savings-rate targets; goal-completion projection; what-if scenarios; automatic budget application without a person pressing something; category auto-creation from spending patterns; weekly and quarterly subscription recurrence detection; anomaly detection on income or on transfers; a dedicated predictions page; storing a prediction so it can be compared against later; per-user or per-household tuning of any threshold; and any notification event beyond the six in section 9.

**Date ranges:** any preset beyond the seven listed; saved or named custom ranges; relative ranges expressed in days ("last 30 days"); a fiscal-year option; range presets on Budgets, Dashboard, Goals, Warranties, Review or Import (section 13.4 records why each is excluded); a compare-to-previous-period mode; and remembering a person's last-used range across sessions.

---

## Revision history

- **v1.0** (2026-08-18): initial approved design. Ships as **v1.4.0**. Two features, no migration, no new table, no new egress destination. **Predictive spending targets:** `src/lib/predict/` computes per-category median, average and a two-half trend over the last 6 full calendar months clipped to the household's first data month, with zero-spend months counting as zero and a three-month minimum; a suggested budget from the median with a halved trend adjustment, a clamped same-month-last-year seasonal factor, a 3x cap and a round up to the dollar, applied through the existing `upsertBudget()` for both household and personal scopes and never overwriting a typed limit; a mid-month pace projection from the seventh day; and six new notification events (`budget_pace`, `unusual_transaction`, `subscription_creep`, `duplicate_charge`, `predicted_vs_actual`, `suggested_budget_refresh`) riding the existing registry, renderer and outbox dedup with per-month or per-transaction keys, all far inside the 400-day retention. **Date-range presets:** one pure `resolveRange()` taking `today` as a parameter so the server's timezone always wins, a URL carrying a preset token rather than a resolved date pair, one `DateRangePicker` form control, and adoption by Reports, Transactions and the CSV export route with both pages' current defaults preserved exactly. Four deviations recorded in section 20.
- **v1.1** (2026-08-18): Task 8 review correction, no behaviour change intended beyond the fixes named here. MUST-10.4 and MUST-10.9 named a 14-day fingerprint slice; the slice `evaluateAnomalies` actually reads and always read is `DUPLICATE_LOOKBACK_DAYS` plus `DUPLICATE_WINDOW_DAYS`, 17 days, a strict superset of the 14-day `unusual_transaction` window that keeps a duplicate pair straddling that boundary intact, sanctioned by the Task 8 implementation brief. Both bullets are amended in place to name the 17-day slice and this rationale. MUST-10.9's cost line is also corrected to reflect a genuine Task 8 review fix landing in the same round: `findUnusual()` now skips a candidate under the unusual floor before querying for it at all, and shares one category baseline query across every candidate in the same category instead of repeating it per candidate.
- **v1.2** (2026-08-19): Final fix wave, two corrections with a matching code fix each. First, MUST-10.8 and MUST-10.9 claimed the three daily-slot evaluators (`evaluateBudgetPace`, `evaluateSubscriptionCreep`, `evaluateMonthBoundary`) "run at most once per user per day by construction" and that an unchanged tick's added cost is one indexed count query; the shipped v1.0/v1.1 code relied on their dedup keys alone, with no record of a slot already processed, so an unchanged tick inside the 12-hour daily catch-up window still recomputed all three roughly 144 times a day. `src/lib/notify/evaluate/index.ts` now keeps a per-user record of the last daily slot date actually processed (mirroring `digestAlreadySent`'s existence check for the weekly digest) and skips the three evaluators once that slot has run; both lines are amended in place to describe this and to state the true steady-state cost. Second, R2's mitigation named the 60-day household-history floor as what holds back a first big import, which is false (that floor clears in a single 12-month import), and the test the row promised was never written. The floor claim is corrected to name the real mitigation (the three per-evaluation caps), and the missing test now exists (`tests/lib/notify/evaluate/anomalies.test.ts`), driving a realistic 12-month import through the first tick and first daily slot and asserting the actual count, 13 messages, rather than the zero this row previously and incorrectly promised.
</content>
</invoke>

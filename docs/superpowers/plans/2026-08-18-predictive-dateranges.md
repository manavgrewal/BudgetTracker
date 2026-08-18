# Predictive Spending Targets and Date-Range Presets Implementation Plan (v1.4.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two features that share nothing but a version number. **(1) Predictive spending targets**, a new pure library tree `src/lib/predict/` computing per-category median, average and a two-half trend over the last 6 full calendar months clipped to the household's first data month, a suggested monthly budget applied through the existing `upsertBudget()` with one press, a mid-month pace projection from the seventh day, and six new notification events riding the existing registry, renderer and outbox dedup. **(2) Date-range presets**, one pure `resolveRange()` that takes `today` as a parameter so the server's timezone always wins, one shared `DateRangePicker` form control, and adoption by Reports, Transactions and the CSV export route with both pages' current defaults preserved exactly.

**Architecture:** This release adds **no migration, no table and no column**. `src/lib/predict/` holds six pure modules (`constants.ts`, `stats.ts`, `window.ts`, `suggest.ts`, `pace.ts`, `anomalies.ts`) and exactly one database module (`history.ts`), which is also where the one server-side composition (`suggestionsFor()`) lives so the Budgets page and the apply action can never compute a different number from each other. The six notification events are six appended `NOTIFICATION_EVENTS` entries, six appended dedup-key builders, six appended `RenderInput` union members and six appended `renderEvent` cases, plus three new evaluator modules called from the existing `runScheduledEvaluation()`; the toggle matrix is generated from the registry and is not edited. `src/lib/date-range.ts` is pure and client-safe, resolves seven presets from an explicit `today`, and puts a preset **token** in the URL rather than a resolved date pair, which is what makes a phone in another timezone agree with a notification computed on the server.

**Tech Stack:** Node 22, Next.js 15 (App Router), React 19, TypeScript (strict), Tailwind CSS 4, better-sqlite3 12, Drizzle ORM 0.x, zod 3, node-cron 3, nodemailer, recharts, Vitest 3, all unchanged. **Zero new runtime dependencies. Zero new outbound destinations.**

**Spec:** `docs/superpowers/specs/2026-08-18-predictive-dateranges-design.md` (the design; `MUST-n.m` labels below are its requirement numbers, and bare `§n` references are its sections). Base specs: `docs/superpowers/specs/2026-08-15-budget-tracker-design.md` (master), `docs/superpowers/specs/2026-08-17-notifications-design.md` (*notify §n*) and `docs/superpowers/specs/2026-08-17-update-loans-design.md` (*v1.3.1 §n*).

## Global Constraints

These bind **every** task below. A task that violates one is wrong even if its own tests pass.

- **Version bump to 1.4.0 and the `CHANGELOG.md` entry happen in the final release task only.** No earlier task touches `package.json` or `CHANGELOG.md`.
- **Per-task verification is TARGETED `vitest` plus `tsc --noEmit` only.** The full suite and `npm run build` run **only** in the final release task (Task 13). This is the owner's speed ruling; a task that green-lights itself on a full-suite run has wasted twenty minutes it did not need to spend.
- **A `'use server'` file may export ONLY async functions.** A `const` export from `src/app/(app)/budgets/actions.ts` breaks `next build`, and **neither `vitest` nor `tsc --noEmit` catches it**. Error strings and zod schemas added to that file stay module-local.
- **Comment and doc style: no em dashes or en dashes anywhere, no AI-sounding phrasing, comments state constraints not narration.** A comment says why a rule exists or what breaks without it. It does not narrate what the next line does.
- **Zero egress: no new fetch destinations anywhere.** `tests/ops/notify-egress.test.ts` must stay green, and Task 13 extends it to the two new trees.
- **No schema migration, no new tables, no new columns.** The spec proves the six events ride the existing registry (MUST-1.4, MUST-9.40). `drizzle/` and `src/db/schema.ts` are untouched by this release. **If any task seems to need a migration the plan is wrong; stop and fix the plan.**
- **Integer cents everywhere, `divRound` half-away-from-zero per §3.** `src/lib/predict/stats.ts` exports exactly one division primitive and everything else uses it. There is no other rounding call anywhere under `src/lib/predict/`.
- **Commit identity is already configured in the repo.** Do not pass `--author`. **Commit messages get NO attribution footers of any kind**, no `Co-Authored-By`, no `Generated with`, nothing. Never `--no-verify`.
- **The notification outbox dedup UNIQUE constraint is the idempotency backbone.** `notification_outbox_dedup_uq` is `(user_id, channel, dedup_key)`, and `enqueue()` is `INSERT ... ON CONFLICT DO NOTHING` against it. Every event task below states its dedup key verbatim from the spec. No evaluator keeps its own record of what it has sent (MUST-9.41).

Copied verbatim from the spec, the requirements every task inherits:

- **MUST-1.1.** "Predictive targets make **no outbound connection of any kind, ever**. There is no model to download, no service to call and no telemetry. `src/lib/predict/` contains zero `fetch(` call sites and zero string literal containing `://`, and `tests/ops/notify-egress.test.ts` is extended to assert both."
- **MUST-1.4.** "This release adds **no table, no column and no migration**." `drizzle/` is untouched. `src/db/schema.ts` is untouched.
- **MUST-2.1.** "Every file under `src/lib/predict/` **except `history.ts`** is **pure**: no `@/db` import, no `@/lib/env` import, no node builtin, no `new Date()`. They take plain arrays and integers and return plain objects."
- **MUST-2.2.** "`src/lib/predict/history.ts` is server-only and is never imported, directly or transitively, from a `*-client.tsx` file. Only `import type` is permitted there."
- **MUST-2.3.** "`src/lib/date-range.ts` is **pure** and client-safe. It imports from `@/lib/dates` and nothing else. It never calls `new Date()`, never calls `todayIso()` and never reads `process.env`. Every function on it takes the current date as an explicit `today: string` parameter."
- **MUST-3.1.** "Every number in this spec is **net spend in integer cents**, defined exactly as `src/lib/budgets.ts` already defines it and with no second definition anywhere." Transfers excluded, refunds net through `netSpentCents()`, income categories excluded, the rollup rule applies, household counts every row and personal counts only `attributed_user_id = U`.
- **MUST-3.2.** "No predictive number is ever computed from a different spend definition than the one the Budgets page is already showing. If a suggestion and a progress bar disagree, the suggestion is wrong."
- **MUST-3.5.** "No intermediate value is ever converted to a floating dollar amount and back. Every multiply-then-divide is done as `divRound(a * b, c)` on integers, in that order."
- **MUST-3.6.** "Every threshold in this spec is a named export of `constants.ts`. No magic number appears in `suggest.ts`, `pace.ts`, `anomalies.ts` or any evaluator."
- **MUST-9.38.** "`renderEvent`'s switch keeps its no-`default` shape. The declared return type means a union member with no matching case is a TS2366 compile error, which is what guarantees the union member and the case land in the same change."
- **MUST-10.2.** "`src/lib/scheduler.ts` is **not** changed." `tests/lib/scheduler.test.ts` is unamended.
- **MUST-11.4.** "`resolveRange` **never** determines the current date. It takes `today` as a required parameter. Every server caller passes `todayIso(new Date(), readEnv().tz)`. The client component **never** calls `resolveRange` and never computes a date from the browser clock."
- **MUST-16.2.** "The app's complete egress destination list is **unchanged** by this release: `api.telegram.org`, the configured SMTP relay, `api.github.com`, the SimpleFIN access URL, and the Watchtower endpoint on the compose network. Nothing is added and nothing is removed."
- **MUST-16.6.** "No suggestion, series or projection is cached, memoised or stored. Every one is recomputed on demand from the transactions table."
- **CAD integer cents (master spec).** Spend is negative, income positive. Money is formatted with `formatCents()` from `src/lib/money.ts`. Dates are ISO `YYYY-MM-DD` TEXT, month keys `YYYY-MM` TEXT.
- **Same-origin first.** `isSameOrigin(await headers())` is the **first** statement of every server action added by this release, then `requireUser()`, then the zod parses, then the domain call, then `revalidatePath`.
- **Existing design-token UI only.** `Card` / `CardHeader` / `CardBody`, `Notice`, `Field`, `TableWrap`, `Money`, `EmptyState`, `btn btn--primary|--secondary|--ghost`, `field-control`, and the `text-ink` / `text-muted` / `text-subtle` / `text-negative` tokens. **No new CSS, no new design token, no new colour.**
- **MUST-17.1.** "No test in this release performs network I/O of any kind, and none needs a stub, because no code path in either feature can reach the network." No test file added by this plan touches `globalThis.fetch`. The evaluator suites stub only the notify **sender** (`setNotifySenderForTests`), which is the existing seam and is not a network call.
- **TypeScript strict.** `npx tsc --noEmit` must stay clean. No `any`, no `@ts-expect-error` outside a test asserting a type error.

## Conventions every task must follow

- Project root for every absolute path: `c:\Users\m.grewal\OneDrive - CloverTool Mfg\Documents\Budget Tracker`. Every `npm` / `npx` / `git` command runs from there in PowerShell.
- Import alias `@/` maps to `src/`. Tests live under `tests/` and mirror `src/` (`src/lib/predict/stats.ts` becomes `tests/lib/predict/stats.test.ts`).
- Vitest runs with `globals: false`. Every test file opens with an explicit `import { describe, it, expect, ... } from 'vitest';`.
- Any test touching the database uses `createTestDb()` / `createSeededTestDb()` / `insertTestUser()` / `insertTestAccount()` / `categoryIdByName()` from `tests/helpers/db.ts`. There is **no shared transaction factory**: each suite writes its own local `spend()` closure, following `tests/lib/budgets.test.ts`.
- Component tests are `.test.tsx` and open with `// @vitest-environment jsdom`, then `import { render, cleanup, screen, fireEvent } from '@testing-library/react';` and an `afterEach(cleanup)`.
- Server-side domain logic lives in `src/lib/predict/**`; React pages and components are thin and call it. Never put SQL in a component.
- **Per-task verification is targeted.** Each task ends with `npx vitest run <the files this task touched>` plus `npx tsc --noEmit`. `npm test` and `npm run build` run in Task 13 only.
- **Commit at the end of each task.** Author identity is the repo's configured identity; do not pass `--author`, and add no attribution trailer of any kind.
- The signal to act on at the end of a task is **green vs red on the files that task touched**, not an absolute test count.

## Five places where this plan resolves the spec rather than transcribing it

Each is a real conflict or gap inside the spec, resolved here once so no task has to decide it twice. Every one of them is repeated at the task that owns it.

1. **Income children and the rollup (MUST-4.9).** MUST-4.9's sentence says income categories are "dropped after the rollup, never before", but its own justification clause says this is so an income child "cannot silently change a parent's total in a way that disagrees with `budgetProgress()`", and §17.2 names the test "an income child not altering a spend parent's total". `budgetProgress()` filters income out of `all` **before** it collects `allChildren` (`src/lib/budgets.ts:189`), so an income child's cents are **not** in a parent's total today. MUST-3.2 makes agreement with the progress bar binding. **`categorySeries()` therefore filters income out before the rollup, exactly as `budgetProgress()` does.** Task 2 owns this.
2. **Seasonality's history floor (MUST-5.6).** Condition 1 requires 15 months of history; condition 3 requires the full 12 months ending at `A = target - 12` to be at or after the first data month, which is 23 months. All four conditions are conjunctive, so condition 3 subsumes condition 1 and the effective floor is 23 months. `seasonalApplies()` implements all three month-arithmetic conditions literally; because it is at least as tight as condition 1, gating the `seasonalReference()` query on it also satisfies MUST-4.11.
3. **A signed delta in a `padded()` table (MUST-9.30 against MUST-9.39).** §9.6's example line prints `+$93.40`, but MUST-9.39 says every amount is formatted by the existing `money()` wrapper, which is `formatCents(cents, { currency: true })` and never prints a `+`. **MUST-9.39 wins**: a positive delta renders `$93.40` and a negative one `-$93.40`. The example line is illustrative prose; the requirement is not.
4. **MUST-11.5's fill rule when the fallback is null.** The spec fills a missing endpoint "from the same preset resolution the fallback would give", which does not exist for Transactions and the export route, both of which pass `fallback: null`. Two named values make the degenerate case behaviour-preserving instead of arbitrary: a missing `to` becomes `monthEnd(monthOf(today))`, keeping MUST-11.3 point 2's "every `to` is a month end", and a missing `from` becomes the exported `RANGE_FLOOR_DATE`, so a one-sided `?to=` bookmark still means "everything up to that date" exactly as it does in v1.3.1. Task 10 owns this.
5. **MUST-9.26's firing guard, made concrete.** The spec says `predicted_vs_actual` "does not fire when the previous month has no category with either a resolved limit or a computable suggestion". A category with a limit and no suggestion has no expected figure to compare against, so it contributes no line. The guard therefore reduces to: fire only when at least one line exists. Task 9 owns this.

**One dangling spec reference.** §2.2's file table routes `CHANGELOG.md` and `README.md` to "section 18.3", and the spec has no §18.3: section 18 stops at 18.2. Both files are updated in Task 13 with the content §1.4, §14 and §19 describe.

<!-- END HEADER -->

---

# Phase 1: The pure predictive core

Four tasks, no database, no React. Every function here takes plain arrays and integers.

## Task 1: `src/lib/predict/constants.ts` and `stats.ts`

**Context:** Spec §3.2, §3.3 and §5 in full. Every threshold this release uses becomes a named export so changing one is a visible, reviewed edit; every division goes through one primitive so a refund-heavy median and a spend-heavy one round the same way. Implements **MUST-3.3 … MUST-3.7** and **MUST-5.1 … MUST-5.5**, **MUST-5.9**.

**Files:**
- Create: `src/lib/predict/constants.ts`
- Create: `src/lib/predict/stats.ts`
- Test: `tests/lib/predict/constants.test.ts` (**new**)
- Test: `tests/lib/predict/stats.test.ts` (**new**)

**Interfaces:**
- Consumes: `OUTBOX_RETENTION_DAYS` from `@/lib/notify/outbox` (**test only**, for MUST-3.7's inequality; `constants.ts` itself imports nothing).
- Produces:
  ```ts
  // src/lib/predict/constants.ts, the exact block from spec §3.3
  export const HISTORY_MONTHS: 6;
  export const MIN_HISTORY_MONTHS: 3;
  export const SEASONAL_MIN_MONTHS: 15;
  export const TREND_MIN_ABS_CENTS: 2000;
  export const TREND_MIN_PCT: 10;
  export const TREND_DAMPING_DIVISOR: 2;
  export const SEASONAL_CLAMP_MIN_PCT: 50;
  export const SEASONAL_CLAMP_MAX_PCT: 200;
  export const SUGGESTION_FLOOR_CENTS: 500;
  export const SUGGESTION_CAP_MULTIPLE: 3;
  export const PACE_MIN_DAY_OF_MONTH: 7;
  export const PACE_OVERSHOOT_MIN_PCT: 110;
  export const UNUSUAL_MULTIPLE: 3;
  export const UNUSUAL_LOOKBACK_DAYS: 14;
  export const UNUSUAL_BASELINE_DAYS: 365;
  export const UNUSUAL_MIN_SAMPLES: 5;
  export const UNUSUAL_MIN_ABS_CENTS: 5000;
  export const UNUSUAL_MIN_HOUSEHOLD_HISTORY_DAYS: 60;
  export const UNUSUAL_MAX_PER_EVALUATION: 5;
  export const CREEP_LOOKBACK_DAYS: 35;
  export const CREEP_BASELINE_DAYS: 365;
  export const CREEP_MIN_CHARGES: 4;
  export const CREEP_MONTHLY_GAP_MIN_DAYS: 25;
  export const CREEP_MONTHLY_GAP_MAX_DAYS: 35;
  export const CREEP_YEARLY_GAP_MIN_DAYS: 350;
  export const CREEP_YEARLY_GAP_MAX_DAYS: 380;
  export const CREEP_MIN_PCT: 5;
  export const CREEP_MIN_ABS_CENTS: 100;
  export const CREEP_MAX_PER_EVALUATION: 5;
  export const DUPLICATE_WINDOW_DAYS: 3;
  export const DUPLICATE_LOOKBACK_DAYS: 14;
  export const DUPLICATE_MIN_ABS_CENTS: 1000;
  export const DUPLICATE_MAX_PER_EVALUATION: 5;
  export const MONTH_REPORT_DAY_MAX: 3;
  export const MONTH_REPORT_MAX_LINES: 8;
  export const SUGGEST_REFRESH_MIN_DELTA_PCT: 10;
  export const SUGGEST_REFRESH_MIN_DELTA_CENTS: 1000;

  // src/lib/predict/stats.ts
  export function divRound(numerator: number, denominator: number): number;
  export function ceilToDollar(cents: number): number;
  export function medianCents(values: number[]): number | null;
  export function meanCents(values: number[]): number | null;
  export function spreadCents(values: number[]): number | null;
  export type TrendDirection = 'rising' | 'falling' | 'flat' | 'unknown';
  export interface Trend { direction: TrendDirection; deltaCents: number }
  export function trendOf(values: number[]): Trend;
  ```

### Steps

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/predict/constants.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as C from '@/lib/predict/constants';
import { OUTBOX_RETENTION_DAYS } from '@/lib/notify/outbox';

describe('MUST-3.6: every threshold is a pinned named export', () => {
  it('matches the spec table value for value', () => {
    expect({
      HISTORY_MONTHS: C.HISTORY_MONTHS,
      MIN_HISTORY_MONTHS: C.MIN_HISTORY_MONTHS,
      SEASONAL_MIN_MONTHS: C.SEASONAL_MIN_MONTHS,
      TREND_MIN_ABS_CENTS: C.TREND_MIN_ABS_CENTS,
      TREND_MIN_PCT: C.TREND_MIN_PCT,
      TREND_DAMPING_DIVISOR: C.TREND_DAMPING_DIVISOR,
      SEASONAL_CLAMP_MIN_PCT: C.SEASONAL_CLAMP_MIN_PCT,
      SEASONAL_CLAMP_MAX_PCT: C.SEASONAL_CLAMP_MAX_PCT,
      SUGGESTION_FLOOR_CENTS: C.SUGGESTION_FLOOR_CENTS,
      SUGGESTION_CAP_MULTIPLE: C.SUGGESTION_CAP_MULTIPLE,
      PACE_MIN_DAY_OF_MONTH: C.PACE_MIN_DAY_OF_MONTH,
      PACE_OVERSHOOT_MIN_PCT: C.PACE_OVERSHOOT_MIN_PCT,
      UNUSUAL_MULTIPLE: C.UNUSUAL_MULTIPLE,
      UNUSUAL_LOOKBACK_DAYS: C.UNUSUAL_LOOKBACK_DAYS,
      UNUSUAL_BASELINE_DAYS: C.UNUSUAL_BASELINE_DAYS,
      UNUSUAL_MIN_SAMPLES: C.UNUSUAL_MIN_SAMPLES,
      UNUSUAL_MIN_ABS_CENTS: C.UNUSUAL_MIN_ABS_CENTS,
      UNUSUAL_MIN_HOUSEHOLD_HISTORY_DAYS: C.UNUSUAL_MIN_HOUSEHOLD_HISTORY_DAYS,
      UNUSUAL_MAX_PER_EVALUATION: C.UNUSUAL_MAX_PER_EVALUATION,
      CREEP_LOOKBACK_DAYS: C.CREEP_LOOKBACK_DAYS,
      CREEP_BASELINE_DAYS: C.CREEP_BASELINE_DAYS,
      CREEP_MIN_CHARGES: C.CREEP_MIN_CHARGES,
      CREEP_MONTHLY_GAP_MIN_DAYS: C.CREEP_MONTHLY_GAP_MIN_DAYS,
      CREEP_MONTHLY_GAP_MAX_DAYS: C.CREEP_MONTHLY_GAP_MAX_DAYS,
      CREEP_YEARLY_GAP_MIN_DAYS: C.CREEP_YEARLY_GAP_MIN_DAYS,
      CREEP_YEARLY_GAP_MAX_DAYS: C.CREEP_YEARLY_GAP_MAX_DAYS,
      CREEP_MIN_PCT: C.CREEP_MIN_PCT,
      CREEP_MIN_ABS_CENTS: C.CREEP_MIN_ABS_CENTS,
      CREEP_MAX_PER_EVALUATION: C.CREEP_MAX_PER_EVALUATION,
      DUPLICATE_WINDOW_DAYS: C.DUPLICATE_WINDOW_DAYS,
      DUPLICATE_LOOKBACK_DAYS: C.DUPLICATE_LOOKBACK_DAYS,
      DUPLICATE_MIN_ABS_CENTS: C.DUPLICATE_MIN_ABS_CENTS,
      DUPLICATE_MAX_PER_EVALUATION: C.DUPLICATE_MAX_PER_EVALUATION,
      MONTH_REPORT_DAY_MAX: C.MONTH_REPORT_DAY_MAX,
      MONTH_REPORT_MAX_LINES: C.MONTH_REPORT_MAX_LINES,
      SUGGEST_REFRESH_MIN_DELTA_PCT: C.SUGGEST_REFRESH_MIN_DELTA_PCT,
      SUGGEST_REFRESH_MIN_DELTA_CENTS: C.SUGGEST_REFRESH_MIN_DELTA_CENTS,
    }).toEqual({
      HISTORY_MONTHS: 6,
      MIN_HISTORY_MONTHS: 3,
      SEASONAL_MIN_MONTHS: 15,
      TREND_MIN_ABS_CENTS: 2000,
      TREND_MIN_PCT: 10,
      TREND_DAMPING_DIVISOR: 2,
      SEASONAL_CLAMP_MIN_PCT: 50,
      SEASONAL_CLAMP_MAX_PCT: 200,
      SUGGESTION_FLOOR_CENTS: 500,
      SUGGESTION_CAP_MULTIPLE: 3,
      PACE_MIN_DAY_OF_MONTH: 7,
      PACE_OVERSHOOT_MIN_PCT: 110,
      UNUSUAL_MULTIPLE: 3,
      UNUSUAL_LOOKBACK_DAYS: 14,
      UNUSUAL_BASELINE_DAYS: 365,
      UNUSUAL_MIN_SAMPLES: 5,
      UNUSUAL_MIN_ABS_CENTS: 5000,
      UNUSUAL_MIN_HOUSEHOLD_HISTORY_DAYS: 60,
      UNUSUAL_MAX_PER_EVALUATION: 5,
      CREEP_LOOKBACK_DAYS: 35,
      CREEP_BASELINE_DAYS: 365,
      CREEP_MIN_CHARGES: 4,
      CREEP_MONTHLY_GAP_MIN_DAYS: 25,
      CREEP_MONTHLY_GAP_MAX_DAYS: 35,
      CREEP_YEARLY_GAP_MIN_DAYS: 350,
      CREEP_YEARLY_GAP_MAX_DAYS: 380,
      CREEP_MIN_PCT: 5,
      CREEP_MIN_ABS_CENTS: 100,
      CREEP_MAX_PER_EVALUATION: 5,
      DUPLICATE_WINDOW_DAYS: 3,
      DUPLICATE_LOOKBACK_DAYS: 14,
      DUPLICATE_MIN_ABS_CENTS: 1000,
      DUPLICATE_MAX_PER_EVALUATION: 5,
      MONTH_REPORT_DAY_MAX: 3,
      MONTH_REPORT_MAX_LINES: 8,
      SUGGEST_REFRESH_MIN_DELTA_PCT: 10,
      SUGGEST_REFRESH_MIN_DELTA_CENTS: 1000,
    });
  });
});

describe('MUST-3.7: every lookback that appears in a dedup key is far inside outbox retention', () => {
  it('compares against the imported constant, not a copied number', () => {
    expect(C.UNUSUAL_LOOKBACK_DAYS).toBeLessThan(OUTBOX_RETENTION_DAYS);
    expect(C.CREEP_LOOKBACK_DAYS).toBeLessThan(OUTBOX_RETENTION_DAYS);
    expect(C.DUPLICATE_LOOKBACK_DAYS).toBeLessThan(OUTBOX_RETENTION_DAYS);
    // The widest of the three, with room to spare. Widening any of them past 400 fails here.
    expect(Math.max(C.UNUSUAL_LOOKBACK_DAYS, C.CREEP_LOOKBACK_DAYS, C.DUPLICATE_LOOKBACK_DAYS)).toBe(35);
  });
});
```

Create `tests/lib/predict/stats.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ceilToDollar, divRound, meanCents, medianCents, spreadCents, trendOf } from '@/lib/predict/stats';

describe('MUST-3.3: divRound is half away from zero in all four sign quadrants', () => {
  it('rounds the documented cases', () => {
    expect(divRound(5, 2)).toBe(3);
    expect(divRound(-5, 2)).toBe(-3);
    expect(divRound(5, -2)).toBe(-3);
    expect(divRound(-5, -2)).toBe(3);
    expect(divRound(4, 2)).toBe(2);
    expect(divRound(0, 7)).toBe(0);
  });

  it('rounds a bare half away from zero rather than to even', () => {
    expect(divRound(1, 2)).toBe(1);
    expect(divRound(-1, 2)).toBe(-1);
    expect(divRound(3, 2)).toBe(2);
    // Math.round(-2.5) is -2 in JavaScript. This is the case that made the primitive necessary.
    expect(divRound(-5, 2)).not.toBe(-2);
  });

  it('throws rather than returning Infinity on a zero denominator', () => {
    expect(() => divRound(1, 0)).toThrow();
  });
});

describe('MUST-3.4: ceilToDollar', () => {
  it('rounds a non-negative amount up to the next whole dollar', () => {
    expect(ceilToDollar(0)).toBe(0);
    expect(ceilToDollar(1)).toBe(100);
    expect(ceilToDollar(99)).toBe(100);
    expect(ceilToDollar(100)).toBe(100);
    expect(ceilToDollar(101)).toBe(200);
  });

  it('throws on a negative input rather than guessing', () => {
    expect(() => ceilToDollar(-1)).toThrow();
  });
});

describe('MUST-5.1: medianCents', () => {
  it('returns null for an empty series', () => {
    expect(medianCents([])).toBeNull();
  });

  it('takes the middle element of an odd-length series exactly', () => {
    expect(medianCents([300, 100, 200])).toBe(200);
    expect(medianCents([500])).toBe(500);
  });

  it('rounds the two middle elements half away from zero on an even-length series', () => {
    expect(medianCents([100, 201])).toBe(151);
    expect(medianCents([-100, -201])).toBe(-151);
    expect(medianCents([100, 200, 300, 400])).toBe(250);
  });

  it('handles an all-zero series and a series with negatives', () => {
    expect(medianCents([0, 0, 0])).toBe(0);
    expect(medianCents([-500, 100, 700])).toBe(100);
  });

  it('never mutates its input', () => {
    const input = [300, 100, 200];
    medianCents(input);
    expect(input).toEqual([300, 100, 200]);
  });
});

describe('MUST-5.3: meanCents', () => {
  it('returns null for an empty series and divRounds otherwise', () => {
    expect(meanCents([])).toBeNull();
    expect(meanCents([100, 200, 301])).toBe(200);
    expect(meanCents([1, 2])).toBe(2);
    expect(meanCents([-1, -2])).toBe(-2);
  });

  it('never mutates its input', () => {
    const input = [5, 7];
    meanCents(input);
    expect(input).toEqual([5, 7]);
  });
});

describe('MUST-5.9: spreadCents is max minus min', () => {
  it('measures the window and returns null when empty', () => {
    expect(spreadCents([])).toBeNull();
    expect(spreadCents([100])).toBe(0);
    expect(spreadCents([100, -50, 900])).toBe(950);
  });
});

describe('MUST-5.4: trendOf is a two-half mean comparison', () => {
  it('is unknown under six values', () => {
    expect(trendOf([])).toEqual({ direction: 'unknown', deltaCents: 0 });
    expect(trendOf([100, 200, 300, 400, 500])).toEqual({ direction: 'unknown', deltaCents: 0 });
  });

  it('rises when the later half clears the threshold', () => {
    // prior mean 10000, recent mean 13000, delta 3000. Threshold is max(2000, 1000) = 2000.
    expect(trendOf([10000, 10000, 10000, 13000, 13000, 13000])).toEqual({ direction: 'rising', deltaCents: 3000 });
  });

  it('falls when the later half drops past the threshold', () => {
    expect(trendOf([13000, 13000, 13000, 10000, 10000, 10000])).toEqual({ direction: 'falling', deltaCents: -3000 });
  });

  it('is flat just under the threshold and rising exactly at it', () => {
    // prior mean 10000, so the 10 percent rule gives 1000 and the $20 floor binds at 2000.
    expect(trendOf([10000, 10000, 10000, 11999, 11999, 11999]).direction).toBe('flat');
    expect(trendOf([10000, 10000, 10000, 12000, 12000, 12000]).direction).toBe('rising');
  });

  it('lets the 10 percent rule bind when the prior half is large', () => {
    // prior mean 100000, so 10 percent is 10000 and beats the $20 floor.
    expect(trendOf([100000, 100000, 100000, 105000, 105000, 105000]).direction).toBe('flat');
    expect(trendOf([100000, 100000, 100000, 110000, 110000, 110000]).direction).toBe('rising');
  });

  it('uses the absolute prior mean, so a refund-heavy earlier half still gets a threshold', () => {
    expect(trendOf([-100000, -100000, -100000, 0, 0, 0]).direction).toBe('rising');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
npx vitest run tests/lib/predict/constants.test.ts tests/lib/predict/stats.test.ts
```
Expected: FAIL, both files, with `Failed to resolve import "@/lib/predict/constants"` and `"@/lib/predict/stats"`.

- [ ] **Step 3: Write `src/lib/predict/constants.ts`**

```ts
/**
 * Every threshold and window this release uses, in one place, PURE (MUST-2.1, MUST-3.6).
 *
 * No magic number appears in suggest.ts, pace.ts, anomalies.ts or any evaluator. A test
 * pins each value, so changing one is a reviewed edit rather than a silent behaviour change.
 *
 * These are module constants, not stored settings (spec D2): notification_user_settings is a
 * fixed-column table with SQL range CHECKs, so a per-user threshold there needs a migration,
 * which MUST-1.4 rules out; the settings key/value table is household-wide, so a per-user
 * "what counts as unusual for me" is not expressible there either.
 */

// The history window (spec section 4)
export const HISTORY_MONTHS = 6; // last 6 full calendar months
export const MIN_HISTORY_MONTHS = 3; // fewer than this: no suggestion at all
export const SEASONAL_MIN_MONTHS = 15; // 12 for the reference year, plus 3 more

// The suggestion (spec section 6)
export const TREND_MIN_ABS_CENTS = 2000; // $20
export const TREND_MIN_PCT = 10;
export const TREND_DAMPING_DIVISOR = 2; // apply half the observed move
export const SEASONAL_CLAMP_MIN_PCT = 50; // ratio floor, 0.5x
export const SEASONAL_CLAMP_MAX_PCT = 200; // ratio ceiling, 2.0x
export const SUGGESTION_FLOOR_CENTS = 500; // $5, below which no suggestion is offered
export const SUGGESTION_CAP_MULTIPLE = 3; // never more than 3x the median

// The pace projection (spec section 8)
export const PACE_MIN_DAY_OF_MONTH = 7;

// The pace notification (spec section 9.2)
export const PACE_OVERSHOOT_MIN_PCT = 110; // projected must reach 110% of the limit

// Unusual transaction (spec section 9.3)
export const UNUSUAL_MULTIPLE = 3;
export const UNUSUAL_LOOKBACK_DAYS = 14;
export const UNUSUAL_BASELINE_DAYS = 365;
export const UNUSUAL_MIN_SAMPLES = 5;
export const UNUSUAL_MIN_ABS_CENTS = 5000; // $50
export const UNUSUAL_MIN_HOUSEHOLD_HISTORY_DAYS = 60;
export const UNUSUAL_MAX_PER_EVALUATION = 5;

// Subscription creep (spec section 9.4)
export const CREEP_LOOKBACK_DAYS = 35;
export const CREEP_BASELINE_DAYS = 365;
export const CREEP_MIN_CHARGES = 4; // 3 baseline charges plus the new one
export const CREEP_MONTHLY_GAP_MIN_DAYS = 25;
export const CREEP_MONTHLY_GAP_MAX_DAYS = 35;
export const CREEP_YEARLY_GAP_MIN_DAYS = 350;
export const CREEP_YEARLY_GAP_MAX_DAYS = 380;
export const CREEP_MIN_PCT = 5;
export const CREEP_MIN_ABS_CENTS = 100; // $1
export const CREEP_MAX_PER_EVALUATION = 5;

// Duplicate charge (spec section 9.5)
export const DUPLICATE_WINDOW_DAYS = 3;
export const DUPLICATE_LOOKBACK_DAYS = 14;
export const DUPLICATE_MIN_ABS_CENTS = 1000; // $10
export const DUPLICATE_MAX_PER_EVALUATION = 5;

// The two month-boundary reports (spec sections 9.6, 9.7)
export const MONTH_REPORT_DAY_MAX = 3; // fires on day 1, 2 or 3 of the month
export const MONTH_REPORT_MAX_LINES = 8;
export const SUGGEST_REFRESH_MIN_DELTA_PCT = 10;
export const SUGGEST_REFRESH_MIN_DELTA_CENTS = 1000; // $10
```

- [ ] **Step 4: Write `src/lib/predict/stats.ts`**

```ts
import { TREND_MIN_ABS_CENTS, TREND_MIN_PCT } from '@/lib/predict/constants';

/**
 * Median, mean, spread and trend over integer cents, PURE (MUST-2.1). Imported by the
 * Budgets client to format a suggestion label, so the Ruling P4 client-bundle constraint
 * applies: no @/db, no @/lib/env, no node builtin, no new Date().
 */

/**
 * Half away from zero. divRound(5, 2) === 3; divRound(-5, 2) === -3 (MUST-3.3).
 *
 * Implemented on absolute values with the sign applied once at the end, because
 * Math.round(-2.5) in JavaScript is -2: that would round a refund-heavy median toward zero
 * and a spend-heavy one away from it, inside the same function.
 *
 * The 2 * a + b form keeps the whole computation in integers (MUST-3.5). The largest
 * intermediate this release can produce is a month's cents times 31, doubled, which is far
 * inside Number.MAX_SAFE_INTEGER.
 */
export function divRound(numerator: number, denominator: number): number {
  if (denominator === 0) throw new Error('divRound: denominator must not be zero');
  const sign = (numerator < 0 ? -1 : 1) * (denominator < 0 ? -1 : 1);
  const a = Math.abs(numerator);
  const b = Math.abs(denominator);
  return sign * Math.floor((2 * a + b) / (2 * b));
}

/**
 * Rounds a non-negative cents value up to the next whole dollar (MUST-3.4). Applied exactly
 * once, as the last step of the suggestion, because nobody types a budget of $247.36.
 *
 * Throws on a negative input rather than guessing which direction "up" means there.
 */
export function ceilToDollar(cents: number): number {
  if (cents < 0) throw new Error('ceilToDollar: negative input');
  return Math.ceil(cents / 100) * 100;
}

/** MUST-5.1. The input array is copied before sorting and is never mutated. */
export function medianCents(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid];
  return divRound(sorted[mid - 1] + sorted[mid], 2);
}

/** MUST-5.3. Plain integer accumulation, matching sumCents() in src/lib/money.ts. */
export function meanCents(values: number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return divRound(sum, values.length);
}

/** MUST-5.9. Feeds only the confidence label, never the suggested amount. */
export function spreadCents(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.max(...values) - Math.min(...values);
}

export type TrendDirection = 'rising' | 'falling' | 'flat' | 'unknown';

export interface Trend {
  direction: TrendDirection;
  deltaCents: number;
}

/**
 * MUST-5.4. Two halves of three months compared by mean, and that is the whole method.
 *
 * MUST-5.5: there is no linear regression, no exponential smoothing and no seasonal
 * decomposition. Six points cannot support one, and a slope fitted to six household months
 * would be presented with more authority than it has earned.
 *
 * The window is capped at six months by historyMonths() (MUST-4.5), so anything other than
 * exactly six values has no even split to compare and reports 'unknown'.
 */
export function trendOf(values: number[]): Trend {
  if (values.length !== 6) return { direction: 'unknown', deltaCents: 0 };
  const recent = meanCents(values.slice(3));
  const prior = meanCents(values.slice(0, 3));
  if (recent === null || prior === null) return { direction: 'unknown', deltaCents: 0 };
  const deltaCents = recent - prior;
  const threshold = Math.max(TREND_MIN_ABS_CENTS, divRound(Math.abs(prior) * TREND_MIN_PCT, 100));
  if (deltaCents >= threshold) return { direction: 'rising', deltaCents };
  if (deltaCents <= -threshold) return { direction: 'falling', deltaCents };
  return { direction: 'flat', deltaCents };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```powershell
npx vitest run tests/lib/predict/constants.test.ts tests/lib/predict/stats.test.ts
npx tsc --noEmit
```
Expected: PASS on both files, clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add src/lib/predict/constants.ts src/lib/predict/stats.ts tests/lib/predict/constants.test.ts tests/lib/predict/stats.test.ts
git commit -m "feat(predict): thresholds and the pure statistics primitives"
```

---

## Task 2: `src/lib/predict/window.ts` and `history.ts`

**Context:** Spec §4 in full. The window is the last 6 full calendar months **clipped to the household's first data month**, which is the single most consequential line in the statistical half: without it every median on a new install is zero. `history.ts` is the **only** module under `src/lib/predict/` that touches the database. Implements **MUST-4.1 … MUST-4.11**, **MUST-5.6** conditions 1 to 3, **MUST-2.1**, **MUST-2.2**, **MUST-3.1**, **MUST-16.3**.

**Resolution carried from the header:** income categories are filtered out **before** the rollup, matching `budgetProgress()` at `src/lib/budgets.ts:189`, so an income child never alters a spend parent's total (§17.2's named test, and MUST-3.2's tiebreaker over MUST-4.9's wording).

**Files:**
- Create: `src/lib/predict/window.ts`
- Create: `src/lib/predict/history.ts`
- Test: `tests/lib/predict/window.test.ts` (**new**)
- Test: `tests/lib/predict/history.test.ts` (**new**)

**Interfaces:**
- Consumes: `HISTORY_MONTHS`, `SEASONAL_MIN_MONTHS` from `@/lib/predict/constants` (Task 1); `addMonths`, `monthEnd`, `monthOf`, `monthRange`, `monthStart`, `monthsBetween` from `@/lib/dates`; `getDb` from `@/db/client`; `transactions` from `@/db/schema`; `listCategories`, `type CategoryRecord` from `@/lib/categories`; `netSpentCents` from `@/lib/money`; `and`, `eq`, `gte`, `isNotNull`, `lte`, `sql` from `drizzle-orm`.
- Produces:
  ```ts
  // src/lib/predict/window.ts, PURE
  export function historyMonths(input: { targetMonth: string; firstDataMonth: string | null }): string[];
  export function seasonalApplies(input: { targetMonth: string; firstDataMonth: string | null }): boolean;

  // src/lib/predict/history.ts, the one database module
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
  export interface SeasonalSeries {
    categoryId: number;
    /** Spend in month A = addMonths(targetMonth, -12). */
    monthCents: number;
    /** The 12 calendar months ending at A inclusive, ascending. */
    twelveMonths: number[];
  }
  export function seasonalReference(input: {
    targetMonth: string;
    scope: 'household' | 'personal';
    userId: number | null;
  }): Map<number, SeasonalSeries>;
  ```

### Steps

- [ ] **Step 1: Write the failing window test**

Create `tests/lib/predict/window.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { historyMonths, seasonalApplies } from '@/lib/predict/window';

describe('MUST-4.1 to MUST-4.5: historyMonths', () => {
  it('is the six full calendar months before the target, never the target itself', () => {
    expect(historyMonths({ targetMonth: '2026-08', firstDataMonth: '2025-01' })).toEqual([
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
    ]);
  });

  it('returns an empty list when the household has no transactions', () => {
    expect(historyMonths({ targetMonth: '2026-08', firstDataMonth: null })).toEqual([]);
  });

  it('MUST-4.3: clips to the household first data month', () => {
    expect(historyMonths({ targetMonth: '2026-08', firstDataMonth: '2026-05' })).toEqual(['2026-05', '2026-06', '2026-07']);
    expect(historyMonths({ targetMonth: '2026-08', firstDataMonth: '2026-07' })).toEqual(['2026-07']);
  });

  it('is empty for a target month the household has not reached', () => {
    expect(historyMonths({ targetMonth: '2026-09', firstDataMonth: '2026-09' })).toEqual([]);
  });

  it('crosses a year boundary', () => {
    expect(historyMonths({ targetMonth: '2026-01', firstDataMonth: '2020-01' })).toEqual([
      '2025-07',
      '2025-08',
      '2025-09',
      '2025-10',
      '2025-11',
      '2025-12',
    ]);
  });
});

describe('MUST-5.6 conditions 1 to 3: seasonalApplies', () => {
  it('is false without a first data month', () => {
    expect(seasonalApplies({ targetMonth: '2026-08', firstDataMonth: null })).toBe(false);
  });

  it('is false under the 15-month floor', () => {
    expect(seasonalApplies({ targetMonth: '2026-08', firstDataMonth: '2025-08' })).toBe(false);
  });

  it('is false when the 12 months ending at the reference month are not all covered', () => {
    // Reference month A is 2025-08. Its own 12-month window starts at 2024-09, so a household
    // that started in 2025-01 has no complete reference year even though it clears 15 months.
    expect(seasonalApplies({ targetMonth: '2026-08', firstDataMonth: '2025-01' })).toBe(false);
  });

  it('is true once the full reference year is inside the household history', () => {
    expect(seasonalApplies({ targetMonth: '2026-08', firstDataMonth: '2024-09' })).toBe(true);
    expect(seasonalApplies({ targetMonth: '2026-08', firstDataMonth: '2024-08' })).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
npx vitest run tests/lib/predict/window.test.ts
```
Expected: FAIL with `Failed to resolve import "@/lib/predict/window"`.

- [ ] **Step 3: Write `src/lib/predict/window.ts`**

```ts
import { addMonths, monthRange, monthsBetween } from '@/lib/dates';
import { HISTORY_MONTHS, SEASONAL_MIN_MONTHS } from '@/lib/predict/constants';

/**
 * The history window and its month arithmetic, PURE (MUST-2.1). Month keys are 'YYYY-MM'
 * TEXT, so a lexical comparison is a chronological one and no Date is ever constructed.
 */

/**
 * MUST-4.1 / MUST-4.2 / MUST-4.5: the last HISTORY_MONTHS full calendar months ending
 * immediately before the target. The current, partial month is never in the window: a month
 * with eleven days in it is not a month, and including it would drag every median down at
 * the start of every month and up at the end of it.
 *
 * MUST-4.3 (the clip): the window is intersected with the months at or after the
 * household's first data month. Without it every median on a new install is zero, because
 * the window would be padded with months the household did not exist for.
 */
export function historyMonths(input: { targetMonth: string; firstDataMonth: string | null }): string[] {
  if (input.firstDataMonth === null) return [];
  const months = monthRange(addMonths(input.targetMonth, -HISTORY_MONTHS), addMonths(input.targetMonth, -1));
  return months.filter((month) => month >= input.firstDataMonth!);
}

/**
 * MUST-5.6 conditions 1, 2 and 3. Condition 4 (a strictly positive 12-month mean) is per
 * category and lives in seasonalFactor().
 *
 * Condition 3 requires the whole 12 months ending at A = target - 12 to be covered, which is
 * 23 months of history and therefore subsumes condition 1's 15. Both are checked because the
 * spec states all of them as binding, and because gating the seasonalReference() query on
 * this function is then at least as tight as MUST-4.11 requires.
 */
export function seasonalApplies(input: { targetMonth: string; firstDataMonth: string | null }): boolean {
  if (input.firstDataMonth === null) return false;
  if (monthsBetween(input.firstDataMonth, input.targetMonth) < SEASONAL_MIN_MONTHS) return false;
  const referenceMonth = addMonths(input.targetMonth, -12);
  if (referenceMonth < input.firstDataMonth) return false;
  return addMonths(referenceMonth, -11) >= input.firstDataMonth;
}
```

- [ ] **Step 4: Run the window test to verify it passes**

```powershell
npx vitest run tests/lib/predict/window.test.ts
```
Expected: PASS.

- [ ] **Step 5: Write the failing history test**

Create `tests/lib/predict/history.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { budgetProgress } from '@/lib/budgets';
import { nowIso } from '@/lib/clock';
import { categorySeries, firstDataMonth, seasonalReference } from '@/lib/predict/history';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function setup() {
  current = createSeededTestDb();
  const alice = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  const bob = insertTestUser(current.db, { name: 'Bob', username: 'bob' });
  const joint = insertTestAccount(current.db, { name: 'Joint Chequing' });
  const spend = (over: {
    categoryId: number | null;
    amountCents: number;
    date: string;
    attributedUserId?: number | null;
    isTransfer?: boolean;
  }) => {
    const row = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, attributed_user_id, created_by, created_at, updated_at)
      values (${joint}, ${over.date}, 'X', 'X', ${over.amountCents}, ${over.categoryId}, 'manual', ${over.isTransfer ? 1 : 0}, ${over.attributedUserId ?? null}, ${alice}, ${nowIso()}, ${nowIso()})
      returning id`);
    return row.id;
  };
  const child = (name: string, parentId: number, opts: { isIncome?: boolean; isArchived?: boolean } = {}) => {
    const row = current!.db.get<{ id: number }>(sql`
      insert into categories (name, parent_id, is_income, is_archived, sort_order)
      values (${name}, ${parentId}, ${opts.isIncome ? 1 : 0}, ${opts.isArchived ? 1 : 0}, 0)
      returning id`);
    return row.id;
  };
  return { db: current.db, sqlite: current.sqlite, alice, bob, joint, spend, child };
}

const WINDOW = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];

describe('MUST-4.4: a month with no spend contributes a zero, not a gap', () => {
  it('zero-fills every month in the window', () => {
    const { db, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    spend({ categoryId: groceries, amountCents: -10000, date: '2026-02-10' });
    spend({ categoryId: groceries, amountCents: -20000, date: '2026-05-10' });

    const row = categorySeries({ months: WINDOW, scope: 'household', userId: null }).find(
      (entry) => entry.categoryId === groceries,
    );
    expect(row?.monthlyCents).toEqual([10000, 0, 0, 20000, 0, 0]);
  });
});

describe('MUST-4.9: the rollup matches budgetProgress on the same fixture', () => {
  it('rolls an archived child into its parent', () => {
    const { db, spend, child } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const gone = child('Corner Store', groceries, { isArchived: true });
    spend({ categoryId: groceries, amountCents: -30000, date: '2026-07-05' });
    spend({ categoryId: gone, amountCents: -5000, date: '2026-07-06' });

    const series = categorySeries({ months: ['2026-07'], scope: 'household', userId: null });
    const parent = series.find((entry) => entry.categoryId === groceries);
    const progress = budgetProgress('2026-07', 'household', null).find((entry) => entry.categoryId === groceries);
    expect(parent?.monthlyCents).toEqual([35000]);
    expect(parent?.monthlyCents[0]).toBe(progress?.spentCents);
  });

  it('drops income categories and never lets an income child change a spend parent', () => {
    const { db, spend, child } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const rebate = child('Grocery rebate', groceries, { isIncome: true });
    spend({ categoryId: groceries, amountCents: -30000, date: '2026-07-05' });
    spend({ categoryId: rebate, amountCents: 9000, date: '2026-07-06' });

    const series = categorySeries({ months: ['2026-07'], scope: 'household', userId: null });
    const parent = series.find((entry) => entry.categoryId === groceries);
    const progress = budgetProgress('2026-07', 'household', null).find((entry) => entry.categoryId === groceries);
    expect(parent?.monthlyCents).toEqual([30000]);
    expect(parent?.monthlyCents[0]).toBe(progress?.spentCents);
    expect(series.some((entry) => entry.categoryId === rebate)).toBe(false);
  });

  it('MUST-4.10: returns a row for every non-income category, all-zero series included', () => {
    const { db } = setup();
    const series = categorySeries({ months: WINDOW, scope: 'household', userId: null });
    const groceries = categoryIdByName(db, 'Groceries');
    const row = series.find((entry) => entry.categoryId === groceries);
    expect(row?.monthlyCents).toEqual([0, 0, 0, 0, 0, 0]);
    expect(series.length).toBeGreaterThan(1);
  });
});

describe('MUST-3.1: scope', () => {
  it('household counts every row and personal counts only the attributed ones', () => {
    const { db, alice, bob, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    spend({ categoryId: groceries, amountCents: -10000, date: '2026-07-01', attributedUserId: alice });
    spend({ categoryId: groceries, amountCents: -20000, date: '2026-07-02', attributedUserId: bob });
    spend({ categoryId: groceries, amountCents: -5000, date: '2026-07-03' });

    const pick = (scope: 'household' | 'personal', userId: number | null) =>
      categorySeries({ months: ['2026-07'], scope, userId }).find((entry) => entry.categoryId === groceries)?.monthlyCents;

    expect(pick('household', null)).toEqual([35000]);
    expect(pick('personal', alice)).toEqual([10000]);
    expect(pick('personal', bob)).toEqual([20000]);
  });

  it('MUST-7.2: personal is all zeros when nothing is attributed', () => {
    const { db, alice, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    spend({ categoryId: groceries, amountCents: -10000, date: '2026-07-01' });
    const personal = categorySeries({ months: ['2026-07'], scope: 'personal', userId: alice });
    expect(personal.every((entry) => entry.monthlyCents.every((cents) => cents === 0))).toBe(true);
  });
});

describe('MUST-4.3: firstDataMonth', () => {
  it('is the month of the oldest non-transfer row, and null on an empty database', () => {
    const { db, spend } = setup();
    expect(firstDataMonth()).toBeNull();
    const groceries = categoryIdByName(db, 'Groceries');
    spend({ categoryId: null, amountCents: -100, date: '2020-01-05', isTransfer: true });
    spend({ categoryId: groceries, amountCents: -10000, date: '2026-03-09' });
    expect(firstDataMonth()).toBe('2026-03');
  });
});

describe('MUST-4.8: one grouped query per call', () => {
  it('reads transactions exactly once', () => {
    const { spend, db } = setup();
    spend({ categoryId: categoryIdByName(db, 'Groceries'), amountCents: -10000, date: '2026-07-01' });

    const prepared: string[] = [];
    const sqlite = current!.sqlite as unknown as { prepare: (source: string) => unknown };
    const original = sqlite.prepare.bind(sqlite);
    sqlite.prepare = (source: string) => {
      prepared.push(source);
      return original(source);
    };
    try {
      categorySeries({ months: WINDOW, scope: 'household', userId: null });
    } finally {
      sqlite.prepare = original;
    }
    expect(prepared.filter((statement) => /\btransactions\b/.test(statement))).toHaveLength(1);
  });

  it('runs no query at all for an empty window', () => {
    setup();
    const prepared: string[] = [];
    const sqlite = current!.sqlite as unknown as { prepare: (source: string) => unknown };
    const original = sqlite.prepare.bind(sqlite);
    sqlite.prepare = (source: string) => {
      prepared.push(source);
      return original(source);
    };
    try {
      expect(categorySeries({ months: [], scope: 'household', userId: null })).toEqual([]);
    } finally {
      sqlite.prepare = original;
    }
    expect(prepared.filter((statement) => /\btransactions\b/.test(statement))).toHaveLength(0);
  });
});

describe('MUST-4.11: seasonalReference', () => {
  it('reads the 12 months ending at the reference month and reports that month separately', () => {
    const { db, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    spend({ categoryId: groceries, amountCents: -60000, date: '2025-08-10' }); // month A
    spend({ categoryId: groceries, amountCents: -12000, date: '2024-09-10' }); // first month of the reference year
    spend({ categoryId: groceries, amountCents: -1000, date: '2024-08-10' }); // outside it

    const reference = seasonalReference({ targetMonth: '2026-08', scope: 'household', userId: null }).get(groceries);
    expect(reference?.twelveMonths).toHaveLength(12);
    expect(reference?.monthCents).toBe(60000);
    expect(reference?.twelveMonths[0]).toBe(12000);
    expect(reference?.twelveMonths[11]).toBe(60000);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

```powershell
npx vitest run tests/lib/predict/history.test.ts
```
Expected: FAIL with `Failed to resolve import "@/lib/predict/history"`.

- [ ] **Step 7: Write `src/lib/predict/history.ts`**

```ts
import { and, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { transactions } from '@/db/schema';
import { listCategories, type CategoryRecord } from '@/lib/categories';
import { addMonths, monthEnd, monthOf, monthRange, monthStart } from '@/lib/dates';
import { netSpentCents } from '@/lib/money';

/**
 * The ONLY module under src/lib/predict/ that touches the database (MUST-2.1). Server-only:
 * never imported, directly or transitively, from a *-client.tsx file (MUST-2.2).
 *
 * MUST-3.1 / MUST-3.2: net spend is defined exactly as src/lib/budgets.ts defines it, and
 * there is no second definition. If a suggestion and a progress bar disagree, this file is
 * where the disagreement is.
 */

export interface CategorySeries {
  categoryId: number;
  categoryName: string;
  parentId: number | null;
  isArchived: boolean;
  /** One entry per month in historyMonths(), same order, zero-filled per MUST-4.4. */
  monthlyCents: number[];
}

export interface SeasonalSeries {
  categoryId: number;
  /** Spend in month A = addMonths(targetMonth, -12). */
  monthCents: number;
  /** The 12 calendar months ending at A inclusive, ascending. */
  twelveMonths: number[];
}

/**
 * MUST-4.8: one grouped query for the whole window, served by transactions_date_idx. Not one
 * query per month and not one resolveBudget() call per category per month.
 */
function cells(
  months: string[],
  scope: 'household' | 'personal',
  userId: number | null,
): Map<number, Map<string, number>> {
  const out = new Map<number, Map<string, number>>();
  if (months.length === 0) return out;

  const clauses = [
    gte(transactions.date, monthStart(months[0])),
    lte(transactions.date, monthEnd(months[months.length - 1])),
    eq(transactions.isTransfer, false),
    isNotNull(transactions.categoryId),
  ];
  if (scope === 'personal') {
    if (userId === null) throw new Error('Personal series requires a user');
    clauses.push(eq(transactions.attributedUserId, userId));
  }

  const month = sql<string>`substr(${transactions.date}, 1, 7)`;
  const rows = getDb()
    .select({ month, categoryId: transactions.categoryId, total: sql<number>`sum(${transactions.amountCents})` })
    .from(transactions)
    .where(and(...clauses))
    .groupBy(month, transactions.categoryId)
    .all();

  for (const row of rows) {
    if (row.categoryId === null) continue;
    const byMonth = out.get(row.categoryId) ?? new Map<string, number>();
    // MUST-4.9: netSpentCents() per (month, category) cell, before any rollup.
    byMonth.set(row.month, netSpentCents(row.total ?? 0));
    out.set(row.categoryId, byMonth);
  }
  return out;
}

/**
 * MUST-4.9: the rollup rule, applied in TypeScript because the grouped query cannot express
 * it. A parent's value for a month is its own cell plus every child's cell for that month,
 * archived children included.
 *
 * Income categories are filtered out BEFORE the rollup, exactly as budgetProgress() does
 * (src/lib/budgets.ts), so an income child under a spend parent cannot change that parent's
 * total. MUST-3.2 makes agreement with the progress bar the binding rule here.
 */
function rollup(months: string[], byCategory: Map<number, Map<string, number>>): CategorySeries[] {
  const all = listCategories({ includeArchived: true }).filter((category) => !category.isIncome);
  const childrenOf = new Map<number, CategoryRecord[]>();
  for (const category of all) {
    if (category.parentId === null) continue;
    const siblings = childrenOf.get(category.parentId) ?? [];
    siblings.push(category);
    childrenOf.set(category.parentId, siblings);
  }
  const cell = (categoryId: number, month: string) => byCategory.get(categoryId)?.get(month) ?? 0;

  // MUST-4.10: a row for EVERY non-income category, all-zero series included, so the pure
  // functions downstream never have to distinguish "absent" from "zero".
  return all.map((category) => ({
    categoryId: category.id,
    categoryName: category.name,
    parentId: category.parentId,
    isArchived: category.isArchived,
    monthlyCents: months.map(
      (month) =>
        cell(category.id, month) +
        (childrenOf.get(category.id) ?? []).reduce((sum, child) => sum + cell(child.id, month), 0),
    ),
  }));
}

export function categorySeries(input: {
  months: string[];
  scope: 'household' | 'personal';
  userId: number | null;
}): CategorySeries[] {
  return rollup(input.months, cells(input.months, input.scope, input.userId));
}

/** MUST-4.3: the month of the oldest non-transfer row, or null on a household with none. */
export function firstDataMonth(): string | null {
  const row = getDb()
    .select({ first: sql<string | null>`min(${transactions.date})` })
    .from(transactions)
    .where(eq(transactions.isTransfer, false))
    .get();
  return row?.first ? monthOf(row.first) : null;
}

/**
 * MUST-4.11: the 12 calendar months ending at A = targetMonth - 12, inclusive, through the
 * same query shape and the same rollup rule. Called only when seasonalApplies() is true, so a
 * household under the history floor never pays for the second query.
 */
export function seasonalReference(input: {
  targetMonth: string;
  scope: 'household' | 'personal';
  userId: number | null;
}): Map<number, SeasonalSeries> {
  const referenceMonth = addMonths(input.targetMonth, -12);
  const months = monthRange(addMonths(referenceMonth, -11), referenceMonth);
  const out = new Map<number, SeasonalSeries>();
  for (const row of categorySeries({ months, scope: input.scope, userId: input.userId })) {
    out.set(row.categoryId, {
      categoryId: row.categoryId,
      monthCents: row.monthlyCents[row.monthlyCents.length - 1] ?? 0,
      twelveMonths: row.monthlyCents,
    });
  }
  return out;
}
```

- [ ] **Step 8: Run both test files to verify they pass**

```powershell
npx vitest run tests/lib/predict/window.test.ts tests/lib/predict/history.test.ts
npx tsc --noEmit
```
Expected: PASS on both, clean typecheck.

- [ ] **Step 9: Commit**

```bash
git add src/lib/predict/window.ts src/lib/predict/history.ts tests/lib/predict/window.test.ts tests/lib/predict/history.test.ts
git commit -m "feat(predict): the clipped history window and the one grouped spend-series query"
```

---

## Task 3: `src/lib/predict/suggest.ts` and `pace.ts`

**Context:** Spec §5.4, §5.5, §6 and §8. Seven ordered steps turn a six-month series into a suggested budget, and three integers turn month-to-date spend into a month-end projection. Both are pure. Implements **MUST-5.6** condition 4, **MUST-5.7**, **MUST-5.8**, **MUST-6.1 … MUST-6.8**, **MUST-8.1 … MUST-8.6**, and **AC6**.

**One deliberate departure, and why it is behaviour-preserving:** step 6 calls `ceilToDollar`, which throws on a negative input (MUST-3.4). A hard falling trend at step 3 can drive the value below zero. A non-positive value would reach step 7 and return `'below-floor'` in any case, so `suggestBudget` short-circuits to `'below-floor'` immediately before step 6 rather than handing `ceilToDollar` an input its contract forbids. MUST-6.5's guarantee (never negative, never zero) is unchanged.

**Files:**
- Create: `src/lib/predict/suggest.ts`
- Create: `src/lib/predict/pace.ts`
- Test: `tests/lib/predict/suggest.test.ts` (**new**)
- Test: `tests/lib/predict/pace.test.ts` (**new**)

**Interfaces:**
- Consumes: `MIN_HISTORY_MONTHS`, `PACE_MIN_DAY_OF_MONTH`, `SEASONAL_CLAMP_MAX_PCT`, `SEASONAL_CLAMP_MIN_PCT`, `SUGGESTION_CAP_MULTIPLE`, `SUGGESTION_FLOOR_CENTS`, `TREND_DAMPING_DIVISOR` from `@/lib/predict/constants` (Task 1); `ceilToDollar`, `divRound`, `meanCents`, `medianCents`, `spreadCents`, `trendOf`, `type Trend` from `@/lib/predict/stats` (Task 1); `monthEnd` from `@/lib/dates` (**test only**, for the leap-year assertion).
- Produces:
  ```ts
  // src/lib/predict/suggest.ts, PURE
  export type Confidence = 'low' | 'medium' | 'high';
  export interface Suggestion {
    suggestedCents: number;
    medianCents: number;
    meanCents: number;
    trend: Trend;
    monthsUsed: number;
    seasonalApplied: boolean;
    confidence: Confidence;
  }
  /** A Suggestion tagged with the category it belongs to. The page-to-client shape. */
  export interface CategorySuggestion extends Suggestion { categoryId: number }
  export type NoSuggestionReason = 'not-enough-history' | 'no-spend' | 'below-floor';
  export type SuggestionResult = { suggestion: Suggestion } | { reason: NoSuggestionReason };
  export function seasonalFactor(input: { monthCents: number; twelveMonths: number[] }): { num: number; den: number } | null;
  export function suggestBudget(input: {
    monthlyCents: number[];
    seasonal: { num: number; den: number } | null;
  }): SuggestionResult;

  // src/lib/predict/pace.ts, PURE
  export function projectMonthEnd(input: {
    spentCents: number;
    dayOfMonth: number;
    daysInMonth: number;
  }): number | null;
  ```

### Steps

- [ ] **Step 1: Write the failing pace test**

Create `tests/lib/predict/pace.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { monthEnd } from '@/lib/dates';
import { projectMonthEnd } from '@/lib/predict/pace';

describe('MUST-8.1 to MUST-8.3: the projection formula', () => {
  it('scales the month so far across the whole month', () => {
    expect(projectMonthEnd({ spentCents: 41000, dayOfMonth: 12, daysInMonth: 31 })).toBe(105917);
    expect(projectMonthEnd({ spentCents: 7000, dayOfMonth: 7, daysInMonth: 31 })).toBe(31000);
    expect(projectMonthEnd({ spentCents: 14000, dayOfMonth: 15, daysInMonth: 28 })).toBe(26133);
  });

  it('MUST-8.3: today counts as elapsed, so the last day projects to exactly what was spent', () => {
    expect(projectMonthEnd({ spentCents: 123456, dayOfMonth: 31, daysInMonth: 31 })).toBe(123456);
  });
});

describe('MUST-8.4 and MUST-8.5: the two guards', () => {
  it('returns null before the seventh, because three days times ten is a rumour', () => {
    expect(projectMonthEnd({ spentCents: 50000, dayOfMonth: 6, daysInMonth: 31 })).toBeNull();
    expect(projectMonthEnd({ spentCents: 50000, dayOfMonth: 1, daysInMonth: 31 })).toBeNull();
  });

  it('returns zero for a month that is net refunded so far, never a negative projection', () => {
    expect(projectMonthEnd({ spentCents: 0, dayOfMonth: 10, daysInMonth: 31 })).toBe(0);
    expect(projectMonthEnd({ spentCents: -4000, dayOfMonth: 10, daysInMonth: 31 })).toBe(0);
  });
});

describe('MUST-8.2: daysInMonth comes from monthEnd, so leap years are already right', () => {
  it('gives February 2028 twenty-nine days', () => {
    const daysInMonth = Number(monthEnd('2028-02').slice(8, 10));
    expect(daysInMonth).toBe(29);
    expect(projectMonthEnd({ spentCents: 29000, dayOfMonth: 29, daysInMonth })).toBe(29000);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
npx vitest run tests/lib/predict/pace.test.ts
```
Expected: FAIL with `Failed to resolve import "@/lib/predict/pace"`.

- [ ] **Step 3: Write `src/lib/predict/pace.ts`**

```ts
import { PACE_MIN_DAY_OF_MONTH } from '@/lib/predict/constants';
import { divRound } from '@/lib/predict/stats';

/**
 * The mid-month pace projection, PURE (MUST-2.1). Three integers in, one integer out.
 *
 * MUST-8.6: there is no day-of-week weighting, no weekend adjustment and no known-upcoming
 * recurring-charge term. A household that pays rent on the 1st sees a high projection on the
 * 7th and a truthful one by the 20th, and the UI says the projection assumes the rest of the
 * month looks like the part already spent. An explanation is cheaper than a model.
 */
export function projectMonthEnd(input: {
  spentCents: number;
  /** 1..31, the day in the app's TZ. */
  dayOfMonth: number;
  /** 28..31, from monthEnd(month). */
  daysInMonth: number;
}): number | null {
  // MUST-8.4: a null projection is never displayed and never notified.
  if (input.dayOfMonth < PACE_MIN_DAY_OF_MONTH) return null;
  // MUST-8.5: a net-refunded month is not projected into a negative month end, and can
  // therefore never trigger an overshoot.
  if (input.spentCents <= 0) return 0;
  // MUST-8.3: the divisor is the day number itself, not dayOfMonth - 1. A transaction dated
  // today is already in spentCents, so on the 10th there are ten days of spending. Off by one
  // here is a 10 percent error on the 10th.
  return divRound(input.spentCents * input.daysInMonth, input.dayOfMonth);
}
```

- [ ] **Step 4: Run the pace test to verify it passes**

```powershell
npx vitest run tests/lib/predict/pace.test.ts
```
Expected: PASS.

- [ ] **Step 5: Write the failing suggest test**

Create `tests/lib/predict/suggest.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { medianCents } from '@/lib/predict/stats';
import { seasonalFactor, suggestBudget, type SuggestionResult } from '@/lib/predict/suggest';

const flat = (cents: number, months = 6) => Array.from({ length: months }, () => cents);

function suggestionOf(result: SuggestionResult) {
  if (!('suggestion' in result)) throw new Error(`expected a suggestion, got ${result.reason}`);
  return result.suggestion;
}

describe('MUST-6.1 step 1: the minimum-history guard', () => {
  it('refuses under three months', () => {
    expect(suggestBudget({ monthlyCents: [], seasonal: null })).toEqual({ reason: 'not-enough-history' });
    expect(suggestBudget({ monthlyCents: flat(50000, 2), seasonal: null })).toEqual({ reason: 'not-enough-history' });
  });

  it('MUST-4.7: three observations are enough, even when one of them is zero', () => {
    // Three zero months and three spending months is six observations, not three. The guard is
    // on the WINDOW length, not on the months in which this category happened to spend.
    const result = suggestBudget({ monthlyCents: [0, 60000, 60000], seasonal: null });
    expect('suggestion' in result).toBe(true);
  });
});

describe('MUST-6.1 step 2: a non-positive median gets no budget', () => {
  it('refuses an all-zero series and a net-refunded one', () => {
    expect(suggestBudget({ monthlyCents: flat(0), seasonal: null })).toEqual({ reason: 'no-spend' });
    expect(suggestBudget({ monthlyCents: flat(-2500), seasonal: null })).toEqual({ reason: 'no-spend' });
  });
});

describe('MUST-6.1 step 3: half the observed trend, and nothing for flat or unknown', () => {
  it('adds half a rising move', () => {
    // median 55000, prior mean 50000, recent mean 60000, delta 10000, half is 5000.
    const series = [50000, 50000, 50000, 60000, 60000, 60000];
    expect(medianCents(series)).toBe(55000);
    expect(suggestionOf(suggestBudget({ monthlyCents: series, seasonal: null })).suggestedCents).toBe(60000);
  });

  it('subtracts half a falling move', () => {
    const series = [60000, 60000, 60000, 50000, 50000, 50000];
    expect(suggestionOf(suggestBudget({ monthlyCents: series, seasonal: null })).suggestedCents).toBe(50000);
  });

  it('leaves a flat series at its median', () => {
    expect(suggestionOf(suggestBudget({ monthlyCents: flat(47300), seasonal: null })).suggestedCents).toBe(47300);
  });

  it('leaves an unknown trend at its median, because three points are not a trend', () => {
    const result = suggestionOf(suggestBudget({ monthlyCents: [40000, 50000, 60000], seasonal: null }));
    expect(result.trend).toEqual({ direction: 'unknown', deltaCents: 0 });
    expect(result.suggestedCents).toBe(50000);
  });
});

describe('MUST-5.7 and MUST-6.1 step 4: the clamped seasonal factor', () => {
  it('is absent when the reference year has no positive mean (MUST-5.6 condition 4)', () => {
    expect(seasonalFactor({ monthCents: 5000, twelveMonths: Array.from({ length: 12 }, () => 0) })).toBeNull();
    expect(seasonalFactor({ monthCents: 5000, twelveMonths: Array.from({ length: 12 }, () => -100) })).toBeNull();
  });

  it('does not apply when the reference month was net refunded', () => {
    expect(seasonalFactor({ monthCents: -1, twelveMonths: Array.from({ length: 12 }, () => 10000) })).toBeNull();
  });

  it('passes an in-band ratio through as a rational, never as a float', () => {
    expect(seasonalFactor({ monthCents: 12000, twelveMonths: Array.from({ length: 12 }, () => 10000) })).toEqual({
      num: 12000,
      den: 10000,
    });
  });

  it('clamps at 0.5x and at 2.0x on the rational', () => {
    expect(seasonalFactor({ monthCents: 1000, twelveMonths: Array.from({ length: 12 }, () => 10000) })).toEqual({
      num: 50,
      den: 100,
    });
    expect(seasonalFactor({ monthCents: 90000, twelveMonths: Array.from({ length: 12 }, () => 10000) })).toEqual({
      num: 200,
      den: 100,
    });
  });

  it('scales the value and records that it happened', () => {
    const result = suggestionOf(suggestBudget({ monthlyCents: flat(40000), seasonal: { num: 150, den: 100 } }));
    expect(result.suggestedCents).toBe(60000);
    expect(result.seasonalApplied).toBe(true);
  });

  it('MUST-5.8: an absent factor is recorded as absent, not as a neutral 1.0', () => {
    expect(suggestionOf(suggestBudget({ monthlyCents: flat(40000), seasonal: null })).seasonalApplied).toBe(false);
  });
});

describe('MUST-6.1 step 5 and MUST-6.3: the cap binds against the median, not the trend', () => {
  it('holds a rising trend and a 2.0x season together to three times the median', () => {
    const series = [1000, 1000, 1000, 200000, 200000, 200000];
    const median = medianCents(series);
    expect(median).toBe(100500);
    const result = suggestionOf(suggestBudget({ monthlyCents: series, seasonal: { num: 200, den: 100 } }));
    expect(result.suggestedCents).toBe(301500);
    expect(result.suggestedCents).toBeLessThanOrEqual((median ?? 0) * 3 + 99);
  });
});

describe('MUST-6.1 step 6: the round up to the dollar', () => {
  it('never shows a budget of $746.03', () => {
    expect(suggestionOf(suggestBudget({ monthlyCents: flat(74603), seasonal: null })).suggestedCents).toBe(74700);
  });
});

describe('MUST-6.1 step 7: the floor', () => {
  it('refuses anything under $5', () => {
    expect(suggestBudget({ monthlyCents: flat(1), seasonal: null })).toEqual({ reason: 'below-floor' });
  });

  it('refuses rather than throwing when a falling trend drives the value below zero', () => {
    // median 100, prior mean 200033, recent mean 33, so step 3 gives 100 - 100000.
    const series = [100, 300000, 300000, 0, 0, 100];
    expect(medianCents(series)).toBe(100);
    expect(suggestBudget({ monthlyCents: series, seasonal: null })).toEqual({ reason: 'below-floor' });
  });
});

describe('MUST-6.7 and MUST-6.8: confidence is a label derived from two things', () => {
  it('reads off the number of months used', () => {
    expect(suggestionOf(suggestBudget({ monthlyCents: flat(50000, 3), seasonal: null })).confidence).toBe('low');
    expect(suggestionOf(suggestBudget({ monthlyCents: flat(50000, 4), seasonal: null })).confidence).toBe('low');
    expect(suggestionOf(suggestBudget({ monthlyCents: flat(50000, 5), seasonal: null })).confidence).toBe('medium');
    expect(suggestionOf(suggestBudget({ monthlyCents: flat(50000, 6), seasonal: null })).confidence).toBe('high');
  });

  it('drops one step when the spread is more than twice the median, and low stays low', () => {
    // median 50000, spread 150000, so high becomes medium.
    const six = [10000, 10000, 10000, 90000, 160000, 90000];
    expect(medianCents(six)).toBe(50000);
    expect(suggestionOf(suggestBudget({ monthlyCents: six, seasonal: null })).confidence).toBe('medium');
    // Five months, spread over twice the median, so medium becomes low.
    const five = [10000, 50000, 50000, 90000, 160000];
    expect(suggestionOf(suggestBudget({ monthlyCents: five, seasonal: null })).confidence).toBe('low');
    // Three months, already low, stays low.
    const three = [10000, 50000, 160000];
    expect(suggestionOf(suggestBudget({ monthlyCents: three, seasonal: null })).confidence).toBe('low');
  });
});

describe('AC6 and MUST-6.5: the property that has to hold over any series', () => {
  it('is null or a positive whole-dollar amount at most 3x median + 99, over 500 series', () => {
    let seed = 20260818;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let run = 0; run < 500; run += 1) {
      const length = 3 + (next() % 4);
      const monthlyCents = Array.from({ length }, () => (next() % 400000) - 100000);
      const seasonal = next() % 3 === 0 ? { num: 50 + (next() % 150), den: 100 } : null;
      const result = suggestBudget({ monthlyCents, seasonal });
      if (!('suggestion' in result)) continue;
      const { suggestedCents } = result.suggestion;
      const median = medianCents(monthlyCents) ?? 0;
      expect(suggestedCents).toBeGreaterThan(0);
      expect(suggestedCents % 100).toBe(0);
      expect(suggestedCents).toBeLessThanOrEqual(median * 3 + 99);
    }
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

```powershell
npx vitest run tests/lib/predict/suggest.test.ts
```
Expected: FAIL with `Failed to resolve import "@/lib/predict/suggest"`.

- [ ] **Step 7: Write `src/lib/predict/suggest.ts`**

```ts
import {
  MIN_HISTORY_MONTHS,
  SEASONAL_CLAMP_MAX_PCT,
  SEASONAL_CLAMP_MIN_PCT,
  SUGGESTION_CAP_MULTIPLE,
  SUGGESTION_FLOOR_CENTS,
  TREND_DAMPING_DIVISOR,
} from '@/lib/predict/constants';
import { ceilToDollar, divRound, meanCents, medianCents, spreadCents, trendOf, type Trend } from '@/lib/predict/stats';

/**
 * The suggested budget, PURE (MUST-2.1). Seven ordered steps over a series of integer cents.
 */

export type Confidence = 'low' | 'medium' | 'high';

export interface Suggestion {
  suggestedCents: number;
  medianCents: number;
  meanCents: number;
  trend: Trend;
  monthsUsed: number;
  seasonalApplied: boolean;
  confidence: Confidence;
}

/** A Suggestion tagged with its category. The shape the Budgets page hands its client. */
export interface CategorySuggestion extends Suggestion {
  categoryId: number;
}

export type NoSuggestionReason =
  | 'not-enough-history' // window shorter than MIN_HISTORY_MONTHS
  | 'no-spend' // median at or below zero
  | 'below-floor'; // computed value under SUGGESTION_FLOOR_CENTS

export type SuggestionResult = { suggestion: Suggestion } | { reason: NoSuggestionReason };

/**
 * MUST-5.7: the same-month-last-year factor as a clamped rational, never a float. Returns
 * null when MUST-5.6 condition 4 fails (no positive reference mean) or when the reference
 * month was net refunded, because a category that was refunded that month last year says
 * nothing useful about this one.
 */
export function seasonalFactor(input: { monthCents: number; twelveMonths: number[] }): { num: number; den: number } | null {
  const den = meanCents(input.twelveMonths);
  if (den === null || den <= 0) return null;
  const num = input.monthCents;
  if (num < 0) return null;
  if (num * 100 < den * SEASONAL_CLAMP_MIN_PCT) return { num: SEASONAL_CLAMP_MIN_PCT, den: 100 };
  if (num * 100 > den * SEASONAL_CLAMP_MAX_PCT) return { num: SEASONAL_CLAMP_MAX_PCT, den: 100 };
  return { num, den };
}

/**
 * MUST-6.7: monthsUsed sets the level, then a spread of more than twice the median drops it
 * one step. MUST-6.8: this is a label the UI shows, never a filter.
 */
function confidenceOf(monthsUsed: number, median: number, spread: number): Confidence {
  const level: Confidence = monthsUsed >= 6 ? 'high' : monthsUsed === 5 ? 'medium' : 'low';
  if (spread <= 2 * median) return level;
  return level === 'high' ? 'medium' : 'low';
}

/** MUST-6.1: the seven steps, in exactly this order, each separately testable. */
export function suggestBudget(input: {
  monthlyCents: number[];
  seasonal: { num: number; den: number } | null;
}): SuggestionResult {
  const series = input.monthlyCents;

  // 1. Guard. Two months of data can produce a median, and that median means nothing.
  if (series.length < MIN_HISTORY_MONTHS) return { reason: 'not-enough-history' };

  // 2. Base. MUST-5.2: the median drives the suggestion because one $2,400 vet bill in six
  // months moves a mean by $400 a month and moves a median by nothing.
  const base = medianCents(series);
  if (base === null || base <= 0) return { reason: 'no-spend' };

  // 3. Trend. MUST-6.2: HALF the observed move. Six months of one household's data is a small
  // sample, and a budget that chases the last three months overshoots on both sides.
  const trend = trendOf(series);
  let value = base;
  if (trend.direction === 'rising' || trend.direction === 'falling') {
    value = base + divRound(trend.deltaCents, TREND_DAMPING_DIVISOR);
  }

  // 4. Seasonality, on the rational (MUST-3.5).
  if (input.seasonal !== null) value = divRound(value * input.seasonal.num, input.seasonal.den);

  // 5. Cap. MUST-6.3: applied to the MEDIAN, not to the post-trend value, so it cannot itself
  // be inflated by the thing it is bounding.
  value = Math.min(value, base * SUGGESTION_CAP_MULTIPLE);

  // 6. Round. ceilToDollar throws on a negative (MUST-3.4) and step 3 can drive the value
  // below zero on a hard falling trend. Step 7 would return 'below-floor' for any such value
  // anyway, so it is returned here rather than handed to a function whose contract forbids it.
  if (value <= 0) return { reason: 'below-floor' };
  value = ceilToDollar(value);

  // 7. Floor.
  if (value < SUGGESTION_FLOOR_CENTS) return { reason: 'below-floor' };

  return {
    suggestion: {
      suggestedCents: value,
      medianCents: base,
      meanCents: meanCents(series) ?? 0,
      trend,
      monthsUsed: series.length,
      seasonalApplied: input.seasonal !== null,
      confidence: confidenceOf(series.length, base, spreadCents(series) ?? 0),
    },
  };
}
```

- [ ] **Step 8: Run both test files to verify they pass**

```powershell
npx vitest run tests/lib/predict/suggest.test.ts tests/lib/predict/pace.test.ts
npx tsc --noEmit
```
Expected: PASS on both, clean typecheck.

- [ ] **Step 9: Commit**

```bash
git add src/lib/predict/suggest.ts src/lib/predict/pace.ts tests/lib/predict/suggest.test.ts tests/lib/predict/pace.test.ts
git commit -m "feat(predict): the suggested budget algorithm and the pace projection"
```

---

## Task 4: `src/lib/predict/anomalies.ts`

**Context:** Spec §9.3, §9.4 and §9.5, the detection logic only. This module is pure: it decides, over rows a caller has already read, whether a charge is unusual, whether a subscription's price went up, and which pairs look like duplicates. The queries that feed it live in Task 8's evaluator. Implements **MUST-9.10**, **MUST-9.11**, **MUST-9.15**, **MUST-9.16**, **MUST-9.20**, **MUST-9.23**.

**Files:**
- Create: `src/lib/predict/anomalies.ts`
- Test: `tests/lib/predict/anomalies.test.ts` (**new**)

**Interfaces:**
- Consumes: `CREEP_LOOKBACK_DAYS`, `CREEP_MIN_ABS_CENTS`, `CREEP_MIN_CHARGES`, `CREEP_MIN_PCT`, `CREEP_MONTHLY_GAP_MAX_DAYS`, `CREEP_MONTHLY_GAP_MIN_DAYS`, `CREEP_YEARLY_GAP_MAX_DAYS`, `CREEP_YEARLY_GAP_MIN_DAYS`, `DUPLICATE_LOOKBACK_DAYS`, `DUPLICATE_MIN_ABS_CENTS`, `DUPLICATE_WINDOW_DAYS`, `UNUSUAL_MIN_ABS_CENTS`, `UNUSUAL_MIN_HOUSEHOLD_HISTORY_DAYS`, `UNUSUAL_MIN_SAMPLES`, `UNUSUAL_MULTIPLE` from `@/lib/predict/constants` (Task 1); `medianCents` from `@/lib/predict/stats` (Task 1); `daysBetweenIso` from `@/lib/dates`.
- Produces:
  ```ts
  // src/lib/predict/anomalies.ts, PURE
  /** One non-transfer spend row, as the evaluator reads it. amountCents is signed. */
  export interface SpendRow {
    id: number;
    date: string;
    merchant: string;
    categoryId: number | null;
    amountCents: number;
  }
  export function hasEnoughHouseholdHistory(firstDateIso: string | null, today: string): boolean;
  export interface UnusualVerdict { baselineCents: number; baselineKind: 'merchant' | 'category' }
  export function unusualVerdict(input: {
    amountCents: number;
    /** ABS cents of OTHER rows for the same merchant. The tested row is already excluded. */
    merchantSample: number[];
    /** ABS cents of OTHER rows in the same category. The tested row is already excluded. */
    categorySample: number[];
  }): UnusualVerdict | null;
  export interface CreepVerdict {
    transactionId: number;
    dateIso: string;
    newAmountCents: number;
    baselineCents: number;
    priorCount: number;
  }
  export function creepVerdict(input: { charges: SpendRow[]; today: string }): CreepVerdict | null;
  export interface DuplicatePair {
    lowerId: number;
    higherId: number;
    merchant: string;
    amountCents: number;
    earlierDateIso: string;
    laterDateIso: string;
  }
  export function findDuplicates(input: { rows: SpendRow[]; today: string }): DuplicatePair[];
  ```

### Steps

- [ ] **Step 1: Write the failing test**

Create `tests/lib/predict/anomalies.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { addDaysIso } from '@/lib/dates';
import {
  creepVerdict,
  findDuplicates,
  hasEnoughHouseholdHistory,
  unusualVerdict,
  type SpendRow,
} from '@/lib/predict/anomalies';

const TODAY = '2026-08-18';

function row(over: Partial<SpendRow> & { id: number; date: string; amountCents: number }): SpendRow {
  return { merchant: 'NETFLIX', categoryId: 1, ...over };
}

describe('MUST-9.10 condition 1: the household history floor', () => {
  it('is silent on a first import and speaks once there are 60 days', () => {
    expect(hasEnoughHouseholdHistory(null, TODAY)).toBe(false);
    expect(hasEnoughHouseholdHistory('2026-07-01', TODAY)).toBe(false);
    expect(hasEnoughHouseholdHistory('2026-06-19', TODAY)).toBe(true);
  });
});

describe('MUST-9.10: unusualVerdict', () => {
  const usual = [12000, 12100, 11900, 12200, 12000];

  it('fires on a charge three times the merchant baseline', () => {
    expect(unusualVerdict({ amountCents: -41288, merchantSample: usual, categorySample: [] })).toEqual({
      baselineCents: 12000,
      baselineKind: 'merchant',
    });
  });

  it('does not fire on a refund or a deposit', () => {
    expect(unusualVerdict({ amountCents: 41288, merchantSample: usual, categorySample: [] })).toBeNull();
  });

  it('does not fire under the $50 floor, however large the multiple', () => {
    expect(unusualVerdict({ amountCents: -400, merchantSample: [100, 100, 100, 100, 100], categorySample: [] })).toBeNull();
  });

  it('does not fire under a 3x multiple', () => {
    expect(unusualVerdict({ amountCents: -35000, merchantSample: usual, categorySample: [] })).toBeNull();
    expect(unusualVerdict({ amountCents: -36000, merchantSample: usual, categorySample: [] })?.baselineKind).toBe('merchant');
  });

  it('falls back to the category baseline under five merchant samples, then to nothing', () => {
    const category = [10000, 10000, 10000, 10000, 10000];
    expect(unusualVerdict({ amountCents: -41288, merchantSample: [12000], categorySample: category })).toEqual({
      baselineCents: 10000,
      baselineKind: 'category',
    });
    expect(unusualVerdict({ amountCents: -41288, merchantSample: [12000], categorySample: [10000] })).toBeNull();
  });

  it('does not fire against a zero baseline, which would make every charge a triple', () => {
    expect(unusualVerdict({ amountCents: -41288, merchantSample: [0, 0, 0, 0, 0], categorySample: [] })).toBeNull();
  });
});

describe('MUST-9.15 and MUST-9.16: creepVerdict', () => {
  const monthlyCharges: SpendRow[] = [
    row({ id: 1, date: '2026-05-14', amountCents: -1649 }),
    row({ id: 2, date: '2026-06-14', amountCents: -1649 }),
    row({ id: 3, date: '2026-07-14', amountCents: -1649 }),
    row({ id: 4, date: '2026-08-14', amountCents: -2099 }),
  ];

  it('fires on a monthly subscription whose newest charge went up', () => {
    expect(creepVerdict({ charges: monthlyCharges, today: TODAY })).toEqual({
      transactionId: 4,
      dateIso: '2026-08-14',
      newAmountCents: 2099,
      baselineCents: 1649,
      priorCount: 3,
    });
  });

  it('needs at least four charges', () => {
    expect(creepVerdict({ charges: monthlyCharges.slice(1), today: TODAY })).toBeNull();
  });

  it('accepts a 28-day gap and a 365-day gap, and rejects 7 and 90', () => {
    // Four charges ending on 2026-08-14, which is four days inside the 35-day lookback,
    // spaced `days` apart. Only the gap band changes between cases.
    const at = (days: number) =>
      creepVerdict({
        charges: [0, 1, 2, 3].map((step) =>
          row({ id: step + 1, date: addDaysIso('2026-08-14', -(3 - step) * days), amountCents: step === 3 ? -2099 : -1649 }),
        ),
        today: TODAY,
      });
    expect(at(28)).not.toBeNull();
    expect(at(365)).not.toBeNull();
    expect(at(7)).toBeNull();
    expect(at(90)).toBeNull();
  });

  it('does not fire when the newest charge is older than the 35-day lookback', () => {
    const stale = monthlyCharges.map((charge) => row({ ...charge, date: addDaysIso(charge.date, -60) }));
    expect(creepVerdict({ charges: stale, today: TODAY })).toBeNull();
  });

  it('does not fire when the increase clears only one of the two thresholds', () => {
    // 5 percent of $16.49 is 82 cents, under the $1 floor, so a 90-cent rise fails.
    const smallAbsolute = [...monthlyCharges.slice(0, 3), row({ id: 4, date: '2026-08-14', amountCents: -1739 })];
    expect(creepVerdict({ charges: smallAbsolute, today: TODAY })).toBeNull();
    // $1 on a $100 subscription is 1 percent, under the 5 percent floor.
    const bigBase: SpendRow[] = [
      row({ id: 1, date: '2026-05-14', amountCents: -100000 }),
      row({ id: 2, date: '2026-06-14', amountCents: -100000 }),
      row({ id: 3, date: '2026-07-14', amountCents: -100000 }),
      row({ id: 4, date: '2026-08-14', amountCents: -100100 }),
    ];
    expect(creepVerdict({ charges: bigBase, today: TODAY })).toBeNull();
  });

  it('does not fire when the newest charge went down', () => {
    const cheaper = [...monthlyCharges.slice(0, 3), row({ id: 4, date: '2026-08-14', amountCents: -1000 })];
    expect(creepVerdict({ charges: cheaper, today: TODAY })).toBeNull();
  });
});

describe('MUST-9.20 to MUST-9.23: findDuplicates', () => {
  it('pairs two identical charges one day apart', () => {
    const rows = [
      row({ id: 10, date: '2026-08-12', amountCents: -8950, merchant: 'BELL CANADA' }),
      row({ id: 11, date: '2026-08-13', amountCents: -8950, merchant: 'BELL CANADA' }),
    ];
    expect(findDuplicates({ rows, today: TODAY })).toEqual([
      {
        lowerId: 10,
        higherId: 11,
        merchant: 'BELL CANADA',
        amountCents: -8950,
        earlierDateIso: '2026-08-12',
        laterDateIso: '2026-08-13',
      },
    ]);
  });

  it('MUST-9.23: three identical charges produce two pairs, nearest earlier only', () => {
    const rows = [
      row({ id: 1, date: '2026-08-12', amountCents: -8950 }),
      row({ id: 2, date: '2026-08-13', amountCents: -8950 }),
      row({ id: 3, date: '2026-08-14', amountCents: -8950 }),
    ];
    expect(findDuplicates({ rows, today: TODAY }).map((pair) => [pair.lowerId, pair.higherId])).toEqual([
      [1, 2],
      [2, 3],
    ]);
  });

  it('MUST-9.22: the same pair keys the same way whatever order the scan reaches it in', () => {
    const forward = findDuplicates({
      rows: [row({ id: 5, date: '2026-08-12', amountCents: -8950 }), row({ id: 4, date: '2026-08-13', amountCents: -8950 })],
      today: TODAY,
    });
    expect(forward).toHaveLength(1);
    expect([forward[0].lowerId, forward[0].higherId]).toEqual([4, 5]);
  });

  it('needs the same merchant, the same amount, and both inside the windows', () => {
    const differentMerchant = [
      row({ id: 1, date: '2026-08-12', amountCents: -8950, merchant: 'BELL' }),
      row({ id: 2, date: '2026-08-13', amountCents: -8950, merchant: 'ROGERS' }),
    ];
    expect(findDuplicates({ rows: differentMerchant, today: TODAY })).toEqual([]);

    const differentAmount = [
      row({ id: 1, date: '2026-08-12', amountCents: -8950 }),
      row({ id: 2, date: '2026-08-13', amountCents: -8951 }),
    ];
    expect(findDuplicates({ rows: differentAmount, today: TODAY })).toEqual([]);

    const tooFarApart = [row({ id: 1, date: '2026-08-10', amountCents: -8950 }), row({ id: 2, date: '2026-08-14', amountCents: -8950 })];
    expect(findDuplicates({ rows: tooFarApart, today: TODAY })).toEqual([]);

    const laterTooOld = [row({ id: 1, date: '2026-07-01', amountCents: -8950 }), row({ id: 2, date: '2026-07-02', amountCents: -8950 })];
    expect(findDuplicates({ rows: laterTooOld, today: TODAY })).toEqual([]);
  });

  it('ignores pairs under $10, because two identical transit fares are two transit fares', () => {
    const rows = [row({ id: 1, date: '2026-08-12', amountCents: -400 }), row({ id: 2, date: '2026-08-13', amountCents: -400 })];
    expect(findDuplicates({ rows, today: TODAY })).toEqual([]);
  });

  it('ignores refunds and deposits', () => {
    const rows = [row({ id: 1, date: '2026-08-12', amountCents: 8950 }), row({ id: 2, date: '2026-08-13', amountCents: 8950 })];
    expect(findDuplicates({ rows, today: TODAY })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
npx vitest run tests/lib/predict/anomalies.test.ts
```
Expected: FAIL with `Failed to resolve import "@/lib/predict/anomalies"`.

- [ ] **Step 3: Write `src/lib/predict/anomalies.ts`**

```ts
import { daysBetweenIso } from '@/lib/dates';
import {
  CREEP_LOOKBACK_DAYS,
  CREEP_MIN_ABS_CENTS,
  CREEP_MIN_CHARGES,
  CREEP_MIN_PCT,
  CREEP_MONTHLY_GAP_MAX_DAYS,
  CREEP_MONTHLY_GAP_MIN_DAYS,
  CREEP_YEARLY_GAP_MAX_DAYS,
  CREEP_YEARLY_GAP_MIN_DAYS,
  DUPLICATE_LOOKBACK_DAYS,
  DUPLICATE_MIN_ABS_CENTS,
  DUPLICATE_WINDOW_DAYS,
  UNUSUAL_MIN_ABS_CENTS,
  UNUSUAL_MIN_HOUSEHOLD_HISTORY_DAYS,
  UNUSUAL_MIN_SAMPLES,
  UNUSUAL_MULTIPLE,
} from '@/lib/predict/constants';
import { medianCents } from '@/lib/predict/stats';

/**
 * The three anomaly detectors, PURE (MUST-2.1). They decide over rows a caller has already
 * read; the queries live in src/lib/notify/evaluate/anomalies.ts.
 */

/** One non-transfer spend row, as the evaluator reads it. amountCents is signed. */
export interface SpendRow {
  id: number;
  date: string;
  merchant: string;
  categoryId: number | null;
  amountCents: number;
}

/** MUST-9.10 condition 1: a first import has no baseline to be unusual against. */
export function hasEnoughHouseholdHistory(firstDateIso: string | null, today: string): boolean {
  if (firstDateIso === null) return false;
  return daysBetweenIso(firstDateIso, today) >= UNUSUAL_MIN_HOUSEHOLD_HISTORY_DAYS;
}

export interface UnusualVerdict {
  baselineCents: number;
  baselineKind: 'merchant' | 'category';
}

/**
 * MUST-9.10 conditions 2 to 5. Both samples arrive with the tested row already excluded
 * (MUST-9.11): including it pulls the median toward the outlier and makes a large charge
 * partly responsible for deciding it is not large.
 *
 * A zero baseline is refused because every charge is three times zero.
 */
export function unusualVerdict(input: {
  amountCents: number;
  merchantSample: number[];
  categorySample: number[];
}): UnusualVerdict | null {
  if (input.amountCents >= 0) return null;
  const spend = Math.abs(input.amountCents);
  if (spend < UNUSUAL_MIN_ABS_CENTS) return null;

  const kind: 'merchant' | 'category' | null =
    input.merchantSample.length >= UNUSUAL_MIN_SAMPLES
      ? 'merchant'
      : input.categorySample.length >= UNUSUAL_MIN_SAMPLES
        ? 'category'
        : null;
  if (kind === null) return null;

  const baselineCents = medianCents(kind === 'merchant' ? input.merchantSample : input.categorySample);
  if (baselineCents === null || baselineCents <= 0) return null;
  if (spend < UNUSUAL_MULTIPLE * baselineCents) return null;
  return { baselineCents, baselineKind: kind };
}

export interface CreepVerdict {
  transactionId: number;
  dateIso: string;
  newAmountCents: number;
  baselineCents: number;
  priorCount: number;
}

/** MUST-9.15: monthly and yearly are the two bands. Weekly and quarterly are out of scope. */
function isRecurringGap(medianGapDays: number): boolean {
  const monthly = medianGapDays >= CREEP_MONTHLY_GAP_MIN_DAYS && medianGapDays <= CREEP_MONTHLY_GAP_MAX_DAYS;
  const yearly = medianGapDays >= CREEP_YEARLY_GAP_MIN_DAYS && medianGapDays <= CREEP_YEARLY_GAP_MAX_DAYS;
  return monthly || yearly;
}

/**
 * MUST-9.15 and MUST-9.16, over one merchant's non-transfer spend rows from the last
 * CREEP_BASELINE_DAYS, ascending by date. Returns the newest charge when its price went up.
 *
 * MUST-9.17: the next month's charge at the new price does not fire again, because by then
 * the median of the preceding charges has moved and the percentage condition fails.
 */
export function creepVerdict(input: { charges: SpendRow[]; today: string }): CreepVerdict | null {
  const charges = [...input.charges].sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1));
  if (charges.length < CREEP_MIN_CHARGES) return null;

  const gaps: number[] = [];
  for (let index = 1; index < charges.length; index += 1) {
    gaps.push(daysBetweenIso(charges[index - 1].date, charges[index].date));
  }
  const medianGap = medianCents(gaps);
  if (medianGap === null || !isRecurringGap(medianGap)) return null;

  const latest = charges[charges.length - 1];
  if (daysBetweenIso(latest.date, input.today) > CREEP_LOOKBACK_DAYS) return null;

  const preceding = charges.slice(0, -1).map((charge) => Math.abs(charge.amountCents));
  const baselineCents = medianCents(preceding);
  if (baselineCents === null || baselineCents <= 0) return null;

  const newAmountCents = Math.abs(latest.amountCents);
  if (newAmountCents <= baselineCents) return null;

  const rise = newAmountCents - baselineCents;
  // Both thresholds, so neither a large cheap subscription nor a tiny expensive one slips
  // through on a technicality.
  if (rise * 100 < baselineCents * CREEP_MIN_PCT) return null;
  if (rise < CREEP_MIN_ABS_CENTS) return null;

  return { transactionId: latest.id, dateIso: latest.date, newAmountCents, baselineCents, priorCount: preceding.length };
}

export interface DuplicatePair {
  lowerId: number;
  higherId: number;
  merchant: string;
  amountCents: number;
  earlierDateIso: string;
  laterDateIso: string;
}

/**
 * MUST-9.20 to MUST-9.23. `rows` covers the last DUPLICATE_LOOKBACK_DAYS + DUPLICATE_WINDOW_DAYS
 * days, so a pair whose later half sits on the lookback boundary still has its earlier half.
 *
 * MUST-9.21: everything reaching here already survived transactions_dedup_uq and the
 * SimpleFIN external_id index, so it is either a genuine second charge or a bank reporting
 * one charge twice. The message says exactly that.
 */
export function findDuplicates(input: { rows: SpendRow[]; today: string }): DuplicatePair[] {
  const groups = new Map<string, SpendRow[]>();
  for (const row of input.rows) {
    if (row.amountCents >= 0) continue;
    if (Math.abs(row.amountCents) < DUPLICATE_MIN_ABS_CENTS) continue;
    const key = `${row.merchant}\u0000${row.amountCents}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const pairs: DuplicatePair[] = [];
  for (const group of groups.values()) {
    const ordered = group.slice().sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1));
    for (let index = 1; index < ordered.length; index += 1) {
      const later = ordered[index];
      if (daysBetweenIso(later.date, input.today) > DUPLICATE_LOOKBACK_DAYS) continue;
      // MUST-9.23: the single NEAREST earlier match, never all of them. Three identical
      // charges on three consecutive days produce two events, not three.
      const earlier = ordered[index - 1];
      if (daysBetweenIso(earlier.date, later.date) > DUPLICATE_WINDOW_DAYS) continue;
      pairs.push({
        lowerId: Math.min(earlier.id, later.id),
        higherId: Math.max(earlier.id, later.id),
        merchant: later.merchant,
        amountCents: later.amountCents,
        earlierDateIso: earlier.date,
        laterDateIso: later.date,
      });
    }
  }
  return pairs.sort((a, b) => (a.laterDateIso === b.laterDateIso ? a.higherId - b.higherId : a.laterDateIso < b.laterDateIso ? -1 : 1));
}
```

- [ ] **Step 4: Run the test to verify it passes**

```powershell
npx vitest run tests/lib/predict/anomalies.test.ts
npx tsc --noEmit
```
Expected: PASS, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/lib/predict/anomalies.ts tests/lib/predict/anomalies.test.ts
git commit -m "feat(predict): unusual charge, subscription creep and duplicate detection"
```

---

# Phase 2: Applying a suggestion

## Task 5: `suggestionsFor()` and the two budget server actions

**Context:** Spec §7 in full, plus §16.3's query budget. The composition that turns a scope and a month into a map of suggestions is written **once**, in `history.ts`, because MUST-7.4 requires the apply action to recompute from the same inputs the page used and MUST-3.2 forbids a second definition. A suggested budget and a typed budget are the same row: there is no flag to store, no column to add and no second code path for clearing one. Implements **MUST-7.1 … MUST-7.10**, **MUST-4.6**, **MUST-4.11**'s query gate, and §17.4's test list.

**`'use server'` warning for this task specifically:** `src/app/(app)/budgets/actions.ts` carries the `'use server'` directive. **Every export must be an `async function`.** The error string added below stays a module-local `const`, beside the existing `CROSS_ORIGIN_ERROR`. A `const` export here breaks `next build` and neither `vitest` nor `tsc --noEmit` catches it.

**Files:**
- Modify: `src/lib/predict/history.ts` (append `ScopeSuggestions` and `suggestionsFor`)
- Modify: `src/app/(app)/budgets/actions.ts` (two new actions, three new imports, one new module-local const)
- Test: `tests/app/budget-suggestions.test.ts` (**new**)

**Interfaces:**
- Consumes: `categorySeries`, `firstDataMonth`, `seasonalReference` from `@/lib/predict/history` (Task 2); `historyMonths`, `seasonalApplies` from `@/lib/predict/window` (Task 2); `seasonalFactor`, `suggestBudget`, `type SuggestionResult` from `@/lib/predict/suggest` (Task 3); the existing `isSameOrigin`, `requireUser`, `resolveBudget`, `upsertBudget`, `revalidatePath`, `formatCents`, and the existing module-local `scopeSchema` / `monthSchema` / `categoryIdSchema` / `userIdField` / `CROSS_ORIGIN_ERROR` / `BudgetActionState` already in `actions.ts`.
- Produces:
  ```ts
  // src/lib/predict/history.ts, appended
  export interface ScopeSuggestions {
    /** The clipped window this scope's suggestions were computed over. Length drives MUST-15.1. */
    months: string[];
    byCategory: Map<number, SuggestionResult>;
  }
  export function suggestionsFor(input: {
    targetMonth: string;
    scope: 'household' | 'personal';
    userId: number | null;
  }): ScopeSuggestions;

  // src/app/(app)/budgets/actions.ts, appended
  export async function applySuggestionAction(prev: BudgetActionState, formData: FormData): Promise<BudgetActionState>;
  export async function applyAllSuggestionsAction(prev: BudgetActionState, formData: FormData): Promise<BudgetActionState>;
  ```

### Steps

- [ ] **Step 1: Write the failing test**

Create `tests/app/budget-suggestions.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { resolveBudget, upsertBudget } from '@/lib/budgets';
import { nowIso } from '@/lib/clock';

let currentUser: { id: number; name: string; username: string; role: 'admin' | 'member' } = {
  id: 1,
  name: 'Alice',
  username: 'alice',
  role: 'member',
};
let mockHeaders = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });

vi.mock('@/lib/auth/session', () => ({
  requireUser: vi.fn(async () => currentUser),
}));

vi.mock('next/headers', () => ({
  headers: async () => mockHeaders,
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import { applyAllSuggestionsAction, applySuggestionAction } from '@/app/(app)/budgets/actions';

const SAME_ORIGIN = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });
const CROSS_ORIGIN = new Headers({ origin: 'http://evil.local', host: 'nas.local:3000' });

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
  mockHeaders = SAME_ORIGIN;
});

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

/** Six flat months of spend for a category, ending the month before TARGET. */
const TARGET = '2026-08';
const WINDOW_MONTHS = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];

function setup() {
  current = createSeededTestDb();
  const alice = insertTestUser(current.db, { name: 'Alice', username: 'alice', role: 'member' });
  const bob = insertTestUser(current.db, { name: 'Bob', username: 'bob', role: 'member' });
  currentUser = { id: alice, name: 'Alice', username: 'alice', role: 'member' };
  const joint = insertTestAccount(current.db, { name: 'Joint Chequing' });
  const spend = (over: { categoryId: number; amountCents: number; date: string; attributedUserId?: number | null }) => {
    current!.db.run(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, attributed_user_id, created_by, created_at, updated_at)
      values (${joint}, ${over.date}, 'X', 'X', ${over.amountCents}, ${over.categoryId}, 'manual', 0, ${over.attributedUserId ?? null}, ${alice}, ${nowIso()}, ${nowIso()})`);
  };
  const flatSix = (categoryId: number, cents: number, attributedUserId?: number) => {
    for (const month of WINDOW_MONTHS) spend({ categoryId, amountCents: -cents, date: `${month}-10`, attributedUserId });
  };
  return { db: current.db, alice, bob, spend, flatSix };
}

describe('MUST-7.4: the amount is never a form field', () => {
  it('writes the recomputed amount and ignores an amount a crafted request adds', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flatSix(groceries, 60000);

    const state = await applySuggestionAction(
      {},
      formData({ scope: 'household', userId: '', month: TARGET, categoryId: String(groceries), amount: '999999' }),
    );

    expect(state.error).toBeUndefined();
    expect(resolveBudget('household', null, groceries, TARGET)).toBe(60000);
  });
});

describe('MUST-7.5: a suggestion that is no longer available writes nothing', () => {
  it('returns the reload error for a category with no computable suggestion', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const dining = categoryIdByName(db, 'Dining out');
    flatSix(groceries, 60000);

    const state = await applySuggestionAction(
      {},
      formData({ scope: 'household', userId: '', month: TARGET, categoryId: String(dining) }),
    );

    expect(state.error).toBe('That suggestion is no longer available. Reload the page.');
    expect(resolveBudget('household', null, dining, TARGET)).toBeNull();
  });
});

describe('MUST-7.6: permissions match setLimitAction exactly', () => {
  it('refuses a member writing to another member personal scope, and allows an admin', async () => {
    const { db, bob, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flatSix(groceries, 60000, bob);

    const refused = await applySuggestionAction(
      {},
      formData({ scope: 'personal', userId: String(bob), month: TARGET, categoryId: String(groceries) }),
    );
    expect(refused.error).toBe('You can only edit your own personal budgets.');
    expect(resolveBudget('personal', bob, groceries, TARGET)).toBeNull();

    currentUser = { ...currentUser, role: 'admin' };
    const allowed = await applySuggestionAction(
      {},
      formData({ scope: 'personal', userId: String(bob), month: TARGET, categoryId: String(groceries) }),
    );
    expect(allowed.error).toBeUndefined();
    expect(resolveBudget('personal', bob, groceries, TARGET)).toBe(60000);
  });
});

describe('MUST-7.7: applying at month M writes effective_month M and leaves earlier rows alone', () => {
  it('does not mutate a limit set in an earlier month', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flatSix(groceries, 60000);
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-01', amountCents: 12345 });

    await applySuggestionAction({}, formData({ scope: 'household', userId: '', month: TARGET, categoryId: String(groceries) }));

    expect(resolveBudget('household', null, groceries, '2026-01')).toBe(12345);
    expect(resolveBudget('household', null, groceries, '2026-07')).toBe(12345);
    expect(resolveBudget('household', null, groceries, TARGET)).toBe(60000);
  });
});

describe('MUST-7.8: apply-all never overwrites a typed limit', () => {
  it('skips every category with a resolved limit and names both counts', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const dining = categoryIdByName(db, 'Dining out');
    flatSix(groceries, 60000);
    flatSix(dining, 30000);
    upsertBudget({ scope: 'household', userId: null, categoryId: dining, month: '2026-06', amountCents: 11100 });

    const state = await applyAllSuggestionsAction({}, formData({ scope: 'household', userId: '', month: TARGET }));

    expect(state.message).toBe('Set 1 budgets from suggestions. Skipped 1 categories that already had a limit.');
    expect(resolveBudget('household', null, groceries, TARGET)).toBe(60000);
    expect(resolveBudget('household', null, dining, TARGET)).toBe(11100);
  });
});

describe('same-origin first', () => {
  it('rejects both actions on a cross-origin request before touching the database', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flatSix(groceries, 60000);
    mockHeaders = CROSS_ORIGIN;

    expect(
      (await applySuggestionAction({}, formData({ scope: 'household', userId: '', month: TARGET, categoryId: String(groceries) })))
        .error,
    ).toBe('Cross-origin request rejected');
    expect((await applyAllSuggestionsAction({}, formData({ scope: 'household', userId: '', month: TARGET }))).error).toBe(
      'Cross-origin request rejected',
    );
    expect(resolveBudget('household', null, groceries, TARGET)).toBeNull();
  });
});

describe('MUST-4.6: under three months of history there are no suggestions at all', () => {
  it('refuses every category on a two-month household', async () => {
    const { db, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    spend({ categoryId: groceries, amountCents: -60000, date: '2026-06-10' });
    spend({ categoryId: groceries, amountCents: -60000, date: '2026-07-10' });

    const state = await applySuggestionAction(
      {},
      formData({ scope: 'household', userId: '', month: TARGET, categoryId: String(groceries) }),
    );
    expect(state.error).toBe('That suggestion is no longer available. Reload the page.');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
npx vitest run tests/app/budget-suggestions.test.ts
```
Expected: FAIL with `applySuggestionAction is not a function` (or an import error naming it).

- [ ] **Step 3: Append `suggestionsFor` to `src/lib/predict/history.ts`**

Add these imports to the existing import block at the top of the file:

```ts
import { historyMonths, seasonalApplies } from '@/lib/predict/window';
import { seasonalFactor, suggestBudget, type SuggestionResult } from '@/lib/predict/suggest';
```

Append at the end of the file:

```ts
export interface ScopeSuggestions {
  /** The clipped window these were computed over. Its length drives MUST-15.1's sentence. */
  months: string[];
  byCategory: Map<number, SuggestionResult>;
}

/**
 * The one composition of window, series, seasonality and suggestion, for one scope and one
 * target month.
 *
 * It lives here, in the tree's only server module, because both the Budgets page render and
 * applySuggestionAction need it and MUST-3.2 forbids a second definition: the button's label
 * can never disagree with what the button did if there is one computation.
 *
 * MUST-16.3: one categorySeries() query, plus at most one seasonalReference() query and only
 * on installs whose history covers a complete reference year (MUST-4.11's gate, via
 * seasonalApplies which is at least as tight).
 */
export function suggestionsFor(input: {
  targetMonth: string;
  scope: 'household' | 'personal';
  userId: number | null;
}): ScopeSuggestions {
  const first = firstDataMonth();
  const months = historyMonths({ targetMonth: input.targetMonth, firstDataMonth: first });
  const byCategory = new Map<number, SuggestionResult>();

  const series = categorySeries({ months, scope: input.scope, userId: input.userId });
  const reference = seasonalApplies({ targetMonth: input.targetMonth, firstDataMonth: first })
    ? seasonalReference({ targetMonth: input.targetMonth, scope: input.scope, userId: input.userId })
    : null;

  for (const row of series) {
    const found = reference?.get(row.categoryId) ?? null;
    byCategory.set(
      row.categoryId,
      suggestBudget({
        monthlyCents: row.monthlyCents,
        seasonal: found === null ? null : seasonalFactor({ monthCents: found.monthCents, twelveMonths: found.twelveMonths }),
      }),
    );
  }
  return { months, byCategory };
}
```

- [ ] **Step 4: Add the two actions to `src/app/(app)/budgets/actions.ts`**

Add to the existing import block:

```ts
import { clearBudget, copyBudgetsFromPreviousMonth, resolveBudget, upsertBudget, type BudgetScope } from '@/lib/budgets';
import { formatCents, parseAmountToCents } from '@/lib/money';
import { suggestionsFor } from '@/lib/predict/history';
```

(the first two lines replace the existing `@/lib/budgets` and `@/lib/money` imports)

Add beside the existing `CROSS_ORIGIN_ERROR` constant. **Module-local, not exported: this file is `'use server'` and may export only async functions.**

```ts
const STALE_SUGGESTION_ERROR = 'That suggestion is no longer available. Reload the page.';
```

Append at the end of the file:

```ts
/**
 * MUST-7.4: takes scope, userId, month and categoryId, and NO amount. The suggestion is
 * recomputed server-side from the same inputs the page used, so a crafted request cannot
 * write an arbitrary number through a path labelled "suggestion".
 */
export async function applySuggestionAction(_prev: BudgetActionState, formData: FormData): Promise<BudgetActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const scope = scopeSchema.safeParse(formData.get('scope'));
  const month = monthSchema.safeParse(String(formData.get('month') ?? ''));
  const categoryId = categoryIdSchema.safeParse(formData.get('categoryId'));
  const rawUserId = userIdField.safeParse(String(formData.get('userId') ?? ''));
  if (!scope.success || !month.success || !categoryId.success || !rawUserId.success) {
    return { error: 'Invalid request.' };
  }

  // MUST-7.6: setLimitAction's rule, verbatim.
  const userId = scope.data === 'personal' ? (rawUserId.data === '' ? user.id : Number(rawUserId.data)) : null;
  if (scope.data === 'personal' && userId !== user.id && user.role !== 'admin') {
    return { error: 'You can only edit your own personal budgets.' };
  }

  const result = suggestionsFor({ targetMonth: month.data, scope: scope.data, userId }).byCategory.get(categoryId.data);
  // MUST-7.5: never fall back to a stale number.
  if (result === undefined || !('suggestion' in result)) return { error: STALE_SUGGESTION_ERROR };

  // MUST-7.7: the existing write, so the existing effective-month semantics apply unchanged.
  upsertBudget({
    scope: scope.data,
    userId,
    categoryId: categoryId.data,
    month: month.data,
    amountCents: result.suggestion.suggestedCents,
  });
  revalidatePath('/budgets');
  return { message: `Budget set to ${formatCents(result.suggestion.suggestedCents, { currency: true })} from the suggestion.` };
}

/**
 * MUST-7.8: applies every available suggestion ONLY to categories whose resolved limit for
 * that month is currently null. A category with a limit somebody typed is skipped, always,
 * with no confirmation dialog and no override flag.
 */
export async function applyAllSuggestionsAction(_prev: BudgetActionState, formData: FormData): Promise<BudgetActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const scope = scopeSchema.safeParse(formData.get('scope'));
  const month = monthSchema.safeParse(String(formData.get('month') ?? ''));
  const rawUserId = userIdField.safeParse(String(formData.get('userId') ?? ''));
  if (!scope.success || !month.success || !rawUserId.success) return { error: 'Invalid request.' };

  const userId = scope.data === 'personal' ? (rawUserId.data === '' ? user.id : Number(rawUserId.data)) : null;
  if (scope.data === 'personal' && userId !== user.id && user.role !== 'admin') {
    return { error: 'You can only edit your own personal budgets.' };
  }

  let set = 0;
  let skipped = 0;
  for (const [categoryId, result] of suggestionsFor({ targetMonth: month.data, scope: scope.data, userId }).byCategory) {
    if (!('suggestion' in result)) continue;
    if (resolveBudget(scope.data as BudgetScope, userId, categoryId, month.data) !== null) {
      skipped += 1;
      continue;
    }
    upsertBudget({ scope: scope.data, userId, categoryId, month: month.data, amountCents: result.suggestion.suggestedCents });
    set += 1;
  }

  revalidatePath('/budgets');
  return { message: `Set ${set} budgets from suggestions. Skipped ${skipped} categories that already had a limit.` };
}
```

- [ ] **Step 5: Run the test to verify it passes**

```powershell
npx vitest run tests/app/budget-suggestions.test.ts tests/app/budgets-actions.test.ts tests/lib/budgets.test.ts
npx tsc --noEmit
```
Expected: PASS on all three files, clean typecheck. `tests/lib/budgets.test.ts` and `tests/app/budgets-actions.test.ts` must be **unamended** and still green (§17.9).

- [ ] **Step 6: Verify by eye that no non-async export was added to the `'use server'` file**

```powershell
Select-String -Path ".\src\app\(app)\budgets\actions.ts" -Pattern '^export '
```
Expected: only `export interface BudgetActionState` (a type, erased at build) and four `export async function` lines. **Any `export const` here breaks `next build`.**

- [ ] **Step 7: Commit**

```bash
git add src/lib/predict/history.ts "src/app/(app)/budgets/actions.ts" tests/app/budget-suggestions.test.ts
git commit -m "feat(budgets): apply a suggestion and apply all, recomputed server-side"
```

---

# Phase 3: The six notification events

Four tasks. Task 6 is the registry-and-renderer gate: no evaluator can compile before it lands, because `renderEvent`'s no-`default` switch turns a missing case into a TS2366 error. Tasks 7, 8 and 9 each add one evaluator module and one call site in `src/lib/notify/evaluate/index.ts`.

## Task 6: Six registry entries, six dedup keys, six render cases

**Context:** Spec §9.1, §9.9 and §9.10. This is notify MUST-4.4's extension point exercised for the second time after `update_available`: six appended array entries, six appended key builders, six appended union members, six appended cases, and **no migration, no `src/db/schema.ts` line and no settings UI component**. The toggle matrix is generated from the registry, so it gains six rows without being edited, and a test proves it. Implements **MUST-9.1 … MUST-9.5**, **MUST-9.7**, **MUST-9.12**, **MUST-9.17**, **MUST-9.22**, **MUST-9.28**, **MUST-9.32**, **MUST-9.37 … MUST-9.41**, **MUST-17.2**.

**The registry currently holds nine events, not eight.** `update_available` shipped in v1.3.1. This task takes it to **fifteen**: `eventsFor('admin')` goes from 9 to 15 and `eventsFor('member')` from 6 to 12, because all six new events are `audience: 'all'`.

**Files:**
- Modify: `src/lib/notify/events.ts` (six appended `NOTIFICATION_EVENTS` entries, six appended key builders)
- Modify: `src/lib/notify/render.ts` (two exported line interfaces, six appended `RenderInput` members, six appended cases, two private line helpers)
- Test: `tests/lib/notify/events.test.ts` (amended: counts, the table, the default-on set, the six key strings)
- Test: `tests/lib/notify/render.test.ts` (amended: six new cases)
- Test: `tests/app/notifications-client.test.tsx` (amended: the matrix gains six rows with no component edit)

**Interfaces:**
- Consumes: the existing private `scopeLetter(scope: BudgetScopeKey): 'h' | 'p'` and the exported `BudgetScopeKey` in `events.ts`; the existing private `money`, `scopeWord`, `padded` and the exported `NAME_MAX`, `truncateText`, `DigestLine` in `render.ts`; `monthLabel` from `@/lib/dates`. All three helpers are file-private and stay that way: the new code lives in the same two files.
- Produces:
  ```ts
  // src/lib/notify/events.ts, appended
  export function budgetPaceKey(scope: BudgetScopeKey, categoryId: number, month: string): string;
  export function unusualTransactionKey(transactionId: number): string;
  export function subscriptionCreepKey(transactionId: number): string;
  export function duplicateChargeKey(lowerId: number, higherId: number): string;
  export function predictedVsActualKey(month: string): string;
  export function suggestedBudgetRefreshKey(month: string): string;

  // src/lib/notify/render.ts, appended
  export interface PredictedLine { name: string; expectedCents: number; actualCents: number }
  export interface RefreshLine { name: string; nowCents: number; wasCents: number | null }
  // six new RenderInput members, discriminated on `event`:
  //  { event: 'budget_pace'; scope: 'household' | 'personal'; categoryName: string; month: string;
  //    limitCents: number; spentCents: number; dayOfMonth: number; projectedCents: number }
  //  { event: 'unusual_transaction'; merchant: string; accountName: string; dateIso: string;
  //    amountCents: number; baselineCents: number; baselineKind: 'merchant' | 'category';
  //    categoryName: string | null }
  //  { event: 'subscription_creep'; merchant: string; dateIso: string; newAmountCents: number;
  //    baselineCents: number; priorCount: number }
  //  { event: 'duplicate_charge'; merchant: string; amountCents: number; earlierDateIso: string;
  //    laterDateIso: string }
  //  { event: 'predicted_vs_actual'; month: string; household: readonly PredictedLine[];
  //    personal: readonly PredictedLine[]; totalDeltaCents: number }
  //  { event: 'suggested_budget_refresh'; month: string; household: readonly RefreshLine[];
  //    personal: readonly RefreshLine[]; changedCount: number }
  ```

### Steps

- [ ] **Step 1: Amend `tests/lib/notify/events.test.ts` so it fails**

Rename the `describe('§4.2: the eight launch events', ...)` block to `describe('the fifteen registered events', ...)` and change its two assertions from 9 to 15:

```ts
  it('has exactly fifteen entries with unique, well-formed ids', () => {
    expect(NOTIFICATION_EVENTS).toHaveLength(15);
    const ids = NOTIFICATION_EVENTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(15);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
  });
```

Append six rows to the `matches the spec table exactly` tuple array, after `['update_available', 'admin', 'tick', true]`:

```ts
      ['budget_pace', 'all', 'daily_slot', true],
      ['unusual_transaction', 'all', 'tick', true],
      ['subscription_creep', 'all', 'daily_slot', true],
      ['duplicate_charge', 'all', 'tick', true],
      ['predicted_vs_actual', 'all', 'daily_slot', false],
      ['suggested_budget_refresh', 'all', 'daily_slot', false],
```

Replace the `MUST-4.1` default-on assertion with:

```ts
    expect(on).toEqual([
      'backup_failed',
      'budget_exceeded',
      'budget_pace',
      'coming_due',
      'duplicate_charge',
      'new_signin',
      'restore_outcome',
      'subscription_creep',
      'unusual_transaction',
      'update_available',
    ]);
```

Change the two `eventsFor` lengths:

```ts
    expect(eventsFor('member')).toHaveLength(12);
    expect(eventsFor('admin')).toHaveLength(15);
```

Change the `toHaveLength(9)` inside `describe('MUST-6.1: the update_available registry entry', ...)` to `toHaveLength(15)`.

Add a new describe block at the end of the file, and add the six builders to the import list at the top:

```ts
describe('spec section 9: the six predictive dedup keys', () => {
  it('builds every key shape in the table', () => {
    expect(budgetPaceKey('household', 7, '2026-08')).toBe('pace:h:7:2026-08');
    expect(budgetPaceKey('personal', 7, '2026-08')).toBe('pace:p:7:2026-08');
    expect(unusualTransactionKey(4211)).toBe('unusual:4211');
    expect(subscriptionCreepKey(4211)).toBe('creep:4211');
    expect(duplicateChargeKey(31, 44)).toBe('dupe:31:44');
    expect(predictedVsActualKey('2026-07')).toBe('predvs:2026-07');
    expect(suggestedBudgetRefreshKey('2026-08')).toBe('suggest:2026-08');
  });

  it('MUST-9.22: a duplicate pair keys the same way whichever row the scan reaches first', () => {
    expect(duplicateChargeKey(44, 31)).toBe(duplicateChargeKey(31, 44));
  });

  it('a pace key never collides with a threshold or an exceeded key', () => {
    expect(budgetPaceKey('household', 7, '2026-08')).not.toBe(budgetExceededKey('household', 7, '2026-08'));
    expect(budgetPaceKey('household', 7, '2026-08')).not.toBe(budgetThresholdKey('household', 7, '2026-08', 80));
  });

  it('carries neither the user nor the channel, which the unique index already holds', () => {
    for (const key of [budgetPaceKey('personal', 7, '2026-08'), unusualTransactionKey(1), predictedVsActualKey('2026-07')]) {
      expect(key).not.toMatch(/telegram|email|user/);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
npx vitest run tests/lib/notify/events.test.ts
```
Expected: FAIL. `expected 9 to be 15`, plus `budgetPaceKey is not a function`.

- [ ] **Step 3: Append the six registry entries and six key builders to `src/lib/notify/events.ts`**

Append these six entries to the end of the `NOTIFICATION_EVENTS` array, after `update_available`:

```ts
  {
    id: 'budget_pace',
    label: 'On pace to go over budget',
    blurb: 'A category is heading past its limit before the month is out.',
    audience: 'all',
    trigger: 'daily_slot',
    defaultEnabled: true,
  },
  {
    id: 'unusual_transaction',
    label: 'An unusually large charge',
    blurb: 'A charge is several times what that merchant usually costs.',
    audience: 'all',
    trigger: 'tick',
    defaultEnabled: true,
  },
  {
    id: 'subscription_creep',
    label: 'A recurring charge went up',
    blurb: 'A subscription or bill came in higher than the last few did.',
    audience: 'all',
    trigger: 'daily_slot',
    defaultEnabled: true,
  },
  {
    id: 'duplicate_charge',
    label: 'A possible duplicate charge',
    blurb: 'The same merchant charged the same amount twice within a few days.',
    audience: 'all',
    trigger: 'tick',
    defaultEnabled: true,
  },
  {
    id: 'predicted_vs_actual',
    label: 'Last month, predicted against actual',
    blurb: 'Early each month, how the month just gone compared with what the six months before it pointed at.',
    audience: 'all',
    trigger: 'daily_slot',
    defaultEnabled: false,
  },
  {
    id: 'suggested_budget_refresh',
    label: 'New month, new suggested budgets',
    blurb: 'Early each month, the categories whose suggested budget has moved away from the limit you have set.',
    audience: 'all',
    trigger: 'daily_slot',
    defaultEnabled: false,
  },
```

Append the six key builders at the end of the file:

```ts
/**
 * Once per scope, per category, per month, EVER (MUST-9.8). It fires on the first day at or
 * after the 7th on which the projection crosses the threshold, and never again that month,
 * whether the projection later gets worse or better. Re-alerting on a moving projection is
 * how a useful alert becomes an ignored one.
 *
 * MUST-9.9 (pruning safety): the key carries the month and the evaluator only ever visits the
 * current month, so a row pruned by the 400-day sweep belongs to a month never evaluated again.
 */
export function budgetPaceKey(scope: BudgetScopeKey, categoryId: number, month: string): string {
  return `pace:${scopeLetter(scope)}:${categoryId}:${month}`;
}

/** Once per transaction, ever. 14 days of lookback against 400 days of retention (MUST-9.14). */
export function unusualTransactionKey(transactionId: number): string {
  return `unusual:${transactionId}`;
}

/**
 * Once per price change, ever, keyed on the INCREASED charge. Next month's charge at the new
 * price does not fire again, because by then the median of the preceding charges has moved
 * (MUST-9.17). A second rise is a different transaction id and a legitimately new message.
 */
export function subscriptionCreepKey(transactionId: number): string {
  return `creep:${transactionId}`;
}

/** MUST-9.22: the two ids sorted ascending, so the same pair keys the same either way round. */
export function duplicateChargeKey(lowerId: number, higherId: number): string {
  const first = Math.min(lowerId, higherId);
  const second = Math.max(lowerId, higherId);
  return `dupe:${first}:${second}`;
}

/** Once per reported month, ever. The evaluator only ever visits the immediately previous one. */
export function predictedVsActualKey(month: string): string {
  return `predvs:${month}`;
}

/** Once per current month, ever. Same pruning argument as predictedVsActualKey. */
export function suggestedBudgetRefreshKey(month: string): string {
  return `suggest:${month}`;
}
```

- [ ] **Step 4: Run the events test to verify it passes**

```powershell
npx vitest run tests/lib/notify/events.test.ts
```
Expected: PASS.

- [ ] **Step 5: Amend `tests/lib/notify/render.test.ts` so it fails**

Append this describe block, following the file's existing import and assertion style:

```ts
describe('spec section 9: the six predictive messages', () => {
  it('budget_pace names the limit, the days elapsed, the projection and the overshoot', () => {
    const { subject, body } = renderEvent({
      event: 'budget_pace',
      scope: 'household',
      categoryName: 'Groceries',
      month: '2026-08',
      limitCents: 60000,
      spentCents: 41000,
      dayOfMonth: 12,
      projectedCents: 105900,
    });
    expect(subject).toBe('On pace to go over: Groceries (August 2026)');
    expect(body).toContain('Household Groceries budget for August 2026 is $600.00.');
    expect(body).toContain('You have spent $410.00 in 12 days.');
    expect(body).toContain('the month ends near $1,059.00, about $459.00 over.');
  });

  it('budget_pace says "Your" for a personal budget', () => {
    const { body } = renderEvent({
      event: 'budget_pace',
      scope: 'personal',
      categoryName: 'Groceries',
      month: '2026-08',
      limitCents: 60000,
      spentCents: 41000,
      dayOfMonth: 12,
      projectedCents: 105900,
    });
    expect(body.startsWith('Your Groceries budget')).toBe(true);
  });

  it('unusual_transaction names the merchant baseline it used', () => {
    const { subject, body } = renderEvent({
      event: 'unusual_transaction',
      merchant: 'CANADIAN TIRE',
      accountName: 'Joint Chequing',
      dateIso: '2026-08-14',
      amountCents: -41288,
      baselineCents: 12100,
      baselineKind: 'merchant',
      categoryName: 'Home & Garden',
    });
    expect(subject).toBe('Unusual charge: CANADIAN TIRE $412.88');
    expect(body).toContain('on 2026-08-14');
    expect(body).toContain('Joint Chequing');
    expect(body).toContain('3.4 times the $121.00 you usually spend at CANADIAN TIRE');
  });

  it('unusual_transaction says so when it fell back to the category baseline', () => {
    const { body } = renderEvent({
      event: 'unusual_transaction',
      merchant: 'CANADIAN TIRE',
      accountName: 'Joint Chequing',
      dateIso: '2026-08-14',
      amountCents: -41288,
      baselineCents: 12100,
      baselineKind: 'category',
      categoryName: 'Home & Garden',
    });
    expect(body).toContain('the $121.00 that Home & Garden charges usually run');
  });

  it('subscription_creep names both amounts, the rise and the percentage', () => {
    const { subject, body } = renderEvent({
      event: 'subscription_creep',
      merchant: 'NETFLIX',
      dateIso: '2026-08-14',
      newAmountCents: 2099,
      baselineCents: 1649,
      priorCount: 3,
    });
    expect(subject).toBe('Price went up: NETFLIX');
    expect(body).toBe(
      'NETFLIX charged $20.99 on 2026-08-14. The last 3 charges were $16.49. That is $4.50 more, about 27 percent.',
    );
  });

  it('MUST-14.10: duplicate_charge says it may be a real second charge', () => {
    const { subject, body } = renderEvent({
      event: 'duplicate_charge',
      merchant: 'BELL CANADA',
      amountCents: -8950,
      earlierDateIso: '2026-08-12',
      laterDateIso: '2026-08-13',
    });
    expect(subject).toBe('Possible duplicate: BELL CANADA $89.50');
    expect(body).toBe(
      'BELL CANADA charged $89.50 on 2026-08-12 and again on 2026-08-13. ' +
        'It may be a real second charge, or the bank may have reported one charge twice.',
    );
  });

  it('MUST-9.27: predicted_vs_actual says the expected figures were recomputed', () => {
    const { subject, body } = renderEvent({
      event: 'predicted_vs_actual',
      month: '2026-07',
      household: [
        { name: 'Groceries', expectedCents: 62000, actualCents: 71340 },
        { name: 'Gas', expectedCents: 20000, actualCents: 18000 },
      ],
      personal: [],
      totalDeltaCents: 21000,
    });
    expect(subject).toBe('July 2026: what we expected against what happened');
    expect(body).toContain('expected $620.00');
    expect(body).toContain('actual $713.40');
    expect(body).toContain('$93.40');
    expect(body).toContain('-$20.00');
    expect(body).toContain('July 2026 came in $210.00 over what the last six months pointed at.');
    expect(body).toContain('recomputed');
  });

  it('MUST-14.10: suggested_budget_refresh says nothing has been changed', () => {
    const { subject, body } = renderEvent({
      event: 'suggested_budget_refresh',
      month: '2026-08',
      household: [
        { name: 'Groceries', nowCents: 78000, wasCents: 60000 },
        { name: 'Gas', nowCents: 12000, wasCents: null },
      ],
      personal: [],
      changedCount: 5,
    });
    expect(subject).toBe('New month: 5 suggested budgets changed');
    expect(body).toContain('now $780.00');
    expect(body).toContain('was $600.00');
    expect(body).toContain('was no limit');
    expect(body).toContain('Open Budgets to apply any of these. Nothing has been changed.');
  });

  it('MUST-9.37: every name passes through truncateText', () => {
    const long = 'M'.repeat(200);
    const { subject, body } = renderEvent({
      event: 'duplicate_charge',
      merchant: long,
      amountCents: -8950,
      earlierDateIso: '2026-08-12',
      laterDateIso: '2026-08-13',
    });
    expect(subject).not.toContain(long);
    expect(body).not.toContain(long);
  });

  it('notify MUST-10.4: no predictive body carries a URL', () => {
    const bodies = [
      renderEvent({
        event: 'budget_pace',
        scope: 'household',
        categoryName: 'Groceries',
        month: '2026-08',
        limitCents: 60000,
        spentCents: 41000,
        dayOfMonth: 12,
        projectedCents: 105900,
      }).body,
      renderEvent({
        event: 'suggested_budget_refresh',
        month: '2026-08',
        household: [{ name: 'Groceries', nowCents: 78000, wasCents: 60000 }],
        personal: [],
        changedCount: 1,
      }).body,
    ];
    for (const body of bodies) expect(body).not.toMatch(/:\/\//);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

```powershell
npx vitest run tests/lib/notify/render.test.ts
```
Expected: FAIL. TypeScript will not narrow `event: 'budget_pace'`, so the run reports the object literal is not assignable to `RenderInput`.

- [ ] **Step 7: Extend `src/lib/notify/render.ts`**

Add the two exported line interfaces beside the existing `DigestLine`:

```ts
/** One category's line in the predicted-against-actual report (spec section 9.6). */
export interface PredictedLine {
  name: string;
  expectedCents: number;
  actualCents: number;
}

/** One category's line in the suggested-budget refresh (spec section 9.7). */
export interface RefreshLine {
  name: string;
  nowCents: number;
  /** null when the category has no resolved limit for the month. */
  wasCents: number | null;
}
```

Append these six members to the `RenderInput` union:

```ts
  | {
      event: 'budget_pace';
      scope: 'household' | 'personal';
      categoryName: string;
      month: string;
      limitCents: number;
      spentCents: number;
      dayOfMonth: number;
      projectedCents: number;
    }
  | {
      event: 'unusual_transaction';
      merchant: string;
      accountName: string;
      dateIso: string;
      /** Signed, negative for a spend. */
      amountCents: number;
      baselineCents: number;
      baselineKind: 'merchant' | 'category';
      categoryName: string | null;
    }
  | {
      event: 'subscription_creep';
      merchant: string;
      dateIso: string;
      newAmountCents: number;
      baselineCents: number;
      priorCount: number;
    }
  | {
      event: 'duplicate_charge';
      merchant: string;
      /** Signed, negative for a spend. */
      amountCents: number;
      earlierDateIso: string;
      laterDateIso: string;
    }
  | {
      event: 'predicted_vs_actual';
      month: string;
      household: readonly PredictedLine[];
      personal: readonly PredictedLine[];
      totalDeltaCents: number;
    }
  | {
      event: 'suggested_budget_refresh';
      month: string;
      household: readonly RefreshLine[];
      personal: readonly RefreshLine[];
      changedCount: number;
    }
```

Add the two private line helpers immediately after `padded()`:

```ts
/**
 * MUST-9.30: the two-column padded() helper, with the category name and the two figures
 * aligned into its left column so the delta column still lines up.
 *
 * The delta goes through money(), which never prints a leading plus (MUST-9.39). A category
 * that came in under its expectation therefore reads -$20.00, and one that came in over
 * reads $93.40. Section 9.6's example line shows a plus; MUST-9.39 is the binding rule.
 */
function predictedLines(rows: readonly PredictedLine[]): string[] {
  const width = rows.reduce((max, row) => Math.max(max, truncateText(row.name, NAME_MAX).length), 0);
  return padded(
    rows.map((row) => ({
      name: `${truncateText(row.name, NAME_MAX).padEnd(width + 2)}expected ${money(row.expectedCents)}   actual ${money(row.actualCents)}`,
      cents: row.actualCents - row.expectedCents,
    })),
  );
}

/** Two aligned columns, with "no limit" where the category has never had one set. */
function refreshLines(rows: readonly RefreshLine[]): string[] {
  const width = rows.reduce((max, row) => Math.max(max, truncateText(row.name, NAME_MAX).length), 0);
  return rows.map(
    (row) =>
      `  ${truncateText(row.name, NAME_MAX).padEnd(width + 2)}now ${money(row.nowCents).padEnd(11)}` +
      `was ${row.wasCents === null ? 'no limit' : money(row.wasCents)}`,
  );
}
```

Append these six cases to `renderEvent`'s switch, before its closing brace and **without adding a `default`** (MUST-9.38):

```ts
    case 'budget_pace': {
      const category = truncateText(input.categoryName, NAME_MAX);
      const label = monthLabel(input.month);
      return {
        subject: `On pace to go over: ${category} (${label})`,
        body:
          `${scopeWord(input.scope)} ${category} budget for ${label} is ${money(input.limitCents)}. ` +
          `You have spent ${money(input.spentCents)} in ${input.dayOfMonth} days. ` +
          `At that rate the month ends near ${money(input.projectedCents)}, ` +
          `about ${money(input.projectedCents - input.limitCents)} over.`,
      };
    }
    case 'unusual_transaction': {
      const merchant = truncateText(input.merchant, NAME_MAX);
      const account = truncateText(input.accountName, NAME_MAX);
      const spend = Math.abs(input.amountCents);
      // A multiple is not an amount, so it is not money()'s business (MUST-9.39).
      const multiple = (spend / input.baselineCents).toFixed(1);
      const usual =
        input.baselineKind === 'merchant'
          ? `the ${money(input.baselineCents)} you usually spend at ${merchant}`
          : `the ${money(input.baselineCents)} that ${truncateText(input.categoryName ?? 'those', NAME_MAX)} charges usually run`;
      return {
        subject: `Unusual charge: ${merchant} ${money(spend)}`,
        body:
          `${merchant} charged ${money(spend)} on ${input.dateIso} (${account}). ` +
          `This is about ${multiple} times ${usual}.`,
      };
    }
    case 'subscription_creep': {
      const merchant = truncateText(input.merchant, NAME_MAX);
      const rise = input.newAmountCents - input.baselineCents;
      const pct = Math.round((rise * 100) / input.baselineCents);
      return {
        subject: `Price went up: ${merchant}`,
        body:
          `${merchant} charged ${money(input.newAmountCents)} on ${input.dateIso}. ` +
          `The last ${input.priorCount} charges were ${money(input.baselineCents)}. ` +
          `That is ${money(rise)} more, about ${pct} percent.`,
      };
    }
    case 'duplicate_charge': {
      const merchant = truncateText(input.merchant, NAME_MAX);
      const amount = money(Math.abs(input.amountCents));
      return {
        subject: `Possible duplicate: ${merchant} ${amount}`,
        body:
          `${merchant} charged ${amount} on ${input.earlierDateIso} and again on ${input.laterDateIso}. ` +
          'It may be a real second charge, or the bank may have reported one charge twice.',
      };
    }
    case 'predicted_vs_actual': {
      const label = monthLabel(input.month);
      const blocks: string[] = [];
      if (input.household.length > 0) blocks.push(['Household', ...predictedLines(input.household)].join('\n'));
      if (input.personal.length > 0) blocks.push(['Yours', ...predictedLines(input.personal)].join('\n'));
      blocks.push(
        `Across every category with a suggestion, ${label} came in ${money(Math.abs(input.totalDeltaCents))} ` +
          `${input.totalDeltaCents >= 0 ? 'over' : 'under'} what the last six months pointed at.`,
      );
      // MUST-9.27: nothing was stored in advance, and the message says so rather than letting
      // the reader take "predicted" for a recorded forecast.
      blocks.push('The expected figures are recomputed from the six months before that one. Nothing was recorded in advance.');
      return { subject: `${label}: what we expected against what happened`, body: blocks.join('\n\n') };
    }
    case 'suggested_budget_refresh': {
      const blocks: string[] = [];
      if (input.household.length > 0) blocks.push(['Household', ...refreshLines(input.household)].join('\n'));
      if (input.personal.length > 0) blocks.push(['Yours', ...refreshLines(input.personal)].join('\n'));
      // MUST-9.33: the message never applies anything.
      blocks.push('Open Budgets to apply any of these. Nothing has been changed.');
      return {
        subject: `New month: ${input.changedCount} suggested budget${input.changedCount === 1 ? '' : 's'} changed`,
        body: blocks.join('\n\n'),
      };
    }
```

- [ ] **Step 8: Amend `tests/app/notifications-client.test.tsx` for MUST-17.2**

Add to the `describe('MUST-11.3: the matrix is generated from the registry', ...)` block:

```ts
  it('MUST-17.2: the six v1.4.0 events render for a member with no component edit', () => {
    render(<NotificationsClient data={props({ role: 'member' })} />);
    for (const id of [
      'budget_pace',
      'unusual_transaction',
      'subscription_creep',
      'duplicate_charge',
      'predicted_vs_actual',
      'suggested_budget_refresh',
    ]) {
      expect(document.querySelector(`input[name="pref:${id}:telegram"]`)).not.toBeNull();
      expect(document.querySelector(`input[name="pref:${id}:email"]`)).not.toBeNull();
    }
  });

  it('MUST-9.3: none of the six needs admin rights', () => {
    const memberIds = eventsFor('member').map((event) => event.id);
    for (const id of [
      'budget_pace',
      'unusual_transaction',
      'subscription_creep',
      'duplicate_charge',
      'predicted_vs_actual',
      'suggested_budget_refresh',
    ]) {
      expect(memberIds).toContain(id);
    }
  });
```

`eventsFor` is already imported by that file's `props()` builder. If it is not, add `import { eventsFor } from '@/lib/notify/events';`.

- [ ] **Step 9: Run the three test files to verify they pass**

```powershell
npx vitest run tests/lib/notify/events.test.ts tests/lib/notify/render.test.ts tests/app/notifications-client.test.tsx tests/db/notification-schema.test.ts
npx tsc --noEmit
```
Expected: PASS on all four, clean typecheck. `src/app/(app)/settings/notifications/notifications-client.tsx` must be **unchanged**: `git status` should not list it.

- [ ] **Step 10: Commit**

```bash
git add src/lib/notify/events.ts src/lib/notify/render.ts tests/lib/notify/events.test.ts tests/lib/notify/render.test.ts tests/app/notifications-client.test.tsx
git commit -m "feat(notify): six predictive events, their dedup keys and their messages"
```

---

## Task 7: `src/lib/notify/evaluate/pace.ts` and the `budget_pace` call site

**Context:** Spec §9.2 and §10.1's daily-slot block. One message per scope, per category, per month, ever. It stands down entirely once spend passes the limit, because that situation belongs to `budget_exceeded` and sending both would be telling somebody their roof might leak while they stand in the rain. Implements **MUST-9.6 … MUST-9.9**, **MUST-8.7**, **MUST-10.3**, **MUST-10.8**.

**Dedup key, verbatim from MUST-9.7:** `pace:<h|p>:<categoryId>:<month>`, built by `budgetPaceKey(scope, categoryId, month)` from Task 6.

**Files:**
- Create: `src/lib/notify/evaluate/pace.ts`
- Modify: `src/lib/notify/evaluate/index.ts` (one call inside the existing daily-slot `if (daily.fires)` block)
- Test: `tests/lib/notify/evaluate/pace.test.ts` (**new**)

**Interfaces:**
- Consumes: `budgetProgress`, `type BudgetRow` from `@/lib/budgets`; `currentMonth`, `monthEnd`, `todayIso` from `@/lib/dates`; `isEventEnabled` from `@/lib/notify/config`; `CHANNELS`, `budgetPaceKey`, `type BudgetScopeKey` from `@/lib/notify/events` (Task 6); `enqueue` from `@/lib/notify/outbox`; `renderEvent` from `@/lib/notify/render` (Task 6); `PACE_MIN_DAY_OF_MONTH`, `PACE_OVERSHOOT_MIN_PCT` from `@/lib/predict/constants` (Task 1); `projectMonthEnd` from `@/lib/predict/pace` (Task 3).
- Produces:
  ```ts
  export function evaluateBudgetPace(input: { userId: number; now: Date; tz: string }): number;
  /** budgetProgress()'s tree as a flat list. Task 9's monthly.ts imports this. */
  export function flattenBudgetRows(rows: BudgetRow[], acc?: BudgetRow[]): BudgetRow[];
  ```

**Note on `flattenBudgetRows`:** `src/lib/notify/evaluate/budget.ts` has an identical private `flatten()`. Spec §2.2's file table is exhaustive and does not list `budget.ts`, so this task does **not** export it from there. `pace.ts` declares the exported copy instead, and Task 9's `monthly.ts` imports it rather than writing a third.

### Steps

- [ ] **Step 1: Write the failing test**

Create `tests/lib/notify/evaluate/pace.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../../helpers/db';
import { upsertBudget } from '@/lib/budgets';
import { saveEmailTarget, saveSmtp, setPref } from '@/lib/notify/config';
import { resetOutboxPumpForTests } from '@/lib/notify/outbox';
import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';
import { evaluateBudgetPace } from '@/lib/notify/evaluate/pace';

let t: TestDb;
let accountId: number;
let creatorId: number;
const TZ = 'UTC';
/** The 12th of a 31-day month, so the projection multiplier is 31/12. */
const NOW = new Date('2026-08-12T12:00:00Z');

beforeEach(() => {
  t = createSeededTestDb();
  accountId = insertTestAccount(t.db);
  creatorId = insertTestUser(t.db, { username: 'creator' });
  resetOutboxPumpForTests();
  setNotifySenderForTests(async () => {});
});

afterEach(() => {
  resetNotifySenderForTests();
  resetOutboxPumpForTests();
  t.cleanup();
});

function emailUser(): number {
  const userId = insertTestUser(t.db, { username: `u${Math.random().toString(36).slice(2, 8)}` });
  saveSmtp({
    preset: 'brevo',
    host: 'h',
    port: 587,
    security: 'starttls',
    username: 'u',
    password: 'p',
    fromEmail: 'f@e.com',
    fromName: 'Budget Tracker',
    enabled: true,
  });
  saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
  return userId;
}

function spend(categoryId: number, cents: number, attributedUserId: number | null = null, date = '2026-08-05'): void {
  t.db.run(
    sql`insert into transactions
          (account_id, date, amount_cents, raw_description, normalized_merchant, category_id,
           attributed_user_id, is_transfer, dedup_hash, created_by, created_at, updated_at)
        values (${accountId}, ${date}, ${-cents}, ${'MERCHANT'}, ${'merchant'}, ${categoryId},
                ${attributedUserId}, 0, ${`h${Math.random()}`}, ${creatorId}, ${'2026-08-05T00:00:00.000Z'}, ${'2026-08-05T00:00:00.000Z'})`,
  );
}

function keys(): string[] {
  return (t.sqlite.prepare('select dedup_key from notification_outbox order by id').all() as { dedup_key: string }[]).map(
    (r) => r.dedup_key,
  );
}

describe('MUST-9.6: the four trigger conditions', () => {
  it('fires at a projected 110 percent and stays silent at 105', () => {
    const userId = emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    // 31/12 of the spend is the projection. A $600 limit needs $660 projected, so $255.49 spent.
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 60000 });

    spend(groceries, 24000); // projects to 62000, which is 103 percent
    expect(evaluateBudgetPace({ userId, now: NOW, tz: TZ })).toBe(0);

    spend(groceries, 2000); // 26000 total, projects to 67167, which is 111 percent
    expect(evaluateBudgetPace({ userId, now: NOW, tz: TZ })).toBe(1);
    expect(keys()).toEqual([`pace:h:${groceries}:2026-08`]);
  });

  it('does not fire before the seventh', () => {
    const userId = emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 60000 });
    spend(groceries, 50000, null, '2026-08-01');
    expect(evaluateBudgetPace({ userId, now: new Date('2026-08-06T12:00:00Z'), tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });

  it('MUST-9.6 condition 3: stands down once the budget is already blown', () => {
    const userId = emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 60000 });
    spend(groceries, 70000);
    expect(evaluateBudgetPace({ userId, now: NOW, tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });

  it('MUST-9.6 condition 2: a zero limit is budget_exceeded business, not a projection', () => {
    const userId = emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 0 });
    spend(groceries, 100);
    expect(evaluateBudgetPace({ userId, now: NOW, tz: TZ })).toBe(0);
  });

  it('does not fire for a category with no limit at all', () => {
    const userId = emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    spend(groceries, 90000);
    expect(evaluateBudgetPace({ userId, now: NOW, tz: TZ })).toBe(0);
  });
});

describe('MUST-9.8: once per scope, per category, per month, ever', () => {
  it('stays silent across ten consecutive daily evaluations after the first', () => {
    const userId = emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 60000 });
    spend(groceries, 26000);

    expect(evaluateBudgetPace({ userId, now: NOW, tz: TZ })).toBe(1);
    for (let day = 13; day <= 22; day += 1) {
      const at = new Date(`2026-08-${day}T12:00:00Z`);
      expect(evaluateBudgetPace({ userId, now: at, tz: TZ })).toBe(0);
    }
    expect(keys()).toEqual([`pace:h:${groceries}:2026-08`]);
  });
});

describe('MUST-9.35: household rows reach every enabled user, personal rows only their owner', () => {
  it('keys household and personal separately and delivers each to the right person', () => {
    const sam = emailUser();
    const alex = emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 60000 });
    // Above the $260 spent so far, so MUST-9.6 condition 3 does not stand the personal row
    // down; the 31/12 projection of $671.67 still clears 110 percent of $300.
    upsertBudget({ scope: 'personal', userId: sam, categoryId: groceries, month: '2026-08', amountCents: 30000 });
    spend(groceries, 26000, sam);

    expect(evaluateBudgetPace({ userId: sam, now: NOW, tz: TZ })).toBe(2);
    expect(evaluateBudgetPace({ userId: alex, now: NOW, tz: TZ })).toBe(1);

    const rows = t.sqlite.prepare('select user_id, dedup_key from notification_outbox order by id').all() as {
      user_id: number;
      dedup_key: string;
    }[];
    expect(rows.filter((row) => row.dedup_key === `pace:p:${groceries}:2026-08`).map((row) => row.user_id)).toEqual([sam]);
    expect(rows.filter((row) => row.dedup_key === `pace:h:${groceries}:2026-08`).map((row) => row.user_id).sort()).toEqual(
      [sam, alex].sort(),
    );
  });
});

describe('notify MUST-4.2: a user with the event switched off hears nothing', () => {
  it('enqueues no row when every channel is off for budget_pace', () => {
    const userId = emailUser();
    setPref(userId, 'budget_pace', 'email', false);
    setPref(userId, 'budget_pace', 'telegram', false);
    const groceries = categoryIdByName(t.db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 60000 });
    spend(groceries, 26000);
    expect(evaluateBudgetPace({ userId, now: NOW, tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
npx vitest run tests/lib/notify/evaluate/pace.test.ts
```
Expected: FAIL with `Failed to resolve import "@/lib/notify/evaluate/pace"`.

- [ ] **Step 3: Write `src/lib/notify/evaluate/pace.ts`**

```ts
import { budgetProgress, type BudgetRow } from '@/lib/budgets';
import { currentMonth, monthEnd, todayIso } from '@/lib/dates';
import { isEventEnabled } from '@/lib/notify/config';
import { CHANNELS, budgetPaceKey, type BudgetScopeKey } from '@/lib/notify/events';
import { enqueue } from '@/lib/notify/outbox';
import { renderEvent } from '@/lib/notify/render';
import { PACE_MIN_DAY_OF_MONTH, PACE_OVERSHOOT_MIN_PCT } from '@/lib/predict/constants';
import { projectMonthEnd } from '@/lib/predict/pace';

/**
 * MUST-10.8: no fingerprint. This runs at most once per user per day by construction, and its
 * dedup key makes a second run inside the catch-up window a no-op.
 *
 * budget.ts has an identical private flatten(). Spec section 2.2's file table is exhaustive
 * and does not list budget.ts, so the shared copy lives here and monthly.ts imports it.
 */
export function flattenBudgetRows(rows: BudgetRow[], acc: BudgetRow[] = []): BudgetRow[] {
  for (const row of rows) {
    acc.push(row);
    if (row.children.length > 0) flattenBudgetRows(row.children, acc);
  }
  return acc;
}

function fireFor(input: {
  userId: number;
  scope: BudgetScopeKey;
  row: BudgetRow;
  month: string;
  dayOfMonth: number;
  daysInMonth: number;
  now: Date;
}): number {
  const { row } = input;
  // Condition 2: a zero limit is budget_exceeded's business, not a projection's.
  if (row.limitCents === null || row.limitCents <= 0) return 0;
  // Condition 3: a budget already blown is budget_exceeded's message. The two are mutually
  // exclusive by construction, not by ordering.
  if (row.spentCents > row.limitCents) return 0;

  // MUST-8.7: spentCents is the number already on the progress bar, not a re-query.
  const projected = projectMonthEnd({
    spentCents: row.spentCents,
    dayOfMonth: input.dayOfMonth,
    daysInMonth: input.daysInMonth,
  });
  if (projected === null) return 0;
  // Condition 4: a projected 3 percent overshoot on the 7th is noise; 10 percent is a number
  // worth acting on. Integer comparison, no float ratio (MUST-3.5).
  if (projected * 100 < row.limitCents * PACE_OVERSHOOT_MIN_PCT) return 0;

  const { subject, body } = renderEvent({
    event: 'budget_pace',
    scope: input.scope,
    categoryName: row.categoryName,
    month: input.month,
    limitCents: row.limitCents,
    spentCents: row.spentCents,
    dayOfMonth: input.dayOfMonth,
    projectedCents: projected,
  });
  const result = enqueue({
    userId: input.userId,
    eventId: 'budget_pace',
    dedupKey: budgetPaceKey(input.scope, row.categoryId, input.month),
    subject,
    body,
    at: input.now,
  });
  return result.inserted.length > 0 ? 1 : 0;
}

/**
 * MUST-9.6: the user's daily slot, the CURRENT MONTH only, over the same two scopes
 * evaluateBudgets() walks. Household rows are delivered to every user with the event enabled
 * (this function is called once per user, so that happens across calls); personal rows are
 * evaluated per user and delivered only to that user.
 */
export function evaluateBudgetPace(input: { userId: number; now: Date; tz: string }): number {
  if (!CHANNELS.some((channel) => isEventEnabled(input.userId, 'budget_pace', channel))) return 0;

  const today = todayIso(input.now, input.tz);
  const dayOfMonth = Number(today.slice(8, 10));
  // MUST-9.6 condition 1, checked before any query.
  if (dayOfMonth < PACE_MIN_DAY_OF_MONTH) return 0;

  const month = currentMonth(input.now, input.tz);
  // MUST-8.2: from monthEnd, so February is 29 days in 2028 without a leap-year rule here.
  const daysInMonth = Number(monthEnd(month).slice(8, 10));

  let fired = 0;
  const scopes: { scope: BudgetScopeKey; rows: BudgetRow[] }[] = [
    { scope: 'household', rows: flattenBudgetRows(budgetProgress(month, 'household', null)) },
    { scope: 'personal', rows: flattenBudgetRows(budgetProgress(month, 'personal', input.userId)) },
  ];
  for (const { scope, rows } of scopes) {
    for (const row of rows) {
      fired += fireFor({ userId: input.userId, scope, row, month, dayOfMonth, daysInMonth, now: input.now });
    }
  }
  return fired;
}
```

- [ ] **Step 4: Add the call site in `src/lib/notify/evaluate/index.ts`**

Add the import beside the existing evaluator imports:

```ts
import { evaluateBudgetPace } from '@/lib/notify/evaluate/pace';
```

Inside the existing `if (daily.fires) {` block, after `evaluateStaleImport(...)`:

```ts
        evaluateBudgetPace({ userId: user.id, now, tz });
```

The surrounding `try`/`catch` and the `logSlotSkipOnce` else-branch are untouched: MUST-10.3's rule is already satisfied by the existing per-user try block, which logs one line and moves on.

- [ ] **Step 5: Run the tests to verify they pass**

```powershell
npx vitest run tests/lib/notify/evaluate/pace.test.ts tests/lib/notify/evaluate/index.test.ts tests/lib/scheduler.test.ts
npx tsc --noEmit
```
Expected: PASS on all three. `tests/lib/scheduler.test.ts` must be **unamended** and its dormancy assertion still green (MUST-10.2).

- [ ] **Step 6: Commit**

```bash
git add src/lib/notify/evaluate/pace.ts src/lib/notify/evaluate/index.ts tests/lib/notify/evaluate/pace.test.ts
git commit -m "feat(notify): budget_pace on the daily slot, once per category per month"
```

---

## Task 8: `src/lib/notify/evaluate/anomalies.ts` and its two call sites

**Context:** Spec §9.3, §9.4, §9.5 and §10.2. Two tick-cadence detectors share one fingerprint because they read the same slice, and a third runs on the daily slot because a price increase is not urgent enough to warrant a per-tick scan. Three independent guards keep a household's first import of a year of history from producing dozens of alerts: the 60-day history floor, the short transaction windows, and the five-per-evaluation cap. Implements **MUST-9.10 … MUST-9.25**, **MUST-9.36**, **MUST-10.4 … MUST-10.7**, **MUST-10.9**, **MUST-10.10**, and **AC8**.

**Dedup keys, verbatim from the spec:**
- `unusual_transaction` (MUST-9.12): `unusual:<transactionId>`, via `unusualTransactionKey(id)`.
- `subscription_creep` (MUST-9.17): `creep:<transactionId>` where the id is the **increased charge**, via `subscriptionCreepKey(id)`.
- `duplicate_charge` (MUST-9.22): `dupe:<lowerId>:<higherId>` with the two ids sorted ascending, via `duplicateChargeKey(a, b)`.

**Fingerprint width:** MUST-10.4 names "the 14-day slice both anomaly detectors read". The duplicate detector needs `DUPLICATE_LOOKBACK_DAYS + DUPLICATE_WINDOW_DAYS` (17) days, so that a pair whose later half sits on the 14-day boundary still has its earlier half. The fingerprint is taken over the wider slice, which is a superset of the 14-day one and is therefore strictly safer: it also changes when the earlier half of such a pair is edited.

**Files:**
- Create: `src/lib/notify/evaluate/anomalies.ts`
- Modify: `src/lib/notify/evaluate/index.ts` (one call in the daily-slot block, one `try`/`catch` block beside the existing `evaluateBudgets` call)
- Test: `tests/lib/notify/evaluate/anomalies.test.ts` (**new**)

**Interfaces:**
- Consumes: `getDb` from `@/db/client`; `accounts`, `transactions` from `@/db/schema`; `listCategories` from `@/lib/categories`; `addDaysIso`, `todayIso` from `@/lib/dates`; `isEventEnabled`, `notifiableUsers` from `@/lib/notify/config`; `CHANNELS`, `duplicateChargeKey`, `subscriptionCreepKey`, `unusualTransactionKey` from `@/lib/notify/events` (Task 6); `enqueue` from `@/lib/notify/outbox`; `renderEvent` from `@/lib/notify/render` (Task 6); the constants block from `@/lib/predict/constants` (Task 1); `creepVerdict`, `findDuplicates`, `hasEnoughHouseholdHistory`, `unusualVerdict`, `type SpendRow` from `@/lib/predict/anomalies` (Task 4); `and`, `asc`, `eq`, `gte`, `inArray`, `lt`, `ne`, `or`, `sql` from `drizzle-orm`.
- Produces:
  ```ts
  export function evaluateAnomalies(input: { now: Date; tz: string }): number;
  export function evaluateSubscriptionCreep(input: { userId: number; now: Date; tz: string }): number;
  export function resetAnomalyFingerprintForTests(): void;
  ```

### Steps

- [ ] **Step 1: Write the failing test**

Create `tests/lib/notify/evaluate/anomalies.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../../helpers/db';
import { saveEmailTarget, saveSmtp, setPref } from '@/lib/notify/config';
import { resetOutboxPumpForTests } from '@/lib/notify/outbox';
import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';
import { evaluateAnomalies, evaluateSubscriptionCreep, resetAnomalyFingerprintForTests } from '@/lib/notify/evaluate/anomalies';

let t: TestDb;
let accountId: number;
let creatorId: number;
const TZ = 'UTC';
const NOW = new Date('2026-08-18T12:00:00Z');

beforeEach(() => {
  t = createSeededTestDb();
  accountId = insertTestAccount(t.db, { name: 'Joint Chequing' });
  creatorId = insertTestUser(t.db, { username: 'creator' });
  resetOutboxPumpForTests();
  resetAnomalyFingerprintForTests();
  setNotifySenderForTests(async () => {});
});

afterEach(() => {
  resetNotifySenderForTests();
  resetOutboxPumpForTests();
  resetAnomalyFingerprintForTests();
  t.cleanup();
});

function emailUser(): number {
  const userId = insertTestUser(t.db, { username: `u${Math.random().toString(36).slice(2, 8)}` });
  saveSmtp({
    preset: 'brevo',
    host: 'h',
    port: 587,
    security: 'starttls',
    username: 'u',
    password: 'p',
    fromEmail: 'f@e.com',
    fromName: 'Budget Tracker',
    enabled: true,
  });
  saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
  return userId;
}

function charge(over: { merchant: string; cents: number; date: string; categoryId?: number | null }): number {
  const row = t.db.get<{ id: number }>(
    sql`insert into transactions
          (account_id, date, amount_cents, raw_description, normalized_merchant, category_id,
           attributed_user_id, is_transfer, dedup_hash, created_by, created_at, updated_at)
        values (${accountId}, ${over.date}, ${-over.cents}, ${over.merchant}, ${over.merchant}, ${over.categoryId ?? null},
                null, 0, ${`h${Math.random()}`}, ${creatorId}, ${'2026-08-01T00:00:00.000Z'}, ${'2026-08-01T00:00:00.000Z'})
        returning id`,
  );
  return row.id;
}

function keys(): string[] {
  return (t.sqlite.prepare('select dedup_key from notification_outbox order by id').all() as { dedup_key: string }[]).map(
    (r) => r.dedup_key,
  );
}

/** 60+ days of household history, so MUST-9.10 condition 1 is satisfied. */
function seedHistory(): void {
  charge({ merchant: 'ANCHOR', cents: 100, date: '2026-01-01' });
}

/**
 * `count` same-merchant samples at $120, all outside the 14-day candidate window.
 *
 * The count matters: unusualVerdict takes the median of the OTHER rows for that merchant, so a
 * test that plants many outliers needs enough $120 rows to keep that median at $120.
 */
function seedMerchantBaseline(merchant: string, categoryId: number, count = 5): void {
  for (let index = 0; index < count; index += 1) {
    const day = String((index % 28) + 1).padStart(2, '0');
    const month = String((index % 5) + 2).padStart(2, '0');
    charge({ merchant, cents: 12000, date: `2026-${month}-${day}`, categoryId });
  }
}

describe('MUST-9.10: unusual_transaction end to end', () => {
  it('fires once for a charge three times the merchant baseline', () => {
    const userId = emailUser();
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('CANADIAN TIRE', groceries);
    const outlier = charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: '2026-08-14', categoryId: groceries });

    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(1);
    expect(keys()).toEqual([`unusual:${outlier}`]);
  });

  it('R2: nothing fires at all on a household with under 60 days of history', () => {
    const userId = emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    for (const date of ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05']) {
      charge({ merchant: 'CANADIAN TIRE', cents: 12000, date, categoryId: groceries });
    }
    charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: '2026-08-14', categoryId: groceries });
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });

  it('MUST-9.13: the cap holds at five with twelve candidates, oldest first', () => {
    const userId = emailUser();
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    // Twenty baseline rows against twelve outliers keeps the merchant median at $120.
    seedMerchantBaseline('BIG SHOP', groceries, 20);
    const ids: number[] = [];
    for (let day = 6; day <= 17; day += 1) {
      // Amounts differ by a cent each so the duplicate detector, which needs the EXACT same
      // amount, stays out of this test's count.
      ids.push(
        charge({ merchant: 'BIG SHOP', cents: 90000 + day, date: `2026-08-${String(day).padStart(2, '0')}`, categoryId: groceries }),
      );
    }
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(5);
    expect(keys()).toEqual(ids.slice(0, 5).map((id) => `unusual:${id}`));
  });

  it('MUST-9.36: the same charge reaches every user with the event enabled', () => {
    const sam = emailUser();
    const alex = emailUser();
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('CANADIAN TIRE', groceries);
    const outlier = charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: '2026-08-14', categoryId: groceries });

    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(2);
    const rows = t.sqlite.prepare('select user_id from notification_outbox where dedup_key = ?').all(`unusual:${outlier}`) as {
      user_id: number;
    }[];
    expect(rows.map((row) => row.user_id).sort()).toEqual([sam, alex].sort());
  });
});

describe('MUST-10.4 to MUST-10.6: the tick fingerprint', () => {
  it('short-circuits a second evaluation with no data change', () => {
    const userId = emailUser();
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('CANADIAN TIRE', groceries);
    charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: '2026-08-14', categoryId: groceries });

    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(1);
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(0);
    expect(keys()).toHaveLength(1);
  });

  it('MUST-10.5: re-categorising an existing row changes the fingerprint', () => {
    const userId = emailUser();
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('CANADIAN TIRE', groceries);
    const outlier = charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: '2026-08-14', categoryId: groceries });
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(1);

    t.db.run(sql`update transactions set updated_at = '2026-08-18T13:00:00.000Z' where id = ${outlier}`);
    // The key changed, so the pass runs again; enqueue() is idempotent, so nothing new lands.
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(0);
    expect(keys()).toHaveLength(1);
  });

  it('MUST-10.10 and AC8: zero participants means zero work and no burned fingerprint', () => {
    const userId = emailUser();
    setPref(userId, 'unusual_transaction', 'email', false);
    setPref(userId, 'unusual_transaction', 'telegram', false);
    setPref(userId, 'duplicate_charge', 'email', false);
    setPref(userId, 'duplicate_charge', 'telegram', false);
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('CANADIAN TIRE', groceries);
    charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: '2026-08-14', categoryId: groceries });

    for (let tick = 0; tick < 12; tick += 1) expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });
});

describe('MUST-9.20 to MUST-9.24: duplicate_charge end to end', () => {
  it('fires once per pair and says the wording MUST-14.10 requires', () => {
    const userId = emailUser();
    seedHistory();
    const first = charge({ merchant: 'BELL CANADA', cents: 8950, date: '2026-08-12' });
    const second = charge({ merchant: 'BELL CANADA', cents: 8950, date: '2026-08-13' });

    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(1);
    expect(keys()).toEqual([`dupe:${first}:${second}`]);
    const body = (t.sqlite.prepare('select body from notification_outbox limit 1').get() as { body: string }).body;
    expect(body).toContain('It may be a real second charge, or the bank may have reported one charge twice.');
  });
});

describe('MUST-9.15 to MUST-9.19: subscription_creep on the daily slot', () => {
  it('fires once for a monthly subscription whose price went up', () => {
    const userId = emailUser();
    seedHistory();
    charge({ merchant: 'NETFLIX', cents: 1649, date: '2026-05-14' });
    charge({ merchant: 'NETFLIX', cents: 1649, date: '2026-06-14' });
    charge({ merchant: 'NETFLIX', cents: 1649, date: '2026-07-14' });
    const risen = charge({ merchant: 'NETFLIX', cents: 2099, date: '2026-08-14' });

    expect(evaluateSubscriptionCreep({ userId, now: NOW, tz: TZ })).toBe(1);
    expect(keys()).toEqual([`creep:${risen}`]);
    expect(evaluateSubscriptionCreep({ userId, now: NOW, tz: TZ })).toBe(0);
  });

  it('is silent for a merchant with no recurring rhythm', () => {
    const userId = emailUser();
    seedHistory();
    charge({ merchant: 'CAFE', cents: 500, date: '2026-08-11' });
    charge({ merchant: 'CAFE', cents: 500, date: '2026-08-12' });
    charge({ merchant: 'CAFE', cents: 500, date: '2026-08-13' });
    charge({ merchant: 'CAFE', cents: 900, date: '2026-08-14' });
    expect(evaluateSubscriptionCreep({ userId, now: NOW, tz: TZ })).toBe(0);
  });

  it('is silent for a user with the event switched off', () => {
    const userId = emailUser();
    setPref(userId, 'subscription_creep', 'email', false);
    setPref(userId, 'subscription_creep', 'telegram', false);
    seedHistory();
    charge({ merchant: 'NETFLIX', cents: 1649, date: '2026-05-14' });
    charge({ merchant: 'NETFLIX', cents: 1649, date: '2026-06-14' });
    charge({ merchant: 'NETFLIX', cents: 1649, date: '2026-07-14' });
    charge({ merchant: 'NETFLIX', cents: 2099, date: '2026-08-14' });
    expect(evaluateSubscriptionCreep({ userId, now: NOW, tz: TZ })).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
npx vitest run tests/lib/notify/evaluate/anomalies.test.ts
```
Expected: FAIL with `Failed to resolve import "@/lib/notify/evaluate/anomalies"`.

- [ ] **Step 3: Write `src/lib/notify/evaluate/anomalies.ts`**

```ts
import { and, asc, eq, gte, inArray, lt, ne, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { accounts, transactions } from '@/db/schema';
import { listCategories } from '@/lib/categories';
import { addDaysIso, todayIso } from '@/lib/dates';
import { isEventEnabled, notifiableUsers } from '@/lib/notify/config';
import { CHANNELS, duplicateChargeKey, subscriptionCreepKey, unusualTransactionKey } from '@/lib/notify/events';
import { enqueue } from '@/lib/notify/outbox';
import { renderEvent } from '@/lib/notify/render';
import { creepVerdict, findDuplicates, hasEnoughHouseholdHistory, unusualVerdict, type SpendRow } from '@/lib/predict/anomalies';
import {
  CREEP_BASELINE_DAYS,
  CREEP_LOOKBACK_DAYS,
  CREEP_MAX_PER_EVALUATION,
  DUPLICATE_LOOKBACK_DAYS,
  DUPLICATE_MAX_PER_EVALUATION,
  DUPLICATE_WINDOW_DAYS,
  UNUSUAL_BASELINE_DAYS,
  UNUSUAL_LOOKBACK_DAYS,
  UNUSUAL_MAX_PER_EVALUATION,
} from '@/lib/predict/constants';

/**
 * MUST-10.4: evaluateAnomalies runs on EVERY tick, so it needs the same guard evaluateBudgets
 * uses. A restart clears this cache and costs exactly one extra evaluation, which is dedup
 * safe because enqueue() is itself idempotent.
 */
let lastAnomalyKey: string | null = null;

/** MUST-10.7: called from the shared test reset helper, beside resetBudgetFingerprintForTests. */
export function resetAnomalyFingerprintForTests(): void {
  lastAnomalyKey = null;
}

interface AnomalyParticipant {
  userId: number;
  unusual: boolean;
  duplicate: boolean;
}

interface SliceRow extends SpendRow {
  accountName: string;
}

/**
 * MUST-10.10: a household with no user having either tick event enabled skips the fingerprint
 * query entirely. Zero enabled participants means zero queries.
 */
function participants(): AnomalyParticipant[] {
  const out: AnomalyParticipant[] = [];
  for (const user of notifiableUsers()) {
    const unusual = CHANNELS.some((channel) => isEventEnabled(user.id, 'unusual_transaction', channel));
    const duplicate = CHANNELS.some((channel) => isEventEnabled(user.id, 'duplicate_charge', channel));
    if (!unusual && !duplicate) continue;
    out.push({ userId: user.id, unusual, duplicate });
  }
  return out;
}

/**
 * MUST-10.4: one indexed count over the slice both tick detectors read, concatenated with the
 * participant list. MUST-10.5: max(updated_at) is in it so that re-categorising an existing
 * transaction, which changes neither the count nor the max id, still triggers a re-evaluation.
 * That matters because the unusual category baseline depends on category_id.
 */
function fingerprint(sliceStart: string, people: AnomalyParticipant[]): string {
  const row = getDb()
    .select({
      n: sql<number>`count(*)`,
      maxId: sql<number>`coalesce(max(${transactions.id}), 0)`,
      maxUpdated: sql<string>`coalesce(max(${transactions.updatedAt}), '')`,
    })
    .from(transactions)
    .where(gte(transactions.date, sliceStart))
    .get();

  const roster = people
    .slice()
    .sort((a, b) => a.userId - b.userId)
    .map((person) => `${person.userId}:${person.unusual ? 1 : 0}${person.duplicate ? 1 : 0}`)
    .join(',');
  return `${sliceStart}|${row?.n ?? 0}|${row?.maxId ?? 0}|${row?.maxUpdated ?? ''}|${roster}`;
}

/** MUST-9.10 condition 1's input: the oldest non-transfer row in the household. */
function earliestTransactionDate(): string | null {
  const row = getDb()
    .select({ first: sql<string | null>`min(${transactions.date})` })
    .from(transactions)
    .where(eq(transactions.isTransfer, false))
    .get();
  return row?.first ?? null;
}

/** The one slice read (MUST-10.9), oldest first so MUST-9.13's cap takes the oldest five. */
function readSlice(sliceStart: string): SliceRow[] {
  return getDb()
    .select({
      id: transactions.id,
      date: transactions.date,
      merchant: transactions.normalizedMerchant,
      categoryId: transactions.categoryId,
      amountCents: transactions.amountCents,
      accountName: accounts.name,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(and(gte(transactions.date, sliceStart), eq(transactions.isTransfer, false), lt(transactions.amountCents, 0)))
    .orderBy(asc(transactions.date), asc(transactions.id))
    .all();
}

/**
 * One baseline aggregate per candidate (MUST-10.9). MUST-9.11: the tested row is excluded in
 * the WHERE, because including it pulls the median toward the outlier.
 */
function baselineSamples(candidate: SliceRow, yearStart: string): { merchantSample: number[]; categorySample: number[] } {
  const match =
    candidate.categoryId === null
      ? eq(transactions.normalizedMerchant, candidate.merchant)
      : or(eq(transactions.normalizedMerchant, candidate.merchant), eq(transactions.categoryId, candidate.categoryId));

  const rows = getDb()
    .select({
      merchant: transactions.normalizedMerchant,
      categoryId: transactions.categoryId,
      magnitude: sql<number>`abs(${transactions.amountCents})`,
    })
    .from(transactions)
    .where(
      and(
        gte(transactions.date, yearStart),
        eq(transactions.isTransfer, false),
        lt(transactions.amountCents, 0),
        ne(transactions.id, candidate.id),
        match,
      ),
    )
    .all();

  const merchantSample: number[] = [];
  const categorySample: number[] = [];
  for (const row of rows) {
    if (row.merchant === candidate.merchant) merchantSample.push(row.magnitude);
    if (candidate.categoryId !== null && row.categoryId === candidate.categoryId) categorySample.push(row.magnitude);
  }
  return { merchantSample, categorySample };
}

interface UnusualFinding {
  row: SliceRow;
  baselineCents: number;
  baselineKind: 'merchant' | 'category';
}

function findUnusual(slice: SliceRow[], today: string): UnusualFinding[] {
  const lookbackStart = addDaysIso(today, -UNUSUAL_LOOKBACK_DAYS);
  const yearStart = addDaysIso(today, -UNUSUAL_BASELINE_DAYS);
  const findings: UnusualFinding[] = [];
  for (const row of slice) {
    // MUST-9.13: oldest first, and stop querying once the cap is met. The remainder are simply
    // not enqueued; this is a deliberate cap on noise, not a queue.
    if (findings.length >= UNUSUAL_MAX_PER_EVALUATION) break;
    if (row.date < lookbackStart) continue;
    const { merchantSample, categorySample } = baselineSamples(row, yearStart);
    const verdict = unusualVerdict({ amountCents: row.amountCents, merchantSample, categorySample });
    if (verdict === null) continue;
    findings.push({ row, baselineCents: verdict.baselineCents, baselineKind: verdict.baselineKind });
  }
  return findings;
}

/**
 * MUST-9.36: unusual_transaction and duplicate_charge are household-wide. The same transaction
 * is reported to every user with the event enabled, with no attribution filter, because a
 * large charge is a household fact and filtering it by attributed_user_id would hide exactly
 * the charges nobody has claimed yet.
 */
export function evaluateAnomalies(input: { now: Date; tz: string }): number {
  const people = participants();
  if (people.length === 0) {
    lastAnomalyKey = null;
    return 0;
  }

  const today = todayIso(input.now, input.tz);
  // Wider than the 14-day unusual window so a duplicate pair straddling the boundary keeps its
  // earlier half. A superset is strictly safer for the fingerprint.
  const sliceStart = addDaysIso(today, -(DUPLICATE_LOOKBACK_DAYS + DUPLICATE_WINDOW_DAYS));

  const key = fingerprint(sliceStart, people);
  if (key === lastAnomalyKey) return 0;

  if (!hasEnoughHouseholdHistory(earliestTransactionDate(), today)) {
    lastAnomalyKey = key;
    return 0;
  }

  const slice = readSlice(sliceStart);
  const categoryNames = new Map(listCategories({ includeArchived: true }).map((category) => [category.id, category.name]));
  const unusual = findUnusual(slice, today);
  const duplicates = findDuplicates({ rows: slice, today }).slice(0, DUPLICATE_MAX_PER_EVALUATION);

  let fired = 0;
  for (const person of people) {
    if (person.unusual) {
      for (const finding of unusual) {
        const { subject, body } = renderEvent({
          event: 'unusual_transaction',
          merchant: finding.row.merchant,
          accountName: finding.row.accountName,
          dateIso: finding.row.date,
          amountCents: finding.row.amountCents,
          baselineCents: finding.baselineCents,
          baselineKind: finding.baselineKind,
          categoryName: finding.row.categoryId === null ? null : (categoryNames.get(finding.row.categoryId) ?? null),
        });
        const result = enqueue({
          userId: person.userId,
          eventId: 'unusual_transaction',
          dedupKey: unusualTransactionKey(finding.row.id),
          subject,
          body,
          at: input.now,
        });
        if (result.inserted.length > 0) fired += 1;
      }
    }
    if (person.duplicate) {
      for (const pair of duplicates) {
        const { subject, body } = renderEvent({
          event: 'duplicate_charge',
          merchant: pair.merchant,
          amountCents: pair.amountCents,
          earlierDateIso: pair.earlierDateIso,
          laterDateIso: pair.laterDateIso,
        });
        const result = enqueue({
          userId: person.userId,
          eventId: 'duplicate_charge',
          dedupKey: duplicateChargeKey(pair.lowerId, pair.higherId),
          subject,
          body,
          at: input.now,
        });
        if (result.inserted.length > 0) fired += 1;
      }
    }
  }

  // MUST-10.6: recorded only after every participant has been processed without throwing.
  // Recording it first would let one participant's transient error burn the fingerprint for
  // the whole household.
  lastAnomalyKey = key;
  return fired;
}

/**
 * MUST-9.18: the user's daily slot. A price increase is not urgent enough to warrant a
 * per-tick scan, and 35 days of lookback means a container that was off for a week loses
 * nothing, so this needs no fingerprint (MUST-10.8).
 */
export function evaluateSubscriptionCreep(input: { userId: number; now: Date; tz: string }): number {
  if (!CHANNELS.some((channel) => isEventEnabled(input.userId, 'subscription_creep', channel))) return 0;

  const today = todayIso(input.now, input.tz);
  const recentStart = addDaysIso(today, -CREEP_LOOKBACK_DAYS);
  const yearStart = addDaysIso(today, -CREEP_BASELINE_DAYS);

  // Only merchants with a charge inside the lookback can possibly fire, so the year-long read
  // below is bounded by that list rather than by the whole table.
  const recentMerchants = getDb()
    .selectDistinct({ merchant: transactions.normalizedMerchant })
    .from(transactions)
    .where(and(gte(transactions.date, recentStart), eq(transactions.isTransfer, false), lt(transactions.amountCents, 0)))
    .all()
    .map((row) => row.merchant);
  if (recentMerchants.length === 0) return 0;

  const rows = getDb()
    .select({
      id: transactions.id,
      date: transactions.date,
      merchant: transactions.normalizedMerchant,
      categoryId: transactions.categoryId,
      amountCents: transactions.amountCents,
    })
    .from(transactions)
    .where(
      and(
        gte(transactions.date, yearStart),
        eq(transactions.isTransfer, false),
        lt(transactions.amountCents, 0),
        inArray(transactions.normalizedMerchant, recentMerchants),
      ),
    )
    .orderBy(asc(transactions.normalizedMerchant), asc(transactions.date), asc(transactions.id))
    .all();

  const byMerchant = new Map<string, SpendRow[]>();
  for (const row of rows) {
    const group = byMerchant.get(row.merchant) ?? [];
    group.push(row);
    byMerchant.set(row.merchant, group);
  }

  const findings: { merchant: string; verdict: NonNullable<ReturnType<typeof creepVerdict>> }[] = [];
  for (const [merchant, charges] of byMerchant) {
    const verdict = creepVerdict({ charges, today });
    if (verdict === null) continue;
    findings.push({ merchant, verdict });
  }
  findings.sort((a, b) => (a.verdict.dateIso === b.verdict.dateIso
    ? a.verdict.transactionId - b.verdict.transactionId
    : a.verdict.dateIso < b.verdict.dateIso ? -1 : 1));

  let fired = 0;
  for (const finding of findings.slice(0, CREEP_MAX_PER_EVALUATION)) {
    const { subject, body } = renderEvent({
      event: 'subscription_creep',
      merchant: finding.merchant,
      dateIso: finding.verdict.dateIso,
      newAmountCents: finding.verdict.newAmountCents,
      baselineCents: finding.verdict.baselineCents,
      priorCount: finding.verdict.priorCount,
    });
    const result = enqueue({
      userId: input.userId,
      eventId: 'subscription_creep',
      dedupKey: subscriptionCreepKey(finding.verdict.transactionId),
      subject,
      body,
      at: input.now,
    });
    if (result.inserted.length > 0) fired += 1;
  }
  return fired;
}
```

- [ ] **Step 4: Add the two call sites in `src/lib/notify/evaluate/index.ts`**

Add the import:

```ts
import { evaluateAnomalies, evaluateSubscriptionCreep } from '@/lib/notify/evaluate/anomalies';
```

Inside the existing `if (daily.fires) {` block, after `evaluateBudgetPace(...)` from Task 7:

```ts
        evaluateSubscriptionCreep({ userId: user.id, now, tz });
```

And beside the existing `evaluateBudgets` call at the end of `runScheduledEvaluation`, as its own `try`/`catch` so one failing detector cannot stop the other (MUST-10.3):

```ts
  try {
    evaluateAnomalies({ now, tz });
  } catch (error) {
    console.error('[notify] anomaly evaluation failed', error);
  }
```

- [ ] **Step 5: Reset the new fingerprint wherever the budget one is already reset (MUST-10.7)**

Two existing suites drive `runScheduledEvaluation`, which now reaches `evaluateAnomalies`, and both already call `resetBudgetFingerprintForTests()` in `beforeEach` and `afterEach`. Add the new reset beside each existing call:

- `tests/lib/notify/dedup.test.ts`
- `tests/lib/notify/evaluate/index.test.ts`

```ts
import { resetAnomalyFingerprintForTests } from '@/lib/notify/evaluate/anomalies';
```

```ts
  resetBudgetFingerprintForTests();
  resetAnomalyFingerprintForTests();
```

A module-level fingerprint that survives between test files in the same fork is the classic source of a suite that passes alone and fails in a full run.

- [ ] **Step 6: Run the tests to verify they pass**

```powershell
npx vitest run tests/lib/notify/evaluate/anomalies.test.ts tests/lib/notify/evaluate/index.test.ts tests/lib/notify/evaluate/budget.test.ts tests/lib/notify/dedup.test.ts tests/lib/scheduler.test.ts
npx tsc --noEmit
```
Expected: PASS on all five, clean typecheck.

- [ ] **Step 7: Commit**

```bash
git add src/lib/notify/evaluate/anomalies.ts src/lib/notify/evaluate/index.ts tests/lib/notify/evaluate/anomalies.test.ts tests/lib/notify/evaluate/index.test.ts tests/lib/notify/dedup.test.ts
git commit -m "feat(notify): unusual charges and duplicates on the tick, creep on the daily slot"
```

---

## Task 9: `src/lib/notify/evaluate/monthly.ts` and the two month-boundary events

**Context:** Spec §9.6 and §9.7. Both fire on day 1, 2 or 3 so a container switched off on the 1st still delivers, both fire once per month ever, and both render **both** scopes into one message per user, which is why their keys carry only the month. `predicted_vs_actual` compares against a prediction that was never recorded (spec D3): "predicted" is recomputed at report time as the suggestion the app would have produced for that month, and the message says so. `suggested_budget_refresh` **never applies anything** (MUST-9.33). Implements **MUST-9.26 … MUST-9.35**.

**Dedup keys, verbatim from the spec:**
- `predicted_vs_actual` (MUST-9.28): `predvs:<M>` where M is the reported month, via `predictedVsActualKey(month)`.
- `suggested_budget_refresh` (MUST-9.32): `suggest:<T>` where T is the current month, via `suggestedBudgetRefreshKey(month)`.

**MUST-9.26's firing guard, made concrete.** The spec says the event "does not fire when the previous month has no category with either a resolved limit or a computable suggestion". A category with a limit and no suggestion has no expected figure to compare against, so it contributes no line. The guard therefore reduces to: **fire only when at least one line exists**, which is the same condition expressed in terms of what the message can actually say.

**Files:**
- Create: `src/lib/notify/evaluate/monthly.ts`
- Modify: `src/lib/notify/evaluate/index.ts` (one call in the existing daily-slot block)
- Test: `tests/lib/notify/evaluate/monthly.test.ts` (**new**)
- Test: `tests/lib/notify/dedup.test.ts` (amended: the six new keys inserted twice insert one row)

**Interfaces:**
- Consumes: `budgetProgress`, `resolveBudget` from `@/lib/budgets`; `listCategories` from `@/lib/categories`; `addMonths`, `currentMonth`, `todayIso` from `@/lib/dates`; `isEventEnabled` from `@/lib/notify/config`; `CHANNELS`, `predictedVsActualKey`, `suggestedBudgetRefreshKey` from `@/lib/notify/events` (Task 6); `enqueue` from `@/lib/notify/outbox`; `renderEvent`, `type PredictedLine`, `type RefreshLine` from `@/lib/notify/render` (Task 6); `flattenBudgetRows` from `@/lib/notify/evaluate/pace` (Task 7); `suggestionsFor` from `@/lib/predict/history` (Task 5); `MONTH_REPORT_DAY_MAX`, `MONTH_REPORT_MAX_LINES`, `SUGGEST_REFRESH_MIN_DELTA_CENTS`, `SUGGEST_REFRESH_MIN_DELTA_PCT` from `@/lib/predict/constants` (Task 1).
- Produces:
  ```ts
  export function evaluateMonthBoundary(input: { userId: number; now: Date; tz: string }): number;
  ```

### Steps

- [ ] **Step 1: Write the failing test**

Create `tests/lib/notify/evaluate/monthly.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../../helpers/db';
import { upsertBudget } from '@/lib/budgets';
import { saveEmailTarget, saveSmtp, setPref } from '@/lib/notify/config';
import { resetOutboxPumpForTests } from '@/lib/notify/outbox';
import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';
import { evaluateMonthBoundary } from '@/lib/notify/evaluate/monthly';

let t: TestDb;
let accountId: number;
let creatorId: number;
const TZ = 'UTC';

beforeEach(() => {
  t = createSeededTestDb();
  accountId = insertTestAccount(t.db);
  creatorId = insertTestUser(t.db, { username: 'creator' });
  resetOutboxPumpForTests();
  setNotifySenderForTests(async () => {});
});

afterEach(() => {
  resetNotifySenderForTests();
  resetOutboxPumpForTests();
  t.cleanup();
});

function optedInUser(): number {
  const userId = insertTestUser(t.db, { username: `u${Math.random().toString(36).slice(2, 8)}` });
  saveSmtp({
    preset: 'brevo',
    host: 'h',
    port: 587,
    security: 'starttls',
    username: 'u',
    password: 'p',
    fromEmail: 'f@e.com',
    fromName: 'Budget Tracker',
    enabled: true,
  });
  saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
  // Both month events are default-off (MUST-9.2); every test here wants them on.
  setPref(userId, 'predicted_vs_actual', 'email', true);
  setPref(userId, 'suggested_budget_refresh', 'email', true);
  return userId;
}

function spend(categoryId: number, cents: number, date: string): void {
  t.db.run(
    sql`insert into transactions
          (account_id, date, amount_cents, raw_description, normalized_merchant, category_id,
           attributed_user_id, is_transfer, dedup_hash, created_by, created_at, updated_at)
        values (${accountId}, ${date}, ${-cents}, ${'MERCHANT'}, ${'merchant'}, ${categoryId},
                null, 0, ${`h${Math.random()}`}, ${creatorId}, ${'2026-01-01T00:00:00.000Z'}, ${'2026-01-01T00:00:00.000Z'})`,
  );
}

/**
 * Six flat months of $600 groceries ending 2026-06, then a $713.40 July. Evaluated on the
 * first days of August: the reported month M is 2026-07, whose reference window is
 * 2026-01 .. 2026-06.
 */
function seedHistory(): number {
  const groceries = categoryIdByName(t.db, 'Groceries');
  for (const month of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']) {
    spend(groceries, 60000, `${month}-10`);
  }
  spend(groceries, 71340, '2026-07-10');
  return groceries;
}

function keys(): string[] {
  return (t.sqlite.prepare('select dedup_key from notification_outbox order by id').all() as { dedup_key: string }[]).map(
    (r) => r.dedup_key,
  );
}

describe('MUST-9.26 and MUST-9.31: the three-day window', () => {
  it('fires on day 1, 2 and 3 and not on day 4', () => {
    const userId = optedInUser();
    seedHistory();
    for (const day of ['01', '02', '03']) {
      resetOutboxPumpForTests();
      t.db.run(sql`delete from notification_outbox`);
      expect(evaluateMonthBoundary({ userId, now: new Date(`2026-08-${day}T09:00:00Z`), tz: TZ })).toBeGreaterThan(0);
    }
    t.db.run(sql`delete from notification_outbox`);
    expect(evaluateMonthBoundary({ userId, now: new Date('2026-08-04T09:00:00Z'), tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });

  it('MUST-9.29 and MUST-9.32: each fires exactly once across all three days', () => {
    const userId = optedInUser();
    seedHistory();
    let total = 0;
    for (const day of ['01', '02', '03']) {
      total += evaluateMonthBoundary({ userId, now: new Date(`2026-08-${day}T09:00:00Z`), tz: TZ });
    }
    expect(total).toBe(2);
    expect(keys().sort()).toEqual(['predvs:2026-07', 'suggest:2026-08']);
  });
});

describe('MUST-9.27: predicted is recomputed, not recalled', () => {
  it('compares July actual against the suggestion the six months before it point at', () => {
    const userId = optedInUser();
    seedHistory();
    setPref(userId, 'suggested_budget_refresh', 'email', false);

    expect(evaluateMonthBoundary({ userId, now: new Date('2026-08-01T09:00:00Z'), tz: TZ })).toBe(1);
    const body = (t.sqlite.prepare('select body from notification_outbox limit 1').get() as { body: string }).body;
    expect(body).toContain('expected $600.00');
    expect(body).toContain('actual $713.40');
    expect(body).toContain('recomputed');
  });
});

describe('MUST-9.31: suggested_budget_refresh needs both thresholds cleared', () => {
  it('does not fire when every suggestion sits close to its resolved limit', () => {
    const userId = optedInUser();
    const groceries = seedHistory();
    setPref(userId, 'predicted_vs_actual', 'email', false);
    // The August window is 2026-02 .. 2026-07: five months at $600 and one at $713.40. Its
    // median is $600.00 and its trend is flat (the $113.40 move is under the 10 percent
    // threshold), so the August suggestion is $600.00. Setting the limit to exactly that
    // leaves a delta of zero, which clears neither threshold.
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-01', amountCents: 60000 });
    expect(evaluateMonthBoundary({ userId, now: new Date('2026-08-01T09:00:00Z'), tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });

  it('fires when a category has a suggestion and no resolved limit at all', () => {
    const userId = optedInUser();
    seedHistory();
    setPref(userId, 'predicted_vs_actual', 'email', false);
    expect(evaluateMonthBoundary({ userId, now: new Date('2026-08-01T09:00:00Z'), tz: TZ })).toBe(1);
    expect(keys()).toEqual(['suggest:2026-08']);
  });

  it('MUST-9.33: the body says nothing has been changed, and nothing has', () => {
    const userId = optedInUser();
    seedHistory();
    setPref(userId, 'predicted_vs_actual', 'email', false);
    evaluateMonthBoundary({ userId, now: new Date('2026-08-01T09:00:00Z'), tz: TZ });
    const body = (t.sqlite.prepare('select body from notification_outbox limit 1').get() as { body: string }).body;
    expect(body).toContain('Nothing has been changed.');
    const written = t.sqlite.prepare('select count(*) as n from budgets').get() as { n: number };
    expect(written.n).toBe(0);
  });
});

describe('MUST-9.26: nothing to report means nothing sent', () => {
  it('is silent on a household with no computable suggestion', () => {
    const userId = optedInUser();
    expect(evaluateMonthBoundary({ userId, now: new Date('2026-08-01T09:00:00Z'), tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
npx vitest run tests/lib/notify/evaluate/monthly.test.ts
```
Expected: FAIL with `Failed to resolve import "@/lib/notify/evaluate/monthly"`.

- [ ] **Step 3: Write `src/lib/notify/evaluate/monthly.ts`**

```ts
import { budgetProgress, resolveBudget } from '@/lib/budgets';
import { listCategories } from '@/lib/categories';
import { addMonths, currentMonth, todayIso } from '@/lib/dates';
import { isEventEnabled } from '@/lib/notify/config';
import { CHANNELS, predictedVsActualKey, suggestedBudgetRefreshKey } from '@/lib/notify/events';
import { flattenBudgetRows } from '@/lib/notify/evaluate/pace';
import { enqueue } from '@/lib/notify/outbox';
import { renderEvent, type PredictedLine, type RefreshLine } from '@/lib/notify/render';
import {
  MONTH_REPORT_DAY_MAX,
  MONTH_REPORT_MAX_LINES,
  SUGGEST_REFRESH_MIN_DELTA_CENTS,
  SUGGEST_REFRESH_MIN_DELTA_PCT,
} from '@/lib/predict/constants';
import { suggestionsFor } from '@/lib/predict/history';

/**
 * The two month-boundary reports. Both run on the user's daily slot and both need no
 * fingerprint (MUST-10.8): the three-day window plus a monthly dedup key already bound them.
 *
 * MUST-9.35: both render BOTH scopes into one message per user, a household section and a
 * "Yours" section, which is why their keys carry only the month.
 */

interface ScopedPredicted {
  scope: 'household' | 'personal';
  line: PredictedLine;
}

/**
 * MUST-9.27 and spec D3: "predicted" is recomputed here as the suggestion the app WOULD have
 * produced for month M, from the six full calendar months ending the month before it. There is
 * no stored forecast, because storing one needs a table and MUST-1.4 rules that out.
 */
function comparePredicted(
  month: string,
  scope: 'household' | 'personal',
  userId: number | null,
): { lines: ScopedPredicted[]; totalDeltaCents: number } {
  const suggestions = suggestionsFor({ targetMonth: month, scope, userId }).byCategory;
  const actual = new Map(flattenBudgetRows(budgetProgress(month, scope, userId)).map((row) => [row.categoryId, row]));

  const lines: ScopedPredicted[] = [];
  let totalDeltaCents = 0;
  for (const [categoryId, result] of suggestions) {
    if (!('suggestion' in result)) continue;
    const row = actual.get(categoryId);
    if (row === undefined) continue;
    const expectedCents = result.suggestion.suggestedCents;
    totalDeltaCents += row.spentCents - expectedCents;
    lines.push({ scope, line: { name: row.categoryName, expectedCents, actualCents: row.spentCents } });
  }
  return { lines, totalDeltaCents };
}

function firePredictedVsActual(input: { userId: number; month: string; now: Date }): number {
  if (!CHANNELS.some((channel) => isEventEnabled(input.userId, 'predicted_vs_actual', channel))) return 0;

  const household = comparePredicted(input.month, 'household', null);
  const personal = comparePredicted(input.month, 'personal', input.userId);
  const all = [...household.lines, ...personal.lines];
  // MUST-9.26: a category with a limit and no suggestion has no expected figure to compare
  // against, so no line, so nothing to send.
  if (all.length === 0) return 0;

  // MUST-9.30: at most MONTH_REPORT_MAX_LINES categories, chosen by the largest absolute
  // difference. The total line below still sums EVERY category with a suggestion.
  const shown = all
    .slice()
    .sort((a, b) => Math.abs(b.line.actualCents - b.line.expectedCents) - Math.abs(a.line.actualCents - a.line.expectedCents))
    .slice(0, MONTH_REPORT_MAX_LINES);

  const { subject, body } = renderEvent({
    event: 'predicted_vs_actual',
    month: input.month,
    household: shown.filter((entry) => entry.scope === 'household').map((entry) => entry.line),
    personal: shown.filter((entry) => entry.scope === 'personal').map((entry) => entry.line),
    totalDeltaCents: household.totalDeltaCents + personal.totalDeltaCents,
  });
  const result = enqueue({
    userId: input.userId,
    eventId: 'predicted_vs_actual',
    dedupKey: predictedVsActualKey(input.month),
    subject,
    body,
    at: input.now,
  });
  return result.inserted.length > 0 ? 1 : 0;
}

/**
 * MUST-9.31: a category counts as changed when its suggestion differs from the limit resolved
 * for that month by at least 10 percent AND at least $10. A category with no resolved limit
 * counts as a difference when it has a suggestion at all.
 */
function refreshFor(month: string, scope: 'household' | 'personal', userId: number | null): RefreshLine[] {
  const names = new Map(listCategories({ includeArchived: true }).map((category) => [category.id, category.name]));
  const out: RefreshLine[] = [];
  for (const [categoryId, result] of suggestionsFor({ targetMonth: month, scope, userId }).byCategory) {
    if (!('suggestion' in result)) continue;
    const nowCents = result.suggestion.suggestedCents;
    const wasCents = resolveBudget(scope, userId, categoryId, month);
    if (wasCents !== null) {
      const delta = Math.abs(nowCents - wasCents);
      if (delta * 100 < Math.abs(wasCents) * SUGGEST_REFRESH_MIN_DELTA_PCT) continue;
      if (delta < SUGGEST_REFRESH_MIN_DELTA_CENTS) continue;
    }
    out.push({ name: names.get(categoryId) ?? String(categoryId), nowCents, wasCents });
  }
  return out.sort((a, b) => Math.abs(b.nowCents - (b.wasCents ?? 0)) - Math.abs(a.nowCents - (a.wasCents ?? 0)));
}

function fireSuggestedRefresh(input: { userId: number; month: string; now: Date }): number {
  if (!CHANNELS.some((channel) => isEventEnabled(input.userId, 'suggested_budget_refresh', channel))) return 0;

  const household = refreshFor(input.month, 'household', null);
  const personal = refreshFor(input.month, 'personal', input.userId);
  const changedCount = household.length + personal.length;
  if (changedCount === 0) return 0;

  const { subject, body } = renderEvent({
    event: 'suggested_budget_refresh',
    month: input.month,
    household: household.slice(0, MONTH_REPORT_MAX_LINES),
    personal: personal.slice(0, Math.max(0, MONTH_REPORT_MAX_LINES - Math.min(household.length, MONTH_REPORT_MAX_LINES))),
    changedCount,
  });
  const result = enqueue({
    userId: input.userId,
    eventId: 'suggested_budget_refresh',
    dedupKey: suggestedBudgetRefreshKey(input.month),
    subject,
    body,
    at: input.now,
  });
  return result.inserted.length > 0 ? 1 : 0;
}

/**
 * MUST-9.26 and MUST-9.31: the three-day window exists so a container switched off on the 1st
 * still delivers on the 2nd or 3rd, on top of the daily slot's own 12-hour catch-up. Each
 * event's monthly key makes the second and third day a no-op.
 */
export function evaluateMonthBoundary(input: { userId: number; now: Date; tz: string }): number {
  const today = todayIso(input.now, input.tz);
  if (Number(today.slice(8, 10)) > MONTH_REPORT_DAY_MAX) return 0;

  const target = currentMonth(input.now, input.tz);
  let fired = 0;
  fired += firePredictedVsActual({ userId: input.userId, month: addMonths(target, -1), now: input.now });
  fired += fireSuggestedRefresh({ userId: input.userId, month: target, now: input.now });
  return fired;
}
```

- [ ] **Step 4: Add the call site in `src/lib/notify/evaluate/index.ts`**

Add the import:

```ts
import { evaluateMonthBoundary } from '@/lib/notify/evaluate/monthly';
```

Inside the existing `if (daily.fires) {` block, after `evaluateSubscriptionCreep(...)` from Task 8. The finished block reads:

```ts
      const daily = dailySlot(now, settings.dailyHour, tz);
      if (daily.fires) {
        evaluateComingDue({ userId: user.id, now, tz });
        evaluateStaleImport({ userId: user.id, now, tz });
        evaluateBudgetPace({ userId: user.id, now, tz });
        evaluateSubscriptionCreep({ userId: user.id, now, tz });
        evaluateMonthBoundary({ userId: user.id, now, tz });
      } else {
        logSlotSkipOnce('daily', user.id, daily.slotDate, daily.hoursSince);
      }
```

- [ ] **Step 5: Amend `tests/lib/notify/dedup.test.ts` for §17.3**

Add a case for each of the six new keys, following the file's existing shape: enqueue twice with identical inputs and assert exactly one outbox row per enabled channel (MUST-9.41, AC5). Add to the file's key-builder import list:

```ts
import {
  budgetPaceKey,
  duplicateChargeKey,
  predictedVsActualKey,
  subscriptionCreepKey,
  suggestedBudgetRefreshKey,
  unusualTransactionKey,
} from '@/lib/notify/events';
```

and a describe block that walks all six:

```ts
describe('AC5: every v1.4.0 dedup key is idempotent through enqueue()', () => {
  it('inserts one row per channel however many times it is enqueued', () => {
    const userId = emailUser();
    const cases: { eventId: string; dedupKey: string }[] = [
      { eventId: 'budget_pace', dedupKey: budgetPaceKey('household', 7, '2026-08') },
      { eventId: 'unusual_transaction', dedupKey: unusualTransactionKey(4211) },
      { eventId: 'subscription_creep', dedupKey: subscriptionCreepKey(4211) },
      { eventId: 'duplicate_charge', dedupKey: duplicateChargeKey(31, 44) },
      { eventId: 'predicted_vs_actual', dedupKey: predictedVsActualKey('2026-07') },
      { eventId: 'suggested_budget_refresh', dedupKey: suggestedBudgetRefreshKey('2026-08') },
    ];
    for (const { eventId, dedupKey } of cases) {
      setPref(userId, eventId, 'email', true);
      const first = enqueue({ userId, eventId, dedupKey, subject: 's', body: 'b' });
      const second = enqueue({ userId, eventId, dedupKey, subject: 's', body: 'b' });
      expect(first.inserted).toEqual(['email']);
      expect(second.inserted).toEqual([]);
    }
    const rows = t.sqlite.prepare('select count(*) as n from notification_outbox').get() as { n: number };
    expect(rows.n).toBe(cases.length);
  });
});
```

`tests/lib/notify/dedup.test.ts` already defines the module-level `t: TestDb` and the `emailUser()` helper the block above uses, and already imports `setPref` and `enqueue`. Add only the six key builders to its `@/lib/notify/events` import list.

- [ ] **Step 6: Run the tests to verify they pass**

```powershell
npx vitest run tests/lib/notify/evaluate/monthly.test.ts tests/lib/notify/dedup.test.ts tests/lib/notify/evaluate/index.test.ts tests/lib/scheduler.test.ts
npx tsc --noEmit
```
Expected: PASS on all four, clean typecheck.

- [ ] **Step 7: Commit**

```bash
git add src/lib/notify/evaluate/monthly.ts src/lib/notify/evaluate/index.ts tests/lib/notify/evaluate/monthly.test.ts tests/lib/notify/dedup.test.ts
git commit -m "feat(notify): the two month-boundary reports, once per month each"
```

---

# Phase 4: Date-range presets

Two tasks, independent of Phases 1 to 3 and 5. They can be executed at any point in the sequence, as long as Task 10 precedes Task 11. Task 11 rewrites the filter forms in `reports-client.tsx` and `transactions-client.tsx`; Task 12 adds a card to `reports-client.tsx`, so run Task 11 before Task 12 to keep those two out of each other's way.

## Task 10: `src/lib/date-range.ts` and `src/components/ui/DateRangePicker.tsx`

**Context:** Spec §11 and §12. The URL carries a preset **token**, never a resolved date pair, and the helper takes `today` as a parameter. That is the entire reason a phone in another timezone cannot produce a different "This month" than the server would: the same "This month" appears in a `budget_pace` notification computed server-side, and a page that disagrees with a notification is a page nobody trusts again. Implements **MUST-2.3**, **MUST-11.1 … MUST-11.9**, **MUST-12.1 … MUST-12.8**, spec **D1**, and **AC7**.

**This plan's resolution of MUST-11.5 under `fallback: null`.** MUST-11.5 fills a missing endpoint "from the same preset resolution the fallback would give", which does not exist when the fallback is `null` (the Transactions and export-route case). Two named constants make the degenerate case behaviour-preserving rather than arbitrary:
- a missing `to` is filled with `monthEnd(monthOf(today))`, keeping MUST-11.3 point 2's "every `to` is a month end";
- a missing `from` is filled with `RANGE_FLOOR_DATE`, so a one-sided `?to=2026-03-31` bookmark still means "everything up to that date", exactly as it does in v1.3.1 where `buildWhere` adds only the one clause.

**Files:**
- Create: `src/lib/date-range.ts`
- Create: `src/components/ui/DateRangePicker.tsx`
- Test: `tests/lib/date-range.test.ts` (**new**)
- Test: `tests/components/DateRangePicker.test.tsx` (**new**)

**Interfaces:**
- Consumes: `addMonths`, `isIsoDate`, `monthEnd`, `monthOf`, `monthStart` from `@/lib/dates` and **nothing else** (MUST-2.3); `Field`, `inputClass`, `selectClass` from `@/components/ui/form`; `useState` from `react`.
- Produces:
  ```ts
  // src/lib/date-range.ts, PURE and client-safe
  export type RangePresetId =
    | 'this_month' | 'last_month' | 'last_3_months'
    | 'last_6_months' | 'ytd' | 'last_year' | 'custom';
  export const RANGE_PRESETS: readonly { id: RangePresetId; label: string }[];
  export const RANGE_FLOOR_DATE: '1900-01-01';
  export function isRangePresetId(value: string): value is RangePresetId;
  export interface ResolvedRange {
    preset: RangePresetId;
    from: string;
    to: string;
    /** 'Last 3 months', or for custom '2026-01-01 to 2026-03-31'. */
    label: string;
  }
  export function resolveRange(input: {
    preset: string | null | undefined;
    from: string | null | undefined;
    to: string | null | undefined;
    today: string;
    fallback: RangePresetId | null;
  }): ResolvedRange | null;
  export function rangeParams(range: ResolvedRange | null): Record<string, string>;

  // src/components/ui/DateRangePicker.tsx, 'use client'
  export function DateRangePicker(props: {
    value: RangePresetId | '';
    from: string;
    to: string;
    today: string;
    allowAny?: boolean;
    className?: string;
  }): React.ReactElement;
  ```

### Steps

- [ ] **Step 1: Write the failing helper test**

Create `tests/lib/date-range.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RANGE_PRESETS, isRangePresetId, rangeParams, resolveRange, type RangePresetId } from '@/lib/date-range';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const at = (today: string, preset: string) => resolveRange({ preset, from: null, to: null, today, fallback: null });

describe('MUST-11.1: seven presets, in order', () => {
  it('lists exactly the approved seven', () => {
    expect(RANGE_PRESETS.map((preset) => preset.id)).toEqual([
      'this_month',
      'last_month',
      'last_3_months',
      'last_6_months',
      'ytd',
      'last_year',
      'custom',
    ]);
    expect(RANGE_PRESETS.map((preset) => preset.label)).toEqual([
      'This month',
      'Last month',
      'Last 3 months',
      'Last 6 months',
      'Year to date',
      'Last year',
      'Custom',
    ]);
  });

  it('recognises its own ids and nothing else', () => {
    for (const preset of RANGE_PRESETS) expect(isRangePresetId(preset.id)).toBe(true);
    expect(isRangePresetId('last_30_days')).toBe(false);
    expect(isRangePresetId('')).toBe(false);
  });
});

describe('MUST-11.2: both endpoints of every preset', () => {
  it('resolves against 2026-08-18', () => {
    const endpoints = (preset: string) => {
      const range = at('2026-08-18', preset);
      return range === null ? null : [range.from, range.to];
    };
    expect(endpoints('this_month')).toEqual(['2026-08-01', '2026-08-31']);
    expect(endpoints('last_month')).toEqual(['2026-07-01', '2026-07-31']);
    expect(endpoints('last_3_months')).toEqual(['2026-06-01', '2026-08-31']);
    expect(endpoints('last_6_months')).toEqual(['2026-03-01', '2026-08-31']);
    expect(endpoints('ytd')).toEqual(['2026-01-01', '2026-08-31']);
    expect(endpoints('last_year')).toEqual(['2025-01-01', '2025-12-31']);
  });

  it('resolves across a year boundary', () => {
    expect(at('2026-01-05', 'last_3_months')).toMatchObject({ from: '2025-11-01', to: '2026-01-31' });
    expect(at('2026-01-05', 'last_month')).toMatchObject({ from: '2025-12-01', to: '2025-12-31' });
    expect(at('2026-01-05', 'ytd')).toMatchObject({ from: '2026-01-01', to: '2026-01-31' });
    expect(at('2026-01-05', 'last_year')).toMatchObject({ from: '2025-01-01', to: '2025-12-31' });
  });

  it('resolves on the last day of a year and on a leap day', () => {
    expect(at('2026-12-31', 'this_month')).toMatchObject({ from: '2026-12-01', to: '2026-12-31' });
    expect(at('2026-12-31', 'last_6_months')).toMatchObject({ from: '2026-07-01', to: '2026-12-31' });
    expect(at('2028-02-29', 'this_month')).toMatchObject({ from: '2028-02-01', to: '2028-02-29' });
    expect(at('2028-02-29', 'last_month')).toMatchObject({ from: '2028-01-01', to: '2028-01-31' });
  });

  it('MUST-11.3: every "to" is a month end, so the range does not shift during the day', () => {
    for (const preset of ['this_month', 'last_3_months', 'last_6_months', 'ytd'] as const) {
      const morning = at('2026-08-18', preset);
      const evening = at('2026-08-18', preset);
      expect(morning).toEqual(evening);
      expect(morning?.to).toBe('2026-08-31');
    }
  });
});

describe('MUST-11.6: precedence', () => {
  it('case 1: a recognised preset ignores any from or to in the URL entirely', () => {
    expect(
      resolveRange({ preset: 'last_month', from: '2020-01-01', to: '2020-12-31', today: '2026-08-18', fallback: null }),
    ).toEqual({ preset: 'last_month', from: '2026-07-01', to: '2026-07-31', label: 'Last month' });
  });

  it('case 2: an explicit custom preset reads from and to', () => {
    expect(resolveRange({ preset: 'custom', from: '2026-01-01', to: '2026-03-31', today: '2026-08-18', fallback: null })).toEqual({
      preset: 'custom',
      from: '2026-01-01',
      to: '2026-03-31',
      label: '2026-01-01 to 2026-03-31',
    });
  });

  it('case 3: a bare from/to pair with no preset resolves as custom, so old bookmarks keep working', () => {
    expect(resolveRange({ preset: null, from: '2026-01-01', to: '2026-03-31', today: '2026-08-18', fallback: null })).toMatchObject(
      { preset: 'custom', from: '2026-01-01', to: '2026-03-31' },
    );
    expect(
      resolveRange({ preset: 'not_a_preset', from: '2026-01-01', to: '2026-03-31', today: '2026-08-18', fallback: null }),
    ).toMatchObject({ preset: 'custom', from: '2026-01-01', to: '2026-03-31' });
  });

  it('case 4: nothing present gives the fallback, or null when there is none', () => {
    expect(resolveRange({ preset: null, from: null, to: null, today: '2026-08-18', fallback: 'last_6_months' })).toMatchObject({
      preset: 'last_6_months',
      from: '2026-03-01',
      to: '2026-08-31',
    });
    expect(resolveRange({ preset: null, from: null, to: null, today: '2026-08-18', fallback: null })).toBeNull();
  });
});

describe('MUST-11.5: custom validation', () => {
  it('discards an invalid endpoint and falls back when both are unusable', () => {
    expect(resolveRange({ preset: 'custom', from: 'nope', to: 'also-nope', today: '2026-08-18', fallback: null })).toBeNull();
    expect(
      resolveRange({ preset: 'custom', from: 'nope', to: 'also-nope', today: '2026-08-18', fallback: 'last_month' }),
    ).toMatchObject({ preset: 'last_month', from: '2026-07-01', to: '2026-07-31' });
  });

  it('fills the missing endpoint from the fallback and stays custom', () => {
    expect(
      resolveRange({ preset: 'custom', from: '2026-02-14', to: null, today: '2026-08-18', fallback: 'last_month' }),
    ).toMatchObject({ preset: 'custom', from: '2026-02-14', to: '2026-07-31' });
    // A missing `from` takes the fallback's own `from`, 2026-07-01, which is after the given
    // `to`, so MUST-11.5's swap puts the pair the right way round.
    expect(
      resolveRange({ preset: 'custom', from: null, to: '2026-02-14', today: '2026-08-18', fallback: 'last_month' }),
    ).toMatchObject({ preset: 'custom', from: '2026-02-14', to: '2026-07-01' });
  });

  it('swaps rather than rejecting a pair typed backwards', () => {
    expect(
      resolveRange({ preset: 'custom', from: '2026-03-31', to: '2026-01-01', today: '2026-08-18', fallback: null }),
    ).toMatchObject({ preset: 'custom', from: '2026-01-01', to: '2026-03-31' });
  });

  it('with no fallback, fills a missing "to" with the current month end and a missing "from" with the floor', () => {
    expect(resolveRange({ preset: null, from: '2026-01-01', to: null, today: '2026-08-18', fallback: null })).toMatchObject({
      preset: 'custom',
      from: '2026-01-01',
      to: '2026-08-31',
    });
    expect(resolveRange({ preset: null, from: null, to: '2026-03-31', today: '2026-08-18', fallback: null })).toMatchObject({
      preset: 'custom',
      from: '1900-01-01',
      to: '2026-03-31',
    });
  });
});

describe('MUST-11.7: fallback null means no range at all', () => {
  it('returns null so the caller applies no date filter', () => {
    expect(resolveRange({ preset: '', from: '', to: '', today: '2026-08-18', fallback: null })).toBeNull();
    expect(resolveRange({ preset: undefined, from: undefined, to: undefined, today: '2026-08-18', fallback: null })).toBeNull();
  });
});

describe('MUST-11.8: rangeParams is the one place a range becomes query parameters', () => {
  it('emits a token for a preset and the pair only for custom', () => {
    expect(rangeParams(null)).toEqual({});
    expect(rangeParams(at('2026-08-18', 'last_3_months'))).toEqual({ range: 'last_3_months' });
    expect(
      rangeParams(resolveRange({ preset: 'custom', from: '2026-01-01', to: '2026-03-31', today: '2026-08-18', fallback: null })),
    ).toEqual({ range: 'custom', from: '2026-01-01', to: '2026-03-31' });
  });

  it('round-trips every preset back through resolveRange to the same result', () => {
    for (const preset of RANGE_PRESETS) {
      if (preset.id === 'custom') continue;
      const first = at('2026-08-18', preset.id);
      const params = rangeParams(first);
      const second = resolveRange({
        preset: params.range ?? null,
        from: params.from ?? null,
        to: params.to ?? null,
        today: '2026-08-18',
        fallback: null,
      });
      expect(second).toEqual(first);
    }
  });
});

describe('MUST-11.9 and AC7: resolveRange is total', () => {
  it('never throws and always returns null or a valid ordered pair, over 1000 garbage inputs', () => {
    const garbage = [
      "';drop table transactions;--",
      '\u0000\uFFFF',
      'x'.repeat(5000),
      '2026-13-45',
      '2026-02-30',
      '../../etc/passwd',
      '{}',
      '[]',
      'null',
      'undefined',
      '-1',
      '1e309',
    ];
    let seed = 7;
    const pick = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return garbage[seed % garbage.length];
    };
    for (let run = 0; run < 1000; run += 1) {
      const result = resolveRange({
        preset: pick(),
        from: pick(),
        to: pick(),
        today: '2026-08-18',
        fallback: run % 2 === 0 ? null : 'last_6_months',
      });
      if (result === null) continue;
      expect(result.from <= result.to).toBe(true);
      expect(result.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(result.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('tolerates a non-string arriving from a repeated query parameter', () => {
    const weird = ['a', 'b'] as unknown as string;
    expect(() => resolveRange({ preset: weird, from: weird, to: weird, today: '2026-08-18', fallback: null })).not.toThrow();
  });
});

describe('MUST-11.4 and AC7: the timezone rule', () => {
  it('gives two different answers for two different todays with the same inputs', () => {
    const toronto = at('2026-08-31', 'this_month');
    const auckland = at('2026-09-01', 'this_month');
    expect(toronto).not.toEqual(auckland);
    expect(toronto?.from).toBe('2026-08-01');
    expect(auckland?.from).toBe('2026-09-01');
  });

  it('the module reads no clock and no environment', () => {
    const source = fs.readFileSync(path.join(root, 'src/lib/date-range.ts'), 'utf8');
    expect(source).not.toMatch(/new Date\b/);
    expect(source).not.toMatch(/Date\.now/);
    expect(source).not.toMatch(/todayIso/);
    expect(source).not.toMatch(/process\.env/);
    // MUST-2.3: @/lib/dates and nothing else.
    const imports = source.match(/from\s+'[^']+'/g) ?? [];
    expect(imports).toEqual(["from '@/lib/dates'"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
npx vitest run tests/lib/date-range.test.ts
```
Expected: FAIL with `Failed to resolve import "@/lib/date-range"`.

- [ ] **Step 3: Write `src/lib/date-range.ts`**

```ts
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
        ? { from: RANGE_FLOOR_DATE, to: monthEnd(monthOf(input.today)) }
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
```

- [ ] **Step 4: Run the helper test to verify it passes**

```powershell
npx vitest run tests/lib/date-range.test.ts
```
Expected: PASS.

- [ ] **Step 5: Write the failing picker test**

Create `tests/components/DateRangePicker.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DateRangePicker } from '@/components/ui/DateRangePicker';

afterEach(() => cleanup());

function renderInForm(props: Parameters<typeof DateRangePicker>[0]) {
  const { container } = render(
    <form data-testid="filter">
      <DateRangePicker {...props} />
    </form>,
  );
  return container.querySelector('form') as HTMLFormElement;
}

const base = { value: 'last_6_months' as const, from: '2026-03-01', to: '2026-08-31', today: '2026-08-18' };

describe('MUST-12.1 and D1: the options', () => {
  it('renders seven options without allowAny and eight with it', () => {
    renderInForm(base);
    expect(screen.getAllByRole('option')).toHaveLength(7);
    cleanup();
    renderInForm({ ...base, allowAny: true, value: '' });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(8);
    expect(options[0].getAttribute('value')).toBe('');
    expect(options[0].textContent).toBe('Any dates');
  });
});

describe('MUST-12.3 and MUST-12.4: the field names and the disabled inputs', () => {
  it('names the select "range" and the two inputs "from" and "to"', () => {
    const form = renderInForm(base);
    expect(form.querySelector('select[name="range"]')).not.toBeNull();
    expect(form.querySelector('input[name="from"]')).not.toBeNull();
    expect(form.querySelector('input[name="to"]')).not.toBeNull();
  });

  it('disables the two date inputs for any preset other than custom', () => {
    const form = renderInForm(base);
    expect((form.querySelector('input[name="from"]') as HTMLInputElement).disabled).toBe(true);
    expect((form.querySelector('input[name="to"]') as HTMLInputElement).disabled).toBe(true);
  });

  it('a disabled input is not in the submitted FormData, so a stale pair cannot ride along', () => {
    const form = renderInForm(base);
    const data = new FormData(form);
    expect(data.get('range')).toBe('last_6_months');
    expect(data.get('from')).toBeNull();
    expect(data.get('to')).toBeNull();
  });

  it('selecting custom reveals two enabled, prefilled inputs that do submit', () => {
    const form = renderInForm(base);
    fireEvent.change(form.querySelector('select[name="range"]') as HTMLSelectElement, { target: { value: 'custom' } });
    const from = form.querySelector('input[name="from"]') as HTMLInputElement;
    const to = form.querySelector('input[name="to"]') as HTMLInputElement;
    expect(from.disabled).toBe(false);
    expect(to.disabled).toBe(false);
    expect(from.value).toBe('2026-03-01');
    expect(to.value).toBe('2026-08-31');
    const data = new FormData(form);
    expect(data.get('range')).toBe('custom');
    expect(data.get('from')).toBe('2026-03-01');
    expect(data.get('to')).toBe('2026-08-31');
  });
});

describe('MUST-12.6: the custom inputs are bounded by the server-resolved today', () => {
  it('puts the today prop on both max attributes', () => {
    const form = renderInForm({ ...base, value: 'custom' });
    expect((form.querySelector('input[name="from"]') as HTMLInputElement).getAttribute('max')).toBe('2026-08-18');
    expect((form.querySelector('input[name="to"]') as HTMLInputElement).getAttribute('max')).toBe('2026-08-18');
  });
});

describe('MUST-12.2 and MUST-12.7: a form control, not a router', () => {
  it('labels the select and both inputs', () => {
    renderInForm({ ...base, value: 'custom' });
    expect(screen.getByText('Dates')).toBeTruthy();
    expect(screen.getByText('From')).toBeTruthy();
    expect(screen.getByText('To')).toBeTruthy();
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

```powershell
npx vitest run tests/components/DateRangePicker.test.tsx
```
Expected: FAIL with `Failed to resolve import "@/components/ui/DateRangePicker"`.

- [ ] **Step 7: Write `src/components/ui/DateRangePicker.tsx`**

```tsx
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
```

- [ ] **Step 8: Run both test files to verify they pass**

```powershell
npx vitest run tests/lib/date-range.test.ts tests/components/DateRangePicker.test.tsx
npx tsc --noEmit
```
Expected: PASS on both, clean typecheck.

- [ ] **Step 9: Commit**

```bash
git add src/lib/date-range.ts src/components/ui/DateRangePicker.tsx tests/lib/date-range.test.ts tests/components/DateRangePicker.test.tsx
git commit -m "feat(dates): the shared range resolver and its picker"
```

---

## Task 11: Reports, Transactions and the CSV export route adopt the picker

**Context:** Spec §13. Both pages keep working from the URL exactly as they do today, and both defaults are byte-identical to v1.3.1: Reports' empty query string still resolves to the last six calendar months, and Transactions' still applies no date clause at all. The export route resolves `range` through the **same** helper, so a link carrying `range=last_3_months` exports the same three months the page is showing. Implements **MUST-13.1 … MUST-13.10** and **AC9**.

**Files:**
- Modify: `src/app/(app)/reports/page.tsx`
- Modify: `src/app/(app)/reports/reports-client.tsx`
- Modify: `src/app/(app)/transactions/page.tsx`
- Modify: `src/app/(app)/transactions/transactions-client.tsx`
- Modify: `src/app/api/reports/export/route.ts`
- Test: `tests/app/date-range-adoption.test.ts` (**new**)
- Test: `tests/api/export.route.test.ts` (amended: a preset token produces the same rows as the page)

**Interfaces:**
- Consumes: `RANGE_PRESETS` is not needed here; `rangeParams`, `resolveRange`, `type ResolvedRange` from `@/lib/date-range` (Task 10); `DateRangePicker` from `@/components/ui/DateRangePicker` (Task 10); `todayIso` from `@/lib/dates`; `readEnv` from `@/lib/env`.
- Produces: `ReportsClient` gains `range: ResolvedRange` and `today: string` and **loses** its `from: string` and `to: string` props. `TransactionsClient` gains `range: ResolvedRange | null` and keeps its existing `today: string`.

### Steps

- [ ] **Step 1: Write the failing adoption test**

Create `tests/app/date-range-adoption.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { addMonths, currentMonth, monthEnd, monthStart } from '@/lib/dates';
import { rangeParams, resolveRange } from '@/lib/date-range';

const TODAY = '2026-08-18';

describe('MUST-13.2 and AC9: Reports keeps its v1.3.1 default exactly', () => {
  it('an empty query string resolves to the same pair the old inline expression produced', () => {
    const range = resolveRange({ preset: null, from: null, to: null, today: TODAY, fallback: 'last_6_months' });
    const legacyMonth = '2026-08';
    expect(range?.from).toBe(monthStart(addMonths(legacyMonth, -5)));
    expect(range?.to).toBe(monthEnd(legacyMonth));
  });

  it('holds for the real current month too, so the assertion is not fixture-bound', () => {
    const month = currentMonth();
    const today = `${month}-15`;
    const range = resolveRange({ preset: null, from: null, to: null, today, fallback: 'last_6_months' });
    expect(range?.from).toBe(monthStart(addMonths(month, -5)));
    expect(range?.to).toBe(monthEnd(month));
  });
});

describe('MUST-13.6 and AC9: Transactions keeps having no default date filter', () => {
  it('an empty query string resolves to null, so no date clause is added', () => {
    expect(resolveRange({ preset: null, from: null, to: null, today: TODAY, fallback: null })).toBeNull();
  });

  it('an existing-style bookmark still resolves to exactly its two dates', () => {
    const range = resolveRange({ preset: null, from: '2026-01-01', to: '2026-03-31', today: TODAY, fallback: null });
    expect(range?.from).toBe('2026-01-01');
    expect(range?.to).toBe('2026-03-31');
    expect(range?.preset).toBe('custom');
  });
});

describe('MUST-13.3 and MUST-13.9: the export link and the route agree', () => {
  it('a preset link carries the token and the route resolves it to the same pair', () => {
    const pageRange = resolveRange({ preset: 'last_3_months', from: null, to: null, today: TODAY, fallback: 'last_6_months' });
    const params = rangeParams(pageRange);
    expect(params).toEqual({ range: 'last_3_months' });
    const routeRange = resolveRange({
      preset: params.range ?? null,
      from: params.from ?? null,
      to: params.to ?? null,
      today: TODAY,
      fallback: null,
    });
    expect(routeRange?.from).toBe(pageRange?.from);
    expect(routeRange?.to).toBe(pageRange?.to);
  });
});
```

- [ ] **Step 2: Run it to verify it fails or passes trivially**

```powershell
npx vitest run tests/app/date-range-adoption.test.ts
```
Expected: PASS. This file pins the **contract** the pages must adopt; the page edits below are what make the app honour it, and Step 8's amended `tests/api/export.route.test.ts` is the failing test that proves the route changed.

- [ ] **Step 3: Rewrite the range resolution in `src/app/(app)/reports/page.tsx`**

Add the imports:

```ts
import { resolveRange } from '@/lib/date-range';
import { readEnv } from '@/lib/env';
```

Replace the two lines that currently read

```ts
const from = one('from') && isIsoDate(one('from')!) ? one('from')! : monthStart(addMonths(month, -5));
const to = one('to') && isIsoDate(one('to')!) ? one('to')! : monthEnd(month);
```

with

```ts
  // MUST-11.4: the server resolves today, in the configured TZ, and hands it down. The client
  // never computes a date from the browser clock.
  const today = todayIso(new Date(), readEnv().tz);
  const range = resolveRange({
    preset: one('range'),
    from: one('from'),
    to: one('to'),
    today,
    fallback: 'last_6_months',
  })!; // non-null: the fallback is non-null
  const from = range.from;
  const to = range.to;
```

Leave every existing call that reads `from` and `to` untouched, and pass the two new props to the client, dropping the old `from` and `to`:

```tsx
      range={range}
      today={today}
```

Remove `isIsoDate` from the `@/lib/dates` import if nothing else in the file uses it; keep `addMonths`, `monthEnd`, `monthStart` only if they are still used elsewhere in the file. `tsc --noEmit` reports any that are now unused only if `noUnusedLocals` is on, so check by eye.

- [ ] **Step 4: Swap the two date inputs in `src/app/(app)/reports/reports-client.tsx`**

Change the props interface: replace `from: string; to: string;` with

```ts
  range: ResolvedRange;
  today: string;
```

and add the imports:

```ts
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { rangeParams, type ResolvedRange } from '@/lib/date-range';
```

Replace the two `<Field label="From">` / `<Field label="To">` blocks in the filter form with:

```tsx
        <DateRangePicker value={range.preset} from={range.from} to={range.to} today={today} />
```

Replace the export link construction with `rangeParams` (MUST-13.3, so no page hand-builds a link):

```tsx
  const exportHref = `/api/reports/export?${new URLSearchParams({
    ...rangeParams(range),
    ...(person ? { person } : {}),
  }).toString()}`;
```

Set the `PageHeader` eyebrow to the range label (MUST-13.4), so it reads `Last 6 months` rather than a pair of dates:

```tsx
      eyebrow={range.label}
```

Every other use of the old `from` / `to` props inside this client becomes `range.from` / `range.to`.

- [ ] **Step 5: Resolve the range in `src/app/(app)/transactions/page.tsx`**

`readFilter` currently reads `from` and `to` as unvalidated raw strings. Give it the resolved range instead. Add the imports:

```ts
import { resolveRange, type ResolvedRange } from '@/lib/date-range';
import { readEnv } from '@/lib/env';
```

Change `readFilter`'s signature and its two date lines:

```ts
function readFilter(
  params: Record<string, string | string[] | undefined>,
  range: ResolvedRange | null,
): TransactionFilter {
  // ... the existing `one` and `num` helpers and every other field, unchanged ...
    from: range?.from ?? null,
    to: range?.to ?? null,
```

In the page body, resolve the range once and pass it to both `readFilter` and the client:

```ts
  const today = todayIso(new Date(), readEnv().tz);
  const one = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  // MUST-13.5: fallback null, because Transactions is the page people open to find a charge
  // from March and giving it a default range would hide exactly those rows.
  const range = resolveRange({ preset: one('range'), from: one('from'), to: one('to'), today, fallback: null });
  const filter = readFilter(params, range);
```

Change the client's existing `today={todayIso()}` prop to `today={today}`, so the manual-entry form and the picker both use the TZ-resolved date (MUST-11.4), and add:

```tsx
      range={range}
```

- [ ] **Step 6: Swap the two date inputs in `src/app/(app)/transactions/transactions-client.tsx`**

Add to the props interface:

```ts
  range: ResolvedRange | null;
```

and the imports:

```ts
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { type ResolvedRange } from '@/lib/date-range';
```

Replace the two bare `<Field label="From">` / `<Field label="To">` inputs in the filter form, in the same position, with:

```tsx
        <DateRangePicker
          allowAny
          value={range?.preset ?? ''}
          from={range?.from ?? ''}
          to={range?.to ?? ''}
          today={today}
        />
```

MUST-13.8: the two inputs render today with no `defaultValue` at all, so a filtered page forgets its own dates on reload. Feeding the picker the server-resolved range fixes that as a consequence of adopting the shared component.

- [ ] **Step 7: Resolve the range in `src/app/api/reports/export/route.ts`**

Add the imports:

```ts
import { resolveRange } from '@/lib/date-range';
import { todayIso } from '@/lib/dates';
import { readEnv } from '@/lib/env';
```

Replace `from: params.get('from'), to: params.get('to'),` in the `filter` literal with:

```ts
  // MUST-13.9: the SAME helper and the SAME fallback the Transactions page uses, so a link
  // carrying range=last_3_months exports the same three months the page is showing.
  // MUST-13.10: fallback null rather than Reports' last_6_months, because this route serves
  // both pages' links and rangeParams() guarantees the caller's parameters are explicit.
  const range = resolveRange({
    preset: params.get('range'),
    from: params.get('from'),
    to: params.get('to'),
    today: todayIso(new Date(), readEnv().tz),
    fallback: null,
  });
```

```ts
  from: range?.from ?? null,
  to: range?.to ?? null,
```

- [ ] **Step 8: Amend `tests/api/export.route.test.ts` for MUST-13.9**

Add a case asserting that `?range=last_3_months` and the explicit `?from=...&to=...` pair for the same window produce identical CSV bodies, following the file's existing request-building and body-reading style:

```ts
  it('MUST-13.9: a preset token exports the same rows as the equivalent explicit pair', async () => {
    const preset = await GET(request('/api/reports/export?range=last_3_months'));
    const month = currentMonth();
    const explicit = await GET(
      request(`/api/reports/export?from=${monthStart(addMonths(month, -2))}&to=${monthEnd(month)}`),
    );
    expect(await preset.text()).toBe(await explicit.text());
  });

  it('MUST-13.10: with no range parameters at all the route still exports everything', async () => {
    const all = await GET(request('/api/reports/export'));
    expect(all.status).toBe(200);
  });
```

Add `addMonths`, `currentMonth`, `monthEnd`, `monthStart` to that file's `@/lib/dates` import, and reuse its existing `request()` helper rather than adding a second one.

- [ ] **Step 9: Run the tests to verify they pass**

```powershell
npx vitest run tests/app/date-range-adoption.test.ts tests/api/export.route.test.ts tests/app/transactions-client.test.tsx tests/lib/transactions.test.ts tests/lib/reports.test.ts
npx tsc --noEmit
```
Expected: PASS on all five, clean typecheck. `tests/app/transactions-client.test.tsx` will need its `props()` builder to pass the new `range` prop; add `range: null` there, which is the no-filter state it already exercises.

- [ ] **Step 10: Commit**

```bash
git add "src/app/(app)/reports/page.tsx" "src/app/(app)/reports/reports-client.tsx" "src/app/(app)/transactions/page.tsx" "src/app/(app)/transactions/transactions-client.tsx" src/app/api/reports/export/route.ts tests/app/date-range-adoption.test.ts tests/api/export.route.test.ts tests/app/transactions-client.test.tsx
git commit -m "feat(dates): Reports, Transactions and the CSV export adopt the shared picker"
```

---

# Phase 5: The predictive surfaces

## Task 12: The Budgets page, the Reports baselines card and the three trend icons

**Context:** Spec §14 and §15. The client is thin: it receives two maps as props and renders them, and performs no arithmetic beyond `formatCents`, which it already imports. Every sentence in MUST-14.10 ships as written, because each one is the difference between a number that is trusted and a number that is guessed at. Implements **MUST-14.1 … MUST-14.10** and **MUST-15.1 … MUST-15.6**, plus **MUST-16.3 … MUST-16.5**.

**Run this task after Task 11**, which rewrites `reports-client.tsx`'s filter form. This task adds a card to the same file and does not touch that form.

**Files:**
- Modify: `src/components/icons.tsx` (`TrendUpIcon`, `TrendDownIcon`, `TrendFlatIcon`)
- Modify: `src/app/(app)/budgets/page.tsx`
- Modify: `src/app/(app)/budgets/budgets-client.tsx`
- Modify: `src/app/(app)/reports/page.tsx`
- Modify: `src/app/(app)/reports/reports-client.tsx`
- Test: `tests/app/budgets-client.test.tsx` (amended: the two new controls, the projection line, the three empty states)
- Test: `tests/components/trend-icons.test.tsx` (**new**)

**Interfaces:**
- Consumes: `suggestionsFor` from `@/lib/predict/history` (Task 5); `projectMonthEnd` from `@/lib/predict/pace` (Task 3); `type CategorySuggestion`, `type Suggestion` from `@/lib/predict/suggest` (Task 3); `applyAllSuggestionsAction`, `applySuggestionAction` from `./actions` (Task 5); `currentMonth`, `monthEnd`, `todayIso` from `@/lib/dates`; `readEnv` from `@/lib/env`; `MIN_HISTORY_MONTHS` from `@/lib/predict/constants` (Task 1); the existing `Card`/`CardHeader`/`CardBody`, `TableWrap`/`AmountCell`, `Money`, `EmptyState`, `BudgetProgressBar`, `formatCents`.
- Produces:
  ```ts
  // src/components/icons.tsx
  export function TrendUpIcon(props: IconProps): React.ReactElement;
  export function TrendDownIcon(props: IconProps): React.ReactElement;
  export function TrendFlatIcon(props: IconProps): React.ReactElement;

  // src/app/(app)/budgets/page.tsx -> budgets-client.tsx, one new prop
  export interface SectionPredictions {
    suggestions: CategorySuggestion[];
    projections: { categoryId: number; projectedCents: number }[];
    /** MUST-15.2: this personal series is entirely zero while the household one is not. */
    noAttribution: boolean;
  }
  export interface BudgetPredictions {
    /** MUST-15.1: the clipped window length, which drives the three-months sentence. */
    monthsUsed: number;
    /** MUST-15.3: the day of the month in the app's TZ. */
    dayOfMonth: number;
    household: SectionPredictions;
    personal: { userId: number; predictions: SectionPredictions }[];
  }
  // BudgetsClient gains: predictions: BudgetPredictions | null   (null for a past or future month)

  // src/app/(app)/reports/page.tsx -> reports-client.tsx, one new prop
  export interface BaselineRow {
    categoryId: number;
    categoryName: string;
    suggestion: Suggestion;
  }
  // ReportsClient gains: baselines: BaselineRow[]; baselineMonthsUsed: number
  ```

`SectionPredictions`, `BudgetPredictions` and `BaselineRow` all live in `src/lib/predict/suggest.ts`, which is pure and client-safe (MUST-2.1), so both the server page and the client component can name them without either importing `history.ts`.

### Steps

- [ ] **Step 1: Write the failing icon test**

Create `tests/components/trend-icons.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TrendDownIcon, TrendFlatIcon, TrendUpIcon } from '@/components/icons';

afterEach(() => cleanup());

describe('MUST-14.9: the three trend glyphs', () => {
  it('renders decorative svgs that follow the house Glyph convention', () => {
    for (const Icon of [TrendUpIcon, TrendDownIcon, TrendFlatIcon]) {
      const { container } = render(<Icon className="h-4 w-4" />);
      const svg = container.querySelector('svg') as SVGElement;
      expect(svg).not.toBeNull();
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(svg.getAttribute('class')).toBe('h-4 w-4');
      cleanup();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
npx vitest run tests/components/trend-icons.test.tsx
```
Expected: FAIL with `TrendUpIcon is not a function` or an import error naming it.

- [ ] **Step 3: Add the three icons to `src/components/icons.tsx`**

Append, following the file's existing `Glyph` convention:

```tsx
export function TrendUpIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M3 17 9.5 10.5l4 4L21 7" />
      <path d="M15 7h6v6" />
    </Glyph>
  );
}

export function TrendDownIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M3 7 9.5 13.5l4-4L21 17" />
      <path d="M15 17h6v-6" />
    </Glyph>
  );
}

export function TrendFlatIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M3 12h14" />
      <path d="m17 8 4 4-4 4" />
    </Glyph>
  );
}
```

- [ ] **Step 4: Add the three shared view types to `src/lib/predict/suggest.ts`**

Append (they are plain interfaces over `Suggestion`, so the module stays pure):

```ts
/** One section's predictive props. The Budgets page builds these; the client renders them. */
export interface SectionPredictions {
  suggestions: CategorySuggestion[];
  projections: { categoryId: number; projectedCents: number }[];
  /** MUST-15.2: this personal series is entirely zero while the household one is not. */
  noAttribution: boolean;
}

export interface BudgetPredictions {
  /** MUST-15.1: the clipped window length, which drives the three-months sentence. */
  monthsUsed: number;
  /** MUST-15.3: the day of the month in the app's TZ. */
  dayOfMonth: number;
  household: SectionPredictions;
  personal: { userId: number; predictions: SectionPredictions }[];
}

/** One row of the Reports baselines card (MUST-14.7). */
export interface BaselineRow {
  categoryId: number;
  categoryName: string;
  suggestion: Suggestion;
}
```

- [ ] **Step 5: Compute the two maps in `src/app/(app)/budgets/page.tsx`**

Add the imports. The file already imports `budgetProgress`, `budgetTotals`, `currentMonth` and `isMonthKey`; widen those two lines rather than adding duplicates:

```ts
import { budgetProgress, budgetTotals, type BudgetRow } from '@/lib/budgets';
import { currentMonth, isMonthKey, monthEnd, todayIso } from '@/lib/dates';
import { readEnv } from '@/lib/env';
import { suggestionsFor, type ScopeSuggestions } from '@/lib/predict/history';
import { projectMonthEnd } from '@/lib/predict/pace';
import type { BudgetPredictions, CategorySuggestion, SectionPredictions } from '@/lib/predict/suggest';
```

Add these two module-level helpers above the page component. `flattenRows` is the same shape `pace.ts` exports, declared locally because a page must not import a notification evaluator:

```ts
function flattenRows(rows: BudgetRow[], acc: BudgetRow[] = []): BudgetRow[] {
  for (const row of rows) {
    acc.push(row);
    if (row.children.length > 0) flattenRows(row.children, acc);
  }
  return acc;
}

/**
 * MUST-8.7 and MUST-16.4: the projection reuses budgetProgress()'s own spentCents, so it adds
 * no query and can never disagree with the progress bar beside it.
 */
function sectionFrom(
  scoped: ScopeSuggestions,
  rows: BudgetRow[],
  dayOfMonth: number,
  daysInMonth: number,
): SectionPredictions {
  const suggestions: CategorySuggestion[] = [];
  for (const [categoryId, result] of scoped.byCategory) {
    if (!('suggestion' in result)) continue;
    suggestions.push({ categoryId, ...result.suggestion });
  }
  const projections: { categoryId: number; projectedCents: number }[] = [];
  for (const row of flattenRows(rows)) {
    if (row.limitCents === null) continue;
    const projectedCents = projectMonthEnd({ spentCents: row.spentCents, dayOfMonth, daysInMonth });
    if (projectedCents === null) continue;
    projections.push({ categoryId: row.categoryId, projectedCents });
  }
  return { suggestions, projections, noAttribution: false };
}
```

Then, after the existing `household` and `personal` are built:

```ts
  const { tz } = readEnv();
  const today = todayIso(new Date(), tz);
  const dayOfMonth = Number(today.slice(8, 10));
  const daysInMonth = Number(monthEnd(month).slice(8, 10));

  // MUST-14.1: computed ONLY when the viewed month is the current month. A pace projection for
  // July, viewed in August, is not a projection.
  let predictions: BudgetPredictions | null = null;
  if (month === currentMonth(new Date(), tz)) {
    // MUST-16.3 budgets this page at 2 + 2P grouped aggregates, so each scope is read ONCE.
    const householdScope = suggestionsFor({ targetMonth: month, scope: 'household', userId: null });
    const householdHasSpend = flattenRows(household).some((row) => row.spentCents !== 0);
    predictions = {
      monthsUsed: householdScope.months.length,
      dayOfMonth,
      household: sectionFrom(householdScope, household, dayOfMonth, daysInMonth),
      personal: personal.map((person) => ({
        userId: person.userId,
        predictions: {
          ...sectionFrom(
            suggestionsFor({ targetMonth: month, scope: 'personal', userId: person.userId }),
            person.rows,
            dayOfMonth,
            daysInMonth,
          ),
          // MUST-15.2 and MUST-7.2: attributed_user_id is NULL on most imported rows until
          // somebody sets it, so this is by far the most likely empty state on a real install.
          noAttribution: householdHasSpend && flattenRows(person.rows).every((row) => row.spentCents === 0),
        },
      })),
    };
  }
```

and pass it to the client:

```tsx
      predictions={predictions}
```

- [ ] **Step 6: Render the three new surfaces in `src/app/(app)/budgets/budgets-client.tsx`**

Add to the props interface:

```ts
  predictions: BudgetPredictions | null;
```

Every snippet below sits inside a section render that has already narrowed `predictions` to non-null and picked its own `SectionPredictions` (the `household` field, or the matching entry in `personal`). Build the two lookups once per section, which is the only work the client does with them:

```ts
const suggestionOf = new Map(section.suggestions.map((entry) => [entry.categoryId, entry]));
const projectionOf = new Map(section.projections.map((entry) => [entry.categoryId, entry.projectedCents]));
```

and inside each row: `const suggestion = suggestionOf.get(row.categoryId) ?? null;` and `const projection = projectionOf.get(row.categoryId) ?? null;`. MUST-14.2: that is the whole of the client's involvement. It computes no median, no trend, no projection and no percentage.

and add the two new action wirings beside the existing two, following the file's `useActionState` plus `latest` pattern:

```tsx
const [applyState, dispatchApply] = useActionState(applySuggestionAction, initial);
const [applyAllState, dispatchApplyAll] = useActionState(applyAllSuggestionsAction, initial);

const applyAction = (formData: FormData) => {
  setLatest('apply');
  dispatchApply(formData);
};
const applyAllAction = (formData: FormData) => {
  setLatest('applyAll');
  dispatchApplyAll(formData);
};
```

Widen the `latest` union to `'limit' | 'copy' | 'apply' | 'applyAll' | null` and add the two new states to the banner's selection, so MUST-15.6's stale-suggestion error surfaces through the existing single banner rather than a second one.

**MUST-14.3, the suggestion control.** In the editable-row block, beside the existing amount input and Save button:

```tsx
{suggestion ? (
  <form action={applyAction}>
    <input type="hidden" name="scope" value={scope} />
    <input type="hidden" name="userId" value={userId ?? ''} />
    <input type="hidden" name="month" value={month} />
    <input type="hidden" name="categoryId" value={row.categoryId} />
    <button
      type="submit"
      className="btn btn--ghost btn--sm px-2 text-xs"
      title={`Median of the last ${suggestion.monthsUsed} full months${
        suggestion.trend.direction === 'rising'
          ? ', adjusted for a rising trend'
          : suggestion.trend.direction === 'falling'
            ? ', adjusted for a falling trend'
            : ''
      }${suggestion.seasonalApplied ? ', adjusted for the same month last year' : ''}. Confidence: ${suggestion.confidence}.`}
    >
      Use {formatCents(suggestion.suggestedCents, { currency: true })}
    </button>
  </form>
) : null}
```

There is **no amount field**: the server recomputes (MUST-7.4). MUST-15.4: a row with no suggestion renders nothing at all in this slot, no `n/a` and no dash.

**MUST-14.4, the projection cell.** In the progress-bar cell, under the existing `<BudgetProgressBar ... />`:

```tsx
{projection !== null ? (
  <p
    className={`mt-1 text-xs ${row.limitCents !== null && projection > row.limitCents ? 'text-negative' : 'text-muted'}`}
    title={`Assumes the rest of the month looks like the ${predictions.dayOfMonth} days so far.`}
  >
    On pace for {formatCents(projection, { currency: true })}
  </p>
) : null}
```

The over-limit colour is `text-negative`, the same token `BudgetProgressBar` uses for `bg-negative-solid`, so the page has one visual language for "this is going badly". MUST-15.3: before day 7 the line is simply absent, and the column header carries `title="Appears from the 7th of the month."`.

**MUST-14.5, the section control.** Beside the existing `Copy previous month` button in each section header, subject to the same `editable` predicate the amount input obeys (MUST-14.6):

```tsx
<form action={applyAllAction}>
  <input type="hidden" name="scope" value={scope} />
  <input type="hidden" name="userId" value={userId ?? ''} />
  <input type="hidden" name="month" value={month} />
  <button
    type="submit"
    className="btn btn--secondary btn--sm"
    title="Only fills in categories with no limit set. Nothing you have typed is changed."
  >
    Apply all suggestions
  </button>
</form>
```

**MUST-15.1 and MUST-15.2, the two sentences.** Under each section heading:

```tsx
{predictions !== null && predictions.monthsUsed < MIN_HISTORY_MONTHS ? (
  <p className="text-sm text-muted">Suggestions appear once there are three full calendar months of history.</p>
) : null}
{section.noAttribution ? (
  <p className="text-sm text-muted">
    No transactions are attributed to you yet, so there is nothing to base a personal suggestion on.
  </p>
) : null}
```

MUST-15.1 is explicit that this is a **sentence, not a disabled button**: a disabled control invites a person to work out what would enable it.

- [ ] **Step 7: Amend `tests/app/budgets-client.test.tsx`**

Add a `predictions` field to the file's existing props builder (default `null`), then add:

```tsx
describe('MUST-14.3 to MUST-14.6: the predictive controls', () => {
  const suggestion = {
    categoryId: 1,
    suggestedCents: 78000,
    medianCents: 76000,
    meanCents: 77000,
    trend: { direction: 'rising' as const, deltaCents: 4000 },
    monthsUsed: 6,
    seasonalApplied: false,
    confidence: 'medium' as const,
  };

  it('renders a Use button carrying no amount field, and its reasoning in the title', () => {
    render(<BudgetsClient {...props({ predictions: predictionsWith([suggestion], []) })} />);
    const button = screen.getByRole('button', { name: 'Use $780.00' });
    expect(button.getAttribute('title')).toContain('Confidence: medium.');
    const form = button.closest('form') as HTMLFormElement;
    expect(new FormData(form).get('amount')).toBeNull();
    expect(new FormData(form).get('categoryId')).toBe('1');
  });

  it('MUST-15.4: a category with no suggestion shows nothing in the slot', () => {
    render(<BudgetsClient {...props({ predictions: predictionsWith([], []) })} />);
    expect(screen.queryByRole('button', { name: /^Use / })).toBeNull();
  });

  it('MUST-14.4: the projection line appears with its assumption in the title', () => {
    render(<BudgetsClient {...props({ predictions: predictionsWith([], [{ categoryId: 1, projectedCents: 105900 }]) })} />);
    const line = screen.getByText('On pace for $1,059.00');
    expect(line.getAttribute('title')).toBe('Assumes the rest of the month looks like the 12 days so far.');
  });

  it('MUST-15.3: before the seventh there is no projection line and no placeholder', () => {
    render(<BudgetsClient {...props({ predictions: predictionsWith([], []) })} />);
    expect(screen.queryByText(/On pace for/)).toBeNull();
  });

  it('MUST-14.5: the section gains an apply-all button with its hint', () => {
    render(<BudgetsClient {...props({ predictions: predictionsWith([suggestion], []) })} />);
    const button = screen.getByRole('button', { name: 'Apply all suggestions' });
    expect(button.getAttribute('title')).toBe('Only fills in categories with no limit set. Nothing you have typed is changed.');
  });

  it('MUST-15.1: under three months there is a sentence and no disabled button', () => {
    render(<BudgetsClient {...props({ predictions: { ...predictionsWith([], []), monthsUsed: 2 } })} />);
    expect(screen.getByText('Suggestions appear once there are three full calendar months of history.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Use / })).toBeNull();
  });

  it('MUST-14.1: a past month renders neither column', () => {
    render(<BudgetsClient {...props({ predictions: null })} />);
    expect(screen.queryByRole('button', { name: /^Use / })).toBeNull();
    expect(screen.queryByText(/On pace for/)).toBeNull();
  });
});
```

with a local builder beside the file's existing `props()`:

```tsx
function predictionsWith(
  suggestions: CategorySuggestion[],
  projections: { categoryId: number; projectedCents: number }[],
): BudgetPredictions {
  return {
    monthsUsed: 6,
    dayOfMonth: 12,
    household: { suggestions, projections, noAttribution: false },
    personal: [],
  };
}
```

Set `categoryId: 1` in the fixture to whatever category id the file's existing `household` fixture row uses.

- [ ] **Step 8: Add the Reports baselines card**

In `src/app/(app)/reports/page.tsx`, add:

```ts
import { suggestionsFor } from '@/lib/predict/history';
import type { BaselineRow } from '@/lib/predict/suggest';
import { listCategories } from '@/lib/categories';
```

```ts
  // MUST-14.8: this card's window is the last 6 FULL calendar months, always, whatever the
  // picker says. MUST-16.5: one query, not one per category.
  const baseline = suggestionsFor({ targetMonth: currentMonth(), scope: 'household', userId: null });
  const categoryNames = new Map(listCategories({ includeArchived: true }).map((category) => [category.id, category.name]));
  const baselines: BaselineRow[] = [];
  for (const [categoryId, result] of baseline.byCategory) {
    if (!('suggestion' in result)) continue;
    baselines.push({ categoryId, categoryName: categoryNames.get(categoryId) ?? String(categoryId), suggestion: result.suggestion });
  }
  baselines.sort((a, b) => b.suggestion.medianCents - a.suggestion.medianCents);
```

```tsx
      baselines={baselines}
      baselineMonthsUsed={baseline.months.length}
```

In `src/app/(app)/reports/reports-client.tsx`, add the two props and render one card **above** the existing month-over-month card:

```tsx
<Card>
  <CardHeader
    title="Category baselines"
    description="Median and average over the last 6 full calendar months. This card does not follow the date filter above: a median needs equal-length months, and an arbitrary range does not have them."
  />
  <CardBody padded={false}>
    {baselineMonthsUsed < 3 || baselines.length === 0 ? (
      <EmptyState icon={ReportsIcon} title="Not enough history yet">
        Baselines appear after three full calendar months.
      </EmptyState>
    ) : (
      <TableWrap bare>
        <thead>
          <tr>
            <th>Category</th>
            <th className="text-right">Median</th>
            <th className="text-right">Average</th>
            <th>Trend</th>
            <th className="text-right">Suggested</th>
          </tr>
        </thead>
        <tbody>
          {baselines.map((row) => (
            <tr key={row.categoryId}>
              <td>{row.categoryName}</td>
              <AmountCell>
                <Money cents={row.suggestion.medianCents} plain />
              </AmountCell>
              <AmountCell>
                <Money cents={row.suggestion.meanCents} plain />
              </AmountCell>
              <td>
                <span className="flex items-center gap-1.5 text-xs text-muted">
                  {row.suggestion.trend.direction === 'rising' ? <TrendUpIcon className="h-4 w-4" /> : null}
                  {row.suggestion.trend.direction === 'falling' ? <TrendDownIcon className="h-4 w-4" /> : null}
                  {row.suggestion.trend.direction === 'flat' ? <TrendFlatIcon className="h-4 w-4" /> : null}
                  {row.suggestion.trend.direction === 'unknown'
                    ? null
                    : `${row.suggestion.trend.direction === 'rising' ? 'Rising' : row.suggestion.trend.direction === 'falling' ? 'Falling' : 'Flat'} ${formatCents(Math.abs(row.suggestion.trend.deltaCents), { currency: true })}`}
                </span>
              </td>
              <AmountCell>
                <Money cents={row.suggestion.suggestedCents} plain />
              </AmountCell>
            </tr>
          ))}
        </tbody>
      </TableWrap>
    )}
  </CardBody>
</Card>
```

MUST-14.9: the arrow always carries a text label beside it, so the information is not carried by shape and colour alone.

`ReportsIcon`, `Card`, `CardHeader`, `CardBody`, `EmptyState`, `Money` and `TableWrap` are all already imported by this file. Add only what is missing: `AmountCell` to the `@/components/ui/Table` import, the three trend icons to the `@/components/icons` import, `formatCents` from `@/lib/money`, and `type BaselineRow` from `@/lib/predict/suggest`.

- [ ] **Step 9: Run the tests to verify they pass**

```powershell
npx vitest run tests/components/trend-icons.test.tsx tests/app/budgets-client.test.tsx tests/app/budget-suggestions.test.ts tests/lib/predict/suggest.test.ts
npx tsc --noEmit
```
Expected: PASS on all four, clean typecheck.

- [ ] **Step 10: Confirm no client component reaches the server-only module**

```powershell
Select-String -Path ".\src\app\(app)\budgets\budgets-client.tsx",".\src\app\(app)\reports\reports-client.tsx" -Pattern "predict/history"
```
Expected: **no matches** (MUST-2.2). Both clients receive plain data as props and import types only from `@/lib/predict/suggest`.

- [ ] **Step 11: Commit**

```bash
git add src/components/icons.tsx src/lib/predict/suggest.ts "src/app/(app)/budgets/page.tsx" "src/app/(app)/budgets/budgets-client.tsx" "src/app/(app)/reports/page.tsx" "src/app/(app)/reports/reports-client.tsx" tests/components/trend-icons.test.tsx tests/app/budgets-client.test.tsx
git commit -m "feat(budgets): suggestion buttons, pace projections and the Reports baselines card"
```

---

# Phase 6: Invariants and release

## Task 13: Egress invariants, the regression guards, v1.4.0 and the release run

**Context:** Spec §16.1, §17.9, §18.1 and §18.3. This is the only task that runs the full suite and `npm run build`, and the only task that touches `package.json` and `CHANGELOG.md`. Implements **MUST-16.1**, **MUST-16.2**, **MUST-17.2**'s companion greps, **MUST-2.1**, **MUST-2.2**, and **AC1 … AC10**.

**Files:**
- Modify: `tests/ops/notify-egress.test.ts` (a third and fourth scanned tree, the pure-module list, the client-import ban)
- Modify: `package.json` (`version` to `1.4.0`)
- Modify: `CHANGELOG.md` (a new `## [1.4.0]` section; the `## Unreleased` heading stays, empty)
- Modify: `README.md` (section 3, "Use it")
- Test: `tests/ops/predict-invariants.test.ts` (**new**)

**Interfaces:**
- Consumes: nothing new. This task adds source-level scanners and documentation.
- Produces: nothing importable.

### Steps

- [ ] **Step 1: Extend `tests/ops/notify-egress.test.ts` (MUST-16.1)**

Add the new tree beside `notifyDir` and `updateDir`:

```ts
const predictDir = path.join(root, 'src/lib/predict');
```

Add `predictDir` to the two `for (const dir of [notifyDir, updateDir])` loops, so a `fetch(` anywhere under it is an offender and the HTTP-client-import ban covers it too. `FETCH_SITES` gains **no** entry: the expected count under `src/lib/predict/` is zero, which the offenders assertion already enforces.

Add a new describe block:

```ts
describe('MUST-1.1 and MUST-16.1: the predictive tree and the date-range files leave nothing', () => {
  const extraFiles = ['src/lib/date-range.ts', 'src/components/ui/DateRangePicker.tsx'];

  it('src/lib/predict/ holds no fetch( call site and no :// literal', () => {
    for (const file of filesUnder(predictDir)) {
      expect({ file: rel(file), literals: urlLiterals(file) }).toEqual({ file: rel(file), literals: [] });
      expect(stripComments(fs.readFileSync(file, 'utf8'))).not.toMatch(/(?<![.\w])fetch\s*\(/);
    }
  });

  it('the two date-range files hold no fetch( call site and no :// literal either', () => {
    for (const name of extraFiles) {
      const file = path.join(root, name);
      expect({ file: name, literals: urlLiterals(file) }).toEqual({ file: name, literals: [] });
      expect(stripComments(fs.readFileSync(file, 'utf8'))).not.toMatch(/(?<![.\w])fetch\s*\(/);
    }
  });
});
```

Add the six pure predictive modules and `date-range.ts` to the `pureModules` table (MUST-2.1, MUST-2.3, AC10). `history.ts` is deliberately absent: it is the one module allowed to import `@/db`:

```ts
  const pureModules: { dir: string; name: string }[] = [
    { dir: notifyDir, name: 'events.ts' },
    { dir: notifyDir, name: 'render.ts' },
    { dir: notifyDir, name: 'egress.ts' },
    { dir: notifyDir, name: 'evaluate/slots.ts' },
    { dir: updateDir, name: 'semver.ts' },
    { dir: updateDir, name: 'egress.ts' },
    { dir: predictDir, name: 'constants.ts' },
    { dir: predictDir, name: 'stats.ts' },
    { dir: predictDir, name: 'window.ts' },
    { dir: predictDir, name: 'suggest.ts' },
    { dir: predictDir, name: 'pace.ts' },
    { dir: predictDir, name: 'anomalies.ts' },
    { dir: path.join(root, 'src/lib'), name: 'date-range.ts' },
  ];
```

Extend the MUST-2.2 client-import ban to the new server-only module:

```ts
    const banned = /from\s+['"]@\/lib\/(notify\/(crypto|config|outbox|raise|send|evaluate)|update\/(github|watchtower|state|check)|predict\/history)/;
```

- [ ] **Step 2: Write `tests/ops/predict-invariants.test.ts` (§17.9, AC4, AC10)**

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const predictDir = path.join(root, 'src/lib/predict');

function filesUnder(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(full, acc);
    else if (/\.tsx?$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

describe('MUST-2.1 and AC10: only history.ts touches the database', () => {
  it('no other file under src/lib/predict/ imports @/db, @/lib/env or a node builtin', () => {
    for (const file of filesUnder(predictDir)) {
      if (path.basename(file) === 'history.ts') continue;
      const source = fs.readFileSync(file, 'utf8');
      const name = path.relative(root, file).replace(/\\/g, '/');
      expect({ name, db: /from\s+['"]@\/db/.test(source) }).toEqual({ name, db: false });
      expect({ name, env: /from\s+['"]@\/lib\/env['"]/.test(source) }).toEqual({ name, env: false });
      expect({ name, node: /from\s+['"]node:/.test(source) }).toEqual({ name, node: false });
    }
  });

  it('MUST-2.1: no pure module constructs a Date', () => {
    for (const file of filesUnder(predictDir)) {
      if (path.basename(file) === 'history.ts') continue;
      const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect({ file: path.basename(file), date: /new Date\b/.test(source) }).toEqual({ file: path.basename(file), date: false });
    }
  });

  it('MUST-3.3: divRound is the only division primitive in the tree', () => {
    for (const file of filesUnder(predictDir)) {
      if (path.basename(file) === 'stats.ts') continue;
      const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect({ file: path.basename(file), round: /Math\.round\s*\(/.test(source) }).toEqual({
        file: path.basename(file),
        round: false,
      });
    }
  });
});

describe('MUST-1.4 and AC4: no migration, no schema change', () => {
  it('the newest migration is still 0007 and the journal has no eighth entry', () => {
    const files = fs.readdirSync(path.join(root, 'drizzle')).filter((name) => name.endsWith('.sql')).sort();
    expect(files[files.length - 1]).toBe('0007_loans.sql');
    const journal = fs.readFileSync(path.join(root, 'drizzle/meta/_journal.json'), 'utf8');
    expect(journal).toContain('"idx": 7');
    expect(journal).not.toContain('"idx": 8');
  });

  it('src/db/schema.ts names no predictive object', () => {
    const schema = fs.readFileSync(path.join(root, 'src/db/schema.ts'), 'utf8');
    for (const banned of ['predict', 'suggestion', 'projection', 'baseline']) {
      expect({ banned, present: new RegExp(banned, 'i').test(schema) }).toEqual({ banned, present: false });
    }
  });
});
```

- [ ] **Step 3: Run the two ops files to verify they pass**

```powershell
npx vitest run tests/ops/notify-egress.test.ts tests/ops/predict-invariants.test.ts
```
Expected: PASS on both. A failure here names the file that broke an invariant; fix the **source**, not the scanner.

- [ ] **Step 4: Bump the version**

In `package.json`, change `"version": "1.3.1"` to `"version": "1.4.0"`. Nothing else in that file changes: this release adds no dependency and no script.

- [ ] **Step 5: Write the CHANGELOG entry**

In `CHANGELOG.md`, leave `## Unreleased` in place and empty, and insert a new section directly beneath it:

```markdown
## [1.4.0] - 2026-08-18

### Added

- **A suggested monthly budget for every category with enough history.** Budgets shows what
  the last six full months point at, and one button writes it. The number is the median of
  those months, nudged half way toward a rising or falling trend, adjusted for the same month
  last year once there is enough history to know what that month usually looks like, capped at
  three times the median and rounded up to the dollar. Suggestions appear once there are three
  full calendar months, and each one carries a confidence label you can see before you press.
- **Apply all suggestions**, per section, which fills in only the categories you have not set a
  limit for. Nothing you have typed is ever changed, and the message tells you how many were
  set and how many were skipped.
- **A pace projection from the seventh of the month.** Each category with a limit shows where
  the month is heading if the rest of it looks like the part already spent, in the same colour
  the progress bar uses when a budget is blown. It says out loud what it assumes.
- **A Category baselines card on Reports**, with each category's median, average, trend and
  suggested amount over the last six full calendar months. It deliberately does not follow the
  date filter above it, and the card says why.
- **Six new notifications**, off or on per person per channel in the toggle matrix you already
  have: a budget on pace to go over, an unusually large charge, a recurring charge that went
  up, a possible duplicate charge, and two start-of-month summaries. Like every notification
  before them, they send nothing to anybody who has not set up a channel.
- **Date-range presets.** Reports and Transactions get one picker with This month, Last month,
  Last 3 months, Last 6 months, Year to date, Last year and Custom. The range lives in the URL
  as a name rather than a pair of dates, so a phone in another timezone sees the same
  "This month" the server does, and the Export CSV link covers exactly what the page shows.

### Changed

- Transactions remembers the dates you filtered by when you reload the page. It still shows
  everything by default, because that is the page you open to find a charge from March.

### Fixed

- Nothing. This release adds no migration, no table and no column, and it makes no outbound
  connection it did not make before.
```

- [ ] **Step 6: Update `README.md` section 3**

In the numbered "Use it" list, extend item 5 and item 7:

```markdown
5. **Budgets**, set monthly limits per category, at household level and per person. A limit you
   set in March applies to March and every month after it until you change it again. Categories
   with three or more full months of history also show a suggested amount you can apply with one
   press, and from the seventh of the month each budgeted category shows where the month is
   heading.
7. **Reports**, category breakdowns, month-over-month trends, who-spent-what, category
   baselines, CSV export. Pick a date range from the presets or set your own.
```

- [ ] **Step 7: Run the full release gate**

```powershell
npm test
npm run typecheck
npm run build
```

Expected: `npm test` green across every file (**AC1**), `tsc --noEmit` clean under `strict` (**AC2**), and `next build` succeeding with **no new route** in the route table. This release adds no route handler and no page.

**If `npm run build` fails and `vitest` and `tsc` were both green, look first at `src/app/(app)/budgets/actions.ts`:** a non-async export from a `'use server'` file is the one class of error only the build catches.

- [ ] **Step 8: Confirm the no-migration claim by hand**

```powershell
git diff --name-only HEAD~13..HEAD | Select-String -Pattern '^drizzle/|^src/db/schema\.ts$'
```
Expected: **no output**. If anything is listed, the plan was wrong and the change must be reverted rather than accommodated (Global Constraints).

- [ ] **Step 9: Commit**

```bash
git add package.json CHANGELOG.md README.md tests/ops/notify-egress.test.ts tests/ops/predict-invariants.test.ts
git commit -m "release: v1.4.0 predictive spending targets and date-range presets"
```

---

# Spec coverage map

Every section of `docs/superpowers/specs/2026-08-18-predictive-dateranges-design.md` maps to at least one task.

| Spec section | Requirements | Task(s) |
|---|---|---|
| §1.2 Zero egress | MUST-1.1, MUST-1.2, MUST-1.3 | Global Constraints; asserted in **13** |
| §1.3 The no-migration claim | MUST-1.4 | Every task by construction; asserted in **13** |
| §2 Architecture delta, §2.1 layout | MUST-2.1, MUST-2.2, MUST-2.3 | **1**-**4** (purity at source), **2** (the one db module), **10** (date-range purity), **13** (the scanners) |
| §2.2 Files modified (exhaustive) |, | **5**-**13**, one file at a time |
| §3.1 What spend means | MUST-3.1, MUST-3.2 | **2** (the definition), asserted against `budgetProgress()` in **2** |
| §3.2 Rounding | MUST-3.3, MUST-3.4, MUST-3.5 | **1**; the no-second-rounding grep in **13** |
| §3.3 Constants | MUST-3.6, MUST-3.7 | **1** |
| §4.1 The window | MUST-4.1 … MUST-4.5 | **2** |
| §4.2 The minimum-history guard | MUST-4.6, MUST-4.7 | **3** (the guard), **5** (end to end), **12** (the sentence) |
| §4.3 `history.ts` | MUST-4.8 … MUST-4.11 | **2**; the seasonal gate in **5** |
| §5.1 Median | MUST-5.1, MUST-5.2 | **1** |
| §5.2 Average | MUST-5.3 | **1** |
| §5.3 Trend | MUST-5.4, MUST-5.5 | **1** |
| §5.4 Seasonality | MUST-5.6, MUST-5.7, MUST-5.8 | **2** (conditions 1 to 3), **3** (condition 4, the clamp, the absent flag) |
| §5.5 Spread | MUST-5.9 | **1** |
| §6.1 The function |, | **3** |
| §6.2 The algorithm | MUST-6.1 … MUST-6.6 | **3** |
| §6.3 Confidence | MUST-6.7, MUST-6.8 | **3** (the derivation), **12** (the label) |
| §7.1 Both scopes | MUST-7.1, MUST-7.2 | **5** (the computation), **12** (MUST-15.2's copy) |
| §7.2 The two server actions | MUST-7.3 … MUST-7.10 | **5** |
| §8.1 The formula | MUST-8.1 … MUST-8.6 | **3** |
| §8.2 Where the number comes from | MUST-8.7 | **7** (the evaluator), **12** (the page) |
| §9.1 The registry entries | MUST-9.1 … MUST-9.5 | **6** |
| §9.2 `budget_pace` | MUST-9.6 … MUST-9.9 | **6** (the key), **7** (the evaluator) |
| §9.3 `unusual_transaction` | MUST-9.10 … MUST-9.14 | **4** (the verdict), **6** (the key), **8** (the queries and the cap) |
| §9.4 `subscription_creep` | MUST-9.15 … MUST-9.19 | **4** (the verdict), **6** (the key), **8** (the daily evaluator) |
| §9.5 `duplicate_charge` | MUST-9.20 … MUST-9.25 | **4** (the pairing), **6** (the key), **8** (the tick evaluator) |
| §9.6 `predicted_vs_actual` | MUST-9.26 … MUST-9.30 | **6** (the key and the renderer), **9** (the evaluator) |
| §9.7 `suggested_budget_refresh` | MUST-9.31 … MUST-9.34 | **6** (the key and the renderer), **9** (the evaluator) |
| §9.8 Scope handling | MUST-9.35, MUST-9.36 | **7** (pace), **8** (household-wide), **9** (both scopes in one message) |
| §9.9 Rendering | MUST-9.37, MUST-9.38, MUST-9.39 | **6** |
| §9.10 The no-migration proof | MUST-9.40, MUST-9.41 | **6** (three files, no schema line), **9** (the dedup assertions), **13** (the scanners) |
| §10.1 Where the evaluators are called | MUST-10.1, MUST-10.2, MUST-10.3 | **7**, **8**, **9** (one call site each); scheduler untouched, asserted in **7** |
| §10.2 The tick fingerprint | MUST-10.4 … MUST-10.7 | **8** |
| §10.3 Cost | MUST-10.8, MUST-10.9, MUST-10.10 | **7**/**9** (no fingerprint needed), **8** (the query shape and the zero-participant return) |
| §11.1 The presets | MUST-11.1 | **10** |
| §11.2 Exact definitions | MUST-11.2 … MUST-11.9 | **10** |
| §12 The picker | MUST-12.1 … MUST-12.8 | **10** |
| §13.1 Reports | MUST-13.1 … MUST-13.4 | **11** |
| §13.2 Transactions | MUST-13.5 … MUST-13.8 | **11** |
| §13.3 The export route | MUST-13.9, MUST-13.10 | **11** |
| §13.4 The pages that do not adopt it | MUST-13.11 | Nothing implemented; **11** touches only the three named files |
| §14.1 The Budgets page | MUST-14.1 … MUST-14.6 | **12** |
| §14.2 The baselines card | MUST-14.7, MUST-14.8, MUST-14.9 | **12** |
| §14.3 Required copy | MUST-14.10 | **6** (the two message sentences), **12** (the three UI sentences) |
| §15 Error and empty states | MUST-15.1 … MUST-15.8 | **12** (15.1 to 15.6), **7**/**8**/**9** (15.7's try/catch), **11** (15.8 unchanged) |
| §16.1 The egress invariant | MUST-16.1, MUST-16.2 | **13** |
| §16.2 Query budget | MUST-16.3 … MUST-16.6 | **5** (one composition), **12** (the page's budget), **2** (one grouped query) |
| §17.1 Pure units |, | **1**, **2**, **3**, **4** |
| §17.2 `history.test.ts` |, | **2** |
| §17.3 The evaluators |, | **7**, **8**, **9** |
| §17.4 Budget application |, | **5** |
| §17.5 The registry-extension proof | MUST-17.2 | **6** |
| §17.6 Date ranges |, | **10** |
| §17.7 The picker |, | **10** |
| §17.8 Page integration |, | **11** |
| §17.9 Regression guards |, | **13** (the greps), **5**/**7** (the unamended suites) |
| §18.1 Automated acceptance | AC1 … AC10 | AC1/AC2 **13**; AC3/AC10 **13**; AC4 **13**; AC5 **9**; AC6 **3**; AC7 **10**; AC8 **8**; AC9 **11** |
| §18.2 Manual QA | A1 … A18 | Final checklist below |
| §19 Decisions taken on the owner's behalf | 1-34 | Encoded as constants and comments across **1**-**12**; 26 in **1**, 27 to 32 in **10**/**11**, 33 in **12**, 34 in **2** |
| §20 Deviations | D1 … D4 | D1 **10** (`allowAny`), D2 **1** (`constants.ts`'s docblock), D3 **9** (the recomputation and its sentence), D4 **12** (the card's description) |
| §21 Risks | R1 … R14 | R1 **8**; R2 **4**/**8**; R3 **10**; R4 **5**; R5 **1**; R6 **2**; R7 **3**; R8 **2**; R9 **7**; R10 **5**; R11 **10**/**11**; R12 **11**; R13 **6**; R14 **5**/**12** |
| §22 Out of scope |, | Nothing implemented |

---

# Final acceptance checklist

Run after Task 13. Automated items must be green; manual items are the once-per-release QA pass of §18.2.

**Automated (§18.1)**
- [ ] **AC1** `npm test` is green, including every test named in §17.
- [ ] **AC2** `npm run typecheck` is clean under `strict`.
- [ ] **AC3** `tests/ops/notify-egress.test.ts` passes with its MUST-16.1 amendment: `src/lib/predict/`, `src/lib/date-range.ts` and `src/components/ui/DateRangePicker.tsx` contain zero `fetch(` sites and zero URL literals.
- [ ] **AC4** The release diff touches **no** file under `drizzle/` and **no** line of `src/db/schema.ts`.
- [ ] **AC5** Each of the six new dedup keys, enqueued twice with identical inputs, produces exactly one outbox row per enabled channel.
- [ ] **AC6** Over 500 generated series, `suggestBudget` never returns a negative amount, never a non-multiple of 100 cents, and never more than `3 x median + 99`.
- [ ] **AC7** `resolveRange` never throws over 1,000 generated garbage inputs, and `src/lib/date-range.ts` contains no `new Date`, no `Date.now`, no `todayIso` and no `process.env`.
- [ ] **AC8** With no user having any of the six events enabled, twelve simulated ticks perform zero predictive queries beyond the participant check.
- [ ] **AC9** Reports and Transactions with an empty query string produce byte-identical filters to v1.3.1.
- [ ] **AC10** No file under `src/lib/predict/` other than `history.ts` imports `@/db`, `@/lib/env` or a node builtin.
- [ ] `npm run build` succeeds and **no new route** appears in the route table.

**Manual (§18.2)**
- [ ] **A1** Fresh install, no transactions. Budgets shows no suggestion buttons and the three-months sentence. Nothing errors.
- [ ] **A2** Import two months of history. Still no suggestions, still the sentence. Import a third full month. Suggestions appear, labelled low confidence.
- [ ] **A3** With six months of history, apply one suggestion. The limit lands on the row, the progress bar redraws against it, and the Budgets month picker shows the same number the following month through the existing effective-month rule.
- [ ] **A4** Press **Apply all suggestions** on a section where three categories already have limits. Exactly the unlimited ones change, and the message names both counts.
- [ ] **A5** As a member, confirm no suggestion or apply-all button appears in another member's personal section, and that a crafted POST to `applySuggestionAction` for that scope is refused.
- [ ] **A6** On the 12th of a month, confirm the projection line appears and reads plausibly against the month-to-date figure. On the 3rd, confirm it is absent.
- [ ] **A7** With Telegram configured and `budget_pace` on, drive a category past its 110 percent projection. The message arrives once. Force a second evaluation the same day and the following day: nothing further arrives.
- [ ] **A8** Enter a transaction three times the usual size for a known merchant. The unusual-charge message arrives within one tick. Re-run the tick: nothing further.
- [ ] **A9** Enter two identical charges for the same merchant one day apart. The duplicate message arrives once, and its wording says it may be a real second charge.
- [ ] **A10** Raise a monthly subscription's amount by $4 and import it. The creep message arrives on the next daily slot, once.
- [ ] **A11** On the 1st of a month with both month events enabled, confirm both arrive, that the predicted-vs-actual body says the prediction was recomputed, and that the refresh body says nothing has been changed. Confirm neither arrives again on the 2nd or 3rd.
- [ ] **A12** Turn every one of the six events off in the toggle matrix. Confirm the matrix rendered all six without any UI having been rebuilt for them, and that no further messages arrive.
- [ ] **A13** Reports: select each of the seven presets in turn and confirm the eyebrow label, the numbers, and that the URL carries `range=` and not a date pair. Select Custom and confirm the two inputs appear prefilled.
- [ ] **A14** Open an old bookmark of the shape `/reports?from=2026-01-01&to=2026-03-31`. It renders exactly as it did in v1.3.1, with the picker showing Custom.
- [ ] **A15** With a preset selected on Reports, press Export CSV. The file covers the same range the page shows.
- [ ] **A16** Transactions with no filters shows every transaction, as it does today. Select "Last month", filter, and confirm the picker still shows "Last month" after the reload.
- [ ] **A17** Set the container's `TZ` to `Pacific/Auckland` while the browser stays on Toronto time, near midnight. Confirm "This month" on the page matches the month the server is in, not the browser.
- [ ] **A18** Restore a v1.3.1 backup. The app boots, no migration runs, suggestions compute from the restored history, and no notification floods on the first tick.

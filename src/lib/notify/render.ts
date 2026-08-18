import { daysBetweenIso, monthLabel } from '@/lib/dates';
import { formatCents } from '@/lib/money';
import { divRound } from '@/lib/predict/stats';
import { ITEM_KIND_LABELS, expiryPhraseForKind, type ItemKind } from '@/lib/warranty/constants';

/**
 * MUST-10.1: ONE channel-agnostic renderer. Telegram sends `subject + '\n\n' + body`;
 * email sends `subject` as the Subject header and `body` as the text part. One renderer,
 * two envelopes: the two channels can never drift apart in wording, and every message is
 * testable as a pure function.
 *
 * PURE (MUST-2.1). Every value arrives already resolved: the evaluators do the querying.
 *
 * MUST-10.4: no body contains a link. The server has no reliable idea of the URL the
 * family uses (LAN IP, reverse-proxy hostname, Tailscale name), and a wrong link is worse
 * than no link.
 */
export const NAME_MAX = 80;
export const USER_AGENT_MAX = 120;

/** MUST-10.3: every value from user or import data is plain text and bounded. */
export function truncateText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export interface DigestLine {
  name: string;
  cents: number;
}

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

export type RenderInput =
  | {
      event: 'coming_due';
      itemName: string;
      kind: ItemKind;
      expiryDate: string;
      todayIso: string;
      vendor: string | null;
      priceCents: number | null;
    }
  | {
      event: 'budget_threshold';
      scope: 'household' | 'personal';
      categoryName: string;
      month: string;
      pct: number;
      spentCents: number;
      limitCents: number;
    }
  | {
      event: 'budget_exceeded';
      scope: 'household' | 'personal';
      categoryName: string;
      month: string;
      spentCents: number;
      limitCents: number;
    }
  | { event: 'backup_failed'; dateIso: string; error: string }
  | {
      event: 'weekly_digest';
      fromIso: string;
      toIso: string;
      householdSpentCents: number;
      personalSpentCents: number;
      topCategories: readonly DigestLine[];
      topMerchants: readonly DigestLine[];
      reviewCount: number;
      overBudget: readonly string[];
    }
  | { event: 'new_signin'; name: string; atLabel: string; tz: string; ip: string; userAgent: string | null }
  | {
      event: 'restore_outcome';
      status: 'success' | 'failed';
      sourceName: string;
      requestedByUsername: string;
      finishedAt: string;
      receiptsRestored: number;
      missingReceiptRows: number;
      error: string | null;
    }
  | { event: 'stale_import'; weeks: number; lastImportIso: string; daysAgo: number }
  | {
      event: 'update_available';
      currentVersion: string;
      latestVersion: string;
      severity: 'patch' | 'minor' | 'major';
      publishedAt: string | null;
      canApplyInApp: boolean;
    }
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
    };

function money(cents: number): string {
  return formatCents(cents, { currency: true });
}

function scopeWord(scope: 'household' | 'personal'): string {
  return scope === 'household' ? 'Household' : 'Your';
}

function inDays(todayIso: string, targetIso: string): string {
  const days = daysBetweenIso(todayIso, targetIso);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

/** notify §11.4's amendment: iso.slice(0, 16).replace('T', ' ') is the app's ONE convention. */
function publishedLine(publishedAt: string | null): string {
  if (publishedAt === null) return '';
  return `\n\nPublished ${publishedAt.slice(0, 16).replace('T', ' ')}.`;
}

/** Two columns, padded, so a digest reads as a table in a plain-text message. */
function padded(lines: readonly DigestLine[], indent = '  '): string[] {
  const width = lines.reduce((max, line) => Math.max(max, truncateText(line.name, NAME_MAX).length), 0);
  return lines.map((line) => `${indent}${truncateText(line.name, NAME_MAX).padEnd(width + 2)}${money(line.cents)}`);
}

/**
 * MUST-9.30: the existing two-column padded() helper aligns the category name against the
 * expected figure; the other two figures are appended after it has run.
 *
 * Nothing composite is ever handed to padded(). It applies truncateText(name, NAME_MAX), so a
 * composite left column would let an 80-character category name cut the last dollar amount
 * off the line. Only the category name goes in, which is what NAME_MAX is for.
 *
 * Every figure goes through money(), which never prints a leading plus (MUST-9.39), so a
 * category that came in under its expectation reads -$20.00 and one that came in over reads
 * $93.40. Section 9.6's example line shows a plus; MUST-9.39 is the binding rule.
 */
function predictedLines(rows: readonly PredictedLine[]): string[] {
  return padded(rows.map((row) => ({ name: row.name, cents: row.expectedCents }))).map((line, index) => {
    const row = rows[index];
    return `${line} expected, ${money(row.actualCents)} actual, ${money(row.actualCents - row.expectedCents)} difference`;
  });
}

/** Same composition, with "no limit set" where the category has never had one. */
function refreshLines(rows: readonly RefreshLine[]): string[] {
  return padded(rows.map((row) => ({ name: row.name, cents: row.nowCents }))).map((line, index) => {
    const was = rows[index].wasCents;
    return `${line} suggested, ${was === null ? 'no limit set' : `${money(was)} set`}`;
  });
}

function renderDigest(input: Extract<RenderInput, { event: 'weekly_digest' }>): string {
  const empty =
    input.householdSpentCents === 0 &&
    input.personalSpentCents === 0 &&
    input.topCategories.length === 0 &&
    input.topMerchants.length === 0;
  if (empty) {
    const tail: string[] = ['No transactions were recorded this week.'];
    if (input.reviewCount > 0) tail.push(`${input.reviewCount} transactions still need review.`);
    if (input.overBudget.length > 0) {
      tail.push(`Over budget this month: ${input.overBudget.map((n) => truncateText(n, NAME_MAX)).join(', ')}.`);
    }
    return tail.join('\n');
  }

  const parts: string[] = [
    `Household spend: ${money(input.householdSpentCents)}`,
    `Your spend:      ${money(input.personalSpentCents)}`,
  ];
  if (input.topCategories.length > 0) {
    parts.push('', 'Top categories (household)', ...padded(input.topCategories));
  }
  if (input.topMerchants.length > 0) {
    parts.push('', 'Top merchants (household)', ...padded(input.topMerchants));
  }
  parts.push('');
  if (input.reviewCount > 0) parts.push(`${input.reviewCount} transactions still need review.`);
  if (input.overBudget.length > 0) {
    parts.push(`Over budget this month: ${input.overBudget.map((n) => truncateText(n, NAME_MAX)).join(', ')}.`);
  }
  return parts.join('\n').trimEnd();
}

export function renderEvent(input: RenderInput): { subject: string; body: string } {
  switch (input.event) {
    case 'coming_due': {
      const name = truncateText(input.itemName, NAME_MAX);
      // MUST-6.14: the verb comes from expiryPhraseForKind() so notifications never become
      // a second place any of the four verbs is written (MUST-19.11 of the warranty spec).
      const phrase = expiryPhraseForKind(input.kind, input.expiryDate);
      const lines = [`${ITEM_KIND_LABELS[input.kind]} "${name}" ${phrase} (${inDays(input.todayIso, input.expiryDate)}).`];
      if (input.vendor) lines.push(`Vendor: ${truncateText(input.vendor, NAME_MAX)}`);
      if (input.priceCents !== null) lines.push(`Price: ${money(input.priceCents)}`);
      return { subject: `Coming due: ${name}`, body: lines.join('\n') };
    }
    case 'budget_threshold': {
      const category = truncateText(input.categoryName, NAME_MAX);
      const label = monthLabel(input.month);
      const remainingCents = input.limitCents - input.spentCents;
      // MUST-6.17: a single import can jump straight past 100%, firing this message
      // alongside budget_exceeded. When that happens remainingCents is negative, and "$X
      // left" would read as still having room, so the remaining clause is omitted here
      // entirely; budget_exceeded is the message that talks about being over.
      const remainingClause = remainingCents >= 0 ? `, ${money(remainingCents)} left` : '';
      return {
        subject: `Budget ${input.pct}%: ${category} (${label})`,
        body:
          `${scopeWord(input.scope)} ${category} budget for ${label} is at ${input.pct}% — ` +
          `${money(input.spentCents)} of ${money(input.limitCents)}${remainingClause}.`,
      };
    }
    case 'budget_exceeded': {
      const category = truncateText(input.categoryName, NAME_MAX);
      const label = monthLabel(input.month);
      return {
        subject: `Over budget: ${category} (${label})`,
        body:
          `${scopeWord(input.scope)} ${category} budget for ${label} is blown — ` +
          `${money(input.spentCents)} of ${money(input.limitCents)}, ${money(input.spentCents - input.limitCents)} over.`,
      };
    }
    case 'backup_failed':
      return {
        subject: 'Nightly backup failed',
        body: [
          `The nightly backup on ${input.dateIso} did not complete.`,
          input.error,
          'The maintenance sweep still ran. Check Settings → Backups.',
        ].join('\n\n'),
      };
    case 'weekly_digest':
      return { subject: `Weekly summary — ${input.fromIso} to ${input.toIso}`, body: renderDigest(input) };
    case 'new_signin': {
      const lines = [
        `${truncateText(input.name, NAME_MAX)} signed in at ${input.atLabel} (${input.tz}) from ${input.ip}.`,
      ];
      if (input.userAgent) lines.push(truncateText(input.userAgent, USER_AGENT_MAX));
      lines.push('If this was not you, change your password in Settings.');
      return { subject: 'New sign-in to your account', body: lines.join('\n\n') };
    }
    case 'restore_outcome': {
      const lines = [
        `Source: ${truncateText(input.sourceName, NAME_MAX)}`,
        `Requested by: ${truncateText(input.requestedByUsername, NAME_MAX)}`,
        `Finished: ${input.finishedAt}`,
        `Receipts restored: ${input.receiptsRestored}; rows with a missing receipt: ${input.missingReceiptRows}`,
      ];
      if (input.error) lines.push(`Error: ${input.error}`);
      return { subject: input.status === 'success' ? 'Restore succeeded' : 'Restore FAILED', body: lines.join('\n') };
    }
    case 'stale_import':
      return {
        subject: `No transactions imported in ${input.weeks} weeks`,
        body: [
          `The last import was ${input.lastImportIso} (${input.daysAgo} days ago).`,
          'Bank exports are how this app learns what you spent.',
        ].join('\n'),
      };
    case 'update_available': {
      const major = input.severity === 'major';
      const subject = major
        ? `Budget Tracker ${input.latestVersion} is available (major update)`
        : `Budget Tracker ${input.latestVersion} is available`;
      if (major) {
        // Fix wave item 2: the app's own "Review and update" screen only exists on an
        // install with an apply path (Watchtower configured). An install without one — see
        // §7.4's fallback, updates-client.tsx's !canApplyInApp branch — has no such button to
        // press, so it gets the honest manual-update wording instead of an instruction it
        // cannot follow.
        // Pre-tag follow-up: Settings → About only shows the LOCAL bundled changelog, which
        // is unreachable-as-"the release notes" on a no-apply-path install that hasn't
        // updated yet -- reworded to point at the actual source instead (no URL, per
        // MUST-10.4), following the patch/minor tail's honest-template phrasing below.
        const tail = input.canApplyInApp
          ? 'Open Settings, read what changed, and press Review and update when you are ready.'
          : "This install has no in-app update trigger; see Settings for how to update by hand. " +
            "The release notes are on the project's GitHub releases page.";
        return {
          subject,
          body:
            `You are running ${input.currentVersion}. Version ${input.latestVersion} is a major update, so this ` +
            `app will not install it on its own. ${tail}` +
            publishedLine(input.publishedAt),
        };
      }
      // MUST-6.5: no body carries a URL (notify MUST-10.4), and publishedAt renders with the
      // app's one timestamp convention and nothing else. Version strings are re-serialised
      // from parsed integers upstream (MUST-4.2), so nothing from the remote payload reaches
      // a message body unparsed.
      // Pre-tag follow-up: "cannot update itself" is false for a pre-1.3.1-compose install --
      // an old Watchtower can still auto-pull it even though this app has no apply path to
      // trigger one. Reworded to the neutral, truthful claim: no in-app trigger, not "no
      // updating happens".
      const tail = input.canApplyInApp
        ? 'Automatic updates are switched off, so open Settings and press Update now when you want it.'
        : 'This install has no in-app update trigger; see Settings for how it updates.';
      return {
        subject,
        body: `You are running ${input.currentVersion}. Version ${input.latestVersion} is published. ${tail}${publishedLine(input.publishedAt)}`,
      };
    }
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
      // A multiple is not an amount, so it is not money()'s business (MUST-9.39). It is still
      // integer arithmetic: tenths through divRound, then split, rather than a float divide
      // and toFixed. MUST-3.5's rule is scoped to src/lib/predict/, but there is no reason to
      // introduce the one float in the codebase that does not need to exist.
      const tenths = divRound(spend * 10, input.baselineCents);
      const multiple = `${Math.trunc(tenths / 10)}.${tenths % 10}`;
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
      const pct = divRound(rise * 100, input.baselineCents);
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
  }
}

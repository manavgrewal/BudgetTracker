import { daysBetweenIso, monthLabel } from '@/lib/dates';
import { formatCents } from '@/lib/money';
import { ITEM_KIND_LABELS, expiryPhraseForKind, type ItemKind } from '@/lib/warranty/constants';

/**
 * MUST-10.1 — ONE channel-agnostic renderer. Telegram sends `subject + '\n\n' + body`;
 * email sends `subject` as the Subject header and `body` as the text part. One renderer,
 * two envelopes: the two channels can never drift apart in wording, and every message is
 * testable as a pure function.
 *
 * PURE (MUST-2.1). Every value arrives already resolved — the evaluators do the querying.
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
  | { event: 'stale_import'; weeks: number; lastImportIso: string; daysAgo: number };

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

/** Two columns, padded, so a digest reads as a table in a plain-text message. */
function padded(lines: readonly DigestLine[], indent = '  '): string[] {
  const width = lines.reduce((max, line) => Math.max(max, truncateText(line.name, NAME_MAX).length), 0);
  return lines.map((line) => `${indent}${truncateText(line.name, NAME_MAX).padEnd(width + 2)}${money(line.cents)}`);
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
      // alongside budget_exceeded. When that happens remainingCents is negative — "$X
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
  }
}

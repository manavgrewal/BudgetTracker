import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { simplefinAccountLinks, simplefinConnections } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { todayIso } from '@/lib/dates';
import { SimplefinError } from './client';
import { decryptAccessUrl, encryptAccessUrl } from './crypto';

/** The bridge allows roughly 24/day/token; stop at 20 so a sync never discovers the ceiling. */
export const DAILY_REQUEST_LIMIT = 20;
export const OVERLAP_DAYS = 5;
export const MAX_WINDOW_DAYS = 90;

export interface ConnectionRecord {
  id: number;
  claimedAt: string;
  lastSyncAt: string | null;
  requestsToday: number;
  requestsDate: string;
  enabled: boolean;
}

function row() {
  return getDb().select().from(simplefinConnections).limit(1).get();
}

export function getConnection(): ConnectionRecord | null {
  const found = row();
  if (!found) return null;
  return {
    id: found.id,
    claimedAt: found.claimedAt,
    lastSyncAt: found.lastSyncAt,
    requestsToday: found.requestsToday,
    requestsDate: found.requestsDate,
    enabled: found.enabled,
  };
}

/** v1 keeps a single connection: claiming again replaces the previous one. */
export function saveClaimedConnection(accessUrl: string, at: Date = new Date()): ConnectionRecord {
  const db = getDb();
  db.transaction((tx) => {
    tx.delete(simplefinConnections).run();
    tx.insert(simplefinConnections)
      .values({
        accessUrlEncrypted: encryptAccessUrl(accessUrl),
        claimedAt: nowIso(at),
        lastSyncAt: null,
        requestsToday: 0,
        requestsDate: todayIso(at),
        enabled: true,
        createdAt: nowIso(at),
      })
      .run();
  });
  const created = getConnection();
  if (!created) throw new Error('failed to store the SimpleFIN connection');
  return created;
}

/** Decrypted only server-side, at the moment of use. Never returned to the browser. */
export function getAccessUrl(): string | null {
  const found = row();
  if (!found) return null;
  return decryptAccessUrl(found.accessUrlEncrypted);
}

/**
 * "Forget connection" also drops every account link: leaving them behind would
 * permanently lock those accounts out of CSV import (isSimplefinManaged stays
 * true forever with no UI left to unlink from) and matches the user's mental
 * model of "forget" — accounts revert to CSV-managed.
 */
export function deleteConnection(): void {
  getDb().transaction((tx) => {
    tx.delete(simplefinAccountLinks).run();
    tx.delete(simplefinConnections).run();
  });
}

export function markSynced(at: Date = new Date()): void {
  const found = row();
  if (!found) return;
  getDb().update(simplefinConnections).set({ lastSyncAt: nowIso(at) }).where(eq(simplefinConnections.id, found.id)).run();
}

export function remainingRequestsToday(at: Date = new Date()): number {
  const found = row();
  if (!found) return DAILY_REQUEST_LIMIT;
  if (found.requestsDate !== todayIso(at)) return DAILY_REQUEST_LIMIT;
  return Math.max(0, DAILY_REQUEST_LIMIT - found.requestsToday);
}

export function assertRequestBudget(at: Date = new Date()): void {
  if (remainingRequestsToday(at) <= 0) {
    throw new SimplefinError(
      'http_error',
      `Daily SimpleFIN request budget used up (${DAILY_REQUEST_LIMIT} of about 24 allowed by the bridge). Try again tomorrow.`,
      429,
    );
  }
}

export function consumeRequest(at: Date = new Date()): void {
  const found = row();
  if (!found) return;
  const today = todayIso(at);
  const requestsToday = found.requestsDate === today ? found.requestsToday + 1 : 1;
  getDb()
    .update(simplefinConnections)
    .set({ requestsToday, requestsDate: today })
    .where(eq(simplefinConnections.id, found.id))
    .run();
}

export interface AccountLink {
  simplefinAccountId: string;
  accountId: number;
  currency: string;
  lastBalanceCents: number | null;
  lastBalanceDate: string | null;
}

export function listLinks(): AccountLink[] {
  return getDb()
    .select({
      simplefinAccountId: simplefinAccountLinks.simplefinAccountId,
      accountId: simplefinAccountLinks.accountId,
      currency: simplefinAccountLinks.currency,
      lastBalanceCents: simplefinAccountLinks.lastBalanceCents,
      lastBalanceDate: simplefinAccountLinks.lastBalanceDate,
    })
    .from(simplefinAccountLinks)
    .all();
}

export function linkAccount(input: { simplefinAccountId: string; accountId: number; currency: string }): void {
  const existing = listLinks().find((link) => link.accountId === input.accountId);
  if (existing && existing.simplefinAccountId !== input.simplefinAccountId) {
    throw new SimplefinError('bad_token', 'That local account is already linked to a different SimpleFIN account.');
  }
  getDb()
    .insert(simplefinAccountLinks)
    .values({
      simplefinAccountId: input.simplefinAccountId,
      accountId: input.accountId,
      currency: input.currency,
      lastBalanceCents: null,
      lastBalanceDate: null,
      createdAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: simplefinAccountLinks.simplefinAccountId,
      set: { accountId: input.accountId, currency: input.currency },
    })
    .run();
}

export function unlinkAccount(simplefinAccountId: string): void {
  getDb().delete(simplefinAccountLinks).where(eq(simplefinAccountLinks.simplefinAccountId, simplefinAccountId)).run();
}

export function updateLinkBalance(input: { simplefinAccountId: string; balanceCents: number | null; balanceDate: string | null }): void {
  getDb()
    .update(simplefinAccountLinks)
    .set({ lastBalanceCents: input.balanceCents, lastBalanceDate: input.balanceDate })
    .where(eq(simplefinAccountLinks.simplefinAccountId, input.simplefinAccountId))
    .run();
}

/** Spec section 3: an account is CSV-managed or SimpleFIN-managed, never both. */
export function isSimplefinManaged(accountId: number): boolean {
  const found = getDb()
    .select({ id: simplefinAccountLinks.simplefinAccountId })
    .from(simplefinAccountLinks)
    .where(eq(simplefinAccountLinks.accountId, accountId))
    .get();
  return found !== undefined;
}

export function linkForAccount(accountId: number): AccountLink | null {
  return listLinks().find((link) => link.accountId === accountId) ?? null;
}

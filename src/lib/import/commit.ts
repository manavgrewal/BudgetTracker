import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { accounts, imports, transactionImports, transactions, users } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { findExistingByHashes, type HashedRow } from './dedup';
import { getImportHooks } from './hooks';
import type { RowError } from './parse';

/**
 * SQLite has no strict column typing, so a malformed row (e.g. a non-numeric
 * amountCents) would otherwise be silently written instead of failing the
 * whole import. Validate the fields we're about to persist so corruption
 * throws inside the transaction and rolls back, instead of landing in the DB.
 */
function assertInsertable(row: HashedRow): void {
  if (typeof row.amountCents !== 'number' || !Number.isFinite(row.amountCents)) {
    throw new Error(`Invalid amountCents for row with dedupHash ${String(row.dedupHash)}`);
  }
  if (typeof row.date !== 'string' || row.date.length === 0) {
    throw new Error(`Invalid date for row with dedupHash ${String(row.dedupHash)}`);
  }
  if (typeof row.rawDescription !== 'string' || row.rawDescription.length === 0) {
    throw new Error(`Invalid rawDescription for row with dedupHash ${String(row.dedupHash)}`);
  }
  if (typeof row.dedupHash !== 'string' || row.dedupHash.length === 0) {
    throw new Error('Invalid dedupHash for row');
  }
  if (typeof row.hashVersion !== 'number') {
    throw new Error(`Invalid hashVersion for row with dedupHash ${row.dedupHash}`);
  }
}

export interface CommitInput {
  accountId: number;
  profileId: number | null;
  filename: string;
  importedBy: number;
  rows: HashedRow[];
  errors: RowError[];
  at?: Date;
}

export interface CommitResult {
  importId: number;
  rowsAdded: number;
  rowsDuplicate: number;
  rowsError: number;
  insertedTransactionIds: number[];
  duplicateTransactionIds: number[];
}

export function commitImport(input: CommitInput): CommitResult {
  const db = getDb();
  const at = input.at ?? new Date();
  const timestamp = nowIso(at);
  const { normalizeMerchant } = getImportHooks();

  const account = db
    .select({ ownerUserId: accounts.ownerUserId })
    .from(accounts)
    .where(eq(accounts.id, input.accountId))
    .get();
  if (!account) throw new Error(`No account ${input.accountId}`);

  const existing = findExistingByHashes(
    input.accountId,
    input.rows.map((row) => row.dedupHash),
  );

  return db.transaction((tx) => {
    const importRow = tx
      .insert(imports)
      .values({
        accountId: input.accountId,
        profileId: input.profileId,
        filename: input.filename,
        importedBy: input.importedBy,
        rowsAdded: 0,
        rowsDuplicate: 0,
        rowsError: input.errors.length,
        createdAt: timestamp,
      })
      .returning({ id: imports.id })
      .get();

    const insertedTransactionIds: number[] = [];
    const duplicateTransactionIds: number[] = [];
    const linked = new Set<number>();

    const link = (transactionId: number) => {
      if (linked.has(transactionId)) return;
      linked.add(transactionId);
      tx.insert(transactionImports)
        .values({ transactionId, importId: importRow.id, createdAt: timestamp })
        .run();
    };

    for (const row of input.rows) {
      const existingId = existing.get(row.dedupHash);
      if (existingId !== undefined) {
        // Spec section 3: record the association for duplicates too — this is
        // what makes undo safe with overlapping date-range exports.
        duplicateTransactionIds.push(existingId);
        link(existingId);
        continue;
      }

      assertInsertable(row);

      const inserted = tx
        .insert(transactions)
        .values({
          accountId: input.accountId,
          importId: importRow.id,
          attributedUserId: account.ownerUserId ?? null,
          date: row.date,
          rawDescription: row.rawDescription,
          normalizedMerchant: normalizeMerchant(row.rawDescription),
          amountCents: row.amountCents,
          categoryId: null,
          categorizationSource: 'none',
          confidence: null,
          isTransfer: false,
          notes: null,
          dedupHash: row.dedupHash,
          hashVersion: row.hashVersion,
          createdBy: input.importedBy,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .returning({ id: transactions.id })
        .get();

      insertedTransactionIds.push(inserted.id);
      existing.set(row.dedupHash, inserted.id);
      link(inserted.id);
    }

    tx.update(imports)
      .set({ rowsAdded: insertedTransactionIds.length, rowsDuplicate: duplicateTransactionIds.length })
      .where(eq(imports.id, importRow.id))
      .run();

    return {
      importId: importRow.id,
      rowsAdded: insertedTransactionIds.length,
      rowsDuplicate: duplicateTransactionIds.length,
      rowsError: input.errors.length,
      insertedTransactionIds,
      duplicateTransactionIds,
    };
  });
}

export interface ImportHistoryRow {
  id: number;
  accountId: number;
  accountName: string;
  profileId: number | null;
  filename: string;
  importedBy: number;
  importedByName: string;
  rowsAdded: number;
  rowsDuplicate: number;
  rowsError: number;
  createdAt: string;
}

export function listImportHistory(limit = 50): ImportHistoryRow[] {
  return getDb()
    .select({
      id: imports.id,
      accountId: imports.accountId,
      accountName: accounts.name,
      profileId: imports.profileId,
      filename: imports.filename,
      importedBy: imports.importedBy,
      importedByName: users.name,
      rowsAdded: imports.rowsAdded,
      rowsDuplicate: imports.rowsDuplicate,
      rowsError: imports.rowsError,
      createdAt: imports.createdAt,
    })
    .from(imports)
    .innerJoin(accounts, eq(accounts.id, imports.accountId))
    .innerJoin(users, eq(users.id, imports.importedBy))
    .orderBy(desc(imports.id))
    .limit(limit)
    .all();
}

/** transaction ids associated with this import, split by whether this is their SOLE association. */
function partitionByAssociation(importId: number): { sole: number[]; shared: number[] } {
  const db = getDb();

  // Total associations per transaction, across ALL imports (not just this one),
  // computed as its own grouped subquery and joined back in — a correlated
  // subquery embedded via sql`` here would have its column reference resolve
  // to the subquery's own alias instead of the outer row, silently counting
  // every row in the table for every transaction.
  const counts = db
    .select({
      transactionId: transactionImports.transactionId,
      associations: sql<number>`count(*)`.as('associations'),
    })
    .from(transactionImports)
    .groupBy(transactionImports.transactionId)
    .as('counts');

  const rows = db
    .select({
      transactionId: transactionImports.transactionId,
      associations: counts.associations,
    })
    .from(transactionImports)
    .innerJoin(counts, eq(counts.transactionId, transactionImports.transactionId))
    .where(eq(transactionImports.importId, importId))
    .all();

  const sole: number[] = [];
  const shared: number[] = [];
  for (const row of rows) {
    if (row.associations <= 1) sole.push(row.transactionId);
    else shared.push(row.transactionId);
  }
  return { sole, shared };
}

/** Route-layer guard: an undo of an unknown importId must 404, not silently no-op. */
export function importExists(importId: number): boolean {
  return getDb().select({ id: imports.id }).from(imports).where(eq(imports.id, importId)).get() !== undefined;
}

export interface UndoPreview {
  importId: number;
  willDelete: number;
  willKeep: number;
}

export function previewUndoImport(importId: number): UndoPreview {
  const { sole, shared } = partitionByAssociation(importId);
  return { importId, willDelete: sole.length, willKeep: shared.length };
}

export interface UndoResult {
  deleted: number;
  kept: number;
}

export function undoImport(importId: number): UndoResult {
  const db = getDb();
  const { tokenize, untrain } = getImportHooks();
  const { sole, shared } = partitionByAssociation(importId);

  return db.transaction((tx) => {
    if (sole.length > 0) {
      // Reverse Bayes training for rows that had reached the confirmed state.
      const confirmed = tx
        .select({ normalizedMerchant: transactions.normalizedMerchant, categoryId: transactions.categoryId })
        .from(transactions)
        .where(
          and(
            inArray(transactions.id, sole),
            eq(transactions.categorizationSource, 'manual'),
            isNotNull(transactions.categoryId),
          ),
        )
        .all();
      for (const row of confirmed) {
        if (row.categoryId !== null) untrain(tokenize(row.normalizedMerchant), row.categoryId);
      }

      // transaction_imports rows cascade away with the transaction.
      tx.delete(transactions).where(inArray(transactions.id, sole)).run();
    }

    // Deleting the imports row is enough to clean up everything else:
    // transaction_imports rows for this import cascade away (onDelete: 'cascade'),
    // and any surviving transaction whose denormalized import_id pointed at this
    // import gets it set to NULL (onDelete: 'set null') — and ONLY when that row's
    // import_id actually was this import, not whichever import happened to share it.
    tx.delete(imports).where(eq(imports.id, importId)).run();
    return { deleted: sole.length, kept: shared.length };
  });
}

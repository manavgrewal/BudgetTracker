import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';

/** Shared across the loan write-side suites (reversal.test.ts, backfill.test.ts). */
export const NOW = '2026-08-18T12:00:00.000Z';

export interface LoanTestContext {
  t: TestDb;
  userId: number;
  accountId: number;
  typeId: number;
  seedLoan(over?: { name?: string; balanceCents?: number | null; principalCents?: number | null }): { itemId: number; accountId: number };
  spend(
    merchant: string,
    amountCents: number,
    over?: { accountId?: number; isTransfer?: boolean; date?: string; categoryId?: number | null },
  ): number;
  balanceOf(itemId: number): number | null;
}

export function setupLoanTest(): LoanTestContext {
  const t = createSeededTestDb();
  const userId = insertTestUser(t.db, { username: 'loans' });
  const accountId = insertTestAccount(t.db, { name: 'Chequing' });
  const type = t.sqlite
    .prepare(`insert into warranty_item_types (name, is_subscription, kind, created_at) values ('Car loan', 0, 'loan', ?) returning id`)
    .get(NOW) as { id: number };
  const typeId = type.id;

  function seedLoan(
    over: { name?: string; balanceCents?: number | null; principalCents?: number | null } = {},
  ): { itemId: number; accountId: number } {
    const balance = over.balanceCents === undefined ? 2_000_000 : over.balanceCents;
    const row = t.sqlite
      .prepare(
        `insert into warranty_items
           (name, purchase_date, is_lifetime, owner_user_id, type_id, principal_cents, current_balance_cents, balance_updated_at, created_at, updated_at)
         values (?, '2024-01-15', 0, ?, ?, ?, ?, ?, ?, ?) returning id`,
      )
      .get(over.name ?? 'Civic', userId, typeId, over.principalCents ?? null, balance, balance === null ? null : NOW, NOW, NOW) as {
      id: number;
    };
    return { itemId: row.id, accountId };
  }

  function spend(
    merchant: string,
    amountCents: number,
    over: { accountId?: number; isTransfer?: boolean; date?: string; categoryId?: number | null } = {},
  ): number {
    const row = t.sqlite
      .prepare(
        `insert into transactions
           (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, is_transfer, created_by, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
      )
      .get(
        over.accountId ?? accountId,
        over.date ?? '2026-08-01',
        merchant,
        // The engine's normalizer uppercases; the fixture matches what it would have written.
        merchant.toUpperCase(),
        amountCents,
        over.categoryId ?? null,
        over.isTransfer === true ? 1 : 0,
        userId,
        NOW,
        NOW,
      ) as { id: number };
    return row.id;
  }

  function balanceOf(itemId: number): number | null {
    return (t.sqlite.prepare('select current_balance_cents as b from warranty_items where id = ?').get(itemId) as { b: number | null }).b;
  }

  return { t, userId, accountId, typeId, seedLoan, spend, balanceOf };
}

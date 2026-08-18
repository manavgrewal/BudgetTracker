import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, insertTestUser, insertTestAccount, type TestDb } from '../helpers/db';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let t: TestDb;
beforeEach(() => {
  t = createTestDb();
});
afterEach(() => {
  t.cleanup();
});

const now = '2026-08-17T12:00:00.000Z';

/** A loan-kind type, a loan item, an account and a payment transaction. */
function seedLoan(): { itemId: number; accountId: number; txnId: number } {
  const userId = insertTestUser(t.db, { username: 'loanowner' });
  const accountId = insertTestAccount(t.db, { name: 'Chequing' });
  // Not a hardcoded id=1: migration 0003 already seeds id=1 ('Laptop'), so a literal id
  // here would collide with that unrelated pre-existing row. Let autoincrement assign it.
  const type = t.sqlite
    .prepare(
      `insert into warranty_item_types (name, is_subscription, kind, created_at) values ('Car loan', 0, 'loan', ?) returning id`,
    )
    .get(now) as { id: number };
  const item = t.sqlite
    .prepare(
      `insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, created_at, updated_at)
       values ('Civic', '2024-01-15', 0, ?, ?, ?, ?) returning id`,
    )
    .get(userId, type.id, now, now) as { id: number };
  const txn = t.sqlite
    .prepare(
      `insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
       values (?, '2026-08-01', 'HONDA FIN SVC', 'HONDA FIN SVC', -45000, ?, ?, ?) returning id`,
    )
    .get(accountId, userId, now, now) as { id: number };
  return { itemId: item.id, accountId, txnId: txn.id };
}

describe('MUST-11.2: the journal entry', () => {
  it('records idx 7 / when 1755820800000 / tag 0007_loans', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(root, 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
    };
    const entry = journal.entries.find((e) => e.idx === 7);
    expect(entry).toEqual({ idx: 7, version: '6', when: 1755820800000, tag: '0007_loans', breakpoints: true });
    // One day after 0006, matching the file's existing one-per-day cadence.
    const prior = journal.entries.find((e) => e.idx === 6);
    expect(entry!.when - prior!.when).toBe(86_400_000);
  });
});

describe('AC6 / MUST-19.3: the breakpoint marker never appears inside a comment', () => {
  it('every occurrence is a statement separator', () => {
    const sqlText = fs.readFileSync(path.join(root, 'drizzle/0007_loans.sql'), 'utf8');
    const marker = ['-->', 'statement-breakpoint'].join(' ');
    const total = sqlText.split(marker).length - 1;
    const withoutComments = sqlText
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--') || line.trimStart().startsWith(marker))
      .join('\n');
    expect(withoutComments.split(marker).length - 1).toBe(total);
    expect(total).toBeGreaterThan(0);
  });
});

describe('MUST-3.1 / AC6: 0007 is a loans-only migration', () => {
  it('carries no update-feature object outside the header prose', () => {
    const sqlText = fs.readFileSync(path.join(root, 'drizzle/0007_loans.sql'), 'utf8');
    const statements = sqlText
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    // \b...\b (not a plain /update/i) so the mandated `balance_updated_at` column name
    // -- "updated" has no word boundary after "update" -- doesn't false-positive here;
    // an actual UPDATE statement (e.g. 0004's `UPDATE warranty_item_types SET ...`) still
    // matches on its trailing space/non-word boundary.
    expect(statements).not.toMatch(/\bupdate\b/i);
    // ...and the settings table is untouched: absence is the update feature's off state.
    expect(statements).not.toMatch(/settings/i);
  });
});

describe('MUST-11.5 / MUST-11.17: the shapes exist after migration', () => {
  it('adds the four money columns to warranty_items, physically last', () => {
    const cols = t.sqlite.prepare(`pragma table_info(warranty_items)`).all() as { name: string; type: string }[];
    const tail = cols.slice(-4).map((c) => c.name);
    expect(tail).toEqual(['principal_cents', 'interest_rate_bps', 'current_balance_cents', 'balance_updated_at']);
    const byName = new Map(cols.map((c) => [c.name, c.type.toLowerCase()]));
    expect(byName.get('principal_cents')).toBe('integer');
    expect(byName.get('interest_rate_bps')).toBe('integer');
    expect(byName.get('current_balance_cents')).toBe('integer');
    expect(byName.get('balance_updated_at')).toBe('text');
  });

  it('creates both tables, empty', () => {
    const names = t.sqlite
      .prepare(`select name from sqlite_master where type = 'table' and name like 'loan_%' order by name`)
      .all() as { name: string }[];
    expect(names.map((r) => r.name)).toEqual(['loan_matcher_rules', 'loan_payments']);
    for (const table of ['loan_matcher_rules', 'loan_payments']) {
      const { n } = t.sqlite.prepare(`select count(*) as n from ${table}`).get() as { n: number };
      expect(n).toBe(0);
    }
  });

  it('creates all five named indexes', () => {
    const names = t.sqlite
      .prepare(`select name from sqlite_master where type = 'index' and name like 'loan_%' order by name`)
      .all() as { name: string }[];
    expect(names.map((r) => r.name)).toEqual([
      'loan_matcher_rules_item_idx',
      'loan_matcher_rules_uq',
      'loan_payments_item_idx',
      'loan_payments_txn_idx',
      'loan_payments_txn_item_uq',
    ]);
  });
});

describe('MUST-11.5: the money-column CHECK constraints', () => {
  it('rejects a negative principal and a negative balance', () => {
    const { itemId } = seedLoan();
    expect(() =>
      t.sqlite.prepare(`update warranty_items set principal_cents = -1 where id = ?`).run(itemId),
    ).toThrowError(/CHECK constraint failed/i);
    expect(() =>
      t.sqlite.prepare(`update warranty_items set current_balance_cents = -1 where id = ?`).run(itemId),
    ).toThrowError(/CHECK constraint failed/i);
  });

  it('accepts zero and rejects a rate above 10000% (1000000 bps)', () => {
    const { itemId } = seedLoan();
    t.sqlite.prepare(`update warranty_items set principal_cents = 0, current_balance_cents = 0 where id = ?`).run(itemId);
    t.sqlite.prepare(`update warranty_items set interest_rate_bps = 1000000 where id = ?`).run(itemId);
    expect(() =>
      t.sqlite.prepare(`update warranty_items set interest_rate_bps = 1000001 where id = ?`).run(itemId),
    ).toThrowError(/CHECK constraint failed/i);
    expect(() =>
      t.sqlite.prepare(`update warranty_items set interest_rate_bps = -1 where id = ?`).run(itemId),
    ).toThrowError(/CHECK constraint failed/i);
  });
});

describe('MUST-11.9 / MUST-11.10 / MUST-11.17: loan_matcher_rules', () => {
  function addRule(itemId: number, merchant: string, accountId: number | null): void {
    t.sqlite
      .prepare(
        `insert into loan_matcher_rules (item_id, merchant_contains, account_id, enabled, created_at, updated_at)
         values (?, ?, ?, 1, ?, ?)`,
      )
      .run(itemId, merchant, accountId, now, now);
  }

  it('rejects a two-character merchant substring', () => {
    const { itemId } = seedLoan();
    expect(() => addRule(itemId, 'HO', null)).toThrowError(/CHECK constraint failed/i);
    // ...and rejects three characters that are only whitespace-padded to length.
    expect(() => addRule(itemId, ' A ', null)).toThrowError(/CHECK constraint failed/i);
    addRule(itemId, 'HON', null);
  });

  it('MUST-11.17: the coalesce(account_id, -1) expression index catches a duplicate NULL pair', () => {
    const { itemId, accountId } = seedLoan();
    addRule(itemId, 'HONDA FIN', null);
    // A plain UNIQUE index would let this through, because NULL != NULL in SQL.
    expect(() => addRule(itemId, 'HONDA FIN', null)).toThrowError(/UNIQUE constraint failed/i);
    addRule(itemId, 'HONDA FIN', accountId);
    expect(() => addRule(itemId, 'HONDA FIN', accountId)).toThrowError(/UNIQUE constraint failed/i);
  });

  it('cascades on account delete', () => {
    const { itemId } = seedLoan();
    // A fresh account, not seedLoan's -- that one is already referenced by a transaction,
    // and transactions.account_id has no ON DELETE CASCADE, so deleting it would throw for
    // an unrelated reason before ever exercising loan_matcher_rules' own cascade.
    const accountId = insertTestAccount(t.db, { name: 'Second Account' });
    addRule(itemId, 'HONDA FIN', accountId);
    t.sqlite.prepare(`delete from accounts where id = ?`).run(accountId);
    const { n } = t.sqlite.prepare(`select count(*) as n from loan_matcher_rules`).get() as { n: number };
    expect(n).toBe(0);
  });
});

describe('MUST-11.13 … MUST-11.16: loan_payments', () => {
  function addLink(txnId: number, itemId: number, amount: number, applied: number, source = 'rule'): void {
    t.sqlite
      .prepare(
        `insert into loan_payments (txn_id, item_id, amount_cents, applied_cents, source, created_at)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(txnId, itemId, amount, applied, source, now);
  }

  it('rejects a non-positive amount, an over-applied figure and an unknown source', () => {
    const { itemId, txnId } = seedLoan();
    expect(() => addLink(txnId, itemId, 0, 0)).toThrowError(/CHECK constraint failed/i);
    expect(() => addLink(txnId, itemId, 45000, 45001)).toThrowError(/CHECK constraint failed/i);
    expect(() => addLink(txnId, itemId, 45000, -1)).toThrowError(/CHECK constraint failed/i);
    expect(() => addLink(txnId, itemId, 45000, 0, 'auto')).toThrowError(/CHECK constraint failed/i);
    addLink(txnId, itemId, 45000, 45000);
  });

  it('MUST-11.15: (txn_id, item_id) is unique, and MUST-11.16 lets one txn fund two loans', () => {
    const { itemId, txnId } = seedLoan();
    addLink(txnId, itemId, 45000, 45000);
    expect(() => addLink(txnId, itemId, 45000, 0)).toThrowError(/UNIQUE constraint failed/i);
    const second = t.sqlite
      .prepare(
        `insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, created_at, updated_at)
         values ('Boat', '2024-02-01', 0, (select owner_user_id from warranty_items where id = ?), 1, ?, ?) returning id`,
      )
      .get(itemId, now, now) as { id: number };
    addLink(txnId, second.id, 45000, 5000);
    const { n } = t.sqlite.prepare(`select count(*) as n from loan_payments where txn_id = ?`).get(txnId) as { n: number };
    expect(n).toBe(2);
  });

  it('cascades away with its transaction, and with its item', () => {
    const { itemId, txnId } = seedLoan();
    addLink(txnId, itemId, 45000, 45000);
    t.sqlite.prepare(`delete from transactions where id = ?`).run(txnId);
    expect((t.sqlite.prepare(`select count(*) as n from loan_payments`).get() as { n: number }).n).toBe(0);

    const { itemId: second, txnId: secondTxn } = (() => {
      const txn = t.sqlite
        .prepare(
          `insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
           values ((select id from accounts limit 1), '2026-09-01', 'HONDA FIN SVC', 'HONDA FIN SVC', -45000,
                   (select owner_user_id from warranty_items where id = ?), ?, ?) returning id`,
        )
        .get(itemId, now, now) as { id: number };
      return { itemId, txnId: txn.id };
    })();
    addLink(secondTxn, second, 45000, 45000);
    t.sqlite.prepare(`delete from warranty_items where id = ?`).run(second);
    expect((t.sqlite.prepare(`select count(*) as n from loan_payments`).get() as { n: number }).n).toBe(0);
  });
});

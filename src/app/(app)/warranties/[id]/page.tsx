import { notFound } from 'next/navigation';
import { listAccounts } from '@/lib/accounts';
import { requireUser } from '@/lib/auth/session';
import { listUsers } from '@/lib/auth/users';
import { todayIso } from '@/lib/dates';
import { listLoanRules, listLoans } from '@/lib/loans';
import { displayNameOf, getTransaction } from '@/lib/transactions';
import { warrantyStatus } from '@/lib/warranty/expiry';
import { getWarrantyItem, listWarrantyReceipts } from '@/lib/warranty/items';
import { listItemTypes } from '@/lib/warranty/types';
import { WarrantyDetailClient } from './warranty-detail-client';

export const dynamic = 'force-dynamic';

export default async function WarrantyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id: raw } = await params;
  if (!/^\d+$/.test(raw)) notFound();
  const item = getWarrantyItem(Number(raw));
  if (!item) notFound();

  const txn = item.transactionId === null ? null : getTransaction(item.transactionId);
  const today = todayIso();
  // v1.3.1: the loan summary (payoff fraction, last payment, payment count) this item's
  // read-only money block renders -- undefined for a non-loan item, or a loan whose money
  // fields haven't been filled in yet.
  const loanSummary = listLoans(today).find((loan) => loan.itemId === item.id);

  return (
    <WarrantyDetailClient
      item={item}
      receipts={listWarrantyReceipts(item.id)}
      status={warrantyStatus(item, today)}
      people={listUsers().filter((u) => u.isActive).map((u) => ({ id: u.id, name: u.name }))}
      types={listItemTypes().map((t) => ({ id: t.id, name: t.name, kind: t.kind }))}
      today={today}
      linkedTransaction={txn ? { id: txn.id, date: txn.date, description: displayNameOf(txn) } : null}
      /* §10.4: never render a dead link. ON DELETE SET NULL leaves no durable marker that
         a link USED to exist, so the only detectable case is a dangling id, which is what
         a database restored with foreign keys off would produce. See the plan's
         "Spec ambiguities resolved" note. */
      linkRemoved={item.transactionId !== null && txn === null}
      rules={listLoanRules(item.id)}
      accounts={listAccounts().map((a) => ({ id: a.id, name: a.name }))}
      payoffFraction={loanSummary?.payoffFraction ?? null}
      lastPaymentAt={loanSummary?.lastPaymentAt ?? null}
      paymentCount={loanSummary?.paymentCount ?? 0}
    />
  );
}

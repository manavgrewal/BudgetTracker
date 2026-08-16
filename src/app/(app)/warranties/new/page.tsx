import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { listUsers } from '@/lib/auth/users';
import { todayIso } from '@/lib/dates';
import { displayNameOf, getTransaction } from '@/lib/transactions';
import { listItemTypes } from '@/lib/warranty/types';
import { NewWarrantyClient, type WarrantyPrefill } from './new-warranty-client';

export const dynamic = 'force-dynamic';

/**
 * MUST-11.3: prefill is computed SERVER-SIDE from the transaction row. The query parameter
 * carries only the id; no field value is ever trusted from the URL.
 */
function prefillFromTransaction(transactionId: number): WarrantyPrefill {
  const txn = getTransaction(transactionId);
  if (!txn) notFound();
  return {
    purchaseDate: txn.date,
    // The ledger stores spend negative; a warranty stores a positive price (§3.2 / §17.26).
    priceCents: Math.abs(txn.amountCents),
    vendor: displayNameOf(txn).replace(/\s+/g, ' ').trim().slice(0, 60),
    transactionId: txn.id,
  };
}

export default async function NewWarrantyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const raw = Array.isArray(params.transactionId) ? params.transactionId[0] : params.transactionId;
  const prefill = raw && /^\d+$/.test(raw) ? prefillFromTransaction(Number(raw)) : {};

  return (
    <NewWarrantyClient
      people={listUsers().filter((u) => u.isActive).map((u) => ({ id: u.id, name: u.name }))}
      types={listItemTypes().map((t) => ({ id: t.id, name: t.name, isSubscription: t.isSubscription }))}
      currentUserId={user.id}
      today={todayIso()}
      prefill={prefill}
    />
  );
}

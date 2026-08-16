import { requireUser } from '@/lib/auth/session';
import { listCategories } from '@/lib/categories';
import { countMatchingMerchant, listReviewQueue } from '@/lib/transactions';
import { reviewQueueCount } from '@/lib/categorize/engine';
import { ReviewClient } from './review-client';

export const dynamic = 'force-dynamic';

export default async function ReviewPage() {
  await requireUser();
  const rows = listReviewQueue(100, 0);
  return (
    <ReviewClient
      total={reviewQueueCount()}
      rows={rows.map((row) => ({ ...row, matchingCount: countMatchingMerchant(row.normalizedMerchant) }))}
      categories={listCategories().map((c) => ({ id: c.id, name: c.name, parentId: c.parentId }))}
    />
  );
}

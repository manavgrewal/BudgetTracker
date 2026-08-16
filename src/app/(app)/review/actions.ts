'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/session';
import { isSameOrigin } from '@/lib/auth/csrf';
import { applyCategoryToMatching, confirmCategory, setTransferFlag } from '@/lib/categorize/engine';
import { getTransaction } from '@/lib/transactions';

export interface ReviewState {
  error?: string;
  message?: string;
}

const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';

export async function acceptGuessAction(_prev: ReviewState, formData: FormData): Promise<ReviewState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const transactionId = Number(formData.get('transactionId'));
  const row = getTransaction(transactionId);
  if (!row || row.categoryId === null) return { error: 'There is no guess to accept on that row.' };
  confirmCategory({ transactionId, categoryId: row.categoryId, userId: user.id });
  revalidatePath('/review');
  return { message: 'Accepted.' };
}

const idFieldsSchema = z.object({
  transactionId: z.coerce.number().int().positive(),
  categoryId: z.coerce.number().int().positive(),
});

export async function fixCategoryAction(_prev: ReviewState, formData: FormData): Promise<ReviewState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const parsed = idFieldsSchema.safeParse({
    transactionId: formData.get('transactionId'),
    categoryId: formData.get('categoryId'),
  });
  if (!parsed.success) return { error: 'Pick a category.' };
  try {
    confirmCategory({ transactionId: parsed.data.transactionId, categoryId: parsed.data.categoryId, userId: user.id });
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not update that transaction.' };
  }
  revalidatePath('/review');
  return { message: 'Category set and rule created.' };
}

export async function applyToAllMatchingAction(_prev: ReviewState, formData: FormData): Promise<ReviewState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const normalizedMerchant = String(formData.get('normalizedMerchant') ?? '');
  const categoryId = Number(formData.get('categoryId'));
  if (normalizedMerchant.length === 0 || !Number.isInteger(categoryId) || categoryId <= 0) return { error: 'Pick a category.' };
  const count = applyCategoryToMatching({ normalizedMerchant, categoryId, userId: user.id });
  revalidatePath('/review');
  return { message: `Applied to ${count} transactions and created a rule.` };
}

export async function markTransferAction(_prev: ReviewState, formData: FormData): Promise<ReviewState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const parsed = z.object({ transactionId: z.coerce.number().int().positive() }).safeParse({
    transactionId: formData.get('transactionId'),
  });
  if (!parsed.success) return { error: 'Invalid request.' };
  try {
    setTransferFlag({ transactionId: parsed.data.transactionId, isTransfer: true, userId: user.id });
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not update that transaction.' };
  }
  revalidatePath('/review');
  return { message: 'Marked as a transfer and learned an exact rule.' };
}

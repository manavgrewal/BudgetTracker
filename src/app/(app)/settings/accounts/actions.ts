'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/csrf';
import { requireAdmin } from '@/lib/auth/session';
import { createAccount, getAccount, renameAccount, setAccountActive, setAccountOwner } from '@/lib/accounts';
import { findUserById } from '@/lib/auth/users';

export interface AccountsFormState {
  error?: string;
  message?: string;
}

const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';

/** '' = Joint/household (spec section 3: owner_user_id NULL means joint). */
const ownerField = z.string().refine((value) => value === '' || /^\d+$/.test(value), 'Pick an owner, or Joint.');

function ownerIdOf(value: string): number | null {
  return value === '' ? null : Number(value);
}

/** The FK would throw a raw SQLite error; check first so the form gets a sentence instead. */
function ownerError(ownerUserId: number | null): string | null {
  if (ownerUserId === null) return null;
  return findUserById(ownerUserId) ? null : 'That person no longer exists.';
}

const createSchema = z.object({
  name: z.string().trim().min(1, 'Give the account a name').max(80),
  institution: z.string().trim().max(80),
  type: z.enum(['chequing', 'credit', 'cash']),
  owner: ownerField,
});

export async function createAccountAction(_prev: AccountsFormState, formData: FormData): Promise<AccountsFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = createSchema.safeParse({
    name: formData.get('name') ?? '',
    institution: formData.get('institution') ?? '',
    type: formData.get('type') ?? 'chequing',
    owner: String(formData.get('owner') ?? ''),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Please check the form.' };

  const ownerUserId = ownerIdOf(parsed.data.owner);
  const invalidOwner = ownerError(ownerUserId);
  if (invalidOwner) return { error: invalidOwner };

  try {
    createAccount({
      name: parsed.data.name,
      institution: parsed.data.institution,
      type: parsed.data.type,
      ownerUserId,
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not create the account.' };
  }

  revalidatePath('/settings/accounts');
  revalidatePath('/import');
  revalidatePath('/dashboard');
  return { message: `Added ${parsed.data.name}. It is now selectable on the Import page.` };
}

export async function renameAccountAction(_prev: AccountsFormState, formData: FormData): Promise<AccountsFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = z
    .object({ accountId: z.coerce.number().int().positive(), name: z.string().trim().min(1, 'Give the account a name').max(80) })
    .safeParse({ accountId: formData.get('accountId'), name: formData.get('name') ?? '' });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };
  if (!getAccount(parsed.data.accountId)) return { error: 'That account no longer exists.' };

  renameAccount(parsed.data.accountId, parsed.data.name);
  revalidatePath('/settings/accounts');
  revalidatePath('/import');
  return { message: `Renamed to ${parsed.data.name}. Transactions and import history are untouched.` };
}

export async function setAccountOwnerAction(_prev: AccountsFormState, formData: FormData): Promise<AccountsFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = z
    .object({ accountId: z.coerce.number().int().positive(), owner: ownerField })
    .safeParse({ accountId: formData.get('accountId'), owner: String(formData.get('owner') ?? '') });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };
  if (!getAccount(parsed.data.accountId)) return { error: 'That account no longer exists.' };

  const ownerUserId = ownerIdOf(parsed.data.owner);
  const invalidOwner = ownerError(ownerUserId);
  if (invalidOwner) return { error: invalidOwner };

  setAccountOwner(parsed.data.accountId, ownerUserId);
  revalidatePath('/settings/accounts');
  // Attribution of NEW transactions follows the owner; existing rows keep the
  // person they were already attributed to, which is why nothing is rewritten here.
  return { message: ownerUserId === null ? 'Owner set to Joint.' : 'Owner updated.' };
}

/**
 * Archive-only, exactly like categories and users: an account id is referenced
 * by transactions, imports and SimpleFIN links forever, so deactivating hides
 * it from the pickers and nothing more. There is deliberately no delete.
 */
export async function setAccountActiveAction(_prev: AccountsFormState, formData: FormData): Promise<AccountsFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = z
    .object({ accountId: z.coerce.number().int().positive(), active: z.enum(['0', '1']) })
    .safeParse({ accountId: formData.get('accountId'), active: formData.get('active') });
  if (!parsed.success) return { error: 'Invalid request.' };
  if (!getAccount(parsed.data.accountId)) return { error: 'That account no longer exists.' };

  setAccountActive(parsed.data.accountId, parsed.data.active === '1');
  revalidatePath('/settings/accounts');
  revalidatePath('/import');
  revalidatePath('/dashboard');
  return {
    message:
      parsed.data.active === '1'
        ? 'Account reactivated.'
        : 'Account deactivated. Its transactions and history stay exactly where they are.',
  };
}

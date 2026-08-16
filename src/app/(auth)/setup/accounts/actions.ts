'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/csrf';
import { requireAdmin } from '@/lib/auth/session';
import { createAccount } from '@/lib/accounts';

export interface SetupAccountsState {
  error?: string;
}

const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';

const rowsSchema = z.array(
  z.object({
    name: z.string().trim().min(1, 'Give every account a name, or remove the empty row').max(80),
    type: z.enum(['chequing', 'credit', 'cash']),
    // '' = Joint/household, which is what a family's main chequing account is.
    owner: z.string().refine((value) => value === '' || /^\d+$/.test(value), 'Pick an owner, or Joint.'),
  }),
);

/**
 * Optional wizard step (spec section 6: "create admin -> seed categories ->
 * optionally create accounts"). Skipping is a plain link to /dashboard; the
 * same accounts can be added later under Settings -> Bank accounts, which uses
 * the same lib functions.
 */
export async function saveSetupAccountsAction(_prev: SetupAccountsState, formData: FormData): Promise<SetupAccountsState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const admin = await requireAdmin();

  let raw: unknown;
  try {
    raw = JSON.parse(String(formData.get('accounts') ?? '[]'));
  } catch {
    return { error: 'Could not read the account list. Please try again.' };
  }

  const parsed = rowsSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Please check the accounts.' };

  for (const row of parsed.data) {
    const ownerUserId = row.owner === '' ? null : Number(row.owner);
    try {
      createAccount({
        name: row.name,
        institution: '',
        type: row.type,
        // Only the admin exists at this point in the wizard, so any non-Joint
        // row belongs to them; anything else is a forged id and falls back to Joint.
        ownerUserId: ownerUserId === admin.id ? ownerUserId : null,
      });
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Could not create that account.' };
    }
  }

  redirect('/dashboard');
}

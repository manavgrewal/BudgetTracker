'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/csrf';
import { requireUser } from '@/lib/auth/session';
import { importMappingSchema } from '@/lib/import/mapping';
import { createProfile, getProfileByName } from '@/lib/import/presets';
import { deleteStagedFile } from '@/lib/import/staging';

export interface WizardState {
  error?: string;
  message?: string;
}

const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';

const saveSchema = z.object({
  name: z.string().trim().min(1, 'Give the profile a name').max(80),
  institution: z.string().trim().min(1, 'Which bank is this?').max(80),
  mapping: importMappingSchema,
  stagingId: z.string().uuid().optional(),
});

export async function saveWizardProfileAction(_prev: WizardState, formData: FormData): Promise<WizardState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireUser();
  const parsed = saveSchema.safeParse({
    name: formData.get('name') ?? '',
    institution: formData.get('institution') ?? '',
    mapping: JSON.parse(String(formData.get('mapping') ?? '{}')),
    stagingId: (formData.get('stagingId') as string | null) ?? undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Check the mapping.' };
  if (getProfileByName(parsed.data.name)) return { error: `A profile named "${parsed.data.name}" already exists.` };

  createProfile({ name: parsed.data.name, institution: parsed.data.institution, mapping: parsed.data.mapping });
  if (parsed.data.stagingId) deleteStagedFile(parsed.data.stagingId);
  revalidatePath('/import');
  return { message: `Saved "${parsed.data.name}". Pick it on the Import page and upload the real file.` };
}

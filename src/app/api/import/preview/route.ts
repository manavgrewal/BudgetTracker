import { z } from 'zod';
import { CsrfError, assertSameOrigin } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { getAccount } from '@/lib/accounts';
import { importMappingSchema } from '@/lib/import/mapping';
import { getProfile } from '@/lib/import/presets';
import { buildPreview } from '@/lib/import/preview';
import { StagingError, writeStagedFile } from '@/lib/import/staging';
import { ImportLimitError, MAX_FILE_BYTES } from '@/lib/import/parse';

const bodySchema = z.object({
  stagingId: z.string().uuid(),
  filename: z.string().min(1).max(255),
  accountId: z.coerce.number().int().positive(),
  profileId: z.coerce.number().int().positive(),
  mapping: importMappingSchema.optional(),
});

function tooLarge(): Response {
  return Response.json({ error: `File is larger than ${MAX_FILE_BYTES} bytes`, code: 'file_too_large' }, { status: 413 });
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
  } catch (error) {
    if (error instanceof CsrfError) return Response.json({ error: 'Forbidden' }, { status: 403 });
    throw error;
  }
  const user = userFromRequest(request);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  // Reject on the declared size BEFORE formData()/json() buffers the whole
  // body — an authenticated user could otherwise force an arbitrarily large
  // body into memory before any per-file cap is ever consulted (review
  // finding 1).
  const contentLength = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_FILE_BYTES) return tooLarge();

  const contentType = request.headers.get('content-type') ?? '';
  let payload: unknown;

  if (contentType.includes('multipart/form-data')) {
    // First hop: the browser posts the file itself.
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return Response.json({ error: 'No file uploaded' }, { status: 400 });
    // content-length can be absent/wrong; the file's own size is
    // authoritative and is known without reading its bytes yet. Validate
    // BEFORE buffering/staging (review finding 4) — an oversized file must
    // never land on disk.
    if (file.size > MAX_FILE_BYTES) return tooLarge();
    const buf = Buffer.from(await file.arrayBuffer());
    const stagingId = writeStagedFile(buf);
    payload = {
      stagingId,
      filename: file.name,
      accountId: form.get('accountId'),
      profileId: form.get('profileId'),
    };
  } else {
    payload = await request.json();
  }

  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });

  const account = getAccount(parsed.data.accountId);
  if (!account) return Response.json({ error: 'Unknown account' }, { status: 404 });
  const profile = getProfile(parsed.data.profileId);
  if (!profile) return Response.json({ error: 'Unknown import profile' }, { status: 404 });

  try {
    const preview = buildPreview({
      stagingId: parsed.data.stagingId,
      filename: parsed.data.filename,
      accountId: parsed.data.accountId,
      profileId: parsed.data.profileId,
      mapping: parsed.data.mapping ?? profile.mapping,
    });
    return Response.json(preview);
  } catch (error) {
    if (error instanceof ImportLimitError) return Response.json({ error: error.message, code: error.code }, { status: 413 });
    if (error instanceof StagingError) return Response.json({ error: error.message }, { status: 410 });
    throw error;
  }
}

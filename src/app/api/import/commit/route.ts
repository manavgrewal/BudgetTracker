import { z } from 'zod';
import { CsrfError, assertSameOrigin } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { getAccount } from '@/lib/accounts';
import { importMappingSchema } from '@/lib/import/mapping';
import { getProfile } from '@/lib/import/presets';
import { commitStagedImport } from '@/lib/import/flow';
import { StagingError } from '@/lib/import/staging';
import { ImportLimitError, MAX_FILE_BYTES } from '@/lib/import/parse';

const bodySchema = z.object({
  stagingId: z.string().uuid(),
  filename: z.string().min(1).max(255),
  accountId: z.number().int().positive(),
  profileId: z.number().int().positive(),
  mapping: importMappingSchema,
});

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
  } catch (error) {
    if (error instanceof CsrfError) return Response.json({ error: 'Forbidden' }, { status: 403 });
    throw error;
  }
  const user = userFromRequest(request);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  // This route never carries file bytes itself (the file is already staged),
  // but the JSON body is still fully buffered by request.json() — reject an
  // implausibly large body on its declared size before that happens, the
  // same defence applied to the upload routes (review finding 1).
  const contentLength = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_FILE_BYTES) {
    return Response.json({ error: `Request body is larger than ${MAX_FILE_BYTES} bytes`, code: 'file_too_large' }, { status: 413 });
  }

  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
  if (!getAccount(parsed.data.accountId)) return Response.json({ error: 'Unknown account' }, { status: 404 });
  if (!getProfile(parsed.data.profileId)) return Response.json({ error: 'Unknown import profile' }, { status: 404 });

  try {
    const result = commitStagedImport({ ...parsed.data, userId: user.id });
    return Response.json(result);
  } catch (error) {
    if (error instanceof ImportLimitError) return Response.json({ error: error.message, code: error.code }, { status: 413 });
    if (error instanceof StagingError) return Response.json({ error: error.message }, { status: 410 });
    throw error;
  }
}

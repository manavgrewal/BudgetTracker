import { z } from 'zod';
import { CsrfError, assertSameOrigin } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { importExists, previewUndoImport, undoImport } from '@/lib/import/commit';

const bodySchema = z.object({
  importId: z.number().int().positive(),
  confirm: z.boolean().default(false),
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

  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) return Response.json({ error: 'Invalid request' }, { status: 400 });
  if (!importExists(parsed.data.importId)) return Response.json({ error: 'Unknown import' }, { status: 404 });

  // Without confirm the caller gets the counts for the confirmation dialog.
  if (!parsed.data.confirm) {
    return Response.json(previewUndoImport(parsed.data.importId));
  }
  return Response.json(undoImport(parsed.data.importId));
}

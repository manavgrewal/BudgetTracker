import { z } from 'zod';
import { CsrfError, assertSameOrigin } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { ImportLimitError, MAX_FILE_BYTES, previewRawRows } from '@/lib/import/parse';
import { writeStagedFile } from '@/lib/import/staging';

const encodingSchema = z.enum(['auto', 'utf-8', 'windows-1252']).default('auto');

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

  // Reject on the declared size BEFORE formData() buffers the whole body —
  // an authenticated user could otherwise force an arbitrarily large body
  // into memory before any per-file cap is ever consulted (review finding 1).
  const contentLength = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_FILE_BYTES) return tooLarge();

  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return Response.json({ error: 'No file uploaded' }, { status: 400 });
  // content-length can be absent/wrong (e.g. chunked transfer); the file's
  // own size is authoritative and is known without reading its bytes yet.
  if (file.size > MAX_FILE_BYTES) return tooLarge();

  const encoding = encodingSchema.parse(form.get('encoding') ?? 'auto');
  const buf = Buffer.from(await file.arrayBuffer());

  try {
    const { rows, encoding: detected } = previewRawRows(buf, encoding, 10);
    const stagingId = writeStagedFile(buf);
    return Response.json({ stagingId, filename: file.name, encoding: detected, rows });
  } catch (error) {
    if (error instanceof ImportLimitError) return Response.json({ error: error.message, code: error.code }, { status: 413 });
    throw error;
  }
}

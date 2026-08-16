import { z } from 'zod';
import { CsrfError, assertSameOrigin } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { enqueueOcrJob } from '@/lib/warranty/ocr/queue';
import {
  MAX_FILES_PER_UPLOAD,
  MAX_RECEIPT_BYTES,
  MAX_UPLOAD_BYTES,
  sha256Bytes,
} from '@/lib/warranty/receipts';
import { HEIC_MESSAGE, UNSUPPORTED_TYPE_MESSAGE, extForMime, looksLikeHeic, sniffReceiptType } from '@/lib/warranty/sniff';
import { writeStagedReceipt } from '@/lib/warranty/staging';

export const dynamic = 'force-dynamic';

/**
 * The ONE multipart endpoint this feature adds (MUST-6.2). File bytes must not travel
 * through a Next server action: Next 15 caps a server action body at 1 MB by default, so a
 * 10 MB receipt would fail with an opaque error, and raising the limit globally would raise
 * it for every other action in the app. The codebase already routes CSV bytes through
 * /api/import/* for exactly this reason.
 */

/** MUST-13.7: zod on the derived per-part metadata, not just on JSON bodies. */
const partSchema = z.object({
  originalFilename: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().positive().max(MAX_RECEIPT_BYTES),
});

function tooLarge(): Response {
  return Response.json(
    { error: `Each receipt must be ${MAX_RECEIPT_BYTES} bytes or smaller.`, code: 'file_too_large' },
    { status: 413 },
  );
}

/**
 * MINOR 2 (review): the Content-Length pre-check trips at MAX_UPLOAD_BYTES (the whole
 * request, up to MAX_FILES_PER_UPLOAD receipts), not at the per-file MAX_RECEIPT_BYTES cap
 * tooLarge() describes — reusing that message on this branch told a member uploading five
 * legitimately-sized 9 MB receipts that "each receipt must be 10485760 bytes or smaller",
 * which is false. This message names the actual limit that tripped.
 */
function requestTooLarge(): Response {
  return Response.json(
    { error: `The whole upload must be ${MAX_UPLOAD_BYTES} bytes (50 MB) or smaller.`, code: 'file_too_large' },
    { status: 413 },
  );
}

export async function POST(request: Request): Promise<Response> {
  // MUST-6.3: the STRICT origin check, first, before anything else. This is a mutating
  // request; the relaxed headerless rule of the download GETs does not apply to it.
  try {
    assertSameOrigin(request);
  } catch (error) {
    if (error instanceof CsrfError) return Response.json({ error: 'Forbidden' }, { status: 403 });
    throw error;
  }

  const user = userFromRequest(request);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  // MUST-6.5(a): refuse on the DECLARED size before formData() buffers the whole body —
  // the same pre-check the import routes already make.
  const contentLength = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) return requestTooLarge();

  const form = await request.formData();
  const parts = form.getAll('file').filter((value): value is File => value instanceof File);
  if (parts.length === 0) return Response.json({ error: 'No file uploaded', code: 'no_file' }, { status: 400 });
  if (parts.length > MAX_FILES_PER_UPLOAD) {
    return Response.json(
      { error: `Upload at most ${MAX_FILES_PER_UPLOAD} files at once.`, code: 'too_many_files' },
      { status: 413 },
    );
  }

  // MUST-6.5(b): validate EVERY part before writing ANY of them. A request that fails is
  // rejected whole — no partial staging.
  const prepared: { buf: Buffer; mime: ReturnType<typeof sniffReceiptType>; originalFilename: string }[] = [];
  for (const part of parts) {
    if (part.size > MAX_RECEIPT_BYTES) return tooLarge();
    const buf = Buffer.from(await part.arrayBuffer());
    if (buf.length === 0) return Response.json({ error: 'That file is empty.', code: 'empty_file' }, { status: 400 });
    if (buf.length > MAX_RECEIPT_BYTES) return tooLarge();

    // MUST-4.5: type decided by LEADING BYTES, never by extension, never by the
    // browser-declared Content-Type.
    const mime = sniffReceiptType(buf);
    if (mime === null) {
      return Response.json(
        { error: looksLikeHeic(buf) ? HEIC_MESSAGE : UNSUPPORTED_TYPE_MESSAGE, code: 'unsupported_type' },
        { status: 400 },
      );
    }

    // MINOR 3 (review): a blank/whitespace-only part name (a drag-and-drop from some
    // clients, or a deliberately empty File.name) used to fall through to zod's min(1) and
    // surface a raw internal message ("Too small: expected string...") as a user-facing
    // 400. Fall back to a generated name instead, exactly like commitStaged's
    // `receipt.<ext>` fallback in items.ts — the lower layer already treats a blank
    // original filename as a non-error, so this layer must not be stricter than it.
    const rawName = part.name.trim();
    const originalFilename = rawName.length > 0 ? rawName.slice(0, 255) : `receipt.${extForMime(mime)}`;
    const meta = partSchema.safeParse({ originalFilename, sizeBytes: buf.length });
    if (!meta.success) {
      return Response.json({ error: meta.error.issues[0]?.message ?? 'Invalid file', code: 'no_file' }, { status: 400 });
    }
    prepared.push({ buf, mime, originalFilename: meta.data.originalFilename });
  }

  const staged = prepared.map((part) => {
    // MUST-6.6: write to ${DATA_DIR}/tmp, then enqueue an OCR job of kind 'staged'.
    const stagingId = writeStagedReceipt(part.buf, part.mime!);
    enqueueOcrJob({ kind: 'staged', stagingId });
    return {
      stagingId,
      originalFilename: part.originalFilename,
      mime: part.mime,
      sizeBytes: part.buf.length,
      sha256: sha256Bytes(part.buf),
    };
  });

  return Response.json({ staged });
}

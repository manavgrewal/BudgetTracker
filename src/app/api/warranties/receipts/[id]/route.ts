import fs from 'node:fs';
import { Readable } from 'node:stream';
import { isSameOriginOrHeaderless } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { getWarrantyReceipt } from '@/lib/warranty/items';
import { resolveReceiptPath } from '@/lib/warranty/receipts';
import type { ReceiptMime } from '@/lib/warranty/sniff';

export const dynamic = 'force-dynamic';

/**
 * MINOR 9 (review): an explicit ALLOWLIST of the mimes that render inline, not
 * "pdf -> attachment, else inline". sniffReceiptType's accepted set is exactly four
 * values today, but a future widening of that set (e.g. a new document type) must fail
 * SAFE — landing in the attachment branch by default — rather than silently becoming
 * inline just because it wasn't the one type this file happened to special-case.
 */
const INLINE_MIMES: ReadonlySet<ReceiptMime> = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * The ONLY way a receipt's bytes reach a browser (§5).
 *
 * MUST-13.2: no anonymous access, ever — no signed URL, no token in the query string, no
 * public path. MUST-2.4: `stage` is a static sibling segment and Next resolves it ahead of
 * this dynamic one, which is why [id] accepts only a positive integer.
 */

/**
 * MUST-5.3: everything outside [A-Za-z0-9._-] becomes _, truncated to 100, then quoted.
 *
 * originalFilename has already had slashes/backslashes/quotes/control-chars stripped at
 * storage time (sanitizeOriginalFilename in items.ts), but bare dots are NOT stripped
 * there — a name like `facture "été" /../weird.pdf` survives that pass as
 * `facture été ..weird.pdf`, and the character-class replace below leaves the ".." run
 * intact since '.' is itself an allowed character. Collapse any run of two-or-more dots
 * to a single underscore afterwards so the header value this function builds can never
 * contain a literal ".." token, even though this name is never used as a path component.
 */
function safeFilename(original: string): string {
  const cleaned = original
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .slice(0, 100);
  return cleaned.length > 0 ? cleaned : 'receipt';
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  // MUST-5.1, in this order, all before any filesystem access.
  // 1. Origin: reject a PRESENT-and-mismatched header; allow a request carrying neither,
  //    because on the documented plain-HTTP LAN deployment an <img> load and a navigation
  //    send no Origin and browsers omit fetch metadata on non-trustworthy origins.
  if (!isSameOriginOrHeaderless(request.headers)) return new Response('Forbidden', { status: 403 });

  // 2. Session.
  const user = userFromRequest(request);
  if (!user) return new Response('Unauthorized', { status: 401 });

  // 3. A positive integer id, or nothing.
  const { id: raw } = await ctx.params;
  if (!/^\d+$/.test(raw)) return new Response('Invalid receipt id', { status: 400 });
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) return new Response('Invalid receipt id', { status: 400 });

  // 4. The row. MUST-4.4: a receipt is only ever located by its database id.
  const receipt = getWarrantyReceipt(id);
  if (!receipt) return new Response('Not found', { status: 404 });

  const file = resolveReceiptPath(receipt.storedFilename);
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    // MUST-5.6 / MUST-4.10: this is the state a v1.0.0 DB-only restore produces. Degrade
    // quietly with a plain-text 410, never a 500.
    return new Response('Receipt file is missing from this install.', {
      status: 410,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store' },
    });
  }

  /**
   * MUST-5.3: images inline, everything else (PDFs today) as an attachment. A same-origin
   * INLINE pdf opens in the browser's PDF viewer, which executes JavaScript embedded in the
   * document within our origin; object-src 'none' in the CSP does not cover a top-level
   * navigation to the file. Gated on the INLINE_MIMES allowlist above, not on excluding
   * 'application/pdf' specifically.
   */
  const disposition = INLINE_MIMES.has(receipt.mime)
    ? 'inline'
    : `attachment; filename="${safeFilename(receipt.originalFilename)}"`;

  // MUST-5.5: streamed, not readFileSync — 10 MB x several concurrent image loads is a
  // needless RSS spike on a NAS.
  const body = Readable.toWeb(fs.createReadStream(file)) as ReadableStream<Uint8Array>;

  return new Response(body, {
    status: 200,
    headers: {
      // MUST-5.2: the STORED mime (itself constrained to a four-value safe list), never the
      // request's and never sniffed at read time.
      'content-type': receipt.mime,
      'content-disposition': disposition,
      'content-length': String(size),
      'cache-control': 'private, no-store',
      // X-Content-Type-Options: nosniff already arrives from securityHeaders() via
      // middleware, which matches /api/*.
    },
  });
}

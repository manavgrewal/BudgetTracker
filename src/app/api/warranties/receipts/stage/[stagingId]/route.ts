import { isSameOriginOrHeaderless } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { STAGING_ID_RE, readSidecar } from '@/lib/warranty/staging';

export const dynamic = 'force-dynamic';

/**
 * The client polls this every 1.5 s while OCR runs, and gives up after 3 minutes with
 * "Still processing — save now and re-run OCR from the item page." It is an authenticated,
 * read-only GET, so it uses the relaxed isSameOriginOrHeaderless() rule (§5, §6.3) for the
 * same reason /api/backup/download does: on plain HTTP a same-origin request carries no
 * Origin and no Sec-Fetch-* header at all.
 *
 * The raw OCR text is deliberately NOT returned: the client only ever needs the
 * suggestions, and §16 item 6 keeps the raw text out of the UI entirely.
 *
 * A staged job whose file was purged writes NO sidecar (Task 5's known deferred concern),
 * so readSidecar() returning null is indistinguishable from "still running" and this
 * endpoint reports 'pending' either way. That is safe only because the CLIENT bounds its
 * own polling to 3 minutes (above) and never trusts this endpoint to eventually resolve on
 * its own — a forever-purged staging id therefore cannot hang a client, it just eventually
 * gives up with the message quoted above.
 */
export async function GET(request: Request, ctx: { params: Promise<{ stagingId: string }> }): Promise<Response> {
  if (!isSameOriginOrHeaderless(request.headers)) return Response.json({ error: 'Forbidden' }, { status: 403 });

  const user = userFromRequest(request);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { stagingId } = await ctx.params;
  // Validated against the UUID regex BEFORE any path is built (§6.3). Ruling P10b: imported
  // from staging.ts, not duplicated here.
  if (!STAGING_ID_RE.test(stagingId)) return Response.json({ error: 'Invalid staging id' }, { status: 400 });

  const sidecar = readSidecar(stagingId);
  if (sidecar === null) return Response.json({ status: 'pending' });
  if (sidecar.status === 'failed') {
    return Response.json({ status: 'failed', error: sidecar.error ?? 'OCR failed.' });
  }
  return Response.json({ status: 'done', suggestions: sidecar.suggestions ?? {} });
}

import { CsrfError, assertSameOrigin } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { MAX_FILE_BYTES } from '@/lib/import/parse';
import { PackFormatError, importRulesPack, previewRulesPackImport } from '@/lib/packs';

export const dynamic = 'force-dynamic';

function tooLarge(): Response {
  return Response.json({ error: `File is larger than ${MAX_FILE_BYTES} bytes`, code: 'file_too_large' }, { status: 413 });
}

async function readPack(request: Request): Promise<{ pack: unknown; mode: string; onConflict: 'keep' | 'overwrite' }> {
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) throw new PackFormatError('No file was uploaded.');
  const text = await file.text();
  let pack: unknown;
  try {
    pack = JSON.parse(text);
  } catch {
    throw new PackFormatError('That file is not valid JSON.');
  }
  return {
    pack,
    mode: String(form.get('mode') ?? 'preview'),
    onConflict: form.get('onConflict') === 'overwrite' ? 'overwrite' : 'keep',
  };
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
  if (user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });

  // Reject on the declared size BEFORE formData() buffers the whole body — same
  // authenticated-memory-DoS defence as the CSV upload routes (review finding 1
  // precedent, e.g. import/raw-preview/route.ts). Reuses the CSV importer's
  // MAX_FILE_BYTES rather than a pack-specific constant: a JSON rules/profiles
  // pack has no reason to ever be larger than a bank statement CSV.
  const contentLength = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_FILE_BYTES) return tooLarge();

  try {
    const { pack, mode, onConflict } = await readPack(request);
    if (mode === 'apply') {
      return Response.json({ applied: true, ...importRulesPack(pack, { onConflict }) });
    }
    return Response.json({ applied: false, ...previewRulesPackImport(pack) });
  } catch (error) {
    if (error instanceof PackFormatError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

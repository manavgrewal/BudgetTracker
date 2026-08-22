'use client';

import { useActionState, useMemo, useState } from 'react';
import { MappingEditor } from '@/components/MappingEditor';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { TableWrap } from '@/components/ui/Table';
import { Field, inputClass } from '@/components/ui/form';
import type { ImportMapping } from '@/lib/import/mapping';
import { detectDateFormat } from '@/lib/import/detect-date-format';
import { saveWizardProfileAction, type WizardState } from '../actions';

const initial: WizardState = {};

const fileInputClass =
  'text-sm text-muted file:mr-3 file:rounded-md file:border-0 file:bg-accent-soft file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-accent-soft-fg';

export function WizardClient({ starterMapping }: { starterMapping: ImportMapping }) {
  const [mapping, setMapping] = useState<ImportMapping>(starterMapping);
  const [rows, setRows] = useState<string[][] | null>(null);
  const [stagingId, setStagingId] = useState<string>('');
  const [encoding, setEncoding] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [state, save] = useActionState(saveWizardProfileAction, initial);

  // This posts a file and stages it server-side, so a double-submit stages the same
  // sample twice and orphans the second staging id. The guard is SubmitButton's
  // useFormStatus rather than a local `busy` flag on purpose: React 19 holds state
  // updates made inside an async form action until that action settles, so a
  // setBusy(true) at the top of this function would not render until it is already
  // too late to matter. useFormStatus reads the form's real pending state.
  async function upload(formData: FormData) {
    setError(null);
    const response = await fetch('/api/import/raw-preview', { method: 'POST', body: formData });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? 'Upload failed');
      return;
    }
    setRows(body.rows as string[][]);
    setStagingId(body.stagingId as string);
    setEncoding(body.encoding as string);
  }

  // /api/import/raw-preview hands back every line of the sample untouched — it does not
  // know yet which rows are headers, since that is exactly what this screen is for
  // deciding. Skip the same rows parseCsv (src/lib/import/parse.ts) would skip before
  // sampling the date column, or a literal "Date" header row poisons detection into
  // reporting 'none' for a perfectly normal file.
  const dateFormatDetection = useMemo(() => {
    if (!rows) return null;
    const skip = mapping.hasHeader ? Math.max(mapping.headerRows, 1) : mapping.headerRows;
    return detectDateFormat(rows.slice(skip).map((row) => row[mapping.dateCol] ?? ''));
  }, [rows, mapping.hasHeader, mapping.headerRows, mapping.dateCol]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Import"
        title="Add a bank"
        description="Upload a sample export from the bank. The first rows are shown with their column numbers so you can say which column holds the date, the description and the amount. Nothing is imported here — this only saves a reusable profile."
      />

      <FormError message={error ?? state.error} />
      {state.message ? <Notice tone="success">{state.message}</Notice> : null}

      <Card>
        <CardHeader title="Sample file" description="A short export is plenty — the first handful of rows is all this needs." />
        <CardBody>
          <form action={upload} className="flex flex-wrap items-center gap-3">
            <input type="file" name="file" accept=".csv,text/csv" required className={fileInputClass} />
            <SubmitButton>Show the first rows</SubmitButton>
          </form>
        </CardBody>
      </Card>

      {rows ? (
        <>
          <Card>
            <CardHeader title="What the file looks like" description={`Detected encoding: ${encoding}`} />
            <TableWrap bare className="max-h-96 overflow-y-auto">
              <thead>
                <tr>
                  {(rows[0] ?? []).map((_, index) => (
                    <th scope="col" key={index}>col {index}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex} className="max-w-40 truncate text-xs">{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          </Card>

          <Card>
            <CardHeader title="Which column is which" description="Column numbers start at 0, matching the headings above." />
            <CardBody>
              <MappingEditor mapping={mapping} onChange={setMapping} dateFormatDetection={dateFormatDetection} />
            </CardBody>
          </Card>

          <Card className="max-w-md">
            <CardHeader title="Save this profile" description="Reusable for every future import from this bank." />
            <CardBody>
              <form action={save} className="flex flex-col gap-4">
                <input type="hidden" name="mapping" value={JSON.stringify(mapping)} />
                <input type="hidden" name="stagingId" value={stagingId} />
                <Field label="Profile name">
                  <input name="name" placeholder="Tangerine Chequing" required className={inputClass} />
                </Field>
                <Field label="Institution">
                  <input name="institution" placeholder="Tangerine" required className={inputClass} />
                </Field>
                <SubmitButton className="w-fit">Save profile</SubmitButton>
              </form>
            </CardBody>
          </Card>
        </>
      ) : null}
    </div>
  );
}

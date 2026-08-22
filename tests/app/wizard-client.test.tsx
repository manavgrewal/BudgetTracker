// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { WizardClient } from '@/app/(app)/import/wizard/wizard-client';
import { getBuiltinPreset } from '@/lib/import/presets';

vi.mock('@/app/(app)/import/actions', () => ({
  saveWizardProfileAction: vi.fn(async () => ({})),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('WizardClient — polish item 8: the sample upload is busy-guarded', () => {
  it('disables the upload button for as long as the request is in flight', async () => {
    const pending: { release?: (value: unknown) => void } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            pending.release = resolve;
          }),
      ),
    );

    const { container, getByRole } = render(<WizardClient starterMapping={getBuiltinPreset('TD Chequing/Debit')} />);
    const button = () => getByRole('button', { name: /show the first rows|working/i }) as HTMLButtonElement;
    expect(button().disabled).toBe(false);

    fireEvent.submit(container.querySelector('form')!);
    // Double-submitting used to stage the same sample file twice and orphan the
    // second staging id. The guard is useFormStatus (via SubmitButton), because a
    // local busy flag set inside an async form action does not render until that
    // action settles.
    await waitFor(() => expect(button().disabled).toBe(true));

    pending.release?.({ ok: false, json: async () => ({ error: 'nope' }) });
    await waitFor(() => expect(button().disabled).toBe(false));
  });
});

// The new-bank wizard is the other consumer of MappingEditor's date-format detection —
// /api/import/raw-preview never calls detectDateFormat itself, so this is computed
// client-side (useMemo, off the already-fetched raw rows and the currently selected
// dateCol) and must be re-checked here too, not just on the profile-editing preview.
describe('WizardClient — date format detection reaches the new-bank wizard too', () => {
  async function upload(rows: string[][], starterMapping = getBuiltinPreset('TD Chequing/Debit')) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ stagingId: 'stg-1', encoding: 'utf-8', rows }) })),
    );
    const view = render(<WizardClient starterMapping={starterMapping} />);
    fireEvent.submit(view.container.querySelector('form')!);
    await waitFor(() => expect(view.getByText(/which column is which/i)).toBeTruthy());
    return view;
  }

  it('offers the detected format as a one-click switch when it disagrees with the starter mapping', async () => {
    // TD Chequing/Debit's starter format is YYYY-MM-DD; every sampled value here only
    // parses as DD-MMM-YYYY, and column 0 (the starter's dateCol) is where they live.
    const { getByText, getByRole } = await upload([
      ['14-Mar-2026', 'Coffee', '5.00', ''],
      ['02-Jan-2026', 'Salary', '', '1000.00'],
    ]);

    expect(getByText(/Detected format: DD-MMM-YYYY/i)).toBeTruthy();
    const dateFormatSelect = () => getByRole('combobox', { name: /date format/i }) as HTMLSelectElement;
    expect(dateFormatSelect().value).toBe('YYYY-MM-DD');

    fireEvent.click(getByRole('button', { name: /use dd-mmm-yyyy/i }));
    expect(dateFormatSelect().value).toBe('DD-MMM-YYYY');
  });

  it('skips the header row before sampling, so a literal "Date" header does not poison detection into reporting none', async () => {
    const starter = { ...getBuiltinPreset('TD Chequing/Debit'), hasHeader: true, headerRows: 1 };
    const { getByText, queryByText } = await upload(
      [
        ['Date', 'Description', 'Debit', 'Credit'],
        ['14-Mar-2026', 'Coffee', '5.00', ''],
        ['02-Jan-2026', 'Salary', '', '1000.00'],
      ],
      starter,
    );

    // Without the header skip, 'Date' fails every known format and detection reports
    // 'none' for a file whose dates are actually perfectly readable.
    expect(queryByText(/Could not recognize this column's date format/i)).toBeNull();
    expect(getByText(/Detected format: DD-MMM-YYYY/i)).toBeTruthy();
  });

  it('surfaces the ambiguous warning in the wizard when the sample column reads as more than one format', async () => {
    const { getByRole } = await upload([
      ['03/04/2026', 'Coffee', '5.00', ''],
      ['05/06/2026', 'Salary', '', '1000.00'],
    ]);

    const alert = getByRole('alert');
    expect(alert.textContent).toMatch(/ambiguous/i);
    expect(alert.textContent).toContain('MM/DD/YYYY');
    expect(alert.textContent).toContain('DD/MM/YYYY');
  });
});

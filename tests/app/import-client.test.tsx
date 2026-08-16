// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ImportClient } from '@/app/(app)/import/import-client';
import { getBuiltinPreset } from '@/lib/import/presets';
import type { ImportHistoryRow } from '@/lib/import/commit';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TD_CHEQUING = getBuiltinPreset('TD Chequing/Debit');
const TD_VISA = getBuiltinPreset('TD Visa');

const PROFILES = [
  { id: 1, name: 'TD Chequing/Debit', isBuiltin: true, mapping: TD_CHEQUING },
  { id: 2, name: 'TD Visa', isBuiltin: true, mapping: TD_VISA },
];

describe('ImportClient — the profile follows the account (I4)', () => {
  it('switches to the account\'s remembered profile when the account changes', () => {
    const { getByLabelText } = render(
      <ImportClient
        accounts={[
          { id: 10, name: 'Joint Chequing', importProfileId: 1 },
          { id: 11, name: 'Joint Visa', importProfileId: 2 },
        ]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );

    const accountSelect = getByLabelText(/Account/) as HTMLSelectElement;
    const profileSelect = getByLabelText(/Import profile/) as HTMLSelectElement;
    expect(profileSelect.value).toBe('1');

    fireEvent.change(accountSelect, { target: { value: '11' } });

    expect(accountSelect.value).toBe('11');
    expect(profileSelect.value).toBe('2');
  });

  it('falls back to the first profile for an account that has never been imported into, instead of keeping the previous account\'s', () => {
    const { getByLabelText } = render(
      <ImportClient
        accounts={[
          { id: 10, name: 'Joint Visa', importProfileId: 2 },
          { id: 11, name: 'Brand New Account', importProfileId: null },
        ]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );

    const accountSelect = getByLabelText(/Account/) as HTMLSelectElement;
    const profileSelect = getByLabelText(/Import profile/) as HTMLSelectElement;
    expect(profileSelect.value).toBe('2');

    fireEvent.change(accountSelect, { target: { value: '11' } });

    expect(profileSelect.value).toBe('1');
  });
});

describe('ImportClient — zero CSV accounts (C1c / I5)', () => {
  it('explains what to do and disables the upload instead of offering a broken form', () => {
    const { getByText, queryByLabelText, getByLabelText } = render(
      <ImportClient accounts={[]} profiles={PROFILES} history={[]} simplefinManaged={[]} />,
    );

    expect(getByText(/No accounts to import into yet/i)).toBeTruthy();
    const link = getByText('Add a bank account') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/settings/accounts');
    // No account picker to submit a zero id from — that raw zod 400 is gone.
    expect(queryByLabelText(/Import profile/)).toBeNull();
    expect((getByLabelText('Upload a CSV') as HTMLInputElement).disabled).toBe(true);
    expect((getByText('Preview') as HTMLButtonElement).disabled).toBe(true);
  });

  it('says why when every account is SimpleFIN-managed rather than repeating the generic message', () => {
    const { getByText } = render(
      <ImportClient accounts={[]} profiles={PROFILES} history={[]} simplefinManaged={['Bridge Chequing']} />,
    );
    expect(getByText(/Every account you have is synced from SimpleFIN/i)).toBeTruthy();
  });

  it('renders the normal upload form as soon as one account exists', () => {
    const { getByLabelText, queryByText } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );
    expect(queryByText(/No accounts to import into yet/i)).toBeNull();
    expect(getByLabelText(/Account/)).toBeTruthy();
  });
});

const HISTORY: ImportHistoryRow[] = [
  {
    id: 77,
    accountId: 10,
    accountName: 'Joint Chequing',
    profileId: 1,
    filename: 'march.csv',
    importedBy: 1,
    importedByName: 'Alice',
    rowsAdded: 12,
    rowsDuplicate: 0,
    rowsError: 0,
    createdAt: '2026-03-10T09:00:00.000Z',
  },
];

function previewBody(over: Record<string, unknown> = {}) {
  return {
    stagingId: 'stg-1',
    filename: 'march.csv',
    accountId: 10,
    profileId: 1,
    encoding: 'utf-8',
    mapping: TD_CHEQUING,
    rows: [],
    errors: [],
    totalRows: 5,
    duplicateCount: 0,
    errorCount: 0,
    skipped: 0,
    truncated: false,
    ...over,
  };
}

describe('ImportClient — polish item 9: rows the profile silently skipped', () => {
  async function renderPreview(skipped: number) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => previewBody({ skipped }) })),
    );
    const view = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );
    fireEvent.submit(view.container.querySelector('form')!);
    await waitFor(() => expect(view.container.textContent).toContain('Preview —'));
    return view;
  }

  it('reports the skipped count when the profile dropped rows', async () => {
    const { container } = await renderPreview(3);
    // Without this, a mis-typed skip rule that swallowed half the file looked
    // exactly like a short file.
    expect(container.textContent).toContain('3 skipped by profile rules');
  });

  it('says nothing at all when nothing was skipped', async () => {
    const { container } = await renderPreview(0);
    expect(container.textContent).not.toContain('skipped by profile rules');
  });
});

describe('ImportClient — polish item 8: the undo button is busy-guarded', () => {
  it('disables Undo while the lookup request is in flight', async () => {
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

    const { getByText } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={HISTORY}
        simplefinManaged={[]}
      />,
    );

    const undo = getByText('Undo') as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    fireEvent.click(undo);
    // A second click here used to fire the whole delete sequence again.
    await waitFor(() => expect(undo.disabled).toBe(true));

    pending.release?.({ ok: false, json: async () => ({ error: 'nope' }) });
    await waitFor(() => expect(undo.disabled).toBe(false));
  });
});

describe('ImportClient — the Preview and Import buttons are busy-guarded', () => {
  it('disables Preview for as long as the upload is in flight (useFormStatus, not a local flag)', async () => {
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

    const { container, getByRole } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );
    const preview = () => getByRole('button', { name: /preview|working/i }) as HTMLButtonElement;
    expect(preview().disabled).toBe(false);

    fireEvent.submit(container.querySelector('form')!);
    // This is a form action: a local `busy` flag set inside it does not render until the
    // action settles, so the old guard left the button clickable for the whole upload.
    await waitFor(() => expect(preview().disabled).toBe(true));

    pending.release?.({ ok: false, json: async () => ({ error: 'nope' }) });
    await waitFor(() => expect(preview().disabled).toBe(false));
  });

  it('disables Import while the commit is in flight, and releases it when the commit fails', async () => {
    const calls: { release?: (value: unknown) => void } = {};
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        // first call: the preview upload, which resolves immediately
        .mockImplementationOnce(async () => ({ ok: true, json: async () => previewBody({ totalRows: 4 }) }))
        // second call: the commit, held open
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              calls.release = resolve;
            }),
        ),
    );

    const { container, getByRole } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(container.textContent).toContain('Preview —'));

    const importButton = () => getByRole('button', { name: /^Import \d+ transactions$/ }) as HTMLButtonElement;
    expect(importButton().disabled).toBe(false);

    fireEvent.click(importButton());
    await waitFor(() => expect(importButton().disabled).toBe(true));

    // Released in a finally, so a failed commit does not strand the button forever.
    calls.release?.({ ok: false, json: async () => ({ error: 'commit exploded' }) });
    await waitFor(() => expect(importButton().disabled).toBe(false));
    expect(container.textContent).toContain('commit exploded');
  });
});

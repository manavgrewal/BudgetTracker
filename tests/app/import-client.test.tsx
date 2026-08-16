// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { ImportClient } from '@/app/(app)/import/import-client';
import { getBuiltinPreset } from '@/lib/import/presets';

afterEach(() => cleanup());

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

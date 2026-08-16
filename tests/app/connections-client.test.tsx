// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ConnectionsClient } from '@/app/(app)/settings/connections/connections-client';

vi.mock('@/app/(app)/settings/connections/actions', () => ({
  forgetConnectionAction: vi.fn(async () => ({ message: 'Connection removed. Bridge Chequing reverts to CSV import.' })),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CONNECTION = { id: 1, claimedAt: '2026-08-15T00:00:00.000Z', lastSyncAt: null, requestsToday: 0, requestsDate: '2026-08-15', enabled: true };

describe('ConnectionsClient — forget connection warns about affected accounts (finding 1)', () => {
  it('lists every linked account name in the confirm dialog before forgetting', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    const { getByText } = render(
      <ConnectionsClient
        connection={CONNECTION}
        links={[
          { simplefinAccountId: 'remote-1', accountId: 10, currency: 'CAD', lastBalanceCents: null, lastBalanceDate: null },
          { simplefinAccountId: 'remote-2', accountId: 11, currency: 'CAD', lastBalanceCents: null, lastBalanceDate: null },
        ]}
        accounts={[
          { id: 10, name: 'Bridge Chequing' },
          { id: 11, name: 'Bridge Savings' },
        ]}
        remainingRequests={20}
        dailyLimit={20}
      />,
    );

    fireEvent.click(getByText('Forget connection'));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const message = confirmSpy.mock.calls[0][0] as string;
    expect(message).toContain('Bridge Chequing');
    expect(message).toContain('Bridge Savings');
    expect(message).toMatch(/CSV import/i);
    confirmSpy.mockRestore();
  });

  it('surfaces the action error instead of reloading when the action is rejected', async () => {
    const forget = vi.mocked((await import('@/app/(app)/settings/connections/actions')).forgetConnectionAction);
    forget.mockResolvedValueOnce({ error: 'Cross-origin request rejected' });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const { getByText, findByText } = render(
      <ConnectionsClient connection={CONNECTION} links={[]} accounts={[]} remainingRequests={20} dailyLimit={20} />,
    );
    fireEvent.click(getByText('Forget connection'));

    expect(await findByText('Cross-origin request rejected')).toBeTruthy();
    confirmSpy.mockRestore();
  });

  it('does not mention unlinking when nothing is linked', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    const { getByText } = render(
      <ConnectionsClient connection={CONNECTION} links={[]} accounts={[]} remainingRequests={20} dailyLimit={20} />,
    );

    fireEvent.click(getByText('Forget connection'));

    const message = confirmSpy.mock.calls[0][0] as string;
    expect(message).not.toMatch(/CSV import/i);
    expect(message).toMatch(/fresh setup token/i);
    confirmSpy.mockRestore();
  });
});

describe('ConnectionsClient — a bridge error with zero accounts is a FAILED sync (m3, spec section 12)', () => {
  function stubSync(payload: Record<string, unknown>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })),
    );
  }

  it('shows only the amber error box — no green "Nothing to import." next to it', async () => {
    stubSync({ accounts: [], errlist: ['Bank X needs re-authentication'], remainingRequests: 19, engineFailed: false });

    const { getByText, queryByText, findByText } = render(
      <ConnectionsClient connection={CONNECTION} links={[]} accounts={[]} remainingRequests={20} dailyLimit={20} />,
    );
    fireEvent.click(getByText('Sync now'));

    expect(await findByText('Bank X needs re-authentication')).toBeTruthy();
    await waitFor(() => expect(queryByText(/Nothing to import/)).toBeNull());
    // The green notice is the only thing suppressed; the bridge's own
    // request-budget line above it is static page content and stays.
    expect(queryByText(/of 20 requests left today\./)).toBeNull();
  });

  it('still reports the summary when at least one account did sync despite an errlist entry', async () => {
    stubSync({
      accounts: [{ accountName: 'Bridge Chequing', added: 2, duplicates: 0, skippedPending: 0, errors: 0, currencyWarning: null }],
      errlist: ['Bank Y is slow today'],
      remainingRequests: 19,
      engineFailed: false,
    });

    const { getByText, findByText } = render(
      <ConnectionsClient connection={CONNECTION} links={[]} accounts={[]} remainingRequests={20} dailyLimit={20} />,
    );
    fireEvent.click(getByText('Sync now'));

    expect(await findByText(/Bridge Chequing: 2 added/)).toBeTruthy();
    expect(getByText('Bank Y is slow today')).toBeTruthy();
  });

  it('says so when the rows landed but categorization failed (m2)', async () => {
    stubSync({
      accounts: [{ accountName: 'Bridge Chequing', added: 2, duplicates: 0, skippedPending: 0, errors: 0, currencyWarning: null }],
      errlist: [],
      remainingRequests: 19,
      engineFailed: true,
    });

    const { getByText, findByText } = render(
      <ConnectionsClient connection={CONNECTION} links={[]} accounts={[]} remainingRequests={20} dailyLimit={20} />,
    );
    fireEvent.click(getByText('Sync now'));

    expect(await findByText(/review queue/i)).toBeTruthy();
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { ConnectionsClient } from '@/app/(app)/settings/connections/connections-client';

vi.mock('@/app/(app)/settings/connections/actions', () => ({
  forgetConnectionAction: vi.fn(async () => ({ message: 'Connection removed. Bridge Chequing reverts to CSV import.' })),
}));

afterEach(() => cleanup());

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

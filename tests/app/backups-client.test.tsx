// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { RestoreOutcome } from '@/lib/backup/restore';
import { BackupsClient } from '@/app/(app)/settings/backups/backups-client';

vi.mock('@/app/(app)/settings/backups/actions', () => ({
  setRetentionAction: vi.fn(async () => ({})),
  runBackupNowAction: vi.fn(async () => ({})),
  stageRestoreAction: vi.fn(async () => ({
    restarting: true,
    message: 'Restoring — the app will restart. Refresh this page in about 30 seconds.',
  })),
}));

afterEach(() => cleanup());

const backups = [
  { name: 'budget-2026-08-16.tar.gz', bytes: 4_194_304, modifiedAt: '2026-08-16T06:00:00.000Z' },
  { name: 'budget-2026-08-15.tar.gz', bytes: 4_100_000, modifiedAt: '2026-08-15T06:00:00.000Z' },
];
const noRestore = { staged: null, result: null };

describe('MUST-20.35: the confirm step', () => {
  it('names the backup and keeps the submit disabled until the box is ticked', () => {
    render(<BackupsClient backups={backups} retention={14} restore={noRestore} />);

    const row = screen.getByText('budget-2026-08-16.tar.gz').closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: /^restore$/i }));

    const panel = within(row);
    // Each phrase below is worded specifically enough that it cannot also match the
    // "Restore and restart" submit button rendered in the same row (which itself contains
    // the word "restart") — MUST-20.35's requirement that the panel names the backup, warns
    // that data is replaced, names the safety copy, and explains the restart.
    expect(panel.getByText(/budget-2026-08-16\.tar\.gz/)).toBeTruthy();
    expect(panel.getByText(/replaces all data currently in the app/i)).toBeTruthy();
    expect(panel.getByText(/budget\.pre-restore-/)).toBeTruthy();
    expect(panel.getByText(/restarts to apply this/i)).toBeTruthy();
    expect(panel.getByText(/no restart policy/i)).toBeTruthy();

    const submit = panel.getByRole('button', { name: /restore and restart/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(panel.getByRole('checkbox'));
    expect(submit.disabled).toBe(false);
  });

  it('opens at most one panel at a time and Cancel collapses it', () => {
    render(<BackupsClient backups={backups} retention={14} restore={noRestore} />);
    fireEvent.click(screen.getAllByRole('button', { name: /^restore$/i })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: /^restore$/i })[0]);
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('unchecking the box after ticking it disables the submit button again', () => {
    render(<BackupsClient backups={backups} retention={14} restore={noRestore} />);
    fireEvent.click(screen.getAllByRole('button', { name: /^restore$/i })[0]);
    const checkbox = screen.getByRole('checkbox');
    const submit = screen.getByRole('button', { name: /restore and restart/i }) as HTMLButtonElement;
    fireEvent.click(checkbox);
    expect(submit.disabled).toBe(false);
    fireEvent.click(checkbox);
    expect(submit.disabled).toBe(true);
  });
});

describe('MUST-20.30: the restarting notice', () => {
  it('replaces the page after a successful submit and leaves nothing to click', async () => {
    render(<BackupsClient backups={backups} retention={14} restore={noRestore} />);

    fireEvent.click(screen.getAllByRole('button', { name: /^restore$/i })[0]);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /restore and restart/i }));

    expect(await screen.findByText(/refresh this page in about 30 seconds/i)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows the staged-but-not-yet-applied notice and disables Restore buttons', () => {
    render(
      <BackupsClient
        backups={backups}
        retention={14}
        restore={{
          staged: {
            version: 1,
            payload: 'payload',
            sourceName: 'budget-2026-08-16.tar.gz',
            kind: 'archive',
            bytes: 4_194_304,
            sha256: '0'.repeat(64),
            appliedMigrations: 4,
            requestedByUserId: 3,
            requestedByUsername: 'meena',
            requestedAt: '2026-08-16T21:04:11.482Z',
            appVersion: '1.1.0',
          },
          result: null,
        }}
      />,
    );
    expect(screen.getByText(/a restore is staged and will be applied the next time the app starts/i)).toBeTruthy();
    for (const button of screen.getAllByRole('button', { name: /^restore$/i })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });
});

describe('MUST-20.35: the result banner', () => {
  it('renders a success outcome', () => {
    const result: RestoreOutcome = {
      version: 1,
      status: 'success',
      sourceName: 'budget-2026-08-16.tar.gz',
      kind: 'archive',
      requestedByUserId: 3,
      requestedByUsername: 'meena',
      requestedAt: '2026-08-16T21:04:11.482Z',
      finishedAt: '2026-08-16T21:04:53.106Z',
      safetyCopy: 'budget.pre-restore-2026-08-16T21-04-49-772Z.db',
      receiptsMovedAside: 'receipts.pre-restore-2026-08-16T21-04-49-772Z',
      receiptsRestored: 128,
      missingReceiptRows: 0,
      receiptsTouched: 0,
      error: null,
    };
    render(<BackupsClient backups={backups} retention={14} restore={{ staged: null, result }} />);
    expect(screen.getByText(/Restored budget-2026-08-16\.tar\.gz/)).toBeTruthy();
    expect(screen.getByText(/128 receipt files/)).toBeTruthy();
    expect(screen.getByText(/budget\.pre-restore-2026-08-16T21-04-49-772Z\.db/)).toBeTruthy();
  });

  it('renders a failure outcome verbatim', () => {
    const result = {
      version: 1,
      status: 'failed',
      sourceName: 'budget-2026-08-16.tar.gz',
      kind: 'archive',
      requestedByUserId: 3,
      requestedByUsername: 'meena',
      requestedAt: '2026-08-16T21:04:11.482Z',
      finishedAt: '2026-08-16T21:04:53.106Z',
      safetyCopy: null,
      receiptsMovedAside: null,
      receiptsRestored: 0,
      missingReceiptRows: 0,
      receiptsTouched: 0,
      error: 'The archive contains no budget.db.',
    } satisfies RestoreOutcome;
    render(<BackupsClient backups={backups} retention={14} restore={{ staged: null, result }} />);
    expect(screen.getByText('The archive contains no budget.db.')).toBeTruthy();
  });
});

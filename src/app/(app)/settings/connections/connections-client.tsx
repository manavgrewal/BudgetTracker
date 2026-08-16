'use client';

import { useState } from 'react';
import { FormError } from '@/components/FormError';
import { formatCents } from '@/lib/money';
import type { AccountLink, ConnectionRecord } from '@/lib/simplefin/connection';
import { forgetConnectionAction } from './actions';

interface RemoteAccount {
  id: string;
  name: string;
  currency: string;
  balance: string;
}

export function ConnectionsClient({
  connection,
  links,
  accounts,
  remainingRequests,
  dailyLimit,
}: {
  connection: ConnectionRecord | null;
  links: AccountLink[];
  accounts: { id: number; name: string }[];
  remainingRequests: number;
  dailyLimit: number;
}) {
  const [setupToken, setSetupToken] = useState('');
  const [remote, setRemote] = useState<RemoteAccount[] | null>(null);
  const [errlist, setErrlist] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function post(url: string, body: unknown) {
    setBusy(true);
    setError(null);
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json();
    setBusy(false);
    if (!response.ok) {
      setError(payload.error ?? 'That did not work.');
      return null;
    }
    return payload;
  }

  async function claim() {
    const result = await post('/api/simplefin/claim', { setupToken });
    if (!result) return;
    setSetupToken('');
    setNotice('Connected. The access URL is stored encrypted and never shown again.');
    window.location.reload();
  }

  async function loadRemote() {
    setBusy(true);
    setError(null);
    const response = await fetch('/api/simplefin/accounts');
    const payload = await response.json();
    setBusy(false);
    if (!response.ok) {
      setError(payload.error ?? 'Could not list the remote accounts.');
      return;
    }
    setRemote(payload.accounts as RemoteAccount[]);
    setErrlist(payload.errlist ?? []);
  }

  async function link(account: RemoteAccount, accountId: number) {
    const result = await post('/api/simplefin/link', { action: 'link', simplefinAccountId: account.id, accountId, currency: account.currency });
    if (!result) return;
    setNotice([result.warning, result.currencyWarning].filter(Boolean).join(' '));
    window.location.reload();
  }

  async function unlink(simplefinAccountId: string) {
    const result = await post('/api/simplefin/link', { action: 'unlink', simplefinAccountId });
    if (!result) return;
    setNotice('Unlinked. CSV import is available for that account again.');
    window.location.reload();
  }

  async function sync() {
    const result = await post('/api/simplefin/sync', {});
    if (!result) return;
    setErrlist(result.errlist ?? []);
    const perAccount = (result.accounts as { accountName: string; added: number; duplicates: number; skippedPending: number; errors: number; currencyWarning: string | null }[])
      .map((a) => `${a.accountName}: ${a.added} added, ${a.duplicates} already had, ${a.skippedPending} still pending, ${a.errors} errors`)
      .join(' · ');
    setNotice(`${perAccount || 'Nothing to import.'} — ${result.remainingRequests} of ${dailyLimit} requests left today.`);
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Connections</h1>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        SimpleFIN fetches transactions from your bank through a bridge you control. It is entirely optional — leave this page alone and the app
        never makes a single network request.
      </p>
      <FormError message={error} />
      {notice ? <p className="text-sm text-green-700 dark:text-green-400">{notice}</p> : null}
      {errlist.length > 0 ? (
        <div className="rounded bg-amber-50 p-3 text-sm dark:bg-amber-950">
          <strong>The bridge reported problems:</strong>
          <ul className="mt-1 list-inside list-disc">
            {errlist.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {connection === null ? (
        <section className="flex max-w-xl flex-col gap-3 rounded border border-slate-200 p-3 text-sm dark:border-slate-800">
          <h2 className="font-medium">Connect a SimpleFIN bridge</h2>
          <p className="text-xs text-slate-500">
            Paste the setup token from your bridge. It can only be claimed <strong>once</strong> — if this fails, generate a fresh token. The access
            URL it returns is a read-only credential for your bank data; it is encrypted before it is stored and is never displayed again.
          </p>
          <textarea
            value={setupToken}
            onChange={(e) => setSetupToken(e.target.value)}
            rows={4}
            placeholder="Paste the setup token"
            className="rounded border border-slate-300 px-2 py-1 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
          />
          <button
            type="button"
            onClick={() => void claim()}
            disabled={busy || setupToken.trim().length === 0}
            className="w-fit rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
          >
            {busy ? 'Claiming…' : 'Claim token'}
          </button>
        </section>
      ) : (
        <>
          <section className="flex flex-col gap-2 text-sm">
            <h2 className="font-medium">Bridge</h2>
            <p>
              Connected {connection.claimedAt.slice(0, 10)} · last sync {connection.lastSyncAt ? connection.lastSyncAt.slice(0, 16).replace('T', ' ') : 'never'} ·{' '}
              <strong>{remainingRequests}</strong> of {dailyLimit} requests left today
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void sync()} disabled={busy} className="rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
                {busy ? 'Working…' : 'Sync now'}
              </button>
              <button type="button" onClick={() => void loadRemote()} disabled={busy} className="rounded border px-3 py-2 dark:border-slate-700">
                List remote accounts
              </button>
              <button
                type="button"
                onClick={async () => {
                  const affectedNames = links.map((l) => accounts.find((a) => a.id === l.accountId)?.name ?? `account ${l.accountId}`);
                  const impact =
                    affectedNames.length > 0
                      ? ` This will also unlink ${affectedNames.join(', ')} — ${affectedNames.length === 1 ? 'it reverts' : 'they revert'} to CSV import.`
                      : '';
                  if (!window.confirm(`Remove the stored connection?${impact} You will need a fresh setup token to reconnect.`)) return;
                  setNotice((await forgetConnectionAction()).message ?? null);
                  window.location.reload();
                }}
                className="rounded border px-3 py-2 dark:border-slate-700"
              >
                Forget connection
              </button>
            </div>
            <p className="text-xs text-slate-500">
              Syncing is manual. Nothing runs on a timer. Each sync asks for everything since the last one plus five days of overlap, so a
              late-posting transaction is never missed.
            </p>
          </section>

          <section className="flex flex-col gap-2 text-sm">
            <h2 className="font-medium">Linked accounts</h2>
            {links.length === 0 ? <p className="text-xs text-slate-500">Nothing linked yet. List the remote accounts to map them.</p> : null}
            <ul>
              {links.map((link) => (
                <li key={link.simplefinAccountId} className="flex items-center justify-between border-b border-slate-100 py-1 dark:border-slate-900">
                  <span>
                    <code className="text-xs">{link.simplefinAccountId}</code> → {accounts.find((a) => a.id === link.accountId)?.name ?? `account ${link.accountId}`}{' '}
                    <span className="text-xs text-slate-500">
                      {link.currency}
                      {link.lastBalanceCents !== null ? ` · balance ${formatCents(link.lastBalanceCents)}` : ''}
                    </span>
                  </span>
                  <button type="button" onClick={() => void unlink(link.simplefinAccountId)} className="text-xs underline">
                    unlink
                  </button>
                </li>
              ))}
            </ul>
            {links.length > 0 ? (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Linked accounts are synced from SimpleFIN, so CSV import is turned off for them. Unlink to switch an account back to CSV.
              </p>
            ) : null}
          </section>

          {remote ? (
            <section className="flex flex-col gap-2 text-sm">
              <h2 className="font-medium">Remote accounts</h2>
              <ul className="flex flex-col gap-2">
                {remote.map((account) => (
                  <li key={account.id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 py-2 dark:border-slate-900">
                    <span>
                      {account.name} <span className="text-xs text-slate-500">{account.currency} · {account.balance}</span>
                    </span>
                    {links.some((l) => l.simplefinAccountId === account.id) ? (
                      <span className="text-xs text-slate-500">already linked</span>
                    ) : (
                      <>
                        <select id={`map-${account.id}`} className="rounded border px-2 py-1 text-xs dark:bg-slate-900">
                          {accounts.map((local) => (
                            <option key={local.id} value={local.id}>
                              {local.name}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => {
                            const select = document.getElementById(`map-${account.id}`) as HTMLSelectElement | null;
                            if (select) void link(account, Number(select.value));
                          }}
                          className="rounded border px-2 py-1 text-xs dark:border-slate-700"
                        >
                          Link
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}

      <p className="text-xs text-slate-500 dark:text-slate-400">
        The access URL is stored encrypted in the database, which means it is also inside your unencrypted nightly backups. If you keep offsite
        copies, turn on your backup tool&apos;s client-side encryption. Rotating <code>SECRET_KEY</code> makes the stored URL undecryptable and you
        will need a fresh setup token.
      </p>
    </div>
  );
}

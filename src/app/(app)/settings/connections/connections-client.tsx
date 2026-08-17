'use client';

import { useState } from 'react';
import { FormError } from '@/components/FormError';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Money } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { Field, selectClass, textareaClass } from '@/components/ui/form';
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
    const errors: string[] = result.errlist ?? [];
    setErrlist(errors);
    const synced = result.accounts as { accountName: string; added: number; duplicates: number; skippedPending: number; errors: number; currencyWarning: string | null }[];
    if (errors.length > 0 && synced.length === 0) {
      // Spec section 12: a non-empty errlist with zero accounts IS a failed
      // sync. Reporting "Nothing to import." in green next to the bridge's
      // complaint reads as success and is exactly wrong.
      setNotice(null);
      return;
    }
    const perAccount = synced
      .map((a) => `${a.accountName}: ${a.added} added, ${a.duplicates} already had, ${a.skippedPending} still pending, ${a.errors} errors`)
      .join(' · ');
    const engineNote = result.engineFailed ? ' Categorization failed, so the new rows are waiting in the review queue.' : '';
    setNotice(`${perAccount || 'Nothing to import.'} — ${result.remainingRequests} of ${dailyLimit} requests left today.${engineNote}`);
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Settings"
        title="Connections"
        description="SimpleFIN fetches transactions from your bank through a bridge you control. It is entirely optional — leave this page alone and the app never makes a single network request."
      />

      <FormError message={error} />
      {notice ? <Notice tone="success">{notice}</Notice> : null}
      {errlist.length > 0 ? (
        <Notice tone="warning" title="The bridge reported problems:">
          <ul className="flex flex-col gap-0.5">
            {errlist.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {connection === null ? (
        <Card className="max-w-xl">
          <CardHeader
            title="Connect a SimpleFIN bridge"
            description={
              <>
                Paste the setup token from your bridge. It can only be claimed <strong className="font-semibold text-ink">once</strong> — if this
                fails, generate a fresh token. The access URL it returns is a read-only credential for your bank data; it is encrypted before it is
                stored and is never displayed again.
              </>
            }
          />
          <CardBody className="flex flex-col gap-3">
            <Field label="Setup token">
              <textarea
                value={setupToken}
                onChange={(e) => setSetupToken(e.target.value)}
                rows={4}
                placeholder="Paste the setup token"
                className={`${textareaClass} font-mono text-xs`}
              />
            </Field>
            <button
              type="button"
              onClick={() => void claim()}
              disabled={busy || setupToken.trim().length === 0}
              className="btn btn--primary w-fit"
            >
              {busy ? 'Claiming…' : 'Claim token'}
            </button>
          </CardBody>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader
              title="Bridge"
              description={
                <>
                  Connected {connection.claimedAt.slice(0, 10)} · last sync{' '}
                  {connection.lastSyncAt ? connection.lastSyncAt.slice(0, 16).replace('T', ' ') : 'never'} ·{' '}
                  <strong className="font-semibold text-ink">{remainingRequests}</strong> of {dailyLimit} requests left today
                </>
              }
            />
            <CardBody className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => void sync()} disabled={busy} className="btn btn--primary">
                  {busy ? 'Working…' : 'Sync now'}
                </button>
                <button type="button" onClick={() => void loadRemote()} disabled={busy} className="btn btn--secondary">
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
                    const result = await forgetConnectionAction();
                    if (result.error) {
                      // A rejected action (cross-origin) must not look like a
                      // successful removal followed by a page reload.
                      setError(result.error);
                      return;
                    }
                    setNotice(result.message ?? null);
                    window.location.reload();
                  }}
                  className="btn btn--ghost"
                >
                  Forget connection
                </button>
              </div>
              <p className="text-xs text-subtle">
                Syncing is manual. Nothing runs on a timer. Each sync asks for everything since the last one plus five days of overlap, so a
                late-posting transaction is never missed.
              </p>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Linked accounts" description="Each remote account maps to exactly one account here." />
            <CardBody className="flex flex-col gap-3">
              {links.length === 0 ? (
                <p className="rounded-md border border-dashed border-line-strong px-4 py-6 text-center text-sm text-muted">
                  Nothing linked yet. List the remote accounts to map them.
                </p>
              ) : (
                <ul className="flex flex-col">
                  {links.map((link) => (
                    <li
                      key={link.simplefinAccountId}
                      className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-2 text-sm last:border-b-0"
                    >
                      <span>
                        <code className="rounded bg-surface-2 px-1 font-mono text-xs">{link.simplefinAccountId}</code> →{' '}
                        {accounts.find((a) => a.id === link.accountId)?.name ?? `account ${link.accountId}`}{' '}
                        <span className="text-xs text-subtle">
                          {link.currency}
                          {link.lastBalanceCents !== null ? <> · balance <Money cents={link.lastBalanceCents} plain /></> : null}
                        </span>
                      </span>
                      <button type="button" onClick={() => void unlink(link.simplefinAccountId)} className="btn btn--ghost btn--sm">
                        unlink
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {links.length > 0 ? (
                <p className="text-xs text-warning">
                  Linked accounts are synced from SimpleFIN, so CSV import is turned off for them. Unlink to switch an account back to CSV.
                </p>
              ) : null}
            </CardBody>
          </Card>

          {remote ? (
            <Card>
              <CardHeader title="Remote accounts" description="What the bridge can see. Map each one to an account here." />
              <CardBody>
                <ul className="flex flex-col">
                  {remote.map((account) => (
                    <li
                      key={account.id}
                      className="flex flex-wrap items-center gap-2 border-b border-line py-2.5 text-sm last:border-b-0"
                    >
                      <span className="flex-1">
                        {account.name} <span className="text-xs text-subtle">{account.currency} · {account.balance}</span>
                      </span>
                      {links.some((l) => l.simplefinAccountId === account.id) ? (
                        <span className="badge badge--green">already linked</span>
                      ) : (
                        <>
                          <select
                            id={`map-${account.id}`}
                            aria-label={`Local account for ${account.name}`}
                            className={`${selectClass} w-auto px-2 py-1 text-xs`}
                          >
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
                            className="btn btn--secondary btn--sm"
                          >
                            Link
                          </button>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ) : null}
        </>
      )}

      <p className="text-xs text-subtle">
        The access URL is stored encrypted in the database, which means it is also inside your unencrypted nightly backups. If you keep offsite
        copies, turn on your backup tool&apos;s client-side encryption. Rotating <code className="font-mono">SECRET_KEY</code> makes the stored URL
        undecryptable and you will need a fresh setup token.
      </p>
    </div>
  );
}

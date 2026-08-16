import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { findUserByUsername } from '@/lib/auth/users';
import { countUnusedRecoveryCodes } from '@/lib/auth/totp';
import { ProfileForms } from './profile-forms';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const user = await requireUser();
  const record = findUserByUsername(user.username);
  const recoveryLeft = countUnusedRecoveryCodes(user.id);

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-xl font-semibold">Settings</h1>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium">Profile</h2>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Signed in as <strong>{user.name}</strong> ({user.username}) — {user.role}
        </p>
        <ProfileForms totpEnabled={record?.totpEnabled ?? false} recoveryLeft={recoveryLeft} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Sessions</h2>
        <form action="/api/auth/logout" method="post">
          <input type="hidden" name="scope" value="all" />
          <button type="submit" className="rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700">
            Log out everywhere
          </button>
        </form>
      </section>

      {user.role === 'admin' ? (
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">Administration</h2>
          <ul className="list-inside list-disc text-sm">
            <li>
              <Link className="underline" href="/settings/users">
                Users
              </Link>
            </li>
          </ul>
        </section>
      ) : null}
    </div>
  );
}

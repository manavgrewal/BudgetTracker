import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { findUserByUsername } from '@/lib/auth/users';
import { countUnusedRecoveryCodes } from '@/lib/auth/totp';
import {
  ArrowRightIcon,
  BellIcon,
  BudgetsIcon,
  ImportIcon,
  SettingsIcon,
  SignOutIcon,
  TransactionsIcon,
  WarrantiesIcon,
  type IconProps,
} from '@/components/icons';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { AboutPanel } from './about-panel';
import { ProfileForms } from './profile-forms';
import { UpdatesCard } from './updates-card';

export const dynamic = 'force-dynamic';

/** The admin surfaces, each with the one sentence that says what it is for. */
const ADMIN_LINKS: { href: string; label: string; blurb: string; Icon: (props: IconProps) => React.ReactElement }[] = [
  { href: '/settings/users', label: 'Users', blurb: 'Who can sign in, and what they may change.', Icon: SettingsIcon },
  { href: '/settings/item-types', label: 'Item types', blurb: 'The warranty categories, and which are subscriptions.', Icon: WarrantiesIcon },
  { href: '/settings/accounts', label: 'Bank accounts', blurb: 'Where imported transactions land.', Icon: BudgetsIcon },
  {
    href: '/settings/managers',
    label: 'Categories, merchant rules and import profiles',
    blurb: 'How transactions get named and sorted.',
    Icon: TransactionsIcon,
  },
  { href: '/settings/backups', label: 'Backups', blurb: 'Nightly archives, downloads and restore.', Icon: ImportIcon },
  { href: '/settings/connections', label: 'Connections (SimpleFIN)', blurb: 'Bank sync instead of CSV, where it is set up.', Icon: ImportIcon },
];

export default async function SettingsPage() {
  const user = await requireUser();
  const record = findUserByUsername(user.username);
  const recoveryLeft = countUnusedRecoveryCodes(user.id);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Settings" description="Your account, and — for admins — how the household's data is managed." />

      <Card>
        <CardHeader
          title="Profile"
          description={
            <>
              Signed in as <strong className="font-semibold text-ink">{user.name}</strong> ({user.username}) — {user.role}
            </>
          }
        />
        <CardBody>
          <ProfileForms totpEnabled={record?.totpEnabled ?? false} recoveryLeft={recoveryLeft} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Sessions" description="Signs you out on every device, including this one." />
        <CardBody>
          <form action="/api/auth/logout" method="post">
            <input type="hidden" name="scope" value="all" />
            <button type="submit" className="btn btn--secondary">
              <SignOutIcon className="h-4 w-4" />
              Log out everywhere
            </button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Notifications" description="Where the app messages you, and about what." />
        <CardBody>
          <Link
            href="/settings/notifications"
            className="group flex items-start gap-3 rounded-md p-1 transition-colors hover:text-accent-text"
          >
            <span
              aria-hidden="true"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-soft-fg"
            >
              <BellIcon className="h-[1.15rem] w-[1.15rem]" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-semibold text-ink">Notifications</span>
              <span className="text-sm text-muted">Telegram and email alerts. Nothing is sent until you set a channel up.</span>
            </span>
            <ArrowRightIcon className="mt-1 h-4 w-4 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5" />
          </Link>
        </CardBody>
      </Card>

      {user.role === 'admin' ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold text-ink">Administration</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {ADMIN_LINKS.map(({ href, label, blurb, Icon }) => (
              <Link
                key={href}
                href={href}
                className="card group flex items-start gap-3 p-4 transition-colors hover:border-accent-text"
              >
                <span
                  aria-hidden="true"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-soft-fg"
                >
                  <Icon className="h-[1.15rem] w-[1.15rem]" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-semibold text-ink">{label}</span>
                  <span className="text-sm text-muted">{blurb}</span>
                </span>
                <ArrowRightIcon className="mt-1 h-4 w-4 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5" />
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {/* MUST-9.1: admin only. A member's Settings page is byte-identical to v1.3.0's. */}
      {user.role === 'admin' ? <UpdatesCard /> : null}

      {/* Last: the version and revision log are reference material, not a task. */}
      <AboutPanel />
    </div>
  );
}

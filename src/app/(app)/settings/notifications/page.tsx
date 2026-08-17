import { requireUser } from '@/lib/auth/session';
import { getDb } from '@/db/client';
import { users } from '@/db/schema';
import { PageHeader } from '@/components/ui/PageHeader';
import { SMTP_PRESETS, getPrefs, getSmtp, getTarget, getUserSettings } from '@/lib/notify/config';
import { eventsFor } from '@/lib/notify/events';
import { listRecentDeliveries } from '@/lib/notify/outbox';
import { NotificationsClient, type NotificationsPageData } from './notifications-client';

export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  const user = await requireUser();

  // MUST-3.7: the page renders EFFECTIVE values, resolved once here so the client never
  // re-implements the fallback rule.
  const stored = getPrefs(user.id);
  const prefs: Record<string, boolean> = {};
  for (const event of eventsFor(user.role)) {
    for (const channel of ['telegram', 'email'] as const) {
      prefs[`${event.id}:${channel}`] = stored[`${event.id}:${channel}`] ?? event.defaultEnabled;
    }
  }

  // §11.6: admins get the household-wide view with a name column.
  const nameById = new Map(
    getDb()
      .select({ id: users.id, name: users.name })
      .from(users)
      .all()
      .map((row) => [row.id, row.name] as const),
  );
  const deliveries = listRecentDeliveries({ userId: user.role === 'admin' ? null : user.id }).map((row) => ({
    ...row,
    userName: nameById.get(row.userId) ?? 'Unknown',
  }));

  const relay = getSmtp();

  const data: NotificationsPageData = {
    role: user.role,
    // MUST-5.3: getSmtp() returns passwordSet, never the password; getTarget() returns
    // secretSet, never the token. §11.3: members see none of the relay's configuration,
    // only whether one exists, so their email card can explain itself.
    smtp: user.role === 'admin' ? relay : null,
    relayConfigured: relay?.enabled === true,
    targets: { telegram: getTarget(user.id, 'telegram'), email: getTarget(user.id, 'email') },
    events: eventsFor(user.role),
    prefs,
    settings: getUserSettings(user.id),
    deliveries,
    presets: SMTP_PRESETS,
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Notifications" description="Nothing is sent anywhere until you set up a channel below." />
      <NotificationsClient {...data} />
    </div>
  );
}

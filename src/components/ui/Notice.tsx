import { AlertIcon, CheckIcon, InfoIcon } from '@/components/icons';

export type NoticeTone = 'success' | 'error' | 'warning' | 'info';

const TONE = {
  success: { wrap: 'bg-positive-soft text-positive-soft-fg', Icon: CheckIcon },
  error: { wrap: 'bg-negative-soft text-negative-soft-fg', Icon: AlertIcon },
  warning: { wrap: 'bg-warning-soft text-warning-soft-fg', Icon: AlertIcon },
  info: { wrap: 'bg-info-soft text-info-soft-fg', Icon: InfoIcon },
} as const satisfies Record<NoticeTone, { wrap: string; Icon: (props: { className?: string }) => React.ReactElement }>;

/**
 * Inline banner for the result of something the person just did.
 *
 * Errors announce themselves (role="alert"); everything else is polite
 * (role="status") so a success confirmation does not interrupt a screen reader
 * mid-sentence. Both are live regions, which is what makes a server-action
 * result audible at all.
 */
export function Notice({
  tone = 'info',
  title,
  children,
  className = '',
  role,
}: {
  tone?: NoticeTone;
  title?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  role?: 'alert' | 'status';
}) {
  const { wrap, Icon } = TONE[tone];
  return (
    <div
      role={role ?? (tone === 'error' ? 'alert' : 'status')}
      className={`flex items-start gap-2.5 rounded-md px-3.5 py-3 text-sm ${wrap} ${className}`}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="flex min-w-0 flex-col gap-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children}
      </div>
    </div>
  );
}

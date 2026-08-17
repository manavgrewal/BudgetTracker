import type { IconProps } from '@/components/icons';

/**
 * What a list looks like before it has anything in it.
 *
 * An empty screen is an invitation to act, so the shape is fixed: a quiet
 * glyph, one sentence naming what will appear here, and the single button that
 * makes it happen. First-run is most of this app's first impression.
 */
export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  className = '',
}: {
  icon: (props: IconProps) => React.ReactElement;
  title: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-center gap-3 px-6 py-12 text-center ${className}`}>
      <span
        aria-hidden="true"
        className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-2 text-subtle"
      >
        <Icon className="h-5 w-5" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-semibold text-ink">{title}</p>
        {children ? <p className="mx-auto max-w-sm text-sm text-muted">{children}</p> : null}
      </div>
      {action ? <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

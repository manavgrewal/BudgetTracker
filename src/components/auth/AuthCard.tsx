import { LogoMark } from '@/components/icons';

/**
 * The card every signed-out page sits in: mark, wordmark, title, then the form.
 *
 * The reassurance line under the card is not filler — this is software the
 * family installed on a box in their own house, and saying so is the single
 * most useful thing the login screen can tell them.
 */
export function AuthCard({
  title,
  description,
  children,
  footer,
  width = 'sm',
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: 'sm' | 'lg';
}) {
  return (
    <div className={`flex w-full flex-col gap-6 ${width === 'lg' ? 'max-w-2xl' : 'max-w-sm'}`}>
      <div className="flex items-center gap-3">
        <LogoMark className="h-10 w-10" />
        <span className="text-lg font-semibold tracking-tight text-ink">Budget Tracker</span>
      </div>

      <div className="card p-6 sm:p-7">
        <div className="mb-5 flex flex-col gap-1.5">
          <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
          {description ? <p className="text-sm text-muted">{description}</p> : null}
        </div>
        {children}
      </div>

      <p className="text-center text-xs text-subtle">
        {footer ?? 'Runs on your own hardware. Nothing leaves the house.'}
      </p>
    </div>
  );
}

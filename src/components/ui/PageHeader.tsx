/**
 * The one <h1> on a page, plus whatever the page's primary action is.
 * `eyebrow` is for real context (the month a page is scoped to, the account a
 * detail page belongs to) — not decoration.
 */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  className = '',
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  eyebrow?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-end justify-between gap-x-6 gap-y-3 ${className}`}>
      <div className="flex min-w-0 flex-col gap-1.5">
        {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-[1.75rem]">{title}</h1>
        {description ? <p className="max-w-2xl text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

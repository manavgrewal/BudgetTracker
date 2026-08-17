/**
 * Form field styling, in one place.
 *
 * The class constants exist alongside the <Field> wrapper because plenty of the
 * app's forms are dense inline grids (the import wizard's mapping editor, the
 * accounts table) where a stacked label/control block would be wrong — those
 * take the class and keep their own layout.
 */

export const inputClass = 'field-control';
export const selectClass = 'field-control';
export const textareaClass = 'field-control';
export const labelClass = 'field-label';
export const hintClass = 'field-hint';

/** Stacked label + control + optional hint — the default shape for a form. */
export function Field({
  label,
  hint,
  htmlFor,
  children,
  className = '',
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const Wrapper = htmlFor ? 'div' : 'label';
  return (
    <Wrapper className={`flex flex-col gap-1.5 ${className}`}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className={labelClass}>
          {label}
        </label>
      ) : (
        <span className={labelClass}>{label}</span>
      )}
      {children}
      {hint ? <span className={hintClass}>{hint}</span> : null}
    </Wrapper>
  );
}

/** A group of related fields with a heading — used by the settings and setup forms. */
export function Fieldset({
  legend,
  description,
  children,
  className = '',
}: {
  legend: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <fieldset className={`flex flex-col gap-4 ${className}`}>
      <legend className="flex flex-col gap-1">
        <span className="text-sm font-semibold text-ink">{legend}</span>
        {description ? <span className="text-sm text-muted">{description}</span> : null}
      </legend>
      {children}
    </fieldset>
  );
}

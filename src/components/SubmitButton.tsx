'use client';

import { useFormStatus } from 'react-dom';
import { buttonClass, type ButtonSize, type ButtonVariant } from '@/components/ui/Button';

/**
 * The submit button for every server-action form. The pending state comes from
 * useFormStatus, so it works without the page having to thread a flag down —
 * and double-submit protection is a side effect of the disabled attribute
 * (several flows rely on that: the import wizard would orphan a staging id).
 */
export function SubmitButton({
  children,
  className = '',
  disabled = false,
  variant = 'primary',
  size = 'md',
}: {
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending || disabled} className={buttonClass(variant, size, className)}>
      {pending ? 'Working…' : children}
    </button>
  );
}

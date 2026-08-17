'use client';

import { useFormStatus } from 'react-dom';

export function SubmitButton({
  children,
  className = '',
  disabled = false,
}: {
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className={`rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-slate-100 dark:text-slate-900 ${className}`}
    >
      {pending ? 'Working…' : children}
    </button>
  );
}

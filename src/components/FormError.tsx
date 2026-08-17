import { Notice } from '@/components/ui/Notice';

/**
 * The error line under a form's heading. Renders nothing when there is nothing
 * wrong, so a form can mount it unconditionally.
 */
export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <Notice tone="error">
      <p>{message}</p>
    </Notice>
  );
}

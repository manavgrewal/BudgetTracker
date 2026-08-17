import type { SmtpTransportConfig } from '@/lib/notify/send';

/**
 * STUB — replaced in Task 7 with the real nodemailer-based SMTP transport. Kept as a real
 * module (rather than left unresolved) purely so `src/lib/notify/send/index.ts`'s dynamic
 * import and `npx tsc --noEmit` both resolve today. Every Task 6 test installs a fake sender
 * via setNotifySenderForTests(), so this body never actually runs yet.
 */
export interface EmailSendInput {
  smtp: SmtpTransportConfig;
  to: string;
  subject: string;
  text: string;
}

export async function sendEmail(_input: EmailSendInput): Promise<void> {
  throw new Error('not implemented — Task 7');
}

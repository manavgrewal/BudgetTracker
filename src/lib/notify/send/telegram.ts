/**
 * STUB — replaced in Task 7 with the real Telegram Bot API transport (fetch-based, no SDK).
 * Kept as a real module (rather than left unresolved) purely so `src/lib/notify/send/index.ts`'s
 * dynamic import and `npx tsc --noEmit` both resolve today. Every Task 6 test installs a fake
 * sender via setNotifySenderForTests(), so this body never actually runs yet.
 */
export interface TelegramSendInput {
  botToken: string;
  chatId: string;
  subject: string;
  body: string;
}

export async function sendTelegram(_input: TelegramSendInput): Promise<void> {
  throw new Error('not implemented — Task 7');
}

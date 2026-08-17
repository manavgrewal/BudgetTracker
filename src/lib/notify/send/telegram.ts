import { scrubSecrets } from '@/lib/notify/crypto';
import { TELEGRAM_API_ORIGIN, assertTelegramUrl } from '@/lib/notify/egress';
import { NotifyError } from '@/lib/notify/send';

/** §19.16 / MUST-8.3: the API limit is 4096; a truncated digest beats a rejected one. */
export const TELEGRAM_MAX_CHARS = 4000;
export const TELEGRAM_TIMEOUT_MS = 15_000;
export const MAX_DETECTED_CHATS = 20;
export const CHAT_TITLE_MAX = 80;

/** MUST-8.10: the three fixed outcome sentences for the Detect chat ID helper. */
export const TELEGRAM_NO_MESSAGES =
  'No messages yet. Open Telegram, find your bot, send it any message, then press this again.';
export const TELEGRAM_TOKEN_REJECTED =
  'That bot token was rejected by Telegram. Check you pasted the whole thing, then save it again.';

export interface TelegramChat {
  /** A string: supergroup ids exceed Number.MAX_SAFE_INTEGER territory. */
  chatId: string;
  /** Untrusted display text — a person can name a Telegram group anything (MUST-8.8). */
  title: string;
  kind: 'private' | 'group' | 'supergroup' | 'channel';
  lastMessageAt: string | null;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** MUST-5.5: the token is in the URL PATH, so every error string is scrubbed. */
function clean(message: string, botToken: string): string {
  return scrubSecrets(message, [botToken]);
}

interface TelegramFailure {
  description?: unknown;
  parameters?: { retry_after?: unknown };
}

async function readFailure(response: Response): Promise<TelegramFailure> {
  try {
    return (await response.json()) as TelegramFailure;
  } catch {
    return {};
  }
}

/**
 * MUST-8.1 — POST https://api.telegram.org/bot<token>/sendMessage, raw fetch, no SDK.
 * MUST-8.2 — NO parse_mode. Messages are plain text, so a merchant name, an OCR-derived
 * warranty title or a user-supplied description can never be interpreted as markup or a
 * link. That is why §10 renders one plain-text body for both channels.
 * MUST-9.3 — redirect: 'error'. A 3xx from api.telegram.org is a failure, not a hop.
 */
export async function sendTelegram(input: {
  botToken: string;
  chatId: string;
  subject: string;
  body: string;
}): Promise<void> {
  const url = `${TELEGRAM_API_ORIGIN}/bot${input.botToken}/sendMessage`;
  assertTelegramUrl(url);

  const text = truncate(`${input.subject}\n\n${input.body}`, TELEGRAM_MAX_CHARS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: input.chatId, text, disable_web_page_preview: true }),
      redirect: 'error',
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
  } catch (error) {
    // DNS failures, connect timeouts and aborts are transient.
    const message = clean(error instanceof Error ? error.message : 'Telegram request failed.', input.botToken);
    throw new NotifyError(message, { permanent: false, scope: 'target' });
  }

  if (response.ok) return;

  const failure = await readFailure(response);
  // MUST-8.4: Telegram's own descriptions — "chat not found", "bot was blocked by the
  // user", "Unauthorized" — are exactly what the user needs to see in Settings.
  const description = typeof failure.description === 'string' ? failure.description : `Telegram returned ${response.status}.`;
  const message = clean(description, input.botToken);

  // MUST-7.7: 400/401/403/404 will never succeed unchanged.
  const permanent = response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404;
  const retryAfter = failure.parameters?.retry_after;
  const retryAfterMs = typeof retryAfter === 'number' && retryAfter > 0 ? retryAfter * 1000 : null;

  throw new NotifyError(message, { permanent, scope: 'target', retryAfterMs });
}

interface RawChat {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  username?: unknown;
}

function chatKind(value: unknown): TelegramChat['kind'] {
  return value === 'group' || value === 'supergroup' || value === 'channel' ? value : 'private';
}

function chatTitle(chat: RawChat, chatId: string): string {
  if (typeof chat.title === 'string' && chat.title.length > 0) return truncate(chat.title, CHAT_TITLE_MAX);
  const person = [chat.first_name, chat.last_name].filter((part): part is string => typeof part === 'string' && part.length > 0);
  if (person.length > 0) return truncate(person.join(' '), CHAT_TITLE_MAX);
  if (typeof chat.username === 'string' && chat.username.length > 0) return truncate(chat.username, CHAT_TITLE_MAX);
  return chatId;
}

/**
 * MUST-8.5/8.6 — the second and LAST Telegram endpoint the app may ever call. Same origin,
 * same assertTelegramUrl() guard, same redirect: 'error', same 15 s abort as sendMessage.
 *
 * MUST-8.7 — it MUST NOT consume the update queue: no `offset` parameter is passed, so
 * Telegram leaves the updates in place and the helper can be pressed repeatedly. Passing
 * an offset would acknowledge the updates and make the second press return nothing — the
 * exact confusing failure the helper exists to prevent.
 */
export async function fetchTelegramChats(botToken: string): Promise<TelegramChat[]> {
  const url = `${TELEGRAM_API_ORIGIN}/bot${botToken}/getUpdates?limit=100&allowed_updates=${encodeURIComponent('["message"]')}`;
  assertTelegramUrl(url);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(clean(error instanceof Error ? error.message : 'Telegram request failed.', botToken));
  }

  if (!response.ok) {
    // MUST-8.10: three outcomes, each with fixed wording.
    if (response.status === 401) throw new Error(TELEGRAM_TOKEN_REJECTED);
    const failure = await readFailure(response);
    const description = typeof failure.description === 'string' ? failure.description : `HTTP ${response.status}`;
    throw new Error(clean(`Telegram said: ${description}`, botToken));
  }

  const payload = (await response.json()) as { result?: { message?: { date?: unknown; chat?: RawChat } }[] };
  const updates = Array.isArray(payload.result) ? payload.result : [];

  // MUST-8.8: reduce to a unique set of chats keyed by chat.id, keeping the most recent
  // date per chat, newest first, capped at MAX_DETECTED_CHATS.
  const byId = new Map<string, { chat: TelegramChat; seconds: number }>();
  for (const item of updates) {
    const chat = item.message?.chat;
    if (!chat || (typeof chat.id !== 'number' && typeof chat.id !== 'string')) continue;
    const chatId = String(chat.id);
    const seconds = typeof item.message?.date === 'number' ? item.message.date : 0;
    const existing = byId.get(chatId);
    if (existing && existing.seconds >= seconds) continue;
    byId.set(chatId, {
      seconds,
      chat: {
        chatId,
        title: chatTitle(chat, chatId),
        kind: chatKind(chat.type),
        lastMessageAt: seconds > 0 ? new Date(seconds * 1000).toISOString() : null,
      },
    });
  }

  return [...byId.values()]
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, MAX_DETECTED_CHATS)
    .map((entry) => entry.chat);
}

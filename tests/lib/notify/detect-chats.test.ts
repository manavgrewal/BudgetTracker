import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MAX_DETECTED_CHATS,
  TELEGRAM_NO_MESSAGES,
  TELEGRAM_TOKEN_REJECTED,
  fetchTelegramChats,
} from '@/lib/notify/send/telegram';

const TOKEN = '123456789:AAHk3f-EXAMPLE-tokenxxxxxxxxxxxxxxxxxx';

let urls: string[];

function stubUpdates(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
          return body;
        },
      } as unknown as Response;
    }),
  );
}

function update(id: number, chat: Record<string, unknown>, date: number) {
  return { update_id: id, message: { message_id: id, date, chat } };
}

beforeEach(() => {
  urls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const url of urls) expect(url.startsWith('https://api.telegram.org/')).toBe(true);
});

describe('MUST-8.6 / MUST-8.7: the request', () => {
  it('GETs getUpdates on the allowed origin with limit and allowed_updates and NO offset', async () => {
    stubUpdates(200, { ok: true, result: [] });
    await fetchTelegramChats(TOKEN);
    const url = new URL(urls[0] ?? '');
    expect(url.origin).toBe('https://api.telegram.org');
    expect(url.pathname).toBe(`/bot${TOKEN}/getUpdates`);
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('allowed_updates')).toBe('["message"]');
    expect(url.searchParams.has('offset')).toBe(false);
  });

  it('is idempotent: a second call against the same response returns the same chats', async () => {
    const body = { ok: true, result: [update(1, { id: 5551234, type: 'private', first_name: 'Sam' }, 1755000000)] };
    stubUpdates(200, body);
    const first = await fetchTelegramChats(TOKEN);
    const second = await fetchTelegramChats(TOKEN);
    expect(second).toEqual(first);
    expect(urls.every((u) => !u.includes('offset'))).toBe(true);
  });
});

describe('MUST-8.8: dedupe and shape', () => {
  it('collapses several updates from one chat, keeping the newest date', async () => {
    stubUpdates(200, {
      ok: true,
      result: [
        update(1, { id: 5551234, type: 'private', first_name: 'Sam' }, 1755000000),
        update(2, { id: 5551234, type: 'private', first_name: 'Sam' }, 1755009999),
      ],
    });
    const chats = await fetchTelegramChats(TOKEN);
    expect(chats).toHaveLength(1);
    expect(chats[0]?.chatId).toBe('5551234');
    expect(chats[0]?.lastMessageAt).toBe(new Date(1755009999 * 1000).toISOString());
  });

  it('sorts newest first and caps the list at 20', async () => {
    stubUpdates(200, {
      ok: true,
      result: Array.from({ length: 30 }, (_, i) => update(i, { id: i + 1, type: 'private', first_name: `P${i}` }, 1_700_000_000 + i)),
    });
    const chats = await fetchTelegramChats(TOKEN);
    expect(chats).toHaveLength(MAX_DETECTED_CHATS);
    expect(chats[0]?.title).toBe('P29');
  });

  it('derives the title through title → first_name last_name → username → id', async () => {
    stubUpdates(200, {
      ok: true,
      result: [
        update(1, { id: 1, type: 'group', title: 'Grewal Family' }, 1_700_000_004),
        update(2, { id: 2, type: 'private', first_name: 'Sam', last_name: 'Grewal' }, 1_700_000_003),
        update(3, { id: 3, type: 'private', username: 'samg' }, 1_700_000_002),
        update(4, { id: 4, type: 'channel' }, 1_700_000_001),
      ],
    });
    expect((await fetchTelegramChats(TOKEN)).map((c) => [c.title, c.kind])).toEqual([
      ['Grewal Family', 'group'],
      ['Sam Grewal', 'private'],
      ['samg', 'private'],
      ['4', 'channel'],
    ]);
  });

  it('MUST-10.3: an untrusted title is returned as literal text, truncated to 80', async () => {
    stubUpdates(200, {
      ok: true,
      result: [
        update(1, { id: 1, type: 'group', title: '<b>hi</b>' }, 1_700_000_002),
        update(2, { id: 2, type: 'group', title: 'L'.repeat(300) }, 1_700_000_001),
      ],
    });
    const chats = await fetchTelegramChats(TOKEN);
    expect(chats[0]?.title).toBe('<b>hi</b>');
    expect(chats[1]?.title).toHaveLength(80);
  });

  it('keeps chat ids as strings — supergroup ids exceed safe-integer territory', async () => {
    stubUpdates(200, { ok: true, result: [update(1, { id: -1001234567890123, type: 'supergroup', title: 'Big' }, 1_700_000_000)] });
    const chats = await fetchTelegramChats(TOKEN);
    expect(typeof chats[0]?.chatId).toBe('string');
    expect(chats[0]?.chatId).toBe('-1001234567890123');
  });
});

describe('MUST-8.10: the three fixed outcomes', () => {
  it('an empty list resolves to [], and the caller renders the empty-state sentence', async () => {
    stubUpdates(200, { ok: true, result: [] });
    await expect(fetchTelegramChats(TOKEN)).resolves.toEqual([]);
    expect(TELEGRAM_NO_MESSAGES).toBe(
      'No messages yet. Open Telegram, find your bot, send it any message, then press this again.',
    );
  });

  it('401 rejects with the token-rejected sentence', async () => {
    stubUpdates(401, { ok: false, description: 'Unauthorized' });
    await expect(fetchTelegramChats(TOKEN)).rejects.toMatchObject({ message: TELEGRAM_TOKEN_REJECTED });
    expect(TELEGRAM_TOKEN_REJECTED).toBe(
      'That bot token was rejected by Telegram. Check you pasted the whole thing, then save it again.',
    );
  });

  it('anything else surfaces Telegram’s own description with the fixed prefix', async () => {
    stubUpdates(409, { ok: false, description: 'terminated by other getUpdates request' });
    await expect(fetchTelegramChats(TOKEN)).rejects.toMatchObject({
      message: 'Telegram said: terminated by other getUpdates request',
    });
  });
});

describe('MUST-8.9: the token never escapes', () => {
  it('is absent from the returned value and from every error message', async () => {
    stubUpdates(200, { ok: true, result: [update(1, { id: 1, type: 'private', first_name: 'Sam' }, 1_700_000_000)] });
    expect(JSON.stringify(await fetchTelegramChats(TOKEN))).not.toContain('AAHk3f');

    vi.unstubAllGlobals();
    urls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(`getaddrinfo ENOTFOUND for https://api.telegram.org/bot${TOKEN}/getUpdates`);
      }),
    );
    const error = await fetchTelegramChats(TOKEN).catch((e) => e as Error);
    expect((error as Error).message).not.toContain('AAHk3f');
    expect((error as Error).message).toContain('[redacted]');
  });
});

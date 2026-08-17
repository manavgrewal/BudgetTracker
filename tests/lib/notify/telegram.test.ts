import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NotifyError } from '@/lib/notify/send';
import { TELEGRAM_MAX_CHARS, sendTelegram } from '@/lib/notify/send/telegram';

const TOKEN = '123456789:AAHk3f-EXAMPLE-tokenxxxxxxxxxxxxxxxxxx';

let calls: { url: string; init: RequestInit }[];

function stubFetch(response: { status: number; body: unknown }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        async json() {
          return response.body;
        },
        async text() {
          return JSON.stringify(response.body);
        },
      } as unknown as Response;
    }),
  );
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  // MUST-17.1: nothing in this suite may have reached a real host.
  for (const call of calls) expect(call.url.startsWith('https://api.telegram.org/')).toBe(true);
});

describe('MUST-8.1 / MUST-8.2 / MUST-9.3: the request', () => {
  it('POSTs JSON to sendMessage on the pinned origin', async () => {
    stubFetch({ status: 200, body: { ok: true } });
    await sendTelegram({ botToken: TOKEN, chatId: '5551234', subject: 'Subject', body: 'Body' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(calls[0]?.init.method).toBe('POST');
    expect((calls[0]?.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(calls[0]?.init.redirect).toBe('error');
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends subject + blank line + body, with no parse_mode key at all', async () => {
    stubFetch({ status: 200, body: { ok: true } });
    await sendTelegram({ botToken: TOKEN, chatId: '5551234', subject: 'Subject', body: 'Body' });
    const payload = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(payload).toEqual({ chat_id: '5551234', text: 'Subject\n\nBody', disable_web_page_preview: true });
    expect('parse_mode' in payload).toBe(false);
  });

  it('MUST-8.3: truncates to 4000 characters with a trailing ellipsis', async () => {
    stubFetch({ status: 200, body: { ok: true } });
    await sendTelegram({ botToken: TOKEN, chatId: '1', subject: 'S', body: 'x'.repeat(8000) });
    const payload = JSON.parse(String(calls[0]?.init.body)) as { text: string };
    expect(payload.text).toHaveLength(TELEGRAM_MAX_CHARS);
    expect(payload.text.endsWith('…')).toBe(true);
  });

  it('renders markup literally rather than interpreting it', async () => {
    stubFetch({ status: 200, body: { ok: true } });
    await sendTelegram({ botToken: TOKEN, chatId: '1', subject: 'S', body: '<b>x</b> *y* [z](http://q)' });
    const payload = JSON.parse(String(calls[0]?.init.body)) as { text: string };
    expect(payload.text).toContain('<b>x</b> *y* [z](http://q)');
  });
});

describe('MUST-7.7 / MUST-8.4: failure classification', () => {
  for (const status of [400, 401, 403, 404]) {
    it(`${status} is permanent and surfaces Telegram's own description`, async () => {
      stubFetch({ status, body: { ok: false, description: 'chat not found' } });
      await expect(sendTelegram({ botToken: TOKEN, chatId: '1', subject: 'S', body: 'B' })).rejects.toMatchObject({
        permanent: true,
        message: 'chat not found',
      });
    });
  }

  for (const status of [429, 500, 502, 503]) {
    it(`${status} is transient`, async () => {
      stubFetch({ status, body: { ok: false, description: 'try later' } });
      await expect(sendTelegram({ botToken: TOKEN, chatId: '1', subject: 'S', body: 'B' })).rejects.toMatchObject({
        permanent: false,
      });
    });
  }

  it('honours parameters.retry_after on a 429', async () => {
    stubFetch({ status: 429, body: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 42 } } });
    await expect(sendTelegram({ botToken: TOKEN, chatId: '1', subject: 'S', body: 'B' })).rejects.toMatchObject({
      permanent: false,
      retryAfterMs: 42_000,
    });
  });

  it('a network throw is transient and never echoes the token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed, reason: ECONNRESET`);
      }),
    );
    const error = await sendTelegram({ botToken: TOKEN, chatId: '1', subject: 'S', body: 'B' }).catch((e) => e as NotifyError);
    expect(error).toBeInstanceOf(NotifyError);
    expect((error as NotifyError).permanent).toBe(false);
    expect((error as NotifyError).message).not.toContain('AAHk3f');
    expect((error as NotifyError).message).toContain('[redacted]');
  });

  it('every Telegram failure is target-scoped, never relay-scoped', async () => {
    stubFetch({ status: 401, body: { ok: false, description: 'Unauthorized' } });
    await expect(sendTelegram({ botToken: TOKEN, chatId: '1', subject: 'S', body: 'B' })).rejects.toMatchObject({
      scope: 'target',
    });
  });
});

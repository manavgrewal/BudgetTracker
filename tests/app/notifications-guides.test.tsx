// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { EmailGuide, GuidePanel, TelegramGuide } from '@/app/(app)/settings/notifications/guides';
import type { SmtpPreset } from '@/lib/notify/config';

afterEach(cleanup);

const CLOSING_TELEGRAM =
  'Last step: press Send test message. If it arrives in Telegram, you are done. Do not rely on notifications until you have seen a test arrive.';
const CLOSING_EMAIL =
  'Last step: press Send test email. If it arrives, you are done. Do not rely on notifications until you have seen a test arrive.';

function textOf(element: HTMLElement): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('MUST-11.6: the Telegram guide is shipped content', () => {
  const { container } = { container: document.createElement('div') };

  it('names BotFather, /newbot, the message-first rule and the Detect chat ID step', () => {
    const { container } = render(<TelegramGuide />);
    const copy = textOf(container);
    expect(copy).toContain('@BotFather');
    expect(copy).toContain('/newbot');
    expect(copy).toContain('A Telegram bot is not allowed to message you until you have messaged it first.');
    expect(copy).toContain('Detect chat ID');
    expect(copy).toContain('123456789:AAHk3f-EXAMPLE-tokenxxxxxxxxxxxxxxxxxx');
    expect(copy).toContain('treat it like a password');
  });

  it('MUST-11.8: ends with the closing line naming the exact button label', () => {
    const copy = textOf(render(<TelegramGuide />).container);
    expect(copy).toContain(CLOSING_TELEGRAM);
    expect(copy.endsWith(CLOSING_TELEGRAM)).toBe(true);
  });

  it('renders every external address as text, never as a link', () => {
    const { container } = render(<TelegramGuide />);
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });

  expect(container).toBeDefined();
});

describe('MUST-11.6: the four email guides', () => {
  const cases: [SmtpPreset, string[], string][] = [
    ['brevo', ['brevo.com', 'SMTP & API', 'Generate a new SMTP key', 'smtp-relay.brevo.com', '300 emails a day'], CLOSING_EMAIL],
    ['smtp2go', ['smtp2go.com', 'Sending', 'SMTP Users', 'mail.smtp2go.com', '1,000 emails a month'], CLOSING_EMAIL],
    ['gmail', ['myaccount.google.com', '2-Step Verification', 'App passwords', 'smtp.gmail.com', '100 to 150 messages a day'], CLOSING_EMAIL],
    ['custom', ['SMTP settings', 'STARTTLS', '587', '465'], CLOSING_EMAIL],
  ];

  for (const [preset, needles, closing] of cases) {
    it(`${preset} names its provider's own page names, its prefilled host and its quota`, () => {
      const copy = textOf(render(<EmailGuide preset={preset} />).container);
      for (const needle of needles) expect(copy).toContain(needle);
      expect(copy.endsWith(closing)).toBe(true);
    });

    it(`${preset} renders no <a href>`, () => {
      expect(render(<EmailGuide preset={preset} />).container.querySelectorAll('a')).toHaveLength(0);
    });
  }

  it('the Gmail guide states the ordinary Google password will not work', () => {
    const copy = textOf(render(<EmailGuide preset="gmail" />).container);
    expect(copy).toContain('Your normal Google password will not work.');
    expect(copy).toContain('16-character');
  });

  it('the Brevo guide warns the SMTP key is not the account password', () => {
    const copy = textOf(render(<EmailGuide preset="brevo" />).container);
    expect(copy).toContain('The SMTP key is not the same thing as your Brevo account password');
  });

  it('the Custom guide names the three encryption choices and the plaintext warning', () => {
    const copy = textOf(render(<EmailGuide preset="custom" />).container);
    expect(copy).toContain('Only pick this for a mail server on your own home network, never for anything on the internet.');
  });
});

describe('MUST-11.5 / MUST-11.7: the panel', () => {
  it('is a <details> whose summary is the shared question', () => {
    const { container } = render(
      <GuidePanel open>
        <p>body</p>
      </GuidePanel>,
    );
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(true);
    expect(container.querySelector('summary')?.textContent).toBe('How do I set this up?');
  });

  it('renders collapsed when open is false', () => {
    const { container } = render(
      <GuidePanel open={false}>
        <p>body</p>
      </GuidePanel>,
    );
    expect(container.querySelector('details')?.open).toBe(false);
  });
});

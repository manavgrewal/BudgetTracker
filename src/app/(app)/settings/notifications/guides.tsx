import type { SmtpPreset } from '@/lib/notify/config';

/**
 * MUST-11.5 / MUST-11.6 — the built-in setup guides. This copy is SHIPPED VERBATIM from
 * spec §11.7. It is content, not placeholder text, and it lives in one module so it is
 * reviewable as prose and testable by string match (§17.5, R10).
 *
 * MUST-9.1a / decision 26 — every external address here is PLAIN TEXT, never a clickable
 * anchor. Nothing in the app resolves, fetches, embeds, previews or link-checks any of them. That
 * keeps the zero-egress claim trivially auditable, survives copy-paste into a screenshot,
 * and removes any question of what a click inside the app might reach.
 *
 * MUST-11.8 — every guide ends with the same closing line, and the phrase "Send test" in
 * it matches the button's label exactly. The test asserts that against the rendered
 * button, not against a duplicated literal.
 */
export const GUIDE_CLOSING_ACTION: Record<'telegram' | SmtpPreset, string> = {
  telegram: 'Send test message',
  brevo: 'Send test email',
  smtp2go: 'Send test email',
  gmail: 'Send test email',
  custom: 'Send test email',
};

function Closing({ action }: { action: string }) {
  return (
    <p className="text-sm text-muted">
      {/* MUST-11.8: "press {action}" is bolded as one phrase, not `action` alone, so this
          copy is never itself an element whose own text exactly matches the button's label —
          a test locating the real button by that exact text must find only one. */}
      <strong className="font-semibold text-ink">Last step:</strong> <strong className="font-semibold text-ink">press {action}</strong>.{' '}
      {action === 'Send test message'
        ? 'If it arrives in Telegram, you are done.'
        : 'If it arrives, you are done.'}{' '}
      Do not rely on notifications until you have seen a test arrive.
    </p>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <p className="text-sm font-semibold text-ink">{children}</p>;
}

/** MUST-11.5: a <details> with the shared summary, so every form carries the same shape. */
export function GuidePanel({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <details open={open} className="rounded-md bg-info-soft px-3.5 py-3 text-sm text-info-soft-fg">
      <summary className="cursor-pointer font-semibold">How do I set this up?</summary>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </details>
  );
}

export function TelegramGuide() {
  return (
    <>
      <Heading>Getting your bot token</Heading>
      <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted">
        <li>Open Telegram on your phone or computer.</li>
        <li>
          In the search box at the top, type <strong className="font-semibold text-ink">BotFather</strong> and open the account called{' '}
          <strong className="font-semibold text-ink">@BotFather</strong>. It has a blue checkmark.
        </li>
        <li>
          Press <strong className="font-semibold text-ink">Start</strong>, then send the message <code>/newbot</code>.
        </li>
        <li>
          BotFather asks for a name. Type anything you like — for example <code>Home Budget</code>. This is just the name that shows up
          on the messages.
        </li>
        <li>
          BotFather then asks for a username. It has to be unused and it has to end in the word <code>bot</code> — for example{' '}
          <code>grewal_home_budget_bot</code>. If it says the name is taken, try another one.
        </li>
        <li>
          BotFather replies with a message containing your token. It looks like this:{' '}
          <code>123456789:AAHk3f-EXAMPLE-tokenxxxxxxxxxxxxxxxxxx</code>
        </li>
        <li>
          Copy that whole line — every character, including the numbers before the colon — and paste it into{' '}
          <strong className="font-semibold text-ink">Bot token</strong> on this page. Then press{' '}
          <strong className="font-semibold text-ink">Save</strong>.
        </li>
      </ol>

      <Heading>Getting your Chat ID</Heading>
      <p className="text-sm text-muted">
        A Telegram bot is not allowed to message you until you have messaged it first. That is a Telegram rule, not something this app
        can skip.
      </p>
      <ol start={8} className="list-decimal space-y-1.5 pl-5 text-sm text-muted">
        <li>Back in Telegram, search for the username you chose in step 5 and open the chat with your new bot.</li>
        <li>
          Press <strong className="font-semibold text-ink">Start</strong>, or just send it the word <code>hello</code>. Anything will do.
        </li>
        <li>
          Come back to this page and <strong className="font-semibold text-ink">press Detect chat ID</strong>. The app asks Telegram
          which conversations your bot has received messages in, and lists them here.
        </li>
        <li>
          Pick yourself from the list. If you set the bot up for a family group chat instead, add the bot to that group, send one message
          there, and <strong className="font-semibold text-ink">press Detect chat ID</strong> again — the group will appear in the list
          too.
        </li>
        <li>
          Press <strong className="font-semibold text-ink">Save</strong>.
        </li>
      </ol>
      <p className="text-sm text-muted">
        If the list comes back empty, it almost always means step 9 did not go through. Send your bot another message and{' '}
        <strong className="font-semibold text-ink">press Detect chat ID</strong> again.
      </p>

      <Heading>About the token</Heading>
      <p className="text-sm text-muted">
        Anyone who has your bot token can send messages as your bot, so treat it like a password. It is stored encrypted on this server,
        it is never shown again after you save it, and it never leaves this server.
      </p>

      <Closing action={GUIDE_CLOSING_ACTION.telegram} />
    </>
  );
}

function BrevoGuide() {
  return (
    <>
      <p className="text-sm text-muted">
        Brevo sends the email for you. The free plan is enough for a household — around{' '}
        <strong className="font-semibold text-ink">300 emails a day</strong>.
      </p>
      <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted">
        <li>
          Go to <strong className="font-semibold text-ink">brevo.com</strong> in your browser and create a free account, or sign in if you
          already have one.
        </li>
        <li>
          Once you are signed in, click your account name in the top-right corner and choose{' '}
          <strong className="font-semibold text-ink">SMTP &amp; API</strong>.
        </li>
        <li>
          Open the <strong className="font-semibold text-ink">SMTP</strong> tab. You will see a server name, a port, and a{' '}
          <strong className="font-semibold text-ink">login</strong> — write the login down, it is usually the email address you signed up
          with.
        </li>
        <li>
          Press <strong className="font-semibold text-ink">Generate a new SMTP key</strong>, give it any name (for example{' '}
          <code>Budget Tracker</code>), and press create.
        </li>
        <li>
          Brevo shows you the key <strong className="font-semibold text-ink">once</strong>. Copy it now — you cannot see it again later,
          though you can always generate another one.
        </li>
        <li>
          Back on this page: <strong className="font-semibold text-ink">Server</strong> and{' '}
          <strong className="font-semibold text-ink">Port</strong> are already filled in for you (<code>smtp-relay.brevo.com</code>, port{' '}
          <code>587</code>, STARTTLS). Leave them alone.
        </li>
        <li>
          Put the <strong className="font-semibold text-ink">login</strong> from step 3 into{' '}
          <strong className="font-semibold text-ink">Username</strong>, and the{' '}
          <strong className="font-semibold text-ink">SMTP key</strong> from step 5 into{' '}
          <strong className="font-semibold text-ink">Password</strong>. The SMTP key is not the same thing as your Brevo account password
          — the account password will not work here.
        </li>
        <li>
          <strong className="font-semibold text-ink">From address</strong> must be an address Brevo has verified as a sender. Your signup
          address already is. If you use a different one, Brevo will refuse to send.
        </li>
        <li>
          Press <strong className="font-semibold text-ink">Save</strong>.
        </li>
      </ol>
      <Closing action={GUIDE_CLOSING_ACTION.brevo} />
    </>
  );
}

function Smtp2goGuide() {
  return (
    <>
      <p className="text-sm text-muted">
        SMTP2GO sends the email for you. The free plan allows around{' '}
        <strong className="font-semibold text-ink">1,000 emails a month</strong>, which is far more than a household will use.
      </p>
      <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted">
        <li>
          Go to <strong className="font-semibold text-ink">smtp2go.com</strong> in your browser and create a free account, or sign in.
        </li>
        <li>
          In the menu on the left, open <strong className="font-semibold text-ink">Sending</strong>, then{' '}
          <strong className="font-semibold text-ink">SMTP Users</strong>.
        </li>
        <li>
          Press <strong className="font-semibold text-ink">Add SMTP User</strong>. Give it any name, and either let it generate a password
          or set one yourself.
        </li>
        <li>
          Write down the <strong className="font-semibold text-ink">username</strong> and{' '}
          <strong className="font-semibold text-ink">password</strong> it shows you. These are only for sending email — they are not your
          SMTP2GO account login.
        </li>
        <li>
          Back on this page: <strong className="font-semibold text-ink">Server</strong> and{' '}
          <strong className="font-semibold text-ink">Port</strong> are already filled in for you (<code>mail.smtp2go.com</code>, port{' '}
          <code>587</code>, STARTTLS). Leave them alone.
        </li>
        <li>
          Put the username and password from step 4 into <strong className="font-semibold text-ink">Username</strong> and{' '}
          <strong className="font-semibold text-ink">Password</strong>.
        </li>
        <li>
          <strong className="font-semibold text-ink">From address</strong> must use a domain SMTP2GO has verified. If you have not added
          your own domain, use the sender address SMTP2GO gives you on the{' '}
          <strong className="font-semibold text-ink">Verified Senders</strong> page.
        </li>
        <li>
          Press <strong className="font-semibold text-ink">Save</strong>.
        </li>
      </ol>
      <Closing action={GUIDE_CLOSING_ACTION.smtp2go} />
    </>
  );
}

function GmailGuide() {
  return (
    <>
      <p className="text-sm text-muted">
        Gmail can send these messages from your own address. It is the fiddliest of the three to set up, and Google limits how much it
        will send — in practice <strong className="font-semibold text-ink">about 100 to 150 messages a day</strong>, which is plenty here.
      </p>
      <p className="text-sm text-muted">
        <strong className="font-semibold text-ink">Your normal Google password will not work.</strong> Google requires a separate
        16-character &ldquo;App password&rdquo; for programs like this one.
      </p>
      <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted">
        <li>
          Go to <strong className="font-semibold text-ink">myaccount.google.com</strong> and sign in.
        </li>
        <li>
          Open <strong className="font-semibold text-ink">Security</strong> in the menu on the left.
        </li>
        <li>
          Find <strong className="font-semibold text-ink">2-Step Verification</strong>. If it is off, turn it on and finish the setup —
          Google will not offer App passwords until it is on.
        </li>
        <li>
          Still under <strong className="font-semibold text-ink">Security</strong>, find{' '}
          <strong className="font-semibold text-ink">App passwords</strong>. (If you cannot see it, search &ldquo;App passwords&rdquo; in
          the search box at the top of the page.)
        </li>
        <li>
          Create one. If Google asks what it is for, choose <strong className="font-semibold text-ink">Mail</strong>, and for the device
          choose <strong className="font-semibold text-ink">Other</strong> and type <code>Budget Tracker</code>.
        </li>
        <li>
          Google shows a 16-character password in four blocks, like <code>abcd efgh ijkl mnop</code>. Copy it. You can type it with or
          without the spaces.
        </li>
        <li>
          Back on this page: <strong className="font-semibold text-ink">Server</strong> and{' '}
          <strong className="font-semibold text-ink">Port</strong> are already filled in for you (<code>smtp.gmail.com</code>, port{' '}
          <code>465</code>, TLS). Leave them alone.
        </li>
        <li>
          Put your full Gmail address into <strong className="font-semibold text-ink">Username</strong>, and the 16-character App password
          from step 6 into <strong className="font-semibold text-ink">Password</strong>.
        </li>
        <li>
          Put that same Gmail address into <strong className="font-semibold text-ink">From address</strong>. Gmail rewrites the sender to
          the account you signed in as, so anything else will be replaced anyway.
        </li>
        <li>
          Press <strong className="font-semibold text-ink">Save</strong>.
        </li>
      </ol>
      <Closing action={GUIDE_CLOSING_ACTION.gmail} />
    </>
  );
}

function CustomGuide() {
  return (
    <>
      <p className="text-sm text-muted">
        Use this if your email provider is not one of the three above, or if you run your own mail server on your network.
      </p>
      <p className="text-sm text-muted">
        Almost every provider has a help page called <strong className="font-semibold text-ink">&ldquo;SMTP settings&rdquo;</strong> or{' '}
        <strong className="font-semibold text-ink">&ldquo;Sending email using SMTP&rdquo;</strong>. It will list the four things this form
        needs. Search for your provider&rsquo;s name plus &ldquo;SMTP settings&rdquo; and you will find it.
      </p>
      <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted">
        <li>
          <strong className="font-semibold text-ink">Server</strong> — the address of the machine that sends the mail, for example{' '}
          <code>smtp.myprovider.com</code>. Not a web address, and no <code>https://</code> in front of it.
        </li>
        <li>
          <strong className="font-semibold text-ink">Port</strong> — a number. <code>587</code> is the usual one. <code>465</code> is the
          other common one, and goes with the <strong className="font-semibold text-ink">TLS</strong> option below.
        </li>
        <li>
          <strong className="font-semibold text-ink">Encryption</strong> — how the connection is protected.
          <ul className="mt-1.5 list-disc space-y-1 pl-5">
            <li>
              <strong className="font-semibold text-ink">STARTTLS</strong> — the normal choice, almost always with port 587.
            </li>
            <li>
              <strong className="font-semibold text-ink">TLS</strong> — used with port 465.
            </li>
            <li>
              <strong className="font-semibold text-ink">None</strong> — no protection at all. Your username, password and messages travel
              readable across the network. Only pick this for a mail server on your own home network, never for anything on the internet.
            </li>
          </ul>
        </li>
        <li>
          <strong className="font-semibold text-ink">Username</strong> and <strong className="font-semibold text-ink">Password</strong> —
          the sign-in details for sending. Many providers want a separate password for this, not your normal account password; their SMTP
          settings page will say so if they do.
        </li>
        <li>
          <strong className="font-semibold text-ink">From address</strong> — the address the email appears to come from. Most providers
          insist this matches the account you signed in as, and will refuse to send otherwise.
        </li>
      </ul>
      <Closing action={GUIDE_CLOSING_ACTION.custom} />
    </>
  );
}

/** MUST-11.7: only the selected preset's guide is ever rendered. */
export function EmailGuide({ preset }: { preset: SmtpPreset }) {
  switch (preset) {
    case 'brevo':
      return <BrevoGuide />;
    case 'smtp2go':
      return <Smtp2goGuide />;
    case 'gmail':
      return <GmailGuide />;
    case 'custom':
      return <CustomGuide />;
  }
}

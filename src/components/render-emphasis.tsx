/**
 * A deliberately tiny bold-run renderer: it handles exactly `**text**` and nothing else —
 * no markdown engine, no dangerouslySetInnerHTML anywhere (MUST-4.8). Shared by AboutPanel
 * (the local changelog) and the Updates card's major-review panel (the remote changelog,
 * fetched from GitHub and treated as untrusted prose) so the two sources render identically
 * and can never drift in appearance from a copy-pasted fork of the same function
 * (MUST-9.5's "same renderer" clause).
 *
 * Everything that is not a `**...**` run passes through as a plain string, which React
 * renders as an escaped text node — so a bullet containing literal `<b>` or `<script>`
 * markup is shown as those characters, never interpreted as markup.
 */
export function renderEmphasis(text: string): React.ReactNode {
  if (!text.includes('**')) return text;
  return text.split(/\*\*(.+?)\*\*/g).map((part, index) =>
    index % 2 === 1 ? (
      <strong key={index} className="font-semibold text-ink">
        {part}
      </strong>
    ) : (
      part
    ),
  );
}

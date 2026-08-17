import { loadChangelog } from '@/lib/changelog';
import { APP_VERSION } from '@/lib/version';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';

/**
 * Server component: the changelog is read from disk on render, so a corrected typo in
 * CHANGELOG.md shows up on the next page load without a rebuild. Rendering is deliberately
 * plain — headings, paragraphs and lists — rather than pulling in a markdown library for a
 * document this app also owns the shape of.
 *
 * The releases are set as a timeline: a hairline rail with a dot per release. Release notes
 * ARE a sequence — that is the one thing the reader needs from them — so the structure earns
 * its keep rather than decorating the list.
 */
/**
 * CHANGELOG.md leans on `**bold**` to name the feature a bullet is about, and those
 * asterisks were being printed literally. Resolving them here rather than in
 * loadChangelog() keeps the parser (and its tests) about structure, and keeps this about
 * presentation — which is also why it handles exactly this one inline form and nothing
 * else: it is a bold-run renderer, not a markdown engine.
 */
function renderEmphasis(text: string): React.ReactNode {
  if (!text.includes('**')) return text;
  return text.split(/\*\*(.+?)\*\*/g).map((part, index) =>
    // Odd indices are the captured inner runs; even indices are the plain text between them.
    index % 2 === 1 ? (
      <strong key={index} className="font-semibold text-ink">
        {part}
      </strong>
    ) : (
      part
    ),
  );
}

export function AboutPanel() {
  const releases = loadChangelog();

  return (
    <Card>
      <CardHeader
        title="About"
        description={
          <>
            Budget Tracker <strong className="font-semibold text-ink" data-testid="app-version">v{APP_VERSION}</strong>
          </>
        }
      />
      <CardBody>
        {releases.length === 0 ? (
          <p className="rounded-md border border-dashed border-line-strong px-4 py-6 text-center text-sm text-muted">
            No changelog is available in this install (CHANGELOG.md was not found).
          </p>
        ) : (
          <div className="max-h-[28rem] overflow-y-auto pr-1">
            <ol className="relative flex flex-col gap-7 border-l border-line pl-6">
              {releases.map((release) => (
                <li key={release.heading} className="relative flex flex-col gap-2">
                  <span
                    aria-hidden="true"
                    className="absolute -left-[1.8125rem] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-accent"
                  />
                  <h3 className="text-sm font-semibold text-ink">{release.heading}</h3>
                  {release.notes.map((note, index) => (
                    <p key={index} className="text-sm text-muted">
                      {renderEmphasis(note)}
                    </p>
                  ))}
                  {release.groups.map((group) => (
                    <div key={group.title} className="flex flex-col gap-1.5">
                      <h4 className="eyebrow">{group.title}</h4>
                      <ul className="flex flex-col gap-1 text-sm text-muted">
                        {group.items.map((item, index) => (
                          <li key={index} className="flex gap-2">
                            <span aria-hidden="true" className="mt-2 h-1 w-1 shrink-0 rounded-full bg-line-strong" />
                            <span>{renderEmphasis(item)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </li>
              ))}
            </ol>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

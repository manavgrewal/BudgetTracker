import { loadChangelog } from '@/lib/changelog';
import { APP_VERSION } from '@/lib/version';

/**
 * Server component: the changelog is read from disk on render, so a corrected typo in
 * CHANGELOG.md shows up on the next page load without a rebuild. Rendering is deliberately
 * plain — headings, paragraphs and lists — rather than pulling in a markdown library for a
 * document this app also owns the shape of.
 */
export function AboutPanel() {
  const releases = loadChangelog();

  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium">About</h2>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Budget Tracker <strong data-testid="app-version">v{APP_VERSION}</strong>
      </p>

      {releases.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No changelog is available in this install (CHANGELOG.md was not found).
        </p>
      ) : (
        <div className="flex max-h-96 flex-col gap-5 overflow-y-auto rounded border border-slate-200 p-4 text-sm dark:border-slate-800">
          {releases.map((release) => (
            <article key={release.heading} className="flex flex-col gap-2">
              <h3 className="font-medium">{release.heading}</h3>
              {release.notes.map((note, index) => (
                <p key={index} className="text-slate-600 dark:text-slate-400">
                  {note}
                </p>
              ))}
              {release.groups.map((group) => (
                <div key={group.title} className="flex flex-col gap-1">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    {group.title}
                  </h4>
                  <ul className="list-inside list-disc text-slate-600 dark:text-slate-400">
                    {group.items.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

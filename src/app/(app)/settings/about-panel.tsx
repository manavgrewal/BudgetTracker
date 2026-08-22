import { loadChangelog } from '@/lib/changelog';
import { APP_VERSION } from '@/lib/version';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import { renderEmphasis } from '@/components/render-emphasis';
import type { OcrEngineKind, OcrEngineState } from '@/lib/warranty/ocr/onnx/probe';

/** ISO to "YYYY-MM-DD HH:MM", which is all a household needs from a timestamp. */
function whenChecked(probedAt: string | null): string {
  return probedAt === null ? 'an unknown date' : probedAt.slice(0, 16).replace('T', ' ');
}

/**
 * Server component: the changelog is read from disk on render, so a corrected typo in
 * CHANGELOG.md shows up on the next page load without a rebuild. Rendering is deliberately
 * plain — headings, paragraphs and lists — rather than pulling in a markdown library for a
 * document this app also owns the shape of.
 *
 * The releases are set as a timeline: a hairline rail with a dot per release. Release notes
 * ARE a sequence — that is the one thing the reader needs from them — so the structure earns
 * its keep rather than decorating the list.
 *
 * CHANGELOG.md leans on `**bold**` to name the feature a bullet is about — rendered through
 * the shared renderEmphasis() (@/components/render-emphasis), the SAME helper the Updates
 * card's major-review panel uses on the remote changelog, so the two never drift in
 * appearance (MUST-9.5).
 *
 * Defect fix (v1.5.0): `liveEngine` and `systemic` answer a question the fallback notice below
 * never could — which reader is ACTUALLY in effect right now (accounting for the OCR_ENGINE
 * override, which the fallback notice's `ocr` prop knows nothing about), and whether OCR is
 * failing on every recent receipt regardless of why. `liveEngine` defaults to `ocr.engine` so
 * every existing caller (and every existing test) keeps working unchanged when there is no
 * override to report.
 */
export function AboutPanel({
  ocr,
  liveEngine = ocr.engine,
  systemic = false,
}: {
  ocr: OcrEngineState;
  liveEngine?: OcrEngineKind | null;
  systemic?: boolean;
}) {
  const releases = loadChangelog();
  // Only when the probe actually fell back AND recorded a reason. Absence of a reason means
  // absence of a probe, not a silent failure.
  const fellBack = ocr.engine === 'tesseract' && ocr.detail !== null;

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
        <p className="mb-4 text-sm text-muted" data-testid="ocr-live-engine">
          {liveEngine === 'onnx'
            ? 'Receipts are currently read by the new receipt reader.'
            : liveEngine === 'tesseract'
              ? 'Receipts are currently read by the older reader.'
              : 'This install has not read a receipt yet, so it has not checked which reader it will use.'}
        </p>
        {systemic ? (
          <Notice tone="error" title="Receipts are not being read right now." className="mb-4">
            <p>
              The last few receipts all failed to read. That is different from one unreadable photo — something
              about the reader itself is failing every time, on every receipt.
            </p>
            <p>Receipts still upload safely. Only the automatic reading of them is affected.</p>
          </Notice>
        ) : null}
        {fellBack ? (
          <Notice tone="warning" title="This machine cannot run the new receipt reader." className="mb-4">
            <p>
              Budget Tracker checked once, the first time this version read a receipt here, and the check did not
              survive. It has gone back to the older reader. Receipts still upload and are still read, just less
              accurately.
            </p>
            <p>
              There is nothing to fix. This is a limitation of the processor in this machine, not a setting, and the
              check will run again by itself the next time you update.
            </p>
            <p>
              Recorded reason: {ocr.detail}, checked on {whenChecked(ocr.probedAt)}.
            </p>
          </Notice>
        ) : null}
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

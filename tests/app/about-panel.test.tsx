// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { render, cleanup, screen } from '@testing-library/react';
import { AboutPanel } from '@/app/(app)/settings/about-panel';
import { APP_VERSION } from '@/lib/version';
import type { OcrEngineState } from '@/lib/warranty/ocr/onnx/probe';

const NO_PROBE: OcrEngineState = { engine: null, probedVersion: null, probedAt: null, detail: null };
const FELL_BACK: OcrEngineState = {
  engine: 'tesseract',
  // Built from APP_VERSION, which this file already imports, rather than typed as a literal:
  // a release number frozen into a fixture in this task is a release number Task 13 has not
  // decided yet (plan resolution 13).
  probedVersion: `${APP_VERSION}/arm64`,
  probedAt: '2026-08-18T09:41:07.000Z',
  detail: 'probe process was killed by SIGILL',
};

afterEach(() => {
  cleanup();
  delete process.env.BUDGET_CHANGELOG_PATH;
});

describe('Settings → About', () => {
  it('shows the running version', () => {
    const { getByTestId } = render(<AboutPanel ocr={NO_PROBE} />);
    expect(getByTestId('app-version').textContent).toBe(`v${APP_VERSION}`);
  });

  it('renders the real changelog: release headings, group titles and bullets', () => {
    const { container, getByText } = render(<AboutPanel ocr={NO_PROBE} />);
    expect(getByText('Unreleased')).toBeTruthy();
    expect(container.textContent).toContain(APP_VERSION);
    // Sections render as headings + lists, not as raw markdown. (The date in a heading
    // like "[1.0.0] - 2026-08-16" is why this checks the bullets, not the whole text.)
    expect(container.textContent).not.toContain('### ');
    const items = Array.from(container.querySelectorAll('li'));
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.textContent?.startsWith('- ')).toBe(false);
    expect(Array.from(container.querySelectorAll('h4')).map((h) => h.textContent)).toContain('Added');
  });

  it('never leaks the maintenance comment at the top of the file', () => {
    const { container } = render(<AboutPanel ocr={NO_PROBE} />);
    expect(container.textContent).not.toContain('HOW TO KEEP THIS FILE');
  });

  it('says so plainly when the changelog is missing, instead of rendering an empty box', () => {
    process.env.BUDGET_CHANGELOG_PATH = path.join(os.tmpdir(), `budget-absent-${Date.now()}.md`);
    const { container, getByTestId } = render(<AboutPanel ocr={NO_PROBE} />);
    expect(container.textContent).toContain('No changelog is available');
    // The version still shows — it does not depend on the file.
    expect(getByTestId('app-version').textContent).toBe(`v${APP_VERSION}`);
  });

  it('renders whatever the file says, so a fixed typo needs no rebuild', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'budget-about-')), 'CHANGELOG.md');
    fs.writeFileSync(file, '## 9.9.9 - 2030-01-01\n\n### Added\n\n- a bullet written at runtime\n');
    process.env.BUDGET_CHANGELOG_PATH = file;
    const { getByText } = render(<AboutPanel ocr={NO_PROBE} />);
    expect(getByText('9.9.9 - 2030-01-01')).toBeTruthy();
    expect(getByText('a bullet written at runtime')).toBeTruthy();
  });
});

describe('MUST-5.16: the fallback warning', () => {
  it('renders when the engine is the older reader and a reason was recorded', () => {
    render(<AboutPanel ocr={FELL_BACK} />);
    expect(screen.getByText(/This machine cannot run the new receipt reader\./)).toBeTruthy();
    expect(screen.getByText(/probe process was killed by SIGILL/)).toBeTruthy();
    expect(screen.getByText(/2026-08-18 09:41/)).toBeTruthy();
  });

  it('does not render when the engine fell back but no reason was recorded', () => {
    render(<AboutPanel ocr={{ ...FELL_BACK, detail: null }} />);
    expect(screen.queryByText(/This machine cannot run/)).toBeNull();
  });

  it('does not render for the new reader', () => {
    render(<AboutPanel ocr={{ ...FELL_BACK, engine: 'onnx', detail: null }} />);
    expect(screen.queryByText(/This machine cannot run/)).toBeNull();
  });

  it('does not render when the keys are absent', () => {
    render(<AboutPanel ocr={NO_PROBE} />);
    expect(screen.queryByText(/This machine cannot run/)).toBeNull();
  });

  it('MUST-5.18: the warning names no library, no model and no version number', () => {
    render(<AboutPanel ocr={{ ...FELL_BACK, detail: 'probe timed out after 60 seconds' }} />);
    // Scoped to the Notice, not the whole panel. AboutPanel also renders the real
    // CHANGELOG.md, whose 1.5.0 entry legitimately contains version numbers and the word
    // "models", so a container-wide assertion would be testing the changelog.
    const warning = screen.getByRole('status').textContent ?? '';
    for (const banned of ['PP-OCR', 'ONNX', 'onnx', 'tesseract', 'Tesseract', 'model', 'Model']) {
      expect(warning).not.toContain(banned);
    }
    // Plan resolution 13: no release number in shipped copy.
    expect(warning).not.toMatch(/\d+\.\d+\.\d+/);
    expect(warning).toContain('the new receipt reader');
    expect(warning).toContain('the older reader');
  });

  it('the recorded reason is a text node, not markup', () => {
    const { container } = render(<AboutPanel ocr={{ ...FELL_BACK, detail: 'exploded <b>badly</b>' }} />);
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('exploded <b>badly</b>');
  });

  it('sits above the changelog list', () => {
    const { container } = render(<AboutPanel ocr={FELL_BACK} />);
    const warning = screen.getByRole('status');
    const list = container.querySelector('ol');
    // AboutPanel renders the <ol> only when loadChangelog() returns something. This repo has
    // a real CHANGELOG.md so it does; assert that rather than letting indexOf('<ol') === -1
    // make the ordering check pass for the wrong reason.
    expect(list).not.toBeNull();
    expect(
      warning.compareDocumentPosition(list as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

// Defect fix (v1.5.0): an admin whose ONNX path throws on every receipt previously had no way
// to see it anywhere — the fallback notice above only ever fires when the PROBE fell back,
// which a run-time throw never touches. These two describe blocks cover the two new signals.
describe('defect fix: which engine is live (liveEngine prop)', () => {
  it('states the new reader when liveEngine is onnx, regardless of the probe detail', () => {
    render(<AboutPanel ocr={NO_PROBE} liveEngine="onnx" />);
    expect(screen.getByTestId('ocr-live-engine').textContent).toContain('the new receipt reader');
  });

  it('states the older reader when liveEngine is tesseract', () => {
    render(<AboutPanel ocr={NO_PROBE} liveEngine="tesseract" />);
    expect(screen.getByTestId('ocr-live-engine').textContent).toContain('the older reader');
  });

  it('says plainly that nothing has been checked yet when liveEngine is null', () => {
    render(<AboutPanel ocr={NO_PROBE} liveEngine={null} />);
    const text = screen.getByTestId('ocr-live-engine').textContent ?? '';
    expect(text).not.toContain('the new receipt reader');
    expect(text).not.toContain('the older reader');
    expect(text.length).toBeGreaterThan(0);
  });

  it('defaults liveEngine to ocr.engine, so every existing caller keeps reporting correctly unchanged', () => {
    render(<AboutPanel ocr={{ ...NO_PROBE, engine: 'onnx' }} />);
    expect(screen.getByTestId('ocr-live-engine').textContent).toContain('the new receipt reader');
  });

  it('an OCR_ENGINE override can report a DIFFERENT live engine than the probe\'s own cached verdict', () => {
    // This is exactly the case liveEngine exists for: the cached probe still says 'onnx' (it
    // was never re-probed), but an admin has forced tesseract via the override, and the panel
    // must say so rather than repeating the stale cached verdict.
    render(<AboutPanel ocr={{ ...NO_PROBE, engine: 'onnx' }} liveEngine="tesseract" />);
    expect(screen.getByTestId('ocr-live-engine').textContent).toContain('the older reader');
  });

  it('names no library, no model and no version number, matching MUST-5.18\'s standard elsewhere on this panel', () => {
    render(<AboutPanel ocr={NO_PROBE} liveEngine="onnx" />);
    const text = screen.getByTestId('ocr-live-engine').textContent ?? '';
    for (const banned of ['PP-OCR', 'ONNX', 'onnx', 'tesseract', 'Tesseract', 'model', 'Model']) {
      expect(text).not.toContain(banned);
    }
  });
});

describe('defect fix: systemic OCR failure notice', () => {
  it('does not render when systemic is false (the default)', () => {
    render(<AboutPanel ocr={NO_PROBE} />);
    expect(screen.queryByText(/Receipts are not being read right now\./)).toBeNull();
  });

  it('renders an alert when systemic is true, independent of the fallback notice', () => {
    render(<AboutPanel ocr={NO_PROBE} systemic />);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Receipts are not being read right now\./)).toBeTruthy();
  });

  it('can render alongside the fallback notice — they answer different questions', () => {
    render(<AboutPanel ocr={FELL_BACK} systemic />);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('names no library, no model and no version number', () => {
    render(<AboutPanel ocr={NO_PROBE} systemic />);
    const text = screen.getByRole('alert').textContent ?? '';
    for (const banned of ['PP-OCR', 'ONNX', 'onnx', 'tesseract', 'Tesseract', 'model', 'Model']) {
      expect(text).not.toContain(banned);
    }
  });

  it('sits above the changelog list, same as the fallback notice', () => {
    const { container } = render(<AboutPanel ocr={NO_PROBE} systemic />);
    const alert = screen.getByRole('alert');
    const list = container.querySelector('ol');
    expect(list).not.toBeNull();
    expect(alert.compareDocumentPosition(list as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (name: string) => fs.readFileSync(path.join(root, name), 'utf8');

const WORKFLOW_PATH = '.github/workflows/test.yml';

/**
 * B9. Same rationale as tests/ops/release-image.test.ts: no YAML parser is a dependency of
 * this project, so these are careful text assertions rather than a real parse.
 *
 * This workflow is the ONLY thing that runs vitest/tsc in CI -- release-image.yml's guard
 * job never did, and now depends on this workflow (via workflow_call) instead of duplicating
 * its steps. A silent edit here -- a dropped trigger, a step put back out of order, an
 * un-pinned action -- would have nothing else in the repo to catch it, the same gap the
 * Dockerfile/release-image ops tests already close for those two files.
 */
describe('.github/workflows/test.yml', () => {
  const workflow = read(WORKFLOW_PATH);

  it('contains no tab-indented lines (a common YAML parse-breaker)', () => {
    const lines = workflow.split(/\r?\n/);
    for (const line of lines) {
      const leading = line.match(/^[ \t]*/)?.[0] ?? '';
      expect(leading, `tab indentation found: ${JSON.stringify(line)}`).not.toContain('\t');
    }
  });

  it('runs on push to main and on every pull request', () => {
    const onBlock = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('permissions:'));
    expect(onBlock).toMatch(/push:/);
    expect(onBlock).toMatch(/branches:\s*\n\s*-\s*main/);
    expect(onBlock).toMatch(/pull_request:\s*\{\}/);
  });

  it('is callable as a reusable workflow, so release-image.yml can depend on it instead of duplicating its steps', () => {
    const onBlock = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('permissions:'));
    expect(onBlock).toMatch(/workflow_call:/);
  });

  it('declares read-only permissions (it never needs to push anything)', () => {
    const beforeJobs = workflow.slice(0, workflow.indexOf('\njobs:'));
    expect(beforeJobs).toMatch(/^permissions:\s*$/m);
    const permissionsBlock = beforeJobs.slice(beforeJobs.indexOf('permissions:'));
    expect(permissionsBlock).toMatch(/contents:\s*read/);
    expect(permissionsBlock).not.toMatch(/write/);
  });

  it('pins every action to a major version, not a floating branch or SHA-less latest', () => {
    const usesLines = workflow.match(/uses:\s*\S+/g) ?? [];
    expect(usesLines.length).toBeGreaterThan(0);
    for (const line of usesLines) {
      expect(line, `unpinned or non-major-version action: ${line}`).toMatch(/@v\d+$/);
    }
    expect(workflow).toContain('actions/checkout@v');
    expect(workflow).toContain('actions/setup-node@v');
  });

  it('runs on Node 22', () => {
    expect(workflow).toMatch(/node-version:\s*'22'/);
  });

  it('vendors the scanner assets before both the typecheck and the test run, so a future import in src/lib/scanner cannot fail CI-only', () => {
    // src/lib/scanner/load.ts currently references the vendored files as same-origin URL
    // strings, never as a module import, which is the only reason tsc-before-vendor was
    // harmless. That is an accident of the current code, not a guarantee -- so the fix is
    // to reorder the steps, not to rely on the accident continuing to hold.
    const vendorIndex = workflow.indexOf('vendor-scanner-assets.mjs');
    const tscIndex = workflow.indexOf('tsc --noEmit');
    const vitestIndex = workflow.indexOf('vitest run');
    expect(vendorIndex).toBeGreaterThan(-1);
    expect(tscIndex).toBeGreaterThan(-1);
    expect(vitestIndex).toBeGreaterThan(-1);
    expect(vendorIndex).toBeLessThan(tscIndex);
    expect(vendorIndex).toBeLessThan(vitestIndex);
  });

  it('runs the typecheck', () => {
    expect(workflow).toContain('npx tsc --noEmit');
  });

  it('runs the full test suite with the worker-teardown-flake workaround', () => {
    expect(workflow).toContain('npx vitest run --no-file-parallelism');
  });

  it('installs dependencies with npm ci before anything that needs node_modules', () => {
    const ciIndex = workflow.indexOf('npm ci');
    expect(ciIndex).toBeGreaterThan(-1);
    expect(ciIndex).toBeLessThan(workflow.indexOf('vendor-scanner-assets.mjs'));
  });
});

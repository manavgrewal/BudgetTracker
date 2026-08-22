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

  it('declares workflow_call with no required inputs or secrets, so release-image.yml (which calls it with no `with:`/`secrets:` block at all) can never fail to invoke it', () => {
    const onBlock = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('permissions:'));
    const callIndex = onBlock.indexOf('workflow_call:');
    expect(callIndex).toBeGreaterThan(-1);
    // Slice to the end of the "on:" block (there's nothing else after workflow_call today,
    // and even if a sibling trigger were added later, requiring the substring to be absent
    // ANYWHERE past this point is the conservative direction to fail in).
    expect(onBlock.slice(callIndex)).not.toMatch(/required:\s*true/);
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

  /**
   * Structural helpers rather than plain text search: `workflow.indexOf(needle)` cannot
   * tell a real step from a comment that happens to mention the same command, and cannot
   * tell "same job" from "some other job later in the file" -- so moving the vendor step
   * into a separate job (a different runner filesystem, and therefore real breakage) would
   * still satisfy an indexOf-before-indexOf check as long as the job order in the YAML
   * didn't change. Parse just enough structure (job blocks, then `- name:` step
   * boundaries within one job) to rule both of those out.
   */
  function jobNames(text: string): string[] {
    return [...text.matchAll(/^ {2}([A-Za-z_][\w-]*):\s*$/gm)].map((m) => m[1]);
  }

  function jobBlock(text: string, name: string): string {
    const header = new RegExp(`^ {2}${name}:\\s*$`, 'm').exec(text);
    if (!header) throw new Error(`job "${name}" not found in workflow`);
    const start = header.index + header[0].length;
    const rest = text.slice(start);
    const nextHeader = /^ {2}[A-Za-z_][\w-]*:\s*$/m.exec(rest.slice(1));
    const end = nextHeader ? start + 1 + nextHeader.index : text.length;
    return text.slice(start, end);
  }

  /** Splits one job's `steps:` list into per-step chunks at each `      - name:` boundary. */
  function steps(block: string): Array<{ name: string; body: string }> {
    const markers = [...block.matchAll(/^ {6}- name:[ \t]*(.+)$/gm)];
    return markers.map((marker, i) => {
      const bodyStart = marker.index! + marker[0].length;
      const bodyEnd = i + 1 < markers.length ? markers[i + 1].index! : block.length;
      return { name: marker[1].trim(), body: block.slice(bodyStart, bodyEnd) };
    });
  }

  /** A step actually RUNS `commandSubstring` -- i.e. has a `run:` line containing it, not
   *  merely a comment line (which never starts with optional whitespace + literal `run:`). */
  function runs(step: { body: string }, commandSubstring: string): boolean {
    const escaped = commandSubstring.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^[ \\t]*run:.*${escaped}`, 'm').test(step.body);
  }

  // Job names only, not push/pull_request/workflow_call (which sit two spaces deep under
  // "on:" and would otherwise match the same "  <word>:" shape jobs use under "jobs:").
  const jobsBlock = workflow.slice(workflow.indexOf('\njobs:'));

  it('has exactly one job, named "test" -- the invariant the checks below rely on to mean anything', () => {
    expect(jobNames(jobsBlock)).toEqual(['test']);
  });

  it('vendors the scanner assets before both the typecheck and the test run, as three REAL steps inside the SAME job\'s steps list', () => {
    // src/lib/scanner/load.ts currently references the vendored files as same-origin URL
    // strings, never as a module import, which is the only reason tsc-before-vendor was
    // harmless. That is an accident of the current code, not a guarantee -- so the fix is
    // to reorder the steps, not to rely on the accident continuing to hold.
    const testSteps = steps(jobBlock(jobsBlock, 'test'));
    const vendorStep = testSteps.findIndex((step) => runs(step, 'vendor-scanner-assets.mjs'));
    const tscStep = testSteps.findIndex((step) => runs(step, 'tsc --noEmit'));
    const vitestStep = testSteps.findIndex((step) => runs(step, 'vitest run'));

    // findIndex returning -1 for any of these would mean the command moved to a different
    // job entirely (jobBlock/steps only ever see the "test" job's own steps list), not
    // merely to a different position within it.
    expect(vendorStep).toBeGreaterThan(-1);
    expect(tscStep).toBeGreaterThan(-1);
    expect(vitestStep).toBeGreaterThan(-1);
    expect(vendorStep).toBeLessThan(tscStep);
    expect(vendorStep).toBeLessThan(vitestStep);
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

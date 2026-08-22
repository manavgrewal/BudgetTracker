import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (name: string) => fs.readFileSync(path.join(root, name), 'utf8');

const WORKFLOW_PATH = '.github/workflows/release-image.yml';

/**
 * No YAML parser is a dependency of this project (checked package.json's devDependencies), so
 * these are careful text assertions rather than a real parse — the same approach the sibling
 * ops tests already use for the Dockerfile and compose files. As a lightweight parseability
 * smoke test, YAML forbids tabs for indentation, so a tab anywhere is a real red flag.
 */
describe('.github/workflows/release-image.yml', () => {
  const workflow = read(WORKFLOW_PATH);

  it('contains no tab-indented lines (a common YAML parse-breaker)', () => {
    const lines = workflow.split(/\r?\n/);
    for (const line of lines) {
      const leading = line.match(/^[ \t]*/)?.[0] ?? '';
      expect(leading, `tab indentation found: ${JSON.stringify(line)}`).not.toContain('\t');
    }
  });

  it('has balanced braces and no obviously truncated flow mappings', () => {
    const opens = (workflow.match(/\{/g) ?? []).length;
    const closes = (workflow.match(/\}/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it('triggers on version tags and manual dispatch, and NOT on every push to a branch', () => {
    const onBlock = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('permissions:'));
    expect(onBlock).toMatch(/push:/);
    expect(onBlock).toMatch(/tags:\s*\n\s*-\s*'v\*'/);
    expect(onBlock).toMatch(/workflow_dispatch:/);
    // The whole point: image releases are deliberate/tag-driven, not a side effect of
    // merging to main. A "branches:" trigger here would defeat that.
    expect(onBlock).not.toMatch(/branches:/);
  });

  it('declares packages: write and contents: write at the workflow level (the release step needs contents: write)', () => {
    const beforeJobs = workflow.slice(0, workflow.indexOf('\njobs:'));
    expect(beforeJobs).toMatch(/^permissions:\s*$/m);
    const permissionsBlock = beforeJobs.slice(beforeJobs.indexOf('permissions:'));
    expect(permissionsBlock).toMatch(/contents:\s*write/);
    expect(permissionsBlock).toMatch(/packages:\s*write/);
  });

  it('targets the GHCR image name, computed from the repo owner rather than hardcoded (so an account/org rename cannot break it), lowercased for GHCR', () => {
    expect(workflow).toContain('github.repository_owner');
    expect(workflow).toContain('ghcr.io/${OWNER_LC}/budgettracker');
    expect(workflow).toMatch(/tr\s+'\[:upper:\]'\s+'\[:lower:\]'/);
    expect(workflow).not.toMatch(/ghcr\.io\/[a-zA-Z0-9-]+\/budgettracker/);
  });

  it('pins every third-party action to a major version, not a floating branch or SHA-less latest', () => {
    // The local reusable-workflow call (uses: ./.github/workflows/test.yml) is excluded on
    // purpose: a same-repo path has no @ref to pin because it always resolves against the
    // exact commit this workflow is running from -- there is no floating-branch risk to
    // guard against the way there is for a third-party action.
    const usesLines = (workflow.match(/uses:\s*\S+/g) ?? []).filter(
      (line) => !line.includes('./.github/workflows/'),
    );
    expect(usesLines.length).toBeGreaterThan(0);
    for (const line of usesLines) {
      expect(line, `unpinned or non-major-version action: ${line}`).toMatch(/@v\d+$/);
    }
    for (const action of [
      'actions/checkout@v',
      'actions/setup-node@v',
      'docker/setup-qemu-action@v',
      'docker/setup-buildx-action@v',
      'docker/login-action@v',
      'docker/build-push-action@v',
    ]) {
      expect(workflow).toContain(action);
    }
  });

  it('B9: calls the shared test workflow as a local reusable workflow instead of duplicating its steps', () => {
    expect(workflow).toContain('uses: ./.github/workflows/test.yml');
    // The line above is a string match against this file's text; it stays green even if
    // the referenced workflow is renamed or deleted, and only fails on GitHub, at the
    // worst possible time (a release push). Assert the referenced path actually exists.
    expect(fs.existsSync(path.join(root, '.github/workflows/test.yml'))).toBe(true);
  });

  it('builds both linux/amd64 and linux/arm64', () => {
    expect(workflow).toContain('linux/amd64,linux/arm64');
  });

  it('tags the pushed image with both the version and latest', () => {
    const buildJob = workflow.slice(workflow.indexOf('build:'));
    expect(buildJob).toMatch(/\$\{\{\s*env\.IMAGE_NAME\s*\}\}:\$\{\{\s*needs\.guard\.outputs\.version\s*\}\}/);
    expect(buildJob).toMatch(/\$\{\{\s*env\.IMAGE_NAME\s*\}\}:latest/);
  });

  it('logs in with GITHUB_TOKEN, not a hand-rolled PAT secret', () => {
    expect(workflow).toContain('password: ${{ secrets.GITHUB_TOKEN }}');
  });

  it('uses the GitHub Actions cache for build layers', () => {
    expect(workflow).toContain('cache-from: type=gha');
    expect(workflow).toContain('cache-to: type=gha');
  });

  it('runs the repo OCR-assets guard before any image is built', () => {
    expect(workflow).toContain('node scripts/check-ocr-assets.mjs');
    expect(workflow.indexOf('node scripts/check-ocr-assets.mjs')).toBeLessThan(workflow.indexOf('build-push-action'));
  });

  it('fails loudly when the pushed tag does not match package.json version', () => {
    const guardJob = workflow.slice(workflow.indexOf('guard:'), workflow.indexOf('build:'));
    expect(guardJob).toContain("require('./package.json').version");
    expect(guardJob).toMatch(/tagVersion !== pkgVersion/);
    expect(guardJob).toContain('process.exit(1)');
    expect(guardJob).toMatch(/does not match package\.json version/);
  });

  it('the build job depends on the guard job, so a bad version never reaches a push', () => {
    const buildJob = workflow.slice(workflow.indexOf('\n  build:'));
    expect(buildJob).toMatch(/needs:\s*\[[^\]]*\bguard\b[^\]]*\]/);
  });

  it('B9: the build job ALSO depends on the test workflow, so a failing suite never reaches a push', () => {
    const buildJob = workflow.slice(workflow.indexOf('\n  build:'));
    expect(buildJob).toMatch(/needs:\s*\[[^\]]*\btest\b[^\]]*\]/);
  });

  it('MUST-10.14: the guard vendors the scanner assets before it checks them', () => {
    const guardJob = workflow.slice(workflow.indexOf('  guard:'), workflow.indexOf('  build:'));
    expect(guardJob).toContain('node scripts/vendor-scanner-assets.mjs');
    expect(guardJob.indexOf('vendor-scanner-assets.mjs')).toBeLessThan(
      guardJob.indexOf('node scripts/check-ocr-assets.mjs'),
    );
  });

  it('MUST-10.16: the architecture comment tells the truth about onnxruntime-node', () => {
    expect(workflow).not.toContain('is architecture-neutral');
    expect(workflow).toMatch(/architecture-specific native binary/);
    expect(workflow).toMatch(/darwin and win32 payloads are\s*#?\s*stripped/);
    expect(workflow).toMatch(/decided at run time/);
  });

  it('MUST-10.17: still exactly two platforms and no emulated smoke-test job', () => {
    expect(workflow).toContain('linux/amd64,linux/arm64');
    expect(workflow).not.toContain('cortex-a53');
  });
});

describe('install/synology-compose-pull.yml', () => {
  const pullCompose = read('install/synology-compose-pull.yml');
  const buildCompose = read('install/synology-compose.yml');

  it('pulls the GHCR image and has no build line', () => {
    expect(pullCompose).toContain('image: ghcr.io/vibelogiccode/budgettracker:latest');
    expect(pullCompose).not.toMatch(/^\s*build:\s*\./m);
    expect(pullCompose).not.toContain('build: .');
  });

  it('explains what it is, the optional SECRET_KEY override, the data-folder permission step, and how to pin a version', () => {
    expect(pullCompose).toMatch(/zero-config/i);
    expect(pullCompose).toMatch(/docs\/INSTALL-SYNOLOGY\.md steps? 1-2/);
    expect(pullCompose).toMatch(/Read\/Write/);
    // The bare `1\.2\.0` alternative that used to sit at the end of this regex was vacuous:
    // it matches that version number ANYWHERE in the file, so the assertion passed even if
    // the actual "how to pin a version" explanation were deleted, as long as an unrelated
    // "1.2.0" string turned up somewhere else. Dropped -- only the two real phrasings remain.
    expect(pullCompose).toMatch(/:latest.*to a specific version tag|change.*:latest.*to.*:1\.2\.0/i);
  });

  it('ships SECRET_KEY commented out as an optional override, not a required placeholder (no .env here either)', () => {
    expect(pullCompose).toMatch(/#\s*SECRET_KEY:/);
    expect(pullCompose).not.toMatch(/^\s*SECRET_KEY:/m);
    expect(pullCompose).not.toContain('PASTE-YOUR-GENERATED-KEY-HERE');
    expect(pullCompose).not.toContain('${SECRET_KEY');
  });

  // v1.2.3 added a watchtower service after budget-tracker, so hardening assertions must be
  // scoped to the budget-tracker service block only — watchtower deliberately does not carry
  // any of this (it needs the Docker socket, and its upstream image is minimal already).
  const budgetTrackerService = pullCompose.slice(
    pullCompose.indexOf('  budget-tracker:'),
    pullCompose.indexOf('  watchtower:'),
  );
  const watchtowerService = pullCompose.slice(pullCompose.indexOf('  watchtower:'));

  it('keeps every hardening setting from the main compose file on the budget-tracker service (read_only, cap_drop, no-new-privileges, tmpfs, healthcheck)', () => {
    for (const needle of [
      'read_only: true',
      'tmpfs:',
      '/tmp',
      'cap_drop:',
      'no-new-privileges:true',
      'healthcheck:',
      '/api/health',
    ]) {
      expect(budgetTrackerService, `missing hardening needle on budget-tracker: ${needle}`).toContain(needle);
      expect(buildCompose, `sanity: build compose missing ${needle}`).toContain(needle);
    }
  });

  it('uses the same service and container name as the build-from-source compose', () => {
    expect(pullCompose).toContain('container_name: budget-tracker');
    expect(pullCompose).toContain('services:\n  budget-tracker:');
  });

  it('mounts /data the same relative way as the build compose', () => {
    expect(pullCompose).toContain('./data:/data');
  });

  it('labels the budget-tracker service so watchtower only ever acts on it', () => {
    expect(budgetTrackerService).toMatch(/labels:\s*\n\s*com\.centurylinklabs\.watchtower\.enable:\s*"true"/);
  });

  it('ships a label-scoped watchtower companion driven by the app over the HTTP API', () => {
    expect(watchtowerService).toContain('image: containrrr/watchtower:latest');
    expect(watchtowerService).toContain('container_name: budget-tracker-watchtower');
    expect(watchtowerService).toMatch(/restart:\s*unless-stopped/);
    expect(watchtowerService).toContain('/var/run/docker.sock:/var/run/docker.sock');
    expect(watchtowerService).toMatch(/WATCHTOWER_LABEL_ENABLE:\s*"true"/);
    expect(watchtowerService).toMatch(/WATCHTOWER_CLEANUP:\s*"true"/);
    // v1.3.1 (MUST-16.1): HTTP-API mode replaces the daily poll.
    expect(watchtowerService).toMatch(/WATCHTOWER_HTTP_API_UPDATE:\s*"true"/);
    expect(watchtowerService).toMatch(/WATCHTOWER_HTTP_API_TOKEN:\s*"[^"]+"/);
    expect(watchtowerService).not.toContain('WATCHTOWER_POLL_INTERVAL');
  });

  it('MUST-16.2: the watchtower service publishes NO port to the host, ever', () => {
    // An unauthenticated-by-default container-control endpoint on the LAN is exactly the
    // thing the private-network argument in MUST-8.2 depends on not existing.
    expect(watchtowerService).not.toMatch(/^\s*ports:/m);
  });

  it('MUST-16.3: the app service carries both variables, and the token matches Watchtower\'s', () => {
    expect(budgetTrackerService).toMatch(/WATCHTOWER_URL:\s*"http:\/\/watchtower:8080\/v1\/update"/);
    const appToken = /WATCHTOWER_TOKEN:\s*"([^"]+)"/.exec(budgetTrackerService)?.[1];
    const watchtowerToken = /WATCHTOWER_HTTP_API_TOKEN:\s*"([^"]+)"/.exec(watchtowerService)?.[1];
    expect(appToken).toBeDefined();
    expect(appToken).toBe(watchtowerToken);
  });

  it('MUST-16.4 / MUST-16.5: the header says updates are off until an admin turns them on', () => {
    expect(pullCompose).not.toMatch(/UPDATES ARE AUTOMATIC BY DEFAULT/);
    expect(pullCompose).toMatch(/Settings -> About/);
    expect(pullCompose).toMatch(/RECEIVES NO UPDATES AT\s*#?\s*ALL/);
    expect(pullCompose).toMatch(/docker\.sock/);
    expect(pullCompose).toMatch(/never published to the host/i);
  });

  it('does not give watchtower the app-container hardening (it needs the Docker socket, not a locked-down filesystem)', () => {
    expect(watchtowerService).not.toContain('read_only: true');
    expect(watchtowerService).not.toContain('cap_drop:');
  });

  it('documents how updates work now and how to opt out of them entirely', () => {
    expect(pullCompose).toMatch(/automatic/i);
    expect(pullCompose).toMatch(/opts? OUT of updates entirely|opting out/i);
    expect(pullCompose).toMatch(/docker\.sock/);
    expect(pullCompose).toMatch(/label/i);
  });
});

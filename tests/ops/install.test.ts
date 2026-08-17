import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const read = (name: string) => fs.readFileSync(path.join(root, name), 'utf8');

function bash(args: string[]) {
  return spawnSync('bash', args, { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
}

function hasCommand(command: string): boolean {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], { encoding: 'utf8' });
  return probe.status === 0;
}

const SHELL_SCRIPTS = ['install/install-linux.sh', 'install/install-synology.sh', 'install/update.sh'];

describe('shell script syntax', () => {
  it.each(SHELL_SCRIPTS)('%s parses with bash -n', (script) => {
    const result = bash(['-n', script]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it.each(SHELL_SCRIPTS)('%s uses a strict shell mode', (script) => {
    expect(read(script)).toContain('set -euo pipefail');
  });

  it.each(SHELL_SCRIPTS)('%s starts with a bash shebang', (script) => {
    expect(read(script).split('\n')[0]).toMatch(/^#!\/usr\/bin\/env bash$/);
  });
});

describe('install-linux.sh --help', () => {
  it('documents every flag the spec requires', () => {
    const result = bash(['install/install-linux.sh', '--help']);
    expect(result.status).toBe(0);
    for (const flag of ['--update', '--uninstall', '--purge-data', '--load', '--dry-run', '--port']) {
      expect(result.stdout).toContain(flag);
    }
  });

  it('rejects an unknown flag with a non-zero exit', () => {
    const result = bash(['install/install-linux.sh', '--wat']);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/unknown option/i);
  });
});

describe('install-linux.sh --dry-run', () => {
  const result = bash(['install/install-linux.sh', '--dry-run']);

  it('exits cleanly without touching anything', () => {
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
  });

  it('plans the whole documented sequence', () => {
    const out = result.stdout;
    expect(out).toMatch(/dry.run/i);
    expect(out).toContain('SECRET_KEY');
    expect(out).toContain('.env');
    expect(out).toContain('docker compose build');
    expect(out).toContain('docker compose up -d');
    expect(out).toContain('/api/health');
    expect(out).toContain('http://');
  });

  it('targets the same compose service and image as the Dockerfile task', () => {
    expect(result.stdout).toContain('budget-tracker');
  });

  it('honours --port in the planned URL and the override file', () => {
    const ported = bash(['install/install-linux.sh', '--dry-run', '--port', '8123']);
    expect(ported.status).toBe(0);
    expect(ported.stdout).toContain('8123');
    expect(ported.stdout).toContain('docker-compose.override.yml');
  });

  it('plans a docker load instead of a build when given --load', () => {
    const loaded = bash(['install/install-linux.sh', '--dry-run', '--load', 'budget-tracker.tar']);
    expect(loaded.status).toBe(0);
    expect(loaded.stdout).toContain('docker load');
    expect(loaded.stdout).toContain('budget-tracker.tar');
    expect(loaded.stdout).not.toContain('docker compose build');
  });

  it('plans an update that preserves data', () => {
    const updated = bash(['install/install-linux.sh', '--dry-run', '--update']);
    expect(updated.status).toBe(0);
    expect(updated.stdout).toMatch(/preserv|kept|untouched/i);
    expect(updated.stdout).not.toContain('rm -rf');
  });

  it('plans an uninstall that keeps /data unless --purge-data is given', () => {
    const kept = bash(['install/install-linux.sh', '--dry-run', '--uninstall']);
    expect(kept.status).toBe(0);
    expect(kept.stdout).toContain('docker compose down');
    expect(kept.stdout).toMatch(/data.*(kept|preserved)/i);
    expect(kept.stdout).not.toMatch(/delete .*data/i);

    const purged = bash(['install/install-linux.sh', '--dry-run', '--uninstall', '--purge-data']);
    expect(purged.status).toBe(0);
    expect(purged.stdout).toMatch(/delete/i);
    expect(purged.stdout).toContain('data');
    // Fold (a): a dry run must never claim a deletion actually happened.
    expect(purged.stdout).not.toContain('Data deleted.');
  });

  it('never generates a key it would then print in full', () => {
    expect(result.stdout).not.toMatch(/SECRET_KEY=[A-Za-z0-9+/_-]{20,}/);
  });

  it('does not print the success banner or exit 0 when the health wait fails', () => {
    // dry-run always simulates success, so this asserts the CONTROL FLOW
    // exists rather than triggering a real failure: do_install/do_update must
    // branch on wait_for_health and only call print_success on the true path.
    const source = read('install/install-linux.sh');
    expect(source).toContain('print_failure()');
    expect(source).toMatch(/if wait_for_health "\$port"; then\s*\n\s*print_success "\$port"\s*\n\s*else\s*\n\s*print_failure "\$port"\s*\n\s*exit 1/);
  });
});

describe('install-linux.sh --port statefulness', () => {
  const overridePath = path.join(root, 'docker-compose.override.yml');

  afterEach(() => {
    if (fs.existsSync(overridePath)) fs.rmSync(overridePath);
  });

  it('removes a stale override left by an earlier --port run when re-run without --port', () => {
    fs.writeFileSync(overridePath, '# stale override from a previous run\nservices:\n  budget-tracker:\n    ports:\n      - "8080:3000"\n');
    const result = bash(['install/install-linux.sh', '--dry-run']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/removing the port override/i);
    expect(result.stdout).toContain('docker-compose.override.yml');
  });

  it('uses the effective port (from the override file) in the banner and health check, not just $PORT', () => {
    const source = read('install/install-linux.sh');
    expect(source).toContain('effective_port()');
    expect(source).toMatch(/port="\$\(effective_port\)"/);
  });
});

describe('update.sh — manual-only, semver-safe, self-rolling-back', () => {
  const result = bash(['install/update.sh', '--dry-run']);

  it('exits cleanly and reports the version and dependency state', () => {
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/version/i);
    expect(result.stdout).toMatch(/lockfile|Dependencies/i);
  });

  it('reads the real version out of package.json, the same field the app reports', () => {
    // app_version() greps package.json with sed. If that field ever moves or the parse
    // drifts, this catches it — the alternative is an update log that says "unknown".
    const version = (JSON.parse(read('package.json')) as { version: string }).version;
    expect(result.stdout).toContain(`Before — app version ${version}`);
    expect(result.stdout).toContain(`App version: ${version} -> ${version}`);
  });

  it('states plainly that it is manual only', () => {
    expect(result.stdout).toMatch(/manual only/i);
    expect(result.stdout).toMatch(/no scheduler/i);
    expect(result.stdout).toMatch(/no auto-update/i);
    expect(result.stdout).toMatch(/no in-app banner/i);
  });

  it('refreshes the base image', () => {
    expect(result.stdout).toContain('docker pull node:22-bookworm-slim');
  });

  it('takes patch and minor dependency updates only, never majors', () => {
    expect(result.stdout).toContain('npm update');
    expect(result.stdout).toMatch(/patch and minor/i);
    expect(result.stdout).toMatch(/majors? .*(not|never)/i);
    // A major-bumping command must appear nowhere in the script.
    const source = read('install/update.sh');
    expect(source).not.toMatch(/npm-check-updates|\bncu\b|npm install .*@latest/);
  });

  it('tags a rollback point before replacing anything', () => {
    expect(result.stdout).toContain('docker tag budget-tracker:latest budget-tracker:previous');
    const out = result.stdout;
    expect(out.indexOf('docker tag budget-tracker:latest budget-tracker:previous')).toBeLessThan(out.indexOf('docker compose build'));
  });

  it('rebuilds, restarts and health-checks', () => {
    expect(result.stdout).toContain('docker compose build');
    expect(result.stdout).toContain('docker compose up -d');
    expect(result.stdout).toContain('docker inspect');
  });

  it('checks health via the container itself (docker inspect), never a hardcoded host port', () => {
    // CRITICAL fix: the updater cannot know what host port an install used
    // (--port is an install-time-only flag), so it must never hit a host URL
    // like http://127.0.0.1:3000/api/health directly -- that would falsely
    // report "unhealthy" (and auto-rollback a perfectly good update) on any
    // install that mapped the container to a different host port.
    const source = read('install/update.sh');
    expect(source).not.toMatch(/http:\/\/127\.0\.0\.1:3000/);
    expect(source).not.toMatch(/HEALTH_URL/);
    expect(source).toContain("docker inspect --format '{{.State.Health.Status}}' ${SERVICE}");
    expect(result.stdout).toContain("docker inspect --format '{{.State.Health.Status}}' budget-tracker");
  });

  it('has a rollback branch that restores the previous tag and re-verifies', () => {
    const source = read('install/update.sh');
    expect(source).toContain('rollback()');
    expect(source).toContain('docker tag "$ROLLBACK_IMAGE" "$IMAGE"');
    expect(source).toMatch(/rollback \|\| exit 1/);
    // The rollback path restarts and re-checks health rather than leaving it down.
    const rollbackBody = source.slice(source.indexOf('rollback()'), source.indexOf('cd "$PROJECT_DIR"'));
    expect(rollbackBody).toContain('docker compose up -d');
    expect(rollbackBody).toContain('wait_for_health');
    expect(rollbackBody).toContain('docker compose logs');
  });

  it('bails explicitly instead of crashing when no rollback point exists', () => {
    const source = read('install/update.sh');
    expect(source).toContain('docker image inspect "$ROLLBACK_IMAGE"');
    expect(source).toMatch(/No rollback point exists/i);
    // The guard must come before the tag command, not after.
    expect(source.indexOf('docker image inspect "$ROLLBACK_IMAGE"')).toBeLessThan(
      source.indexOf('docker tag "$ROLLBACK_IMAGE" "$IMAGE"'),
    );
  });

  it('warns about leftover git/npm mutations whenever a rollback happens', () => {
    const source = read('install/update.sh');
    expect(source).toContain('warn_dirty_tree()');
    expect(source).toMatch(/git checkout -- package\.json package-lock\.json|git stash/i);
    // Called from both rollback exits: the "no rollback point" bail and the
    // normal end-of-rollback path.
    const rollbackBody = source.slice(source.indexOf('rollback()'), source.indexOf('cd "$PROJECT_DIR"'));
    const occurrences = rollbackBody.match(/warn_dirty_tree/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it('never puts /data in a destructive command, in any branch', () => {
    const source = read('install/update.sh');
    expect(source).not.toMatch(/rm\s+-rf/);
    expect(source).not.toMatch(/docker\s+compose\s+down\s+.*-v/);
    expect(result.stdout).toMatch(/\/data.*(untouched|preserved|kept)/i);
  });

  it('honours the skip flags', () => {
    const skipped = bash(['install/update.sh', '--dry-run', '--skip-git', '--no-pull', '--no-deps']);
    expect(skipped.status).toBe(0);
    expect(skipped.stdout).not.toContain('docker pull node:22-bookworm-slim');
    expect(skipped.stdout).not.toContain('[dry-run] would run: npm update');
    expect(skipped.stdout).toMatch(/Skipped \(--skip-git\)/);
    expect(skipped.stdout).toMatch(/Skipped \(--no-pull\)/);
    expect(skipped.stdout).toMatch(/Skipped \(--no-deps\)/);
  });

  it('documents every flag in --help', () => {
    const help = bash(['install/update.sh', '--help']);
    expect(help.status).toBe(0);
    for (const flag of ['--dry-run', '--skip-git', '--no-pull', '--no-deps']) {
      expect(help.stdout).toContain(flag);
    }
    expect(help.stdout).toMatch(/AUTO-ROLLBACK/i);
  });

  it('rejects an unknown flag', () => {
    const bad = bash(['install/update.sh', '--yolo']);
    expect(bad.status).not.toBe(0);
    expect(`${bad.stdout}${bad.stderr}`).toMatch(/unknown option/i);
  });
});

describe('no auto-update anywhere in the codebase', () => {
  it('does not schedule the updater from the app scheduler', () => {
    const scheduler = read('src/lib/scheduler.ts');
    expect(scheduler).not.toMatch(/update\.(sh|ps1)/);
    expect(scheduler).not.toMatch(/npm update|docker (pull|compose)/);
  });
});

describe('install-synology.sh --dry-run', () => {
  it('exits cleanly and defaults the install root to the project checkout (no /volume1 assumption)', () => {
    const result = bash(['install/install-synology.sh', '--dry-run']);
    expect(result.status).toBe(0);
    // The default root is the checkout itself — the only directory
    // docker-compose.yml's relative ./data mount can actually use — so the
    // script works on /volume2 (or any volume) exactly as well as /volume1.
    expect(result.stdout).not.toContain('/volume1/docker/budget-tracker');
    expect(result.stdout).toMatch(/Synology install root: .*[/\\](Budget Tracker|BudgetTracker|budget-tracker)/);
    expect(result.stdout).toContain('docker compose up -d');
  });

  it('resolves its own project directory instead of trusting CWD', () => {
    const source = read('install/install-synology.sh');
    expect(source).toContain('SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"');
    expect(source).toContain('PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"');
    expect(source).toContain('cd "$PROJECT_DIR"');
    // Guards against a docker-compose.yml-less CWD before doing anything destructive.
    expect(source).toMatch(/docker-compose\.yml.*was not found/);
  });

  it('falls back to /dev/urandom for SECRET_KEY generation, same as install-linux.sh', () => {
    const source = read('install/install-synology.sh');
    expect(source).toContain('generate_secret()');
    expect(source).toContain('/dev/urandom');
    expect(source).toMatch(/neither openssl nor \/dev\/urandom is available/);
  });

  it('does not print the success banner or exit 0 when the health wait fails', () => {
    const source = read('install/install-synology.sh');
    expect(source).toContain('print_failure()');
    expect(source).toMatch(/if wait_for_health; then/);
  });

  describe('--root validation (a bad --root can rm -rf the wrong directory)', () => {
    it('refuses "/" as the install root', () => {
      const result = bash(['install/install-synology.sh', '--dry-run', '--root', '/']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/must not be '\/'/);
    });

    it('refuses an install root that is not the project folder (compose mounts ./data inside it)', () => {
      const result = bash(['install/install-synology.sh', '--dry-run', '--root', '/tmp']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/must be this project folder/);
    });

    it('refuses an install root that does not exist', () => {
      const result = bash(['install/install-synology.sh', '--dry-run', '--root', '/no/such/dir/budget-tracker']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/does not exist/);
    });

    it('accepts an explicit --root equal to the project folder', () => {
      const result = bash(['install/install-synology.sh', '--dry-run', '--root', root]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('docker compose up -d');
    });
  });
});

describe('PowerShell scripts', () => {
  const pwshAvailable = hasCommand('pwsh');
  const check = (script: string) =>
    spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path '${script}'), [ref]$null, [ref]$errors); if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Output $_.Message }; exit 1 } else { exit 0 }`,
      ],
      { cwd: root, encoding: 'utf8' },
    );

  it.runIf(pwshAvailable)('install-windows.ps1 parses without errors', () => {
    const result = check('install/install-windows.ps1');
    expect(result.stdout.trim()).toBe('');
    expect(result.status).toBe(0);
  });

  it.runIf(pwshAvailable)('update.ps1 parses without errors', () => {
    const result = check('install/update.ps1');
    expect(result.stdout.trim()).toBe('');
    expect(result.status).toBe(0);
  });

  it('declares the same flags as the shell installer', () => {
    const source = read('install/install-windows.ps1');
    for (const flag of ['Update', 'Uninstall', 'PurgeData', 'Load', 'DryRun', 'Port']) {
      expect(source).toContain(`$${flag}`);
    }
    expect(source).toMatch(/wsl/i);
    expect(source).toMatch(/Docker Desktop/i);
  });

  it('update.ps1 mirrors the shell updater: manual-only, semver-safe, rollback', () => {
    const source = read('install/update.ps1');
    for (const flag of ['DryRun', 'SkipGit', 'NoDeps', 'NoPull']) {
      expect(source).toContain(`$${flag}`);
    }
    expect(source).toMatch(/manual only/i);
    expect(source).toContain('node:22-bookworm-slim');
    expect(source).toContain('npm');
    expect(source).toMatch(/PATCH AND MINOR ONLY/i);
    expect(source).toContain('budget-tracker:previous');
    expect(source).toContain('Invoke-Rollback');
    expect(source).toContain('/api/health');
    expect(source).not.toMatch(/Remove-Item.*data/i);
  });

  it('update.ps1 checks health via docker inspect, never a hardcoded host port', () => {
    const source = read('install/update.ps1');
    expect(source).not.toMatch(/127\.0\.0\.1:3000/);
    expect(source).not.toMatch(/\$HealthUrl/);
    expect(source).toContain("docker inspect --format '{{.State.Health.Status}}' $Service");
  });

  it('update.ps1 guards the rollback tag so a missing rollback image bails instead of throwing past the diagnostics', () => {
    const source = read('install/update.ps1');
    expect(source).toMatch(/No rollback point exists/i);
    // The guard (docker image inspect) must appear before the tag Invoke-Step call.
    expect(source.indexOf('docker image inspect $RollbackImage')).toBeLessThan(
      source.indexOf("Invoke-Step 'docker' @('tag', $RollbackImage, $Image)"),
    );
    expect(source).toContain('Write-DirtyTreeWarning');
    expect(source).toMatch(/git checkout -- package\.json package-lock\.json|git stash/i);
  });

  it('install-windows.ps1 removes a stale port override when re-run without -Port', () => {
    const source = read('install/install-windows.ps1');
    expect(source).toContain('$OverrideFile');
    expect(source).toMatch(/removing the port override/i);
    expect(source).toContain('Get-EffectivePort');
  });

  it('install-windows.ps1 does not print a success banner or exit 0 when the health wait fails', () => {
    const source = read('install/install-windows.ps1');
    expect(source).toContain('Show-FailureBanner');
    expect(source).toMatch(/if \(Wait-Healthy -EffectivePort \$effectivePort\) \{/);
  });

  it('install-windows.ps1 only reports "Data deleted." when a deletion actually happened', () => {
    const source = read('install/install-windows.ps1');
    // "Data deleted." must be reachable only through the branch that ran
    // Remove-Item and then verified the path is really gone -- not unconditionally.
    expect(source).toMatch(/Test-Path \$dataPath[\s\S]{0,80}Write-Warn|if \(Test-Path \$dataPath\) \{\s*Write-Warn/);
    expect(source).not.toMatch(/Remove-Item -Recurse -Force \$dataPath -ErrorAction SilentlyContinue\s*\n\s*Write-Info 'Data deleted\.'/);
  });
});

describe('install/synology-compose.yml', () => {
  const compose = read('install/synology-compose.yml');
  const original = read('docker-compose.yml');

  it('keeps every hardening setting from the main compose file', () => {
    for (const needle of ['read_only: true', 'tmpfs:', '/tmp', 'cap_drop:', 'no-new-privileges:true', 'healthcheck:', '/api/health']) {
      expect(compose).toContain(needle);
      expect(original).toContain(needle);
    }
  });

  it('uses the same service, image and container names', () => {
    expect(compose).toContain('budget-tracker');
    expect(compose).toContain('budget-tracker:latest');
  });

  it('carries a literal SECRET_KEY placeholder, because Container Manager has no .env', () => {
    expect(compose).toContain('PASTE-YOUR-GENERATED-KEY-HERE');
    expect(compose).not.toContain('${SECRET_KEY');
  });

  it('does not tell the reader to uncomment a second, already-active image line (fold b)', () => {
    // There is exactly one "image: budget-tracker:latest" line -- Option B's
    // instruction is only to comment out "build: .", never to "uncomment"
    // anything, since the image line is unconditionally active already.
    const imageLines = compose.match(/^\s*image: budget-tracker:latest\s*$/gm) ?? [];
    expect(imageLines.length).toBe(1);
    expect(compose).not.toMatch(/uncomment the next line/i);
  });
});

describe('INSTALL.md', () => {
  const install = read('INSTALL.md');

  it('has a prerequisite matrix with the architectures, RAM and port', () => {
    expect(install).toMatch(/x86_64|amd64/i);
    expect(install).toMatch(/arm64|aarch64/i);
    expect(install).toMatch(/1 GB/i);
    expect(install).toContain('3000');
  });

  it('has a quick start per platform', () => {
    for (const heading of ['Linux', 'Windows', 'Synology', 'Raspberry Pi', 'macOS']) {
      expect(install).toContain(heading);
    }
  });

  it('covers the Raspberry Pi requirements from the spec', () => {
    expect(install).toMatch(/64-bit Raspberry Pi OS/i);
    expect(install).toMatch(/Pi 4/);
    expect(install).toMatch(/2 GB/);
    expect(install).toMatch(/4 GB/);
    expect(install).toContain('--load');
  });

  it('covers update, uninstall and restore', () => {
    expect(install).toContain('--update');
    expect(install).toContain('--uninstall');
    expect(install).toContain('--purge-data');
    expect(install).toMatch(/restore/i);
    expect(install).toContain('-wal');
    expect(install).toContain('-shm');
  });

  it('describes the update flow as manual-only with rollback (spec v1.4)', () => {
    expect(install).toMatch(/Updates are manual/i);
    expect(install).toMatch(/never nags|no.*banner/i);
    expect(install).toMatch(/patch and minor/i);
    expect(install).toMatch(/rolls back automatically|auto-?rollback/i);
    expect(install).toContain('budget-tracker:previous');
    expect(install).toContain('--no-deps');
  });

  it('has the four required FAQ entries', () => {
    expect(install).toMatch(/port .*(in use|already)/i);
    expect(install).toMatch(/permission/i);
    expect(install).toMatch(/forgot (your |the )?password/i);
    expect(install).toMatch(/forgot (your |the )?SECRET_KEY/i);
  });

  it('documents the rescue script invocation', () => {
    expect(install).toContain('reset-admin-password.ts');
    expect(install).toContain('docker compose exec');
  });

  it('explains that backups may live on a NAS mount but the database may not', () => {
    expect(install).toContain('Keeping backups on a separate NAS');
    // The rule has to be stated as a rule, not implied by an example.
    expect(install).toMatch(/must stay on local disk/i);
    expect(install).toMatch(/NFS/);
    expect(install).toMatch(/SMB/);
    expect(install).toContain('VACUUM INTO');
    // Both offered patterns: the compose second-volume mapping and the rsync job.
    expect(install).toContain('/mnt/nas/budget-backups:/data/backups');
    expect(install).toContain('./data:/data');
    expect(install).toMatch(/rsync/);
    // ...and the FAQ answers the same question where people will actually look.
    expect(install).toMatch(/### Can I keep the data on my other NAS/);
  });

  it('gives no-SSH Synology users a way to run the rescue script (m5)', () => {
    expect(install).toMatch(/Container Manager/);
    expect(install).toMatch(/Terminal/);
    expect(install).toMatch(/node --experimental-strip-types scripts\/reset-admin-password\.ts/);
  });

  it('describes the SECRET_KEY-loss recovery accurately: recovery codes survive, --clear-mfa is the escape hatch (C2)', () => {
    const section = install.slice(install.indexOf('### I forgot / lost my SECRET_KEY'));
    expect(section).toMatch(/recovery code/i);
    expect(section).toMatch(/SHA-256/);
    expect(section).toContain('--clear-mfa');
    // The old false claim: the password reset alone does NOT bypass two-factor.
    expect(install).not.toMatch(/bypasses two-factor/i);
    expect(install).toMatch(/does not touch two-factor authentication/i);
  });

  it('has a cross-origin FAQ entry naming TRUST_PROXY and X-Forwarded-Host (m4)', () => {
    expect(install).toMatch(/Cross-origin request rejected/);
    expect(install).toContain('TRUST_PROXY');
    expect(install).toContain('X-Forwarded-Host');
    const readme = read('README.md');
    expect(readme).toMatch(/Cross-origin request rejected/);
    expect(readme).toContain('X-Forwarded-Host');
  });

  it('leads with the prebuilt GHCR image and still documents building from source', () => {
    expect(install).toContain('GHCR');
    expect(install).toContain('synology-compose-pull.yml');
    expect(install.indexOf('Quick start — prebuilt image')).toBeLessThan(
      install.indexOf('## Prerequisites'),
    );
    expect(install).toMatch(/build from source/i);
  });

  it('has a manual QA checklist', () => {
    expect(install).toMatch(/QA checklist/i);
  });
});

describe('docs/INSTALL-SYNOLOGY.md', () => {
  const synology = read('docs/INSTALL-SYNOLOGY.md');

  it('walks through Container Manager without requiring SSH', () => {
    expect(synology).toContain('Container Manager');
    expect(synology).toContain('Project');
    expect(synology).toContain('File Station');
    expect(synology).toMatch(/no ssh|without ssh/i);
  });

  it('is a numbered click-by-click walkthrough that ends at a URL', () => {
    expect(synology).toMatch(/^1\./m);
    expect(synology).toMatch(/^10\./m);
    expect(synology).toContain(':3000');
  });

  it('tells the reader where the SECRET_KEY goes', () => {
    expect(synology).toContain('PASTE-YOUR-GENERATED-KEY-HERE');
    expect(synology).toContain('synology-compose.yml');
  });

  it('makes the data folder writable before the first start, in File Station (I1)', () => {
    const permissionStep = synology.slice(synology.indexOf('2. '), synology.indexOf('3. '));
    expect(permissionStep).toMatch(/File Station/);
    expect(permissionStep).toMatch(/Propert/i);
    expect(permissionStep).toMatch(/Permission/);
    expect(permissionStep).toMatch(/Read\/Write/);
    expect(permissionStep).toMatch(/uid 1000/);
    // It has to come before the project is created and started.
    expect(synology.indexOf('Read/Write')).toBeLessThan(synology.indexOf('Create the Project'));
  });

  it('names BOTH restart-loop causes and points at /api/health to tell them apart (I1)', () => {
    const troubleshooting = synology.slice(synology.indexOf('Check it started'), synology.indexOf('Open the app'));
    expect(troubleshooting).toMatch(/writable|permission/i);
    expect(troubleshooting).toMatch(/SECRET_KEY/);
    expect(troubleshooting).toContain('/api/health');
    expect(troubleshooting).toContain('dataDir');
    expect(troubleshooting).toContain('db');
  });
});

describe('README pointer', () => {
  it('points at INSTALL.md near the top', () => {
    const readme = read('README.md');
    expect(readme).toContain('INSTALL.md');
    expect(readme.indexOf('INSTALL.md')).toBeLessThan(1500);
  });
});

describe('Dockerfile carries the rescue script', () => {
  it('copies scripts/ into the runtime stage', () => {
    const dockerfile = read('Dockerfile');
    const runtime = dockerfile.slice(dockerfile.lastIndexOf('FROM node:22-bookworm-slim AS runner'));
    expect(runtime).toMatch(/COPY .*\/app\/scripts \.\/scripts/);
  });
});

/** Recursively collects every ".ts"/".tsx" file under dir — a Node walk so this is meaningful with or without ripgrep on PATH. */
function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(full, out);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strips block comments then line comments, so a prose mention of "fetch()"
 * inside a doc comment doesn't false-positive as a real call site (this is
 * not a full TS parser, just enough to tell code from commentary). The `//`
 * strip requires a non-colon before it so `https://` URLs inside a string
 * aren't truncated mid-line.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * True when 'use client' is the file's directive prologue (the actual Next.js
 * rule: it must be the first statement, before any import). A Server
 * Component .tsx (a page.tsx with no directive) still renders server-side —
 * a fetch() there is exactly what this invariant exists to catch, so it must
 * NOT be exempted just because the file is a .tsx.
 */
function isClientComponent(source: string): boolean {
  const withoutBom = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const prologue = withoutBom.trimStart().slice(0, 20);
  return /^['"]use client['"]/.test(prologue);
}

describe('the app makes no network call unless SimpleFIN is configured', () => {
  it('every real (non-comment) fetch() call site is either the SimpleFIN client or inside a client component', () => {
    // Client components (files whose directive prologue is 'use client') make
    // browser-initiated, same-origin fetch()es on user interaction — out of
    // scope for "the app calls out on its own". Everything else (Server
    // Components included — a page.tsx has no 'use client' and still renders
    // server-side) must route through the one allowed server-side call site.
    const srcRoot = path.join(root, 'src');
    const allowedFile = path.join(srcRoot, 'lib', 'simplefin', 'client.ts');
    const offenders: string[] = [];
    const clientComponentHits: string[] = [];
    for (const file of walkTsFiles(srcRoot)) {
      const raw = fs.readFileSync(file, 'utf8');
      const stripped = stripComments(raw);
      if (!/\bfetch\s*\(/.test(stripped)) continue;

      if (file === allowedFile) continue;
      if (isClientComponent(raw)) {
        clientComponentHits.push(path.relative(root, file));
        continue;
      }
      offenders.push(path.relative(root, file));
    }

    expect(offenders).toEqual([]);
    // Proves rule (b) is doing real work, not just a name-list of the known
    // sites: every fetch()-calling file that isn't the allowed one must have
    // been exempted BECAUSE it declared 'use client', not by coincidence.
    expect(clientComponentHits.length).toBeGreaterThan(0);
  });

  it('the scheduler never triggers a sync', () => {
    const scheduler = read('src/lib/scheduler.ts');
    expect(scheduler).not.toMatch(/simplefin|runSync/i);
  });
});

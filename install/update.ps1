<#
.SYNOPSIS
  Budget Tracker updater for Windows: manual, semver-safe, self-rolling-back.
.DESCRIPTION
  Deliberately MANUAL ONLY (spec section 9): no scheduler, no auto-update
  (the prebuilt-image install has an opt-in in-app check; this is the
  build-from-source path). Dependency updates stay inside the lockfile's
  caret ranges (patch and minor only); major upgrades are never taken
  automatically. .\data is never touched by any branch, including the
  rollback.
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$SkipGit,
  [switch]$NoDeps,
  [switch]$NoPull,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'
$Service = 'budget-tracker'
$Image = 'budget-tracker:latest'
$RollbackImage = 'budget-tracker:previous'
$BaseImage = 'node:22-bookworm-slim'
$HealthTimeout = 120
$ProjectDir = Split-Path -Parent $PSScriptRoot

if ($Help) {
  @'
Budget Tracker updater (Windows) - manual, semver-safe, self-rolling-back

Usage: .\install\update.ps1 [-DryRun] [-SkipGit] [-NoPull] [-NoDeps] [-Help]

What it does, in order:
  1. git pull --ff-only        (only when .git exists and -SkipGit was not given)
  2. docker pull node:22-bookworm-slim   (base-image security fixes)
  3. npm update                (PATCH AND MINOR ONLY - majors are never automatic)
  4. tag the running image as budget-tracker:previous   (the rollback point)
  5. docker compose build
  6. docker compose up -d
  7. poll the container's own health status via "docker inspect" (independent
     of any --port remap done at install time -- it reads the container's
     internal /api/health check, not a host URL)
  8. AUTO-ROLLBACK if it never becomes healthy: restore budget-tracker:previous,
     restart, re-verify, print the logs, exit non-zero.

There is no scheduler and no automatic update. Run this by hand.
Your .\data directory is never touched, in any branch.
If a rollback happens, any git pull / npm update from this run are left in
your working tree -- see the ROLLBACK message for exact recovery commands.
'@ | Write-Output
  exit 0
}

function Write-Step { param([string]$Message) Write-Output "`n==> $Message" }

function Invoke-Step {
  param([string]$Command, [string[]]$Arguments)
  if ($DryRun) {
    Write-Output "[dry-run] would run: $Command $($Arguments -join ' ')"
    return
  }
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Command exited with $LASTEXITCODE" }
}

function Get-AppVersion {
  $packageJson = Get-Content (Join-Path $ProjectDir 'package.json') -Raw | ConvertFrom-Json
  return $packageJson.version
}

function Get-DependencyFingerprint {
  $lock = Join-Path $ProjectDir 'package-lock.json'
  if (-not (Test-Path $lock)) { return 'none' }
  return (Get-FileHash $lock -Algorithm SHA256).Hash.Substring(0, 12).ToLower()
}

# Port-independent by design: checks the CONTAINER's own healthcheck status
# (docker inspect) rather than curling a host URL, so it is unaffected by any
# --port remap the install-time host mapping used. A hardcoded host URL would
# falsely report "unhealthy" (and trigger an unwanted auto-rollback) whenever
# the app was installed on a non-default host port.
function Wait-Healthy {
  Write-Output "Waiting for the $Service container to report healthy (docker inspect) for up to $HealthTimeout seconds"
  if ($DryRun) {
    Write-Output "[dry-run] would run: docker inspect --format '{{.State.Health.Status}}' $Service"
    return $true
  }
  for ($waited = 0; $waited -lt $HealthTimeout; $waited += 3) {
    $status = $null
    try { $status = (& docker inspect --format '{{.State.Health.Status}}' $Service 2>$null) } catch { $status = $null }
    if ($status) {
      $status = "$status".Trim()
      if ($status -eq 'healthy') { Write-Output "Healthy after ${waited}s."; return $true }
      if ($status -eq 'unhealthy') { Write-Warning "Container reported unhealthy after ${waited}s."; return $false }
    }
    Start-Sleep -Seconds 3
  }
  return $false
}

function Write-DirtyTreeWarning {
  Write-Warning 'Any git pull / npm update changes from this run are still in your working tree.'
  Write-Warning 'Rebuilding from here would reproduce the same broken image. Before trying again:'
  Write-Warning '  git checkout -- package.json package-lock.json   # discard the dependency bump, or: git stash'
  Write-Warning '  then investigate the failure and re-run install/update.ps1 when ready.'
}

function Invoke-Rollback {
  Write-Step 'ROLLBACK - the updated image never became healthy'
  Write-Output 'Recent logs from the failed container:'
  if ($DryRun) { Write-Output "[dry-run] would run: docker compose logs --tail 40 $Service" }
  else { & docker compose logs --tail 40 $Service }

  # Guard BEFORE tagging: Invoke-Step throws a terminating error on a failed
  # command (by design, so real failures stop the script), which previously
  # meant a missing rollback image blew past every diagnostic below it instead
  # of printing them. Check first and return cleanly instead.
  if ($DryRun) {
    Write-Output "[dry-run] would check: docker image inspect $RollbackImage"
  }
  else {
    & docker image inspect $RollbackImage *> $null
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "No rollback point exists ($RollbackImage was never tagged - this looks like the very first build)."
      Write-Warning "The update has been left in place, unhealthy. Investigate with: docker compose logs $Service"
      Write-DirtyTreeWarning
      return
    }
  }

  Write-Output 'Restoring the previous image'
  Invoke-Step 'docker' @('tag', $RollbackImage, $Image)
  Write-Output 'Running: docker compose up -d'
  Invoke-Step 'docker' @('compose', 'up', '-d')

  if (Wait-Healthy) {
    Write-Output 'Rolled back successfully - you are running the previous version again.'
    Write-Output 'Your .\data was never touched. Nothing was lost.'
  }
  else {
    Write-Warning 'The rollback also failed to report healthy. Investigate with:'
    Write-Output "  docker compose logs $Service"
  }
  Write-Warning 'Update aborted and rolled back.'
  Write-DirtyTreeWarning
}

Set-Location $ProjectDir
if ($DryRun) { Write-Output '*** DRY RUN - nothing will be changed. ***' }
Write-Output 'This updater is manual only: no scheduler, no auto-update. (The prebuilt-image install has an opt-in in-app update check at Settings -> About; this script is the build-from-source path and is unaffected by it.)'

$beforeVersion = Get-AppVersion
$beforeDeps = Get-DependencyFingerprint
Write-Step "Before - app version $beforeVersion, lockfile $beforeDeps"

Write-Step 'Step 1/8 - new source'
if ($SkipGit) { Write-Output 'Skipped (-SkipGit).' }
elseif (Test-Path (Join-Path $ProjectDir '.git')) {
  Write-Output 'Running: git pull --ff-only'
  Invoke-Step 'git' @('pull', '--ff-only')
}
else {
  Write-Warning 'This is not a git checkout, so there is nothing to pull.'
  Write-Output 'Your .\data and .env are safe: only source files need replacing.'
}

Write-Step 'Step 2/8 - base image refresh'
if ($NoPull) { Write-Output 'Skipped (-NoPull).' }
else {
  Write-Output "Running: docker pull $BaseImage"
  Invoke-Step 'docker' @('pull', $BaseImage)
}

Write-Step 'Step 3/8 - semver-safe dependency update (patch and minor only)'
if ($NoDeps) { Write-Output 'Skipped (-NoDeps).' }
else {
  Write-Output 'Running: npm update'
  Write-Output 'Major version bumps are NOT taken here - they stay a manual, reviewed change.'
  Invoke-Step 'npm' @('update')
}

Write-Step 'Step 4/8 - tagging the rollback point'
if ($DryRun) { Write-Output "[dry-run] would run: docker tag $Image $RollbackImage" }
else {
  & docker image inspect $Image *> $null
  if ($LASTEXITCODE -eq 0) {
    Invoke-Step 'docker' @('tag', $Image, $RollbackImage)
    Write-Output "Rollback point saved as $RollbackImage."
  }
  else {
    Write-Warning "No existing $Image to tag - this looks like a first build, so there is nothing to roll back to."
  }
}

Write-Step 'Step 5/8 - rebuilding'
Write-Output 'Running: docker compose build'
Invoke-Step 'docker' @('compose', 'build')

Write-Step 'Step 6/8 - restarting'
Write-Output 'Running: docker compose up -d'
Invoke-Step 'docker' @('compose', 'up', '-d')

Write-Step 'Step 7/8 - health check'
if (Wait-Healthy) {
  Write-Output 'The updated container is healthy.'
}
else {
  Write-Step 'Step 8/8 - health check FAILED, rolling back'
  Invoke-Rollback
  exit 1
}

Write-Step 'Step 8/8 - done'
$afterVersion = Get-AppVersion
$afterDeps = Get-DependencyFingerprint
Write-Output "App version: $beforeVersion -> $afterVersion"
if ($beforeDeps -eq $afterDeps) { Write-Output "Dependencies: unchanged ($afterDeps)" }
else { Write-Output "Dependencies: updated ($beforeDeps -> $afterDeps) - patch/minor only" }
Write-Output '/data was untouched - the database, backups and .env are exactly as they were.'
Write-Output "Watch the logs with: docker compose logs -f $Service"

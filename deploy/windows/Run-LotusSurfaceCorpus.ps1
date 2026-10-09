# One-shot Options Surface corpus collection wrapper.
#
#   powershell -ExecutionPolicy Bypass -File deploy\windows\Run-LotusSurfaceCorpus.ps1
#   powershell -ExecutionPolicy Bypass -File deploy\windows\Run-LotusSurfaceCorpus.ps1 -Once -Enable
#   powershell -ExecutionPolicy Bypass -File deploy\windows\Run-LotusSurfaceCorpus.ps1 -DryRun

param(
    [switch]$Once = $true,
    [switch]$Enable,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Python = Join-Path $RepoRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) {
    throw "Python venv not found at $Python."
}

$Args = @(
    "-m", "project.scripts.collect_options_surface"
    "--once"
    "--curated-expiries"
)
if ($Enable) { $Args += "--enable" }
if ($DryRun) { $Args += "--dry-run" }

Set-Location $RepoRoot
& $Python @Args
exit $LASTEXITCODE

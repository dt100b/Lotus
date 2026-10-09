# Register a conservative Options Surface corpus collector as a Windows
# Scheduled Task. Disabled until LOTUS_SURFACE_COLLECT_ENABLED=true in .env
# or the task is edited to pass --enable.
#
#   powershell -ExecutionPolicy Bypass -File deploy\windows\Register-LotusSurfaceCorpus.ps1
#
# Unregister:
#   Unregister-ScheduledTask -TaskName "LotusSurfaceCorpus" -Confirm:$false

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Python = Join-Path $RepoRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) {
    throw "Python venv not found at $Python. Create .venv and pip install -e . first."
}

$TaskName = "LotusSurfaceCorpus"
$LogDir = Join-Path $RepoRoot "project\runtime\options_surface_snapshots\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Wrapper = Join-Path $PSScriptRoot "Run-LotusSurfaceCorpus.ps1"

# Hourly by default. Do not use an aggressive cadence.
# Finite repetition duration: some Windows hosts reject TimeSpan.MaxValue.
$Trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(5)) `
    -RepetitionInterval (New-TimeSpan -Hours 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$Action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Wrapper`" -Once -Enable" `
    -WorkingDirectory $RepoRoot
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 20)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Force | Out-Null

Write-Host "Registered $TaskName (hourly, --enable). Corpus dir: project\runtime\options_surface_snapshots"

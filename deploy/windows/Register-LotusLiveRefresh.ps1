# Register the Phase 6 live refresher as a Windows Scheduled Task that restarts
# on failure and at logon. Run elevated from the repo root:
#
#   powershell -ExecutionPolicy Bypass -File deploy\windows\Register-LotusLiveRefresh.ps1
#
# Unregister:
#   Unregister-ScheduledTask -TaskName "LotusLiveRefresh" -Confirm:$false

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Python = Join-Path $RepoRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) {
    throw "Python venv not found at $Python. Create .venv and pip install -e . first."
}

$TaskName = "LotusLiveRefresh"
$LogDir = Join-Path $RepoRoot "project\runtime\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Stdout = Join-Path $LogDir "live_refresh.out.log"
$Stderr = Join-Path $LogDir "live_refresh.err.log"

$ArgList = @(
    "project\scripts\refresh_dashboard_live.py"
    "--db-path", "project\data\phase1_history.sqlite3"
    "--artifacts-dir", "project\runtime\dashboard_build"
    "--snapshot-path", "project\greeks\data\latest_gex_snapshot.json"
    "--job-name", "btc_options_live_phase6"
    "--lookback-minutes", "180"
    "--interval-seconds", "120"
    "--materialize-mode", "auto"
) -join " "

# cmd wrapper keeps the process in WorkingDirectory and appends logs.
$Command = "cd /d `"$RepoRoot`" && `"$Python`" $ArgList >> `"$Stdout`" 2>> `"$Stderr`""

$Action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c $Command" -WorkingDirectory $RepoRoot
$TriggerLogon = New-ScheduledTaskTrigger -AtLogOn
# Re-arm every 5 minutes if the process exited; the task itself is continuous.
$TriggerRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration ([TimeSpan]::MaxValue)
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger @($TriggerLogon, $TriggerRepeat) `
    -Settings $Settings `
    -Principal $Principal `
    -Force | Out-Null

Write-Host "Registered Scheduled Task '$TaskName'."
Write-Host "Logs: $Stdout / $Stderr"
Write-Host "Start now: Start-ScheduledTask -TaskName $TaskName"

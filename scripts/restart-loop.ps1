# Restart the AltarisLevels scoring loop WITHOUT elevation.
#
# Why this exists: the scheduled task is registered with MultipleInstances=IgnoreNew, so
# `Start-ScheduledTask` is silently dropped (0x800710E0) while an instance is running — the
# CLAUDE.md "just Start-ScheduledTask" takeover only works when the old instance is already
# dead. The task also runs in an S4U session this user can't open process handles to, so
# taskkill/Stop-Process are Access Denied (this is the same reason isPidAlive needs EPERM
# handling in src/run.ts).
#
# Instead we use the loop's own takeover mechanism: write a sentinel PID into data/.loop.pid;
# the running instance notices it lost ownership on its next cron fire (<= SCORE_INTERVAL_MIN,
# i.e. up to 15 min) and exits itself, ending the task instance. Then Start-ScheduledTask works.
#
# One-time permanent fix (needs a UAC prompt, restores the original one-command restart):
#   Start-Process powershell -Verb RunAs -ArgumentList '-Command', `
#     '$t = Get-ScheduledTask AltarisLevels; $t.Settings.MultipleInstances = "Parallel"; Set-ScheduledTask -InputObject $t'

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root "data\.loop.pid"
$task = "AltarisLevels"

if ((Get-ScheduledTask -TaskName $task).State -ne "Running") {
    Write-Host "Task not running - starting it."
    Start-ScheduledTask -TaskName $task
    exit 0
}

$oldPid = (Get-Content $pidFile -ErrorAction SilentlyContinue)
Set-Content $pidFile -Value "0" -Encoding ascii -NoNewline
Write-Host "Sentinel written to .loop.pid (old loop pid: $oldPid)."
Write-Host "Waiting for the old instance to self-exit at its next cron fire (up to 15 min)..."

$deadline = (Get-Date).AddMinutes(17)
while ((Get-Date) -lt $deadline) {
    if ((Get-ScheduledTask -TaskName $task).State -ne "Running") { break }
    Start-Sleep -Seconds 15
}

if ((Get-ScheduledTask -TaskName $task).State -eq "Running") {
    Write-Warning "Old instance still running after 17 min - it may be wedged mid-tick. Re-run this script, or kill it elevated via scripts/kill-stale-loops.ps1."
    exit 1
}

Start-ScheduledTask -TaskName $task
Start-Sleep -Seconds 8
$newPid = (Get-Content $pidFile -ErrorAction SilentlyContinue)
Write-Host "Restarted. New loop pid: $newPid (task state: $((Get-ScheduledTask -TaskName $task).State))"

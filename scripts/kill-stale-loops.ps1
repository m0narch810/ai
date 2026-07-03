# One-shot janitor, run ELEVATED via the AltarisLevels task action: kills every process
# belonging to a scoring-loop instance (powershell/cmd/npm/node with altaris-levels or
# tsx src/run.ts in the command line), excluding itself. Logs what it killed.
$log = Join-Path $PSScriptRoot "kill-stale-loops.log"
"[$(Get-Date -Format o)] janitor start (pid $PID)" | Out-File $log -Encoding utf8

$targets = Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -ne $PID -and
  $_.CommandLine -and
  $_.CommandLine -notmatch "kill-stale-loops" -and
  ($_.CommandLine -match "altaris-levels.*(npm start|tsx|run\.ts)" -or
   ($_.Name -match "node\.exe|cmd\.exe" -and $_.CommandLine -match "altaris-levels"))
}
foreach ($t in $targets) {
  "kill $($t.ProcessId) [$($t.Name)] $($t.CommandLine.Substring(0, [Math]::Min(140, $t.CommandLine.Length)))" | Out-File $log -Append -Encoding utf8
  try { Stop-Process -Id $t.ProcessId -Force -ErrorAction Stop; "  → killed" | Out-File $log -Append -Encoding utf8 }
  catch { "  → FAILED: $($_.Exception.Message)" | Out-File $log -Append -Encoding utf8 }
}
"[$(Get-Date -Format o)] janitor done ($(@($targets).Count) targets)" | Out-File $log -Append -Encoding utf8

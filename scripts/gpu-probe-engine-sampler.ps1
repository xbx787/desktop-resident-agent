# Samples per-process GPU engine utilization ("Task Manager GPU%" basis) for the
# dev probe's electron processes and the boss's running pet, once per second,
# into a CSV, so probe windows can be cross-checked against engine counters.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gpu-probe-engine-sampler.ps1 -Minutes 12
param([int]$Minutes = 12)
$csv = 'D:\DesktopPetProject\.cache\gpu-engine-timeseries.csv'
if (-not (Test-Path $csv)) { "ts,pid,engtype,value" | Out-File -Encoding utf8 $csv }
$end = (Get-Date).AddMinutes($Minutes)
while ((Get-Date) -lt $end) {
  $procs = @(Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq 'electron.exe') -or ($_.ExecutablePath -like '*Whale Companion*')
  })
  $ids = @($procs | ForEach-Object { [string]$_.ProcessId })
  if ($ids.Count -eq 0) { Start-Sleep -Seconds 5; continue }
  $pat = 'pid_(' + ($ids -join '|') + ')_'
  $batch = Get-Counter -Counter '\GPU Engine(*)\Utilization Percentage' -SampleInterval 1 -MaxSamples 60 -ErrorAction SilentlyContinue
  foreach ($s in $batch) {
    $ts = $s.Timestamp.ToString('HH:mm:ss')
    foreach ($c in $s.CounterSamples) {
      if ($c.InstanceName -match $pat -and $c.CookedValue -gt 0.05) {
        $m = [regex]::Match($c.InstanceName, 'pid_(\d+)_.*engtype_([a-z0-9_]+)$')
        if ($m.Success) {
          ($ts + ',' + $m.Groups[1].Value + ',' + $m.Groups[2].Value + ',' + [math]::Round($c.CookedValue, 2)) | Out-File -Append -Encoding utf8 $csv
        }
      }
    }
  }
}
Write-Output ('sampler done; csv rows: ' + ((Get-Content $csv | Measure-Object -Line).Lines - 1))

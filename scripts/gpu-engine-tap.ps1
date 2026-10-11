# GPU engine tap: samples Windows' GPU Engine utilisation counters once a
# second — the Task Manager metric (% of one engine, summed per process) — and
# appends `epochMs,pid,percent` CSV rows to the output file. Run it beside any
# electron probe to price its per-process GPU engine load; align afterwards by
# timestamp.
#
#   powershell -NoProfile -File scripts/gpu-engine-tap.ps1 -Seconds 150 -Out .cache/gpu-tap.csv
param([int]$Seconds = 60, [string]$Out = "gpu-tap.csv", [int]$IntervalMs = 950)
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
  $stamp = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  try {
    $s = Get-Counter -Counter "\GPU Engine(*)\Utilization Percentage" -MaxSamples 1 -ErrorAction Stop
    $agg = @{}
    foreach ($c in $s.CounterSamples) {
      if ($c.InstanceName -match "pid_(\d+)") {
        $k = $Matches[1]
        if (-not $agg.ContainsKey($k)) { $agg[$k] = 0.0 }
        $agg[$k] += [double]$c.CookedValue
      }
    }
    foreach ($k in $agg.Keys) {
      ("{0},{1},{2:N2}" -f $stamp, $k, $agg[$k]) | Out-File -Append -Encoding ascii $Out
    }
  } catch { }
  Start-Sleep -Milliseconds $IntervalMs
}

param(
  [string]$OldExe,
  [string]$NewExe
)

$ErrorActionPreference = 'SilentlyContinue'
$processName = 'Whale Companion Preview'

# Without arguments: quit whatever is running, then start the highest
# version found under release/. Explicit paths still override.
$running = Get-Process -Name $processName
if (-not $OldExe -and $running) { $OldExe = ($running | Select-Object -First 1).Path }

if (-not $NewExe) {
  $releaseRoot = Join-Path $PSScriptRoot '..\release'
  $candidates = Get-ChildItem -LiteralPath $releaseRoot -Directory -Filter 'whale-companion-v*' |
    Sort-Object { try { [version]($_.Name -replace '^whale-companion-v', '') } catch { [version]'0.0.0' } } -Descending
  foreach ($dir in $candidates) {
    $candidate = Join-Path $dir.FullName 'win-unpacked\Whale Companion Preview.exe'
    if (Test-Path -LiteralPath $candidate) { $NewExe = $candidate; break }
  }
}

if (-not $OldExe -and -not $running) {
  # Nothing is running; just launch the newest build.
} elseif ($running) {
  if ($OldExe -and (Test-Path -LiteralPath $OldExe)) {
    & $OldExe --quit
  } else {
    $running | Stop-Process -Force
  }
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if (-not (Get-Process -Name $processName)) { break }
  }
}

if (-not $NewExe) { throw 'No packaged build found under release/.' }
if (-not (Test-Path -LiteralPath $NewExe)) { throw "New executable not found: $NewExe" }
Start-Process -FilePath $NewExe

# CDP setup: launches Edge with a remote-debugging port so browser work can be
# driven through the DevTools Protocol (JS on the real DOM — no coordinate
# clicking). Chromium 136+ refuses the debug port on the *default* profile, so
# a slim copy of the profile (login state only) moves to a dedicated folder.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/cdp-setup.ps1
$ErrorActionPreference = 'Stop'
$src = Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data'
$dst = 'D:\EdgeDebugProfile'

# Edge must be gone for the cookie files to be copyable (and for the relaunch
# to pick the debug port at all).
Stop-Process -Name msedge -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

New-Item -ItemType Directory -Path (Join-Path $dst 'Default') -Force | Out-Null
Copy-Item (Join-Path $src 'Local State') $dst -Force -ErrorAction SilentlyContinue
foreach ($name in 'Cookies', 'Login Data', 'Web Data', 'Preferences', 'Secure Preferences') {
  Copy-Item (Join-Path $src "Default\$name") (Join-Path $dst 'Default') -Force -ErrorAction SilentlyContinue
}

Start-Process msedge -ArgumentList "--user-data-dir=$dst", '--remote-debugging-port=9222', 'https://chatgpt.com/c/6aca5ecb-2580-83ec-b76e-ec5064882c3b'
Start-Sleep -Seconds 10
try {
  $version = (Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json/version' -UseBasicParsing -TimeoutSec 5).Content
  Write-Output "CDP_UP $version"
} catch {
  Write-Output 'CDP_PORT_NOT_UP'
}

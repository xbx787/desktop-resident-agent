param([Parameter(Mandatory=$true)][string]$ReleaseDir)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$releasePath = [IO.Path]::GetFullPath($ReleaseDir).TrimEnd([IO.Path]::DirectorySeparatorChar)
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd([IO.Path]::DirectorySeparatorChar)
$releaseRoot = Join-Path $projectRoot 'release'
if (-not [String]::Equals((Split-Path $releasePath), $releaseRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Release directory is outside the project.'
}
$name = [IO.Path]::GetFileName($releasePath)
if ($name -notmatch '^whale-companion-v\d+\.\d+\.\d+$') { throw 'Invalid release directory name.' }
$unpacked = Join-Path $releasePath 'win-unpacked'
if (-not (Test-Path -LiteralPath (Join-Path $unpacked 'Whale Companion Preview.exe'))) { throw 'Executable missing.' }
if (-not (Test-Path -LiteralPath (Join-Path $unpacked 'resources\app.asar'))) { throw 'App archive missing.' }
$version = $name.Substring('whale-companion-v'.Length)
$exeVersion = (Get-Item -LiteralPath (Join-Path $unpacked 'Whale Companion Preview.exe')).VersionInfo.FileVersion
if ($exeVersion -ne $version) { throw 'Executable version does not match release directory.' }
$allowedTopLevel = @(
  'locales', 'resources', 'Whale Companion Preview.exe', 'chrome_100_percent.pak',
  'chrome_200_percent.pak', 'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll',
  'ffmpeg.dll', 'icudtl.dat', 'LICENSE.electron.txt', 'LICENSES.chromium.html',
  'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'version',
  'vk_swiftshader_icd.json', 'vk_swiftshader.dll', 'vulkan-1.dll'
)
foreach ($item in (Get-ChildItem -LiteralPath $unpacked -Force)) {
  if ($allowedTopLevel -notcontains $item.Name) { throw "Unexpected package entry: $($item.Name)" }
}
foreach ($item in (Get-ChildItem -LiteralPath $unpacked -Force -Recurse)) {
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Package contains a link: $($item.FullName)" }
  if ($item.Name -match '^(data|\.git|\.env(?:\..*)?|[^.]+\.(?:pem|p12|pfx|key))$') {
    throw "Package contains a private entry: $($item.FullName)"
  }
}
$zip = Join-Path (Split-Path $releasePath) "$name-win-x64.zip"
$sum = Join-Path (Split-Path $releasePath) "$name.sha256.txt"
if (Test-Path -LiteralPath $zip) { throw "Archive already exists: $zip" }
if (Test-Path -LiteralPath $sum) { throw "Checksum already exists: $sum" }
$temporary = "$zip.$([guid]::NewGuid().ToString('N')).tmp"
try {
  [IO.Compression.ZipFile]::CreateFromDirectory($unpacked, $temporary, [IO.Compression.CompressionLevel]::Optimal, $true)
  $archive = [IO.Compression.ZipFile]::OpenRead($temporary)
  try {
    $entries = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
    if (-not ($entries | Where-Object { $_ -eq 'win-unpacked/Whale Companion Preview.exe' })) { throw 'Executable missing from archive.' }
    if ($entries | Where-Object { $_ -match '(^|/)(data|\.env(?:\..*)?|\.git|[^/]+\.(?:pem|p12|pfx|key))(/|$)' }) {
      throw 'Private data found in archive.'
    }
  } finally { $archive.Dispose() }
  Move-Item -LiteralPath $temporary -Destination $zip
} finally {
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}
# Get-FileHash can be unavailable when PowerShell 7's module path shadows the
# 5.1 utility modules; the .NET hash has no such dependency.
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
  $stream = [IO.File]::OpenRead($zip)
  try { $hash = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose() }
} finally { $sha256.Dispose() }
[IO.File]::WriteAllText($sum, "$hash  $([IO.Path]::GetFileName($zip))`n", [Text.UTF8Encoding]::new($false))
Write-Output "Archive OK: $zip"
Write-Output "SHA256: $hash"

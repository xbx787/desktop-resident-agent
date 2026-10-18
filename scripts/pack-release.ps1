param([switch]$NoShortcutSwitch)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectRoot
$version = (& node -p "require('./package.json').version").Trim()
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid package version.' }

$releaseName = "whale-companion-v$version"
$releaseDir = [IO.Path]::GetFullPath((Join-Path $projectRoot (Join-Path 'release' $releaseName)))
if (-not $releaseDir.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Release target is outside the project.'
}
if (Test-Path -LiteralPath $releaseDir) { throw "Release directory already exists: $releaseDir" }

& npm run check
if ($LASTEXITCODE -ne 0) { throw 'Type check failed.' }
& npm test
if ($LASTEXITCODE -ne 0) { throw 'Tests failed.' }
& node scripts/audit-active-avatar-assets.cjs
if ($LASTEXITCODE -ne 0) { throw 'Active avatar assets failed quality audit.' }
& npm run pack:dir -- "-c.directories.output=release/$releaseName"
if ($LASTEXITCODE -ne 0) { throw 'Packaging failed.' }
& npm run verify:asar
if ($LASTEXITCODE -ne 0) { throw 'Packaged app verification failed.' }

$unpacked = Join-Path $releaseDir 'win-unpacked'
$exe = Join-Path $unpacked 'Whale Companion Preview.exe'
$icon = Join-Path $unpacked 'resources\whale-tray-icon-pixel.ico'
if (-not (Test-Path -LiteralPath $exe) -or -not (Test-Path -LiteralPath $icon)) {
  throw 'Packaged executable or icon is missing.'
}

if (-not $NoShortcutSwitch) {
  & (Join-Path $PSScriptRoot 'switch-shortcuts.ps1') -ProjectRoot $projectRoot -ReleaseDir $releaseDir
  if ($LASTEXITCODE -ne 0) { throw 'Shortcut switch failed.' }
}
Write-Output "Release ready: $releaseDir"

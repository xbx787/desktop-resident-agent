param()

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

$shortcutName = ([char]0x5c0f).ToString() + ([char]0x9cb8).ToString() + '.lnk'
$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell
foreach ($linkPath in @((Join-Path $projectRoot $shortcutName), (Join-Path $desktop $shortcutName))) {
  $shortcut = $shell.CreateShortcut($linkPath)
  $shortcut.TargetPath = $exe
  $shortcut.WorkingDirectory = $projectRoot
  $shortcut.IconLocation = "$icon,0"
  $shortcut.Save()
  $saved = $shell.CreateShortcut($linkPath)
  if ($saved.TargetPath -ne $exe -or $saved.WorkingDirectory -ne $projectRoot -or $saved.IconLocation -ne "$icon,0") {
    throw "Shortcut verification failed: $linkPath"
  }
  Write-Output "Shortcut OK: $linkPath"
}
Write-Output "Release ready: $releaseDir"

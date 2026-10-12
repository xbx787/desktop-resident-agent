param(
  [Parameter(Mandatory=$true)][string]$ProjectRoot,
  [Parameter(Mandatory=$true)][string]$ReleaseDir
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $ProjectRoot).ProviderPath.TrimEnd([IO.Path]::DirectorySeparatorChar)
$target = (Resolve-Path -LiteralPath $ReleaseDir).ProviderPath.TrimEnd([IO.Path]::DirectorySeparatorChar)
$releaseRoot = Join-Path $root 'release'
$name = [IO.Path]::GetFileName($target)
if (-not [String]::Equals((Split-Path $target), $releaseRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $name -notmatch '^whale-companion-v\d+\.\d+\.\d+$') {
  throw 'Release directory is not a versioned package under the project.'
}
$exe = Join-Path $target 'win-unpacked\Whale Companion Preview.exe'
$icon = Join-Path $target 'win-unpacked\resources\whale-tray-icon-pixel.ico'
if (-not (Test-Path -LiteralPath $exe) -or -not (Test-Path -LiteralPath $icon)) {
  throw 'Packaged executable or icon is missing.'
}
if ((Get-Item -LiteralPath $exe).VersionInfo.FileVersion -ne $name.Substring('whale-companion-v'.Length)) {
  throw 'Executable version does not match release directory.'
}
$shortcutName = ([char]0x5c0f).ToString() + ([char]0x9cb8).ToString() + '.lnk'
$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop) { throw 'Desktop path is unavailable.' }
$shell = New-Object -ComObject WScript.Shell
$links = @((Join-Path $root $shortcutName), (Join-Path $desktop $shortcutName))
$old = @()
foreach ($linkPath in $links) {
  $exists = Test-Path -LiteralPath $linkPath
  $entry = @{ Path = $linkPath; Exists = $exists; Target = ''; Working = ''; Icon = '' }
  if ($exists) {
    $previous = $shell.CreateShortcut($linkPath)
    $entry.Target = $previous.TargetPath
    $entry.Working = $previous.WorkingDirectory
    $entry.Icon = $previous.IconLocation
  }
  $old += $entry
}
try {
  foreach ($linkPath in $links) {
    $shortcut = $shell.CreateShortcut($linkPath)
    $shortcut.TargetPath = $exe
    $shortcut.WorkingDirectory = $root
    $shortcut.IconLocation = "$icon,0"
    $shortcut.Save()
    $saved = $shell.CreateShortcut($linkPath)
    if ($saved.TargetPath -ne $exe -or $saved.WorkingDirectory -ne $root -or $saved.IconLocation -ne "$icon,0") {
      throw "Shortcut verification failed: $linkPath"
    }
    Write-Output "Shortcut OK: $linkPath"
  }
} catch {
  $cause = $_
  foreach ($entry in $old) {
    try {
      if ($entry.Exists) {
        $previous = $shell.CreateShortcut($entry.Path)
        $previous.TargetPath = $entry.Target
        $previous.WorkingDirectory = $entry.Working
        $previous.IconLocation = $entry.Icon
        $previous.Save()
      } elseif (Test-Path -LiteralPath $entry.Path) {
        Remove-Item -LiteralPath $entry.Path -Force
      }
    } catch {
      Write-Error "Shortcut rollback failed: $($entry.Path)"
    }
  }
  throw $cause
}

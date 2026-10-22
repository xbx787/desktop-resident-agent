param([switch]$NoShortcutSwitch)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectRoot
$version = (& node -p "require('./package.json').version").Trim()
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid package version.' }

$releaseName = "whale-companion-v$version$($env:WHALE_RELEASE_SUFFIX)"
$releaseDir = [IO.Path]::GetFullPath((Join-Path $projectRoot (Join-Path 'release' $releaseName)))
if (-not $releaseDir.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Release target is outside the project.'
}
if (Test-Path -LiteralPath $releaseDir) { throw "Release directory already exists: $releaseDir" }

& npm run check
if ($LASTEXITCODE -ne 0) { throw 'Type check failed.' }
& npm test
if ($LASTEXITCODE -ne 0) { throw 'Tests failed.' }
# DSH 运行时补丁（ACP session/steer）：vendor 副本被重装覆盖时靠这一步恢复。
& node scripts/patch-dsh-runtime.cjs
if ($LASTEXITCODE -ne 0) { throw 'DSH runtime patch failed.' }
& node scripts/audit-active-avatar-assets.cjs
if ($LASTEXITCODE -ne 0) { throw 'Active avatar assets failed quality audit.' }
& npm run pack:dir -- "-c.directories.output=release/$releaseName"
if ($LASTEXITCODE -ne 0) { throw 'Packaging failed.' }
# electron-builder 会原样保留 pnpm junction，目标仍是开发机 reference；这里改指
# 包内镜像，并移除被过滤器排除、没有包内镜像的可选链接。随后再跑一次 -Check 兜底。
$dshRuntime = Join-Path $releaseDir 'win-unpacked\resources\dsh'
& (Join-Path $PSScriptRoot 'fix-dsh-links.ps1') -Root $dshRuntime
if ($LASTEXITCODE -ne 0) { throw 'DSH runtime link repair failed.' }
& (Join-Path $PSScriptRoot 'fix-dsh-links.ps1') -Root $dshRuntime -Check
if ($LASTEXITCODE -ne 0) { throw 'DSH runtime is not self-contained after link repair.' }
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

# 可复现构建信息：版本、DSH 版本、打补丁后的 ACP 桥哈希，写进发布目录。
try {
  $dshPnpm = Join-Path $unpacked 'resources\dsh\node_modules\.pnpm'
  $dshAcpDir = Get-ChildItem -LiteralPath $dshPnpm -Directory -ErrorAction Ignore |
    Where-Object { $_.Name -like '@deepseek-ai+dsh-acp@*' } | Select-Object -First 1
  $dshPkg = Join-Path $unpacked 'resources\dsh\node_modules\@deepseek-ai\dsh\package.json'
  $dshVersion = 'unknown'
  if (Test-Path -LiteralPath $dshPkg) {
    try { $dshVersion = (Get-Content -Raw -LiteralPath $dshPkg | ConvertFrom-Json).version } catch { $dshVersion = 'unknown' }
  }
  $acpHash = 'missing'
  if ($dshAcpDir) {
    $acpIndex = Join-Path $dshAcpDir.FullName 'node_modules\@deepseek-ai\dsh-acp\lib\index.js'
    if (Test-Path -LiteralPath $acpIndex) {
      # Get-FileHash 不在精简 PowerShell 模块里；用 node 算，和补丁脚本同一环境。
      $acpHash = (& node -e "const c=require('crypto'),f=require('fs');process.stdout.write(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex').toUpperCase())" $acpIndex).Trim()
    }
  }
  $buildInfo = [ordered]@{
    version = $version
    dshVersion = $dshVersion
    patchedAcpSha256 = $acpHash
    builtAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  $buildInfo | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $releaseDir 'BUILD-INFO.json') -Encoding utf8
} catch {
  Write-Warning "BUILD-INFO 未写入：$($_.Exception.Message)"
}

# 包内 DSH 依赖不允许指向开发目录：junction 目标必须在发布目录内，
# 否则运行中的包会被 reference 里的改动带崩（0.93 救援的根因）。
$dshRoot = Join-Path $unpacked 'resources\dsh'
if (Test-Path -LiteralPath $dshRoot) {
  $badLinks = Get-ChildItem -LiteralPath $dshRoot -Recurse -Force -ErrorAction Ignore |
    Where-Object { $_.LinkType -eq 'Junction' -and $_.Target -and ($_.Target -notlike "$unpacked*") }
  $badLink = $badLinks | Select-Object -First 1
  if ($badLink) {
    throw "包内依赖指向开发目录：$($badLink.FullName) -> $($badLink.Target)"
  }
}

Write-Output "Release ready: $releaseDir"


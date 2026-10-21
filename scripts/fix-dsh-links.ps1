# 把发布包 resources/dsh 里的 pnpm junction 从开发机 reference 改指包内镜像。
#
# 背景：electron-builder 复制 node_modules 时会保留 pnpm 的 junction，目标仍是
# `D:\DesktopPetProject\reference\dsh-runtime\...`。于是发布包加载的是开发机上的
# 运行时（本次 0.94 读图事故就是这样被 reference 补丁放大的）。
#
# 包内 `.pnpm/...` 已经有同一份真实目录，所以只需重建 junction 指向包内，
# 不需要复制运行时。被 extraResources 过滤器排除的可选包没有包内镜像，其链接
# 直接移除，避免发布包再悄悄回落到开发机。
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$ReferenceRoot,
  [switch]$Check
)

$ErrorActionPreference = 'Stop'

$rootFull = [IO.Path]::GetFullPath($Root)
if (-not (Test-Path -LiteralPath $rootFull)) { throw "DSH runtime not found: $rootFull" }
$nodeModules = Join-Path $rootFull 'node_modules'
if (-not (Test-Path -LiteralPath $nodeModules)) { throw "node_modules not found under: $rootFull" }

if (-not $ReferenceRoot) {
  $ReferenceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\reference\dsh-runtime'))
}
$referenceFull = [IO.Path]::GetFullPath($ReferenceRoot)
$referencePrefix = $referenceFull.TrimEnd('\') + '\'
$rootPrefix = $rootFull.TrimEnd('\') + '\'
$marker = '\node_modules\'

$repaired = 0
$alreadyInternal = 0
$removed = 0
$bad = [System.Collections.Generic.List[string]]::new()

function Remove-ReparsePoint([string]$Path) {
  # 损坏的 junction 会让 Remove-Item 的内部提供程序抛 NullReference；目录级删除
  # 只移除重解析点本身，不触碰目标，优先用它。
  try { [IO.Directory]::Delete($Path, $false); return } catch { }
  try { Remove-Item -LiteralPath $Path -Force -ErrorAction Stop; return } catch { }
  & cmd.exe /c rmdir "$Path" 2>$null | Out-Null
  if ([IO.Directory]::Exists($Path) -or [IO.File]::Exists($Path)) {
    throw "cannot remove reparse point: $Path"
  }
}

function New-InternalJunction([string]$Path, [string]$Target) {
  try {
    New-Item -ItemType Junction -Path $Path -Target $Target -ErrorAction Stop | Out-Null
  } catch {
    & cmd.exe /c mklink /J "$Path" "$Target" 2>$null | Out-Null
  }
  if (-not [IO.Directory]::Exists($Path)) { throw "cannot create junction: $Path -> $Target" }
}

$links = @(Get-ChildItem -LiteralPath $nodeModules -Recurse -Force -Directory -Attributes ReparsePoint -ErrorAction Stop)
foreach ($link in $links) {
  $rawTarget = @($link.Target)[0]
  if (-not $rawTarget) {
    $bad.Add("$($link.FullName): reparse point has no target")
    continue
  }
  $targetFull = if ([IO.Path]::IsPathRooted($rawTarget)) {
    [IO.Path]::GetFullPath($rawTarget)
  } else {
    [IO.Path]::GetFullPath((Join-Path $link.Parent.FullName $rawTarget))
  }

  if ($targetFull.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    if (Test-Path -LiteralPath $targetFull) { $alreadyInternal++; continue }
    $bad.Add("$($link.FullName): dangling internal target $targetFull")
    continue
  }

  if (-not $targetFull.StartsWith($referencePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    $bad.Add("$($link.FullName): target escapes the release and is not the build reference: $targetFull")
    continue
  }

  if ($Check) {
    $bad.Add("$($link.FullName): still points at the build reference: $targetFull")
    continue
  }

  $at = $targetFull.IndexOf($marker, [StringComparison]::OrdinalIgnoreCase)
  if ($at -lt 0) {
    $bad.Add("$($link.FullName): cannot map reference target into the package: $targetFull")
    continue
  }
  $relative = $targetFull.Substring($at + $marker.Length)
  $internal = Join-Path $nodeModules $relative
  try {
    if (Test-Path -LiteralPath $internal) {
      Remove-ReparsePoint $link.FullName
      New-InternalJunction $link.FullName $internal
      $repaired++
    } else {
      # extraResources 过滤器有意排除的可选包：移除链接，别让它回落到开发机。
      Remove-ReparsePoint $link.FullName
      $removed++
    }
  } catch {
    $bad.Add("$($link.FullName): $($_.Exception.Message)")
  }
}

$summary = [ordered]@{
  root = $rootFull
  reparsePoints = $links.Count
  repaired = $repaired
  alreadyInternal = $alreadyInternal
  removedWithoutMirror = $removed
  problems = $bad.Count
  samples = @($bad | Select-Object -First 10)
}
$summary | ConvertTo-Json -Depth 4

if ($bad.Count -gt 0) { exit 1 }
exit 0

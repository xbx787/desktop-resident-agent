param([switch]$NoShortcutSwitch, [switch]$NoSelfTest)

# 进化闭环：打包 → 关闭旧实例 → 启动新实例自检 → 等结果落盘。
# 结果在 data/self-test/latest.json；自检失败时脚本非零退出。
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectRoot
$version = (& node -p "require('./package.json').version").Trim()
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^\d+\.\d+\.\d+$') { throw '版本号无效。' }

& (Join-Path $PSScriptRoot 'pack-release.ps1') -NoShortcutSwitch:$NoShortcutSwitch
if ($LASTEXITCODE -ne 0) { throw '打包失败。' }

$releaseDir = Join-Path $projectRoot "release/whale-companion-v$version/win-unpacked"
$exe = Join-Path $releaseDir 'Whale Companion Preview.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "找不到新版本：$exe" }

# 关闭正在运行的旧实例。--quit 会先保存正在进行的对话。
$running = Get-Process -Name 'Whale Companion Preview' -ErrorAction SilentlyContinue
if ($running) {
  $main = $running | Where-Object { $_.MainWindowTitle } | Select-Object -First 1
  if (-not $main) { $main = $running | Sort-Object StartTime | Select-Object -First 1 }
  & $main.Path --quit
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline -and (Get-Process -Id $main.Id -ErrorAction SilentlyContinue)) {
    Start-Sleep -Milliseconds 300
  }
  if (Get-Process -Id $main.Id -ErrorAction SilentlyContinue) {
    throw '旧实例没有在 20 秒内退出，未强制结束；请检查对话保存状态。'
  }
  # 等单实例锁和窗口资源释放。
  Start-Sleep -Seconds 2
}

$resultRoot = Join-Path $projectRoot 'data/self-test'
$resultPath = Join-Path $resultRoot 'latest.json'
$stdoutPath = Join-Path $resultRoot 'app.out.log'
$stderrPath = Join-Path $resultRoot 'app.err.log'
New-Item -ItemType Directory -Force -Path $resultRoot | Out-Null
Remove-Item -LiteralPath $resultPath, $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue

if ($NoSelfTest) {
  # 定时/迁移任务要在启动后由 resumeEvolveTask 接管；--self-test 会跳过恢复。
  Start-Process -FilePath $exe -WorkingDirectory $releaseDir `
    -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  Write-Output "EVOLVE_LAUNCHED version=$version"
  exit 0
} else {
  Start-Process -FilePath $exe -ArgumentList '--self-test' -WorkingDirectory $releaseDir `
    -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
}

$deadline = (Get-Date).AddSeconds(90)
$result = $null
while ((Get-Date) -lt $deadline) {
  if (Test-Path -LiteralPath $resultPath) {
    try {
      $parsed = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
      if ($parsed.version -eq $version) { $result = $parsed; break }
    } catch {
      # 文件可能正写到一半，下一轮再读。
    }
  }
  Start-Sleep -Seconds 1
}

if (-not $result) {
  $tail = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Tail 20 | Out-String } else { '' }
  throw "自检超时（90 秒）：$resultPath`n$tail"
}

$result | ConvertTo-Json -Depth 6
if (-not $result.ok) { throw '启动自检未通过。' }
Write-Output "EVOLVE_OK version=$version"

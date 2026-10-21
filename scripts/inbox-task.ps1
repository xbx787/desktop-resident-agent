param(
  [string]$TaskFile = 'D:\DesktopPetProject\data\scheduled\2026-10-20-1800-task.md',
  [string]$Marker = 'D:\DesktopPetProject\data\scheduled\inbox-1800.sent'
)

# 定时任务投递：先确保桌面小鲸/内置 Claude Code 在运行，再把任务作为一条
# 普通用户消息放进当前对话。消息由 InboxWatcher 的 autoRun 分支消费，会
# 真正启动模型回合，结果留在聊天记录里。
#
# 应用没启动时先启动它；仍然失败才回退到独立 headless 脚本。
$ErrorActionPreference = 'Stop'
$project = 'D:\DesktopPetProject'
$logDir = Join-Path $project 'data\scheduled'
$inbox = Join-Path $project 'data\inbox'
$log = Join-Path $logDir 'inbox-1800.log'
New-Item -ItemType Directory -Force -Path $logDir, $inbox | Out-Null

function Write-Log([string]$message) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message"
  Add-Content -LiteralPath $log -Value $line
  Write-Output $line
}

if (Test-Path -LiteralPath $Marker) {
  Write-Log 'marker exists, already delivered'
  exit 0
}
if (-not (Test-Path -LiteralPath $TaskFile)) {
  Write-Log "task file missing: $TaskFile"
  exit 1
}

$processName = 'Whale Companion Preview'
$apps = @(Get-Process -Name $processName -ErrorAction SilentlyContinue)
if ($apps.Count -eq 0) {
  Write-Log 'app not running, starting shortcut'
  $shortcut = 'C:\Users\27926\Desktop\小鲸.lnk'
  if (Test-Path -LiteralPath $shortcut) {
    Start-Process -FilePath $shortcut
  } else {
    $exe = Join-Path $project 'release\whale-companion-v0.0.88\win-unpacked\Whale Companion Preview.exe'
    if (-not (Test-Path -LiteralPath $exe)) {
      Write-Log 'no shortcut and no 0.0.88 exe'
      exit 1
    }
    Start-Process -FilePath $exe
  }
  $deadline = (Get-Date).AddSeconds(40)
  while ((Get-Date) -lt $deadline) {
    $apps = @(Get-Process -Name $processName -ErrorAction SilentlyContinue)
    if ($apps.Count -gt 0 -and (Test-Path -LiteralPath $inbox)) { break }
    Start-Sleep -Milliseconds 500
  }
  if ($apps.Count -eq 0) {
    Write-Log 'app did not start; falling back to headless'
    & (Join-Path $project 'scripts\wake-1800.ps1') -Slot 1800
    exit $LASTEXITCODE
  }
  # Let the controller finish loading the saved conversation and start the inbox watcher.
  Start-Sleep -Seconds 3
  Write-Log "app started pid=$($apps[0].Id)"
} else {
  Write-Log "app already running pid=$($apps[0].Id)"
}

$task = Get-Content -LiteralPath $TaskFile -Raw -Encoding UTF8
$message = @{
  from = @{ name = '定时任务'; badge = '时' }
  autoRun = $true
  text = "[定时任务] 现在是 $(Get-Date -Format 'yyyy-MM-dd HH:mm')。请直接执行下面的任务，把完整报告写入任务里指定的路径，并在聊天里给出摘要。`n`n$task"
}
$name = "task-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$temp = Join-Path $inbox "$name.tmp"
$final = Join-Path $inbox "$name.json"
$json = $message | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($temp, $json, (New-Object System.Text.UTF8Encoding($false)))
Move-Item -LiteralPath $temp -Destination $final -Force
Write-Log "delivered inbox file $final"
New-Item -ItemType File -Force -Path $Marker | Out-Null
Write-Log 'marker written'

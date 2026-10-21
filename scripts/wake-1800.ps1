param([ValidateSet('1800', '1815', 'dryrun')][string]$Slot = '1800')

# 18:00 兜底执行器：不依赖 Claude Code 交互会话。
# 由 Windows 计划任务启动；每次运行都会确保 Whale-1800 / Whale-1815 两个任务
# 存在且启用，然后用 headless Claude Code 执行任务并把结果写到 data/scheduled。
$ErrorActionPreference = 'Stop'
$project = 'D:\DesktopPetProject'
$logDir = Join-Path $project 'data\scheduled'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "wake-$Slot.log"

function Write-Log([string]$message) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [$Slot] $message"
  Add-Content -LiteralPath $log -Value $line
  Write-Output $line
}

Write-Log 'start'
$scriptPath = Join-Path $project 'scripts\wake-1800.ps1'

function Ensure-Task([string]$name, [datetime]$at) {
  try {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($task) {
      if ($task.State -eq 'Disabled') {
        Enable-ScheduledTask -TaskName $name | Out-Null
        Write-Log "task $name enabled"
      } else {
        Write-Log "task $name present state=$($task.State)"
      }
      return
    }
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -Slot 1800"
    $trigger = New-ScheduledTaskTrigger -Once -At $at
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description 'Whale 18:00 fallback' -Force | Out-Null
    Write-Log "task $name registered at $at"
  } catch {
    Write-Log "task $name check/register failed: $($_.Exception.Message)"
  }
}

if ($Slot -ne 'dryrun') {
  Ensure-Task 'Whale-1800' ([datetime]'2026-10-20 18:00:00')
  Ensure-Task 'Whale-1815' ([datetime]'2026-10-20 18:15:00')
}

$resultPath = Join-Path $logDir '2026-10-20-1800-result.md'
$taskPath = Join-Path $logDir '2026-10-20-1800-task.md'
if ($Slot -ne 'dryrun' -and (Test-Path -LiteralPath $resultPath)) {
  $size = (Get-Item -LiteralPath $resultPath).Length
  if ($size -gt 0) {
    Write-Log "result already exists ($size bytes), skip"
    exit 0
  }
}

$settingsPath = Join-Path $env:USERPROFILE '.claude\settings.json'
if (-not (Test-Path -LiteralPath $settingsPath)) {
  Write-Log '~/.claude/settings.json missing'
  exit 1
}
$settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
$token = [string]$settings.env.ANTHROPIC_AUTH_TOKEN
if (-not $token) {
  Write-Log 'no ANTHROPIC_AUTH_TOKEN in settings'
  exit 1
}
$env:ANTHROPIC_AUTH_TOKEN = $token
$env:ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
$env:ANTHROPIC_MODEL = 'deepseek-flash'
$env:DEEPSEEK_API_KEY = $token
$env:PATH = "D:\Program Files\nodejs;$env:PATH"

$claudeCmd = Join-Path $env:APPDATA 'npm\claude.cmd'
if (-not (Test-Path -LiteralPath $claudeCmd)) {
  Write-Log 'claude.cmd missing'
  exit 1
}
$mcpConfig = Join-Path $project 'scripts\deepseek-mcp.json'
Set-Location -LiteralPath $project

if ($Slot -eq 'dryrun') {
  $out = & $claudeCmd -p '只回复 OK' --output-format text 2>&1
  Write-Log ("dryrun output: " + (($out | Out-String).Trim()))
  exit 0
}

$task = Get-Content -LiteralPath $taskPath -Raw
$stdoutPath = Join-Path $logDir "wake-$Slot.stdout.log"
Write-Log 'invoking headless claude'
$task | & $claudeCmd -p --output-format text --permission-mode bypassPermissions --allowedTools 'mcp__deepseek__search,mcp__deepseek__fetch,Read,Write,Bash' --mcp-config $mcpConfig *> $stdoutPath
$code = $LASTEXITCODE
Write-Log "claude exit=$code"

if (-not (Test-Path -LiteralPath $resultPath) -or (Get-Item -LiteralPath $resultPath).Length -eq 0) {
  if (Test-Path -LiteralPath $stdoutPath) {
    Copy-Item -LiteralPath $stdoutPath -Destination $resultPath -Force
  }
}
if (Test-Path -LiteralPath $resultPath) {
  Write-Log "result bytes=$((Get-Item -LiteralPath $resultPath).Length)"
  try { msg.exe $env:USERNAME '18:00 任务已完成，结果在 data\scheduled\2026-10-20-1800-result.md' | Out-Null } catch { }
} else {
  Write-Log 'result missing'
  exit 1
}

<#
.SYNOPSIS
  Claude Code Monitor — 一键安装脚本
.DESCRIPTION
  检测环境、部署 PowerShell 上报脚本、合并 settings.json 配置、安装 npm 依赖
#>

$ErrorActionPreference = "Stop"
$UserName = $env:USERNAME
$UserProfile = $env:USERPROFILE
$ClaudeDir = "$UserProfile\.claude"
$SettingsFile = "$ClaudeDir\settings.json"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = $ScriptDir  # install.ps1 lives in claude-monitor/ root

# PS 5.1 兼容: ConvertFrom-Json 没有 -AsHashtable，手动递归转换
function ConvertFromJsonToHash {
  param([string]$Json)
  $obj = $Json | ConvertFrom-Json
  return ConvertToHash $obj
}

function ConvertToHash {
  param($obj)
  if ($null -eq $obj) { return $null }
  if ($obj -is [array]) {
    $arr = @()
    foreach ($item in $obj) { $arr += (ConvertToHash $item) }
    return $arr
  }
  if ($obj -is [System.Management.Automation.PSCustomObject]) {
    $hash = @{}
    foreach ($prop in $obj.PSObject.Properties) {
      $hash[$prop.Name] = ConvertToHash $prop.Value
    }
    return $hash
  }
  return $obj
}

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Claude Code Monitor - Installer v0.5.0" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: 检测 Node.js ──────────────────
Write-Host "[1/7] Checking Node.js..." -ForegroundColor Yellow
try {
  $nodeVersion = node --version 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "  Node.js $nodeVersion found" -ForegroundColor Green
  } else {
    throw "node not found"
  }
} catch {
  Write-Host "  ERROR: Node.js >= 18 is required for MVP" -ForegroundColor Red
  Write-Host "  Download from https://nodejs.org/" -ForegroundColor Red
  exit 1
}

# ── Step 2: 检测 ExecutionPolicy ───────────
Write-Host "[2/7] Checking PowerShell ExecutionPolicy..." -ForegroundColor Yellow
$policy = Get-ExecutionPolicy -Scope CurrentUser
Write-Host "  CurrentUser policy: $policy" -ForegroundColor $(if ($policy -eq "Restricted") { "Red" } else { "Green" })
if ($policy -eq "Restricted") {
  Write-Host "  WARNING: Scripts are blocked. Run this to allow:" -ForegroundColor Yellow
  Write-Host "    Set-ExecutionPolicy RemoteSigned -Scope CurrentUser" -ForegroundColor White
}

# ── Step 3: 部署上报脚本 ──────────────────
Write-Host "[3/7] Deploying PowerShell scripts..." -ForegroundColor Yellow
if (!(Test-Path $ClaudeDir)) {
  New-Item -ItemType Directory -Path $ClaudeDir -Force | Out-Null
}
Copy-Item "$ScriptDir\scripts\report-status.ps1" "$ClaudeDir\report-status.ps1" -Force
Copy-Item "$ScriptDir\scripts\report-hook.ps1" "$ClaudeDir\report-hook.ps1" -Force
Write-Host "  Copied to $ClaudeDir" -ForegroundColor Green

# ── Step 4: 合并 settings.json ────────────
Write-Host "[4/7] Configuring settings.json..." -ForegroundColor Yellow

$hookCommand = $($ClaudeDir -replace '\\','/')
$monitorHooks = @{
  hooks = @{
    SessionStart = @(
      @{
        hooks = @(
          @{
            type = "command"
            shell = "powershell"
            command = "powershell -NoProfile -ExecutionPolicy Bypass -File $hookCommand/report-hook.ps1 SessionStart"
            timeout = 10
          }
        )
      }
    )
    UserPromptSubmit = @(
      @{
        hooks = @(
          @{
            type = "command"
            shell = "powershell"
            command = "powershell -NoProfile -ExecutionPolicy Bypass -File $hookCommand/report-hook.ps1 UserPromptSubmit"
            timeout = 10
          }
        )
      }
    )
    PreToolUse = @(
      @{
        matcher = "Write|Edit|Bash|TaskCreate|Agent|NotebookEdit"
        hooks = @(
          @{
            type = "command"
            shell = "powershell"
            command = "powershell -NoProfile -ExecutionPolicy Bypass -File $hookCommand/report-hook.ps1 PreToolUse"
            timeout = 10
          }
        )
      }
    )
    PostToolUse = @(
      @{
        matcher = "Write|Edit|Bash|TaskCreate|Agent|NotebookEdit"
        hooks = @(
          @{
            type = "command"
            shell = "powershell"
            command = "powershell -NoProfile -ExecutionPolicy Bypass -File $hookCommand/report-hook.ps1 PostToolUse"
            timeout = 10
          }
        )
      }
    )
    Stop = @(
      @{
        hooks = @(
          @{
            type = "command"
            shell = "powershell"
            command = "powershell -NoProfile -ExecutionPolicy Bypass -File $hookCommand/report-hook.ps1 Stop"
            timeout = 15
          }
        )
      }
    )
  }
  statusLine = @{
    type = "command"
    command = "powershell -NoProfile -ExecutionPolicy Bypass -File $hookCommand/report-status.ps1"
  }
}

$existingSettings = @{}
$hasExistingStatusLine = $false
$statusLineAction = "skip"

if (Test-Path $SettingsFile) {
  Write-Host "  Existing settings.json found, backing up..." -ForegroundColor Yellow
  $backupFile = "$ClaudeDir\settings.json.bak.$(Get-Date -Format 'yyyyMMddHHmmss')"
  Copy-Item $SettingsFile $backupFile -Force
  Write-Host "  Backup: $backupFile" -ForegroundColor Green

  # 解析现有配置
  try {
    $existingJson = Get-Content $SettingsFile -Raw -Encoding UTF8
    if ($existingJson.Trim()) {
      # ConvertFrom-Json -AsHashtable not available in PS 5.1, use PSCustomObject
      $existingSettings = ConvertFromJsonToHash($existingJson)
    }
  } catch {
    Write-Host "  WARNING: Failed to parse existing settings.json. Creating new." -ForegroundColor Yellow
    $existingSettings = @{}
  }
}

# 检查 statusLine
if ($existingSettings.ContainsKey('statusLine') -and $existingSettings['statusLine']) {
  $hasExistingStatusLine = $true
  Write-Host ""
  Write-Host "  WARNING: You already have a custom statusLine configured!" -ForegroundColor Yellow
  Write-Host "  Options:" -ForegroundColor White
  Write-Host "    [1] Skip   - Keep your current statusLine (recommended, monitor still works via hooks)" -ForegroundColor White
  Write-Host "    [2] Replace - Overwrite with monitor statusLine (you'll lose your custom statusLine)" -ForegroundColor White
  Write-Host "    [3] Abort  - Cancel installation" -ForegroundColor White
  $choice = Read-Host "  Enter choice [1/2/3]"
  if ($choice -eq "2") {
    $statusLineAction = "replace"
  } elseif ($choice -eq "3") {
    Write-Host "  Installation aborted." -ForegroundColor Red
    exit 0
  } else {
    $statusLineAction = "skip"
  }
}

# 合并 hooks: 保留用户现有 hook，追加 monitor hook
$merged = $existingSettings.Clone()
if (!$merged.ContainsKey('hooks')) {
  $merged['hooks'] = @{}
}
$userHooks = $merged['hooks']

foreach ($eventName in $monitorHooks.hooks.Keys) {
  $monitorHookDefs = $monitorHooks.hooks[$eventName]
  if ($userHooks.ContainsKey($eventName)) {
    # 用户已有此事件的 hook，追加到末尾
    $userHooks[$eventName] = @($userHooks[$eventName]) + @($monitorHookDefs)
  } else {
    $userHooks[$eventName] = @($monitorHookDefs)
  }
}

# 合并 statusLine
if ($statusLineAction -eq "replace" -or !$hasExistingStatusLine) {
  $merged['statusLine'] = $monitorHooks['statusLine']
}

# 写入 settings.json
$mergedJson = $merged | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($SettingsFile, $mergedJson, [System.Text.Encoding]::UTF8)

# JSON 语法校验
try {
  $null = Get-Content $SettingsFile -Raw | ConvertFrom-Json
  Write-Host "  settings.json updated and validated" -ForegroundColor Green
} catch {
  Write-Host "  ERROR: Generated settings.json is invalid JSON!" -ForegroundColor Red
  Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "  Restoring from backup..." -ForegroundColor Yellow
  Copy-Item $backupFile $SettingsFile -Force
  exit 1
}

if ($hasExistingStatusLine -and $statusLineAction -eq "skip") {
  Write-Host "  NOTE: Your existing statusLine was preserved. Monitor will use hooks data only." -ForegroundColor Yellow
}

# ── Step 5: npm install ───────────────────
Write-Host "[5/7] Installing npm dependencies..." -ForegroundColor Yellow
Push-Location $ProjectDir
try {
  npm install 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "npm install exited with code $LASTEXITCODE"
  }
  Write-Host "  Dependencies installed" -ForegroundColor Green
} catch {
  Write-Host "  npm install failed. Try running manually:" -ForegroundColor Red
  Write-Host "    cd $ProjectDir && npm install" -ForegroundColor White
} finally {
  Pop-Location
}

# ── Step 6: 快捷方式 ──────────────────────
Write-Host "[6/7] Shortcut options..." -ForegroundColor Yellow
$desktopChoice = Read-Host "  Create desktop shortcut? [y/N]"
if ($desktopChoice -eq 'y' -or $desktopChoice -eq 'Y') {
  $desktopPath = [Environment]::GetFolderPath('Desktop')
  if (!$desktopPath -or !(Test-Path $desktopPath)) {
    Write-Host "  Could not find Desktop folder, skipping shortcut" -ForegroundColor Yellow
  } else {
    try {
      $WshShell = New-Object -ComObject WScript.Shell
      $Shortcut = $WshShell.CreateShortcut("$desktopPath\Claude Monitor.lnk")
      $Shortcut.TargetPath = "cmd.exe"
      $Shortcut.Arguments = "/c npm start"
      $Shortcut.WorkingDirectory = $ProjectDir
      $Shortcut.Description = "Claude Code Monitor"
      $Shortcut.Save()
      Write-Host "  Desktop shortcut created" -ForegroundColor Green
    } catch {
      Write-Host "  Failed to create shortcut: $_" -ForegroundColor Red
    }
  }
}

# ── Step 7: 开机自启 ──────────────────────
Write-Host "[7/7] Startup options..." -ForegroundColor Yellow
$startupChoice = Read-Host "  Launch on system startup? [y/N]"
if ($startupChoice -eq 'y' -or $startupChoice -eq 'Y') {
  $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  $cmdValue = "cmd.exe /c npm start"
  try {
    Set-ItemProperty -Path $runKey -Name "ClaudeMonitor" -Value $cmdValue -Force
    # Also set the working directory via a separate registry value
    $startupPath = "C:\Users\$UserName\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup"
    if (Test-Path $startupPath) {
      $WshShell = New-Object -ComObject WScript.Shell
      $Shortcut = $WshShell.CreateShortcut("$startupPath\Claude Monitor.lnk")
      $Shortcut.TargetPath = "cmd.exe"
      $Shortcut.Arguments = "/c npm start"
      $Shortcut.WorkingDirectory = $ProjectDir
      $Shortcut.Save()
    }
    Write-Host "  Added to startup" -ForegroundColor Green
  } catch {
    Write-Host "  Failed to add startup entry: $_" -ForegroundColor Red
  }
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Installation complete!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Start monitor: npm start" -ForegroundColor White
Write-Host "  Working dir:   $ProjectDir" -ForegroundColor White
Write-Host ""

# 扫描项目级配置
Write-Host "  NOTE: If any project has its own .claude/settings.local.json"
Write-Host "  with hooks, the global monitor hooks will NOT apply to that"
Write-Host "  project. Add monitor hooks to the project config manually if needed."
Write-Host ""

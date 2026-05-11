param([switch]$Debug)

[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$inputJson = [Console]::In.ReadToEnd()
if (!$inputJson) {
  Write-Output "Claude monitor"
  exit 0
}

# 向上递归查找 Claude Code 的 node.exe 进程 PID (用于 Ctrl+C / kill 检测)
# 进程链可能是: node → cmd → powershell 或 node → powershell
function Get-ClaudeNodePid {
  $currentPid = $PID
  for ($i = 0; $i -lt 5; $i++) {
    try {
      $parent = Get-WmiObject Win32_Process -Filter "ProcessId = $currentPid" -ErrorAction Stop
      if (!$parent) { break }
      $ppid = $parent.ParentProcessId
      $pname = (Get-WmiObject Win32_Process -Filter "ProcessId = $ppid" -ErrorAction Stop).Name
      if ($pname -eq 'node.exe') { return $ppid }
      $currentPid = $ppid
    } catch { break }
  }
  return 0
}

try {
  $ccPid = Get-ClaudeNodePid
  $data = $inputJson | ConvertFrom-Json
  $data | Add-Member -NotePropertyName "_ppid" -NotePropertyValue $ccPid -Force
  $inputJson = $data | ConvertTo-Json -Depth 20 -Compress
  if ($Debug) {
    Add-Content "$env:USERPROFILE\.claude\monitor-debug.log" "[$(Get-Date -Format 's')] status pid=$ccPid"
  }
} catch {
  # JSON 改造失败不影响后续流程
}

try {
  Invoke-RestMethod `
    -Uri "http://127.0.0.1:4317/claude/status" `
    -Method Post `
    -ContentType "application/json; charset=utf-8" `
    -Body $inputJson `
    -TimeoutSec 1 | Out-Null
} catch {
  if ($Debug) {
    Add-Content "$env:USERPROFILE\.claude\monitor-debug.log" "[$(Get-Date -Format 's')] statusLine HTTP fail: $_"
  }
}

try {
  $data = $inputJson | ConvertFrom-Json
  $model = $data.model.display_name
  $dir = Split-Path $data.workspace.current_dir -Leaf
  $pct = [int]($data.context_window.used_percentage)
  Write-Output "[$model] $dir | context ${pct}%"
} catch {
  Write-Output "Claude monitor active"
}

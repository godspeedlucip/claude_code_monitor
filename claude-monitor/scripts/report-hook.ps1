param(
  [string]$EventName,
  [switch]$Debug
)

[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$inputJson = [Console]::In.ReadToEnd()
if (!$inputJson) { exit 0 }

# 向上递归查找 Claude Code 的 node.exe 进程 PID (用于 Ctrl+C / kill 检测)
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
  $obj = $inputJson | ConvertFrom-Json
  $obj | Add-Member -NotePropertyName "_event" -NotePropertyValue $EventName -Force

  $ccPid = Get-ClaudeNodePid
  $obj | Add-Member -NotePropertyName "_ppid" -NotePropertyValue $ccPid -Force
  if ($Debug) {
    Add-Content "$env:USERPROFILE\.claude\monitor-debug.log" "[$(Get-Date -Format 's')] hook $EventName pid=$ccPid"
  }

  $body = $obj | ConvertTo-Json -Depth 20 -Compress

  Invoke-RestMethod `
    -Uri "http://127.0.0.1:4317/claude/hook" `
    -Method Post `
    -ContentType "application/json; charset=utf-8" `
    -Body $body `
    -TimeoutSec 1 | Out-Null
} catch {
  if ($Debug) {
    Add-Content "$env:USERPROFILE\.claude\monitor-debug.log" "[$(Get-Date -Format 's')] hook $EventName HTTP fail: $_"
  }
}

exit 0
